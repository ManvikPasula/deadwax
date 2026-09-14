import "server-only";

import { ProviderError, truncateBody } from "@/lib/providers/errors";
import { env } from "@/lib/env";
import { BUDGETS, consume } from "@/lib/security/rate-limit";

/**
 * MusicBrainz — the enrichment provider, and STRICTLY THE ENRICHMENT PROVIDER.
 *
 * WHAT IT IS FOR. It supplies the one thing Deezer cannot: a real crowd rating with a real
 * vote count. Probing returned `{value: 4.5, votes-count: 72}` for Kid A and
 * `{value: 4.5, votes-count: 80}` for Radiohead. That `(score, count)` pair is the entire
 * reason the consensus card and `reliableAverage` can exist honestly rather than being
 * popularity in a rating's clothing. It also supplies release-GROUP first-release dates
 * (which is what stops every remaster reading as a new album), `secondary-types` (the
 * canonical-release filter), curated count-weighted `genres`, and artist `country`.
 *
 * WHY IT IS NEVER ON A CRITICAL PATH. Probing found ONE REQUEST IN THREE answering
 *   {"error":"The MusicBrainz web server is currently busy. Please try again later."}
 * with HTTP 503. A provider that flaky cannot be allowed to decide a response status or to
 * delay a page. So:
 *   - there is NO throwing variant exported from this module at all;
 *   - every caller coalesces to null and the feature degrades to absent;
 *   - the TTL is 30 days, because the data barely moves and the endpoint is expensive to
 *     reach;
 *   - a serialising queue spaces requests, because their published policy is ~1 req/s and
 *     being blocked would cost us the only honest rating source we have.
 *
 * THE USER-AGENT IS MANDATORY. MusicBrainz refuses requests without a descriptive one, and it
 * must carry a way to contact the operator — hence the site URL.
 */

const BASE_URL = "https://musicbrainz.org/ws/2";
const MIN_SPACING_MS = 1_100; // their policy is ~1 req/s; 1.1s leaves margin for clock skew
const CACHE_SECONDS = 60 * 60 * 24 * 30;

/* -------------------------------------------------------------------------- */
/* The serialising queue                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A promise chain, not a token bucket.
 *
 * Every call links onto the tail of the chain and waits until at least MIN_SPACING_MS has
 * elapsed since the previous one STARTED. This is per-process, so on serverless N instances
 * give N req/s — which is why the Postgres-backed `musicbrainzOutbound` budget (45/60s) is
 * the real global control and this queue is the local one. Both are needed: the budget stops
 * the fleet, the queue stops one instance from bursting.
 */
let tail: Promise<unknown> = Promise.resolve();
let lastStartedAt = 0;

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(async () => {
    const wait = Math.max(0, lastStartedAt + MIN_SPACING_MS - Date.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastStartedAt = Date.now();
    return work();
  });
  // Keep the chain alive even when a link rejects, or one failure stalls the queue forever.
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/* -------------------------------------------------------------------------- */
/* Types (transcribed from captured payloads, not from documentation)          */
/* -------------------------------------------------------------------------- */

export type MbRating = { value?: number | null; "votes-count"?: number | null };
export type MbTag = { name: string; count?: number | null };
export type MbGenre = MbTag;

export type MbArtistCredit = { name?: string; artist?: { id: string; name: string } };

export type MbReleaseGroup = {
  id: string;
  title: string;
  "first-release-date"?: string | null;
  "primary-type"?: string | null;
  "secondary-types"?: string[] | null;
  rating?: MbRating | null;
  genres?: MbGenre[] | null;
  tags?: MbTag[] | null;
  "artist-credit"?: MbArtistCredit[] | null;
  score?: number;
};

export type MbArtist = {
  id: string;
  name: string;
  country?: string | null;
  area?: { name?: string } | null;
  "life-span"?: { begin?: string | null; end?: string | null; ended?: boolean } | null;
  rating?: MbRating | null;
  genres?: MbGenre[] | null;
  tags?: MbTag[] | null;
};

type MbBusy = { error?: string };

/* -------------------------------------------------------------------------- */
/* The client — OPTIONAL ONLY. There is deliberately no throwing export.      */
/* -------------------------------------------------------------------------- */

function userAgent(): string {
  return `Deadwax/0.1.0 ( ${env.siteUrl} )`;
}

async function mbRequest<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const limit = await consume(BUDGETS.musicbrainzOutbound, "all");
  if (!limit.ok) {
    throw new ProviderError("musicbrainz", 429, path, "outbound budget exhausted");
  }

  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set("fmt", "json");
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: { "User-Agent": userAgent(), Accept: "application/json" },
    next: { revalidate: CACHE_SECONDS },
  });

  if (!response.ok) {
    throw new ProviderError("musicbrainz", response.status, path, truncateBody(await response.text().catch(() => "")));
  }

  const payload = (await response.json()) as T & MbBusy;

  // The in-200/503 body. Their "currently busy" response is an ordinary JSON object with an
  // `error` string, so it must be detected in the payload rather than by status alone.
  if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
    const busy = /busy/i.test(payload.error);
    throw new ProviderError("musicbrainz", busy ? 503 : 404, path, truncateBody(payload.error));
  }

  return payload as T;
}

async function optional<T>(path: string, params: Record<string, string | number | undefined>): Promise<T | null> {
  try {
    return await enqueue(() => mbRequest<T>(path, params));
  } catch (error) {
    // Deliberately quiet at info level: a busy MusicBrainz is the normal case, not an
    // incident, and logging it as a warning on every album view would train the operator to
    // ignore warnings.
    console.info("[musicbrainz] skipped —", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Lookup by release-group MBID, with everything the enrichment needs in one request. */
export function getReleaseGroup(mbid: string): Promise<MbReleaseGroup | null> {
  return optional<MbReleaseGroup>(`/release-group/${encodeURIComponent(mbid)}`, {
    inc: "artists+ratings+genres+tags",
  });
}

export function getArtist(mbid: string): Promise<MbArtist | null> {
  return optional<MbArtist>(`/artist/${encodeURIComponent(mbid)}`, { inc: "ratings+genres+tags" });
}

/**
 * Resolve a Deezer album to a MusicBrainz release group by artist + title.
 *
 * `release:"..."` rather than `releasegroup:"..."` because it matches reissue titles back to
 * the original group — verified: querying `release:"OK Computer OKNOTOK" AND
 * artistname:Radiohead` returns the release group "OK Computer" with first-release-date
 * 1997-05-21, which is exactly the reissue-trap fix we want and is why the resolution is done
 * this way round.
 */
export async function findReleaseGroup(artistName: string, title: string): Promise<MbReleaseGroup | null> {
  const clean = (value: string) => value.replace(/["\\]/g, " ").trim();
  const query = `release:"${clean(title)}" AND artistname:"${clean(artistName)}"`;
  const result = await optional<{ "release-groups"?: MbReleaseGroup[] }>("/release-group", { query, limit: 5 });
  const groups = result?.["release-groups"] ?? [];
  if (groups.length === 0) return null;

  // Prefer an exact-ish title match on a primary-type Album, then fall back to the top score.
  const target = clean(title).toLowerCase();
  const scored = [...groups].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const exact = scored.find((group) => group.title.toLowerCase() === target && group["primary-type"] === "Album");
  return exact ?? scored[0] ?? null;
}

export const MUSICBRAINZ_TTL_MS = CACHE_SECONDS * 1000;

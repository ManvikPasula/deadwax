import "server-only";

import { env } from "@/lib/env";
import { BUDGETS, consume } from "@/lib/security/rate-limit";

/**
 * Last.fm — OPTIONAL, env-gated, and it degrades to absent rather than to wrong.
 *
 * WHAT A KEY BUYS:
 *
 *  1. `listeners` — the true equivalent of TMDB's `vote_count`, and therefore of the
 *     onboarding familiarity heuristic. The brief's principle is worth quoting because it is
 *     the whole argument: "Popularity is whatever aired this week; vote count is how many
 *     people ever bothered to rate it, which is the closest thing to household familiarity the
 *     data has." A cumulative listener count is that; a streaming chart is not.
 *  2. `artist.getSimilar` — a SECOND neighbour source, genuinely co-listening derived, which
 *     the brief ranks above every alternative including Deezer's.
 *
 * WITHOUT A KEY: familiarity falls back to Deezer `fans` over a curated seed, and the
 * neighbour graph runs on Deezer alone. Both are real answers, which is why this is optional
 * rather than required.
 */

const BASE_URL = "https://ws.audioscrobbler.com/2.0/";

export type LastfmSimilarArtist = { name: string; match?: string };
export type LastfmAlbumInfo = { listeners: number; playcount: number; tags: string[] };

export function lastfmConfigured(): boolean {
  return Boolean(env.lastfmApiKey);
}

async function call<T>(params: Record<string, string>): Promise<T | null> {
  const key = env.lastfmApiKey;
  if (!key) return null;

  const limit = await consume(BUDGETS.lastfmOutbound, "all");
  if (!limit.ok) return null;

  const url = new URL(BASE_URL);
  url.searchParams.set("api_key", key);
  url.searchParams.set("format", "json");
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

  try {
    const response = await fetch(url, { next: { revalidate: 60 * 60 * 24 * 7 } });
    if (!response.ok) return null;
    const payload = (await response.json()) as T & { error?: number };
    if (payload && typeof payload === "object" && "error" in payload && payload.error) return null;
    return payload as T;
  } catch {
    // Silent: this provider is a bonus, and a bonus that logs a warning on every page view
    // teaches the operator to ignore warnings.
    return null;
  }
}

/** Cumulative listeners and playcount — the familiarity proxy. */
export async function albumInfo(artist: string, album: string): Promise<LastfmAlbumInfo | null> {
  type Response = {
    album?: { listeners?: string; playcount?: string; tags?: { tag?: Array<{ name: string }> } | string };
  };
  const result = await call<Response>({ method: "album.getinfo", artist, album, autocorrect: "1" });
  const found = result?.album;
  if (!found) return null;
  const tagList = typeof found.tags === "object" ? (found.tags?.tag ?? []) : [];
  return {
    listeners: Number(found.listeners ?? 0) || 0,
    playcount: Number(found.playcount ?? 0) || 0,
    tags: tagList.map((tag) => tag.name.toLowerCase()).slice(0, 10),
  };
}

/** The second neighbour source. Names only — resolution to local artist rows happens in ingest. */
export async function similarArtists(artist: string, limit = 20): Promise<LastfmSimilarArtist[]> {
  type Response = { similarartists?: { artist?: LastfmSimilarArtist[] } };
  const result = await call<Response>({
    method: "artist.getsimilar",
    artist,
    autocorrect: "1",
    limit: String(limit),
  });
  return result?.similarartists?.artist ?? [];
}

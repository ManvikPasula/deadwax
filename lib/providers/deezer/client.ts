import "server-only";

import { ProviderBudgetError, ProviderError, truncateBody } from "@/lib/providers/errors";
import { BUDGETS, consume } from "@/lib/security/rate-limit";

import type { DeezerErrorBody } from "./types";

/**
 * The single egress point to Deezer.
 *
 * Deezer needs NO API KEY AND NO OAUTH, which is the reason it was chosen over Spotify: no
 * hourly client-credentials token to cache and refresh, and therefore no 401-triggered-retry
 * failure class that the television original does not have.
 *
 * ORDER OF OPERATIONS — the order is the design:
 *
 *  1. BUDGET FIRST, before any network work. One platform-wide counter, not per user and not
 *     per IP, because the provider relationship is the scarce resource: being throttled takes
 *     the catalogue down for everyone.
 *  2. URL assembly. Only the PATH is interpolated and every param goes through
 *     `searchParams.set`, so there is no SSRF surface. `undefined` values are skipped
 *     entirely, which is what lets every endpoint pass optional filters straight through with
 *     no conditional object building.
 *  3. Caching via `next: { revalidate, tags }`.
 *  4. Errors — including the in-200-body kind (see below).
 *  5. A degrading variant with its rule written down.
 */

const BASE_URL = "https://api.deezer.com";

export const CACHE_SECONDS = {
  /** A released tracklist is immutable. The strongest TTL in the system, and deliberately so. */
  albumDetail: 60 * 60 * 24 * 30,
  /** Short enough that a new release shows up in a discography. */
  artistDetail: 60 * 60 * 24,
  /** Charts and genre browse. Slower-moving than "what aired this week". */
  discovery: 60 * 60 * 6,
  search: 60 * 10,
  /** The neighbour graph moves slowly, and it is cached in a table on top of this. */
  similar: 60 * 60 * 24 * 7,
  /** The 28-entry genre vocabulary. */
  static: 60 * 60 * 24 * 7,
} as const;

export const TAGS = {
  album: (id: string | number) => `dz:album:${id}`,
  artist: (id: string | number) => `dz:artist:${id}`,
  discovery: "dz:discovery",
  genres: "dz:genres",
} as const;

type FetchOptions = {
  params?: Record<string, string | number | boolean | undefined>;
  revalidate?: number;
  tags?: string[];
};

/** Deezer's own error type strings, mapped to the HTTP status they should have been. */
function statusForErrorType(type: string | undefined): number {
  switch (type) {
    case "DataException":
      return 404; // "no data" — the thing does not exist
    case "QuotaException":
      return 429;
    case "OAuthException":
    case "Exception":
      return 502;
    default:
      return 502;
  }
}

async function request<T>(path: string, options: FetchOptions, attempt: number): Promise<T> {
  // 1. Budget first.
  const limit = await consume(BUDGETS.deezerOutbound, "all");
  if (!limit.ok) {
    console.warn("[deezer] outbound budget exhausted", { path, count: limit.count, limit: limit.limit });
    throw new ProviderBudgetError("deezer", limit.retryAfterSeconds);
  }

  // 2. URL assembly.
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }

  // 3. Fetch with Next's cache directives.
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    next: { revalidate: options.revalidate ?? CACHE_SECONDS.discovery, tags: options.tags },
  });

  // 4a. Real HTTP errors.
  if (!response.ok) {
    const body = truncateBody(await response.text().catch(() => ""));

    /**
     * Deezer DOES return 429 with a Retry-After header, which the television original
     * honours for TMDB nowhere at all ("there is no retry, no backoff, and no 429 handling
     * anywhere"). One retry is attempted here, and only when the wait is short: a long
     * Retry-After means we are genuinely over budget and blocking a request for it would
     * just move the failure into the user's page-load time.
     */
    if (response.status === 429 && attempt === 0) {
      const after = Number(response.headers.get("retry-after") ?? "0");
      if (Number.isFinite(after) && after > 0 && after <= 2) {
        await new Promise((resolve) => setTimeout(resolve, after * 1000));
        return request<T>(path, options, attempt + 1);
      }
    }

    throw new ProviderError("deezer", response.status, path, body || response.statusText);
  }

  const payload = (await response.json()) as T & DeezerErrorBody;

  // 4b. The in-200-body error. Verified: GET /album/999999999999 returns HTTP 200 with
  //     {"error":{"type":"DataException","message":"no data","code":800}}. Without this
  //     branch, a missing album would flow into the mapper as an object with no title and
  //     land in the database as a row full of nulls.
  if (payload && typeof payload === "object" && "error" in payload && payload.error) {
    const status = statusForErrorType(payload.error.type);
    throw new ProviderError("deezer", status, path, truncateBody(payload.error.message ?? payload.error.type ?? "error"));
  }

  return payload as T;
}

/**
 * The THROWING variant. Use it wherever the caller must distinguish "missing" from "broken" —
 * which means ingest, because a 404 should keep a stale mirror and an outage should too, but
 * a cold 404 must return null rather than creating an empty row.
 */
export function deezerFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  return request<T>(path, options, 0);
}

/**
 * The DEGRADING variant.
 *
 * NEVER USE IT WHERE THE CALLER NEEDS TO DISTINGUISH "MISSING" FROM "BROKEN". Every
 * discovery, search and chart surface uses this and coalesces to an empty list, because a
 * homepage rail that is empty for a minute is better than a homepage that 500s. Album and
 * artist detail use the throwing form.
 */
export async function deezerFetchOptional<T>(path: string, options: FetchOptions = {}): Promise<T | null> {
  try {
    return await request<T>(path, options, 0);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn("[deezer] optional fetch failed —", detail);
    return null;
  }
}

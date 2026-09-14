import "server-only";

import { CACHE_SECONDS, TAGS, deezerFetch, deezerFetchOptional } from "./client";
import type {
  DeezerAlbumDetail,
  DeezerAlbumSummary,
  DeezerArtistDetail,
  DeezerGenre,
  DeezerList,
  DeezerTrack,
} from "./types";

/**
 * Typed Deezer endpoints.
 *
 * The throwing/optional split is not stylistic. Detail reads throw, so ingest can tell a
 * missing album from a broken provider and act differently. Everything discovery-shaped is
 * optional and coalesces to `[]`.
 *
 * ENDPOINT MAP against the television original, for anyone reading the two side by side:
 *   /tv/{id}                  -> GET /album/{id}  +  GET /album/{id}/tracks   (TWO calls; see below)
 *   /tv/{id}/season/{n}       -> (no analogue — collapsed into the album)
 *   /tv/{id}/recommendations  -> GET /artist/{id}/related   (artist-level, so neighbour
 *                                provenance is per-artist rather than per-album)
 *   /trending/tv/week         -> GET /chart/0/albums
 *   /tv/popular               -> GET /chart/{genreId}/albums, or search ordered by RANKING
 *   /tv/top_rated             -> (no analogue: Deezer has no rating. Use fans/rank, labelled
 *                                as popularity, never as quality.)
 *   /tv/airing_today          -> DELETED. No analogue exists and inventing one would lie.
 *   /discover/tv              -> GET /search/album with the q: filter grammar. WEAKER: there
 *                                is no with_genres AND-join, so a two-genre intersection has
 *                                to be post-filtered against the mirrored `genres` jsonb.
 *   /genre/tv/list            -> GET /genre
 */

const PAGE_MAX = 100; // Deezer's own per-request ceiling on list endpoints.

/* -------------------------------------------------------------------------- */
/* Detail — THROWING                                                          */
/* -------------------------------------------------------------------------- */

export function getAlbumDetail(deezerId: string | number): Promise<DeezerAlbumDetail> {
  return deezerFetch<DeezerAlbumDetail>(`/album/${encodeURIComponent(String(deezerId))}`, {
    revalidate: CACHE_SECONDS.albumDetail,
    tags: [TAGS.album(deezerId)],
  });
}

/**
 * The tracklist, and it is a SEPARATE CALL ON PURPOSE.
 *
 * `GET /album/{id}` embeds a tracks array, but that embedded shape omits `track_position`,
 * `disk_number` and `isrc` — verified against Discovery and The Wall. Since
 * (album, disc, track) is a track's addressable identity and a unique index depends on it,
 * the positions cannot be inferred from array order on the primary path.
 *
 * Pages at 100. `total` on the first response tells us whether there are more, so a 26-track
 * double album costs one request and a 180-track box set costs two.
 */
export async function getAlbumTracks(deezerId: string | number, expected?: number): Promise<DeezerTrack[]> {
  const id = encodeURIComponent(String(deezerId));
  const first = await deezerFetch<DeezerList<DeezerTrack>>(`/album/${id}/tracks`, {
    params: { limit: PAGE_MAX, index: 0 },
    revalidate: CACHE_SECONDS.albumDetail,
    tags: [TAGS.album(deezerId)],
  });

  const collected = [...(first.data ?? [])];
  const total = first.total ?? expected ?? collected.length;

  // Sequential, not parallel: a box set should cost a few serial requests rather than a
  // burst that eats the platform-wide budget other members are also drawing on.
  while (collected.length < total && collected.length < 1000) {
    const page = await deezerFetchOptional<DeezerList<DeezerTrack>>(`/album/${id}/tracks`, {
      params: { limit: PAGE_MAX, index: collected.length },
      revalidate: CACHE_SECONDS.albumDetail,
      tags: [TAGS.album(deezerId)],
    });
    const rows = page?.data ?? [];
    if (rows.length === 0) break; // a short page ends the walk
    collected.push(...rows);
  }

  return collected;
}

export function getArtistDetail(deezerId: string | number): Promise<DeezerArtistDetail> {
  return deezerFetch<DeezerArtistDetail>(`/artist/${encodeURIComponent(String(deezerId))}`, {
    revalidate: CACHE_SECONDS.artistDetail,
    tags: [TAGS.artist(deezerId)],
  });
}

/* -------------------------------------------------------------------------- */
/* Discography, similarity, discovery — OPTIONAL                              */
/* -------------------------------------------------------------------------- */

export async function getArtistAlbums(deezerId: string | number, limit = PAGE_MAX): Promise<DeezerAlbumSummary[]> {
  const result = await deezerFetchOptional<DeezerList<DeezerAlbumSummary>>(
    `/artist/${encodeURIComponent(String(deezerId))}/albums`,
    {
      params: { limit: Math.min(limit, PAGE_MAX) },
      revalidate: CACHE_SECONDS.artistDetail,
      // Deliberately ALSO tagged with the artist tag, so purging an artist purges its
      // discography — the same trick the television original uses for seasons under a show.
      tags: [TAGS.artist(deezerId)],
    },
  );
  return result?.data ?? [];
}

/**
 * THE NEIGHBOUR GRAPH.
 *
 * The +0.3..+1.0 neighbour term is the largest single term in the recommender and the reason
 * ranking works at all. Spotify deprecated its equivalent for new applications in late 2024;
 * this one was verified working. Its results are cached into `artist_similar` on top of the
 * HTTP cache, because re-fetching per /for-you render would dominate the outbound budget.
 */
export async function getRelatedArtists(deezerId: string | number, limit = 20): Promise<DeezerArtistDetail[]> {
  const result = await deezerFetchOptional<DeezerList<DeezerArtistDetail>>(
    `/artist/${encodeURIComponent(String(deezerId))}/related`,
    {
      params: { limit: Math.min(limit, PAGE_MAX) },
      revalidate: CACHE_SECONDS.similar,
      tags: [TAGS.artist(deezerId)],
    },
  );
  return result?.data ?? [];
}

export async function getArtistTopTracks(deezerId: string | number, limit = 10): Promise<DeezerTrack[]> {
  const result = await deezerFetchOptional<DeezerList<DeezerTrack>>(
    `/artist/${encodeURIComponent(String(deezerId))}/top`,
    { params: { limit: Math.min(limit, PAGE_MAX) }, revalidate: CACHE_SECONDS.artistDetail },
  );
  return result?.data ?? [];
}

/**
 * Search.
 *
 * `order: "RANKING"` is Deezer's relevance-plus-popularity sort. There is no vote-count floor
 * to pass (Deezer has no votes), so the notability filter happens later, against the mirrored
 * `fans` column — which is a notability signal, not a quality one.
 *
 * Requests `limit + 1` so a full window is distinguishable from the end of the results. This
 * is also why the original's 20-into-24 page stitching is not ported: Deezer accepts an
 * arbitrary `limit`, so the whole `windowBounds`/`maxWindowPage` apparatus disappears.
 */
export async function searchAlbums(query: string, limit = 25, index = 0): Promise<DeezerAlbumSummary[]> {
  if (!query.trim()) return [];
  const result = await deezerFetchOptional<DeezerList<DeezerAlbumSummary>>("/search/album", {
    params: { q: query, limit: Math.min(limit, PAGE_MAX), index, order: "RANKING" },
    revalidate: CACHE_SECONDS.search,
  });
  return result?.data ?? [];
}

export async function searchArtists(query: string, limit = 25, index = 0): Promise<DeezerArtistDetail[]> {
  if (!query.trim()) return [];
  const result = await deezerFetchOptional<DeezerList<DeezerArtistDetail>>("/search/artist", {
    params: { q: query, limit: Math.min(limit, PAGE_MAX), index, order: "RANKING" },
    revalidate: CACHE_SECONDS.search,
  });
  return result?.data ?? [];
}

/**
 * Deezer's advanced search grammar: `artist:"X" album:"Y"`.
 *
 * Used by the seed and by album-identity resolution, where a title alone is ambiguous — there
 * are dozens of albums called "Greatest Hits".
 */
export function searchAlbumByArtistTitle(artist: string, title: string, limit = 5): Promise<DeezerAlbumSummary[]> {
  const quoted = `artist:"${artist.replace(/"/g, "")}" album:"${title.replace(/"/g, "")}"`;
  return searchAlbums(quoted, limit);
}

/** genreId 0 is "All". Verified 28 top-level genres. */
export async function chartAlbums(genreId = 0, limit = 25, index = 0): Promise<DeezerAlbumSummary[]> {
  const result = await deezerFetchOptional<DeezerList<DeezerAlbumSummary>>(`/chart/${genreId}/albums`, {
    params: { limit: Math.min(limit, PAGE_MAX), index },
    revalidate: CACHE_SECONDS.discovery,
    tags: [TAGS.discovery],
  });
  return result?.data ?? [];
}

export async function chartArtists(genreId = 0, limit = 25): Promise<DeezerArtistDetail[]> {
  const result = await deezerFetchOptional<DeezerList<DeezerArtistDetail>>(`/chart/${genreId}/artists`, {
    params: { limit: Math.min(limit, PAGE_MAX) },
    revalidate: CACHE_SECONDS.discovery,
    tags: [TAGS.discovery],
  });
  return result?.data ?? [];
}

export async function genreArtists(genreId: number, limit = 25): Promise<DeezerArtistDetail[]> {
  const result = await deezerFetchOptional<DeezerList<DeezerArtistDetail>>(`/genre/${genreId}/artists`, {
    params: { limit: Math.min(limit, PAGE_MAX) },
    revalidate: CACHE_SECONDS.discovery,
    tags: [TAGS.discovery],
  });
  return result?.data ?? [];
}

/**
 * The genre vocabulary, cached for a week.
 *
 * This is load-bearing, not a nicety. Album summaries carry `genre_id` but not always a
 * `genres` array, and a summary cached without genre NAMES is an album the recommender cannot
 * see at all. The television original measured the cost of getting this wrong: 370 of 433
 * mirrored shows — 85% — had no genres, and every one of them was unrankable.
 */
export async function getGenres(): Promise<DeezerGenre[]> {
  const result = await deezerFetchOptional<DeezerList<DeezerGenre>>("/genre", {
    revalidate: CACHE_SECONDS.static,
    tags: [TAGS.genres],
  });
  return (result?.data ?? []).filter((genre) => genre.id !== 0);
}

/**
 * Signed-out home rails. DELIBERATELY NOT the most popular genres — Pop and Rap/Hip Hop would
 * fill the page with the same records the chart rail already has.
 *
 * Ids verified against GET /genre: 85 Alternative, 129 Jazz, 106 Electro, 464 Metal.
 */
export const DEFAULT_GENRE_IDS = [85, 129, 106, 464] as const;
export const DEFAULT_GENRES = ["Alternative", "Jazz", "Electro", "Metal"] as const;

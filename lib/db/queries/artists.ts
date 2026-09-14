import "server-only";

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { albums, artistSimilar, artists, tracks } from "@/lib/db/schema";
import { containsPattern, startsWithPattern } from "@/lib/like";
import { averageRating, meterPercent } from "@/lib/ratings";
import { albumSlug } from "@/lib/slug";

import {
  albumTrackKey,
  buildHeatCells,
  getAlbumsByIds,
  getCrownedTracks,
  getTrackAggregates,
  getViewerAlbumOverlay,
  getViewerTrackRatings,
  type AlbumRow,
  type HeatCell,
} from "./albums";

/**
 * Every read path over artists, the sixth `DISTINCT ON` aggregate, and the payload for the
 * signature view.
 *
 * The runtime dependency is ONE-WAY: this file imports from ./albums, never the reverse. That
 * is why the album projection, the heat-cell vocabulary and the viewer overlays live there and
 * are reused here, rather than being duplicated or lifted into a third module that neither
 * page would import directly.
 *
 * The aggregate contract, the guest filter, the rated-first tiebreak and the two driver traps
 * around `::int` and raw `date` values are all documented at length in ./albums. Read that
 * docblock before editing `getAlbumAggregates` here: it is the sixth of six variants and
 * NOTHING CENTRALISES THE PATTERN, so a fix applied to one of them and not the others makes a
 * rating vanish from one surface while persisting on another.
 */

/* -------------------------------------------------------------------------- */
/* Row shapes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * THIS TYPE AND `artistRowColumns` MUST BE EDITED TOGETHER.
 *
 * `beganOn` and `endedOn` are STRINGS: Drizzle maps `date` to a string and `timestamptz` to a
 * `Date`, and mixing them silently produces "Invalid Date" (I-9). Neither `synced_at` nor
 * `mbSyncedAt` is projected — a read path has no business making a staleness decision, which
 * belongs to lib/ingest/albums.ts and nowhere else.
 */
export type ArtistRow = {
  id: number;
  deezerId: string;
  mbid: string | null;
  name: string;
  slug: string;
  picturePath: string | null;
  bio: string | null;
  country: string | null;
  beganOn: string | null;
  endedOn: string | null;
  genres: string[];
  tags: string[];
  /** POPULARITY, not quality. Feeds retrieval, the notability floor and tiebreaks only. */
  fans: number;
  albumCount: number;
  /**
   * MusicBrainz, ALREADY on the stored 0..10 scale. Probing found artists carry real ratings
   * (Radiohead: 4.5 over 80 votes), so the artist page shows a genuine attributed baseline
   * rather than a mean of that artist's rated albums wearing an artist's label.
   */
  criticScore: number | null;
  criticVotes: number;
  isActive: boolean;
};

/** Edited together with `ArtistRow`. */
const artistRowColumns = {
  id: artists.id,
  deezerId: artists.deezerId,
  mbid: artists.mbid,
  name: artists.name,
  slug: artists.slug,
  picturePath: artists.picturePath,
  bio: artists.bio,
  country: artists.country,
  beganOn: artists.beganOn,
  endedOn: artists.endedOn,
  genres: artists.genres,
  tags: artists.tags,
  fans: artists.fans,
  albumCount: artists.albumCount,
  criticScore: artists.criticScore,
  criticVotes: artists.criticVotes,
  isActive: artists.isActive,
} as const;

/** `IN (${idList(ids)})`. Every caller guards the empty array first: `IN ()` is invalid SQL. */
function idList(ids: number[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

function toIds(input: number | number[]): number[] {
  return [...new Set(Array.isArray(input) ? input : [input])];
}

/* ========================================================================== *
 * VARIANT 3 — getAlbumAggregates: DISTINCT ON (user_id, album_id)
 * ========================================================================== */

export type AlbumAggregate = {
  albumId: number;
  average: number | null;
  ratingCount: number;
};

/**
 * Community album averages for one artist's whole catalogue, keyed by album id. THIS FEEDS THE
 * DISCOGRAPHY GRID.
 *
 * Anchored on `logs.artist_id` rather than joined through `albums`, because `artist_id` is the
 * always-present anchor and is RESOLVED SERVER-SIDE FROM THE ALBUM ROW on every album log, so
 * the two are equivalent and this way uses `logs_artist_target_idx` directly.
 *
 * DELIBERATELY NOT FILTERED ON `is_canonical`. This returns a map keyed by album id and the
 * caller decides which keys it looks up, so a non-canonical key is inert here — and the same
 * map also serves `/artist/[slug]/albums`, which exists precisely to show the singles, EPs and
 * compilations the heatmap excludes. The exclusion belongs to the row list, not to the
 * aggregate.
 *
 * The three load-bearing details are commented inline. The rated-first tiebreak is absent for
 * the same reason as in `getTrackAggregates`: `rating IS NOT NULL` is already in the WHERE, so
 * the newest surviving row is by construction the newest rated one. Relax that filter and you
 * must add the tiebreak back in the same edit (I-11).
 */
export async function getAlbumAggregates(artistId: number): Promise<Map<number, AlbumAggregate>> {
  const result = await db.execute<{ album_id: number; rating: number; count: number }>(sql`
    WITH scoped AS (
      SELECT DISTINCT ON (l.user_id, l.album_id) l.user_id, l.album_id, l.rating
      FROM logs l
      JOIN users u ON u.id = l.user_id
      WHERE l.target_type = 'album'
        AND l.artist_id = ${artistId}
        AND l.album_id IS NOT NULL
        AND l.disc_number IS NULL    -- an omitted ordinal is an explicit IS NULL, or this
        AND l.track_number IS NULL   -- sweeps in every track row on every album
        AND l.rating IS NOT NULL
        AND u.is_guest = false       -- I-12: no database-level guard exists
      ORDER BY l.user_id, l.album_id, l.created_at DESC
    )
    SELECT album_id, rating, COUNT(*)::int AS count
    FROM scoped
    GROUP BY album_id, rating
  `);

  const buckets = new Map<number, Array<{ value: number; count: number }>>();
  for (const row of result.rows) {
    const list = buckets.get(row.album_id);
    if (list) list.push({ value: row.rating, count: row.count });
    else buckets.set(row.album_id, [{ value: row.rating, count: row.count }]);
  }

  const out = new Map<number, AlbumAggregate>();
  for (const [albumId, list] of buckets) {
    out.set(albumId, {
      albumId,
      // In TypeScript, as a genuine weighted mean — never SQL AVG. See ./albums.
      average: averageRating(list),
      ratingCount: list.reduce((total, bucket) => total + bucket.count, 0),
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Detail reads                                                               */
/* -------------------------------------------------------------------------- */

/** An album in a discography listing, with the community figures the row shows. */
export type DiscographyAlbum = AlbumRow & {
  memberAverage: number | null;
  memberCount: number;
  viewerRating: number | null;
  replayCount: number;
};

export type ArtistWithAlbums = {
  artist: ArtistRow;
  /** Canonical releases only, chronological. See `getArtistDiscography` for the full list. */
  albums: DiscographyAlbum[];
};

/**
 * The artist page's own payload: the artist row plus their canonical discography with member
 * figures already attached, so the page never assembles an average itself.
 */
export async function getArtistWithAlbums(artistId: number, viewerId?: number | null): Promise<ArtistWithAlbums | null> {
  const [artist] = await db.select(artistRowColumns).from(artists).where(eq(artists.id, artistId)).limit(1);
  if (!artist) return null;
  return { artist, albums: await getArtistDiscography(artistId, { viewerId }) };
}

export const DISCOGRAPHY_SORTS = ["chronological", "newest", "rated", "popular", "title"] as const;
export type DiscographySort = (typeof DISCOGRAPHY_SORTS)[number];

export function parseDiscographySort(value: string | undefined | null): DiscographySort {
  return (DISCOGRAPHY_SORTS as readonly string[]).includes(value ?? "")
    ? (value as DiscographySort)
    : "chronological";
}

export type DiscographyOptions = {
  viewerId?: number | null;
  sort?: DiscographySort;
  /** `/artist/[slug]/albums?type=…` passes true so singles, EPs and compilations appear. */
  includeNonCanonical?: boolean;
  /** A Deezer `record_type`: album | single | ep | compilation. */
  recordType?: string | null;
  limit?: number;
};

/**
 * One artist's releases with the community and viewer figures attached.
 *
 * CHRONOLOGICAL MEANS `original_release_date ?? release_date`, ASCENDING. The first-release
 * date is the one that tells the truth about a catalogue: order by the Deezer `release_date`
 * alone and every remaster jumps to the end of the discography, which is the single most common
 * way a music catalogue lies about itself. `NULLS LAST` because an undated row is almost always
 * an announced-but-unreleased record, and putting it before the debut album inverts the arc the
 * page exists to draw.
 *
 * `rated` sorts by the member average with NULLS LAST rather than treating an unrated album as
 * a zero — a zero would be a measured verdict, and there is no zero on this scale.
 */
export async function getArtistDiscography(
  artistId: number,
  options: DiscographyOptions = {},
): Promise<DiscographyAlbum[]> {
  const conditions: SQL[] = [sql`${albums.artistId} = ${artistId}`];

  if (!options.includeNonCanonical) {
    // albums.is_canonical — the "specials" exclusion. A non-canonical release must never enter
    // a completion denominator, a discography heatmap row, or a recommendation pool. COPY THIS
    // COMMENT next to any new query that filters on it; the television version's
    // `season_number > 0` was pasted into three CTEs precisely because it is easy to omit in a
    // fourth — and the failure mode is silent: a deluxe edition's bonus tracks substitute for
    // real ones and mark a discography complete.
    conditions.push(sql`${albums.isCanonical} = true`);
  }
  if (options.recordType) {
    conditions.push(sql`${albums.recordType} = ${options.recordType}`);
  }

  // Only the ids, in chronological order: the display columns come from `getAlbumsByIds`, which
  // returns rows IN THE ORDER THE IDS WERE GIVEN, so the ordering decided here survives.
  const rows = await db
    .select({ id: albums.id })
    .from(albums)
    .where(and(...conditions))
    .orderBy(
      sql`coalesce(${albums.originalReleaseDate}, ${albums.releaseDate}) ASC NULLS LAST`,
      sql`${albums.id} ASC`,
    )
    .limit(options.limit ?? 500);

  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return [];

  const [albumRows, aggregates, overlay] = await Promise.all([
    getAlbumsByIds(ids),
    getAlbumAggregates(artistId),
    getViewerAlbumOverlay(options.viewerId, ids),
  ]);

  const merged: DiscographyAlbum[] = albumRows.map((row) => {
    const aggregate = aggregates.get(row.id);
    const seen = overlay.get(row.id);
    return {
      ...row,
      memberAverage: aggregate?.average ?? null,
      memberCount: aggregate?.ratingCount ?? 0,
      viewerRating: seen?.rating ?? null,
      replayCount: seen?.plays ?? 0,
    };
  });

  const sort = options.sort ?? "chronological";
  if (sort === "chronological") return merged; // already ordered by the statement above

  // The remaining orders are applied in TypeScript because two of the three sort on figures
  // that do not exist in SQL — the member average is computed here, not by AVG. The list is one
  // artist's releases, so it is tens of rows and sorting it in memory costs nothing.
  const dated = (row: DiscographyAlbum) => row.originalReleaseDate ?? row.releaseDate ?? "";
  const sorted = [...merged];
  switch (sort) {
    case "newest":
      sorted.sort((left, right) => dated(right).localeCompare(dated(left)) || right.id - left.id);
      break;
    case "rated":
      sorted.sort(
        (left, right) =>
          (right.memberAverage ?? -1) - (left.memberAverage ?? -1) ||
          right.memberCount - left.memberCount ||
          right.fans - left.fans,
      );
      break;
    case "popular":
      sorted.sort((left, right) => right.popularity - left.popularity || right.fans - left.fans);
      break;
    case "title":
      sorted.sort((left, right) => left.title.localeCompare(right.title));
      break;
  }
  return sorted;
}

/**
 * The cached neighbour graph, for the "listeners also play" rail.
 *
 * Ordered by `position`, which is the provider's own relatedness order — re-sorting it by fans
 * was the rejected alternative, because it turns a similarity list into a popularity list and
 * every artist's neighbours become the same five household names.
 */
export async function getSimilarArtists(artistId: number, limit = 12): Promise<ArtistRow[]> {
  // `position` is ordered on but not selected: it is provenance, not something a card renders.
  return db
    .select(artistRowColumns)
    .from(artistSimilar)
    .innerJoin(artists, eq(artists.id, artistSimilar.similarId))
    .where(eq(artistSimilar.artistId, artistId))
    .orderBy(asc(artistSimilar.position))
    .limit(limit);
}

/* -------------------------------------------------------------------------- */
/* THE SIGNATURE VIEW — the discography heatmap                               */
/* -------------------------------------------------------------------------- */

export type DiscographyHeatmapRow = {
  albumId: number;
  title: string;
  /** `/album/<slug>-<id>`. Built with the same helper the cards use, so a row label and a card
   *  link can never point at different URLs for the same record. */
  href: string;
  /** The mono year in the row gutter. NULL for an undated release. */
  year: string | null;
  coverPath: string | null;
  /**
   * Needed by the cell links: a cell's href is
   * `${row.href}/track/${trackLocator({ disc, track, discCount: row.discCount })}`, and the
   * locator drops the redundant "1-" only when `discCount === 1`.
   */
  discCount: number;
  cells: HeatCell[];
};

/**
 * THE PAYLOAD FOR THE SIGNATURE VIEW: one row per canonical album, one cell per track.
 *
 * This is the true analogue of "the shape of the run", and the product's thesis feature: it
 * draws a career arc — the sophomore slump, the late return to form — which has no clean
 * television equivalent.
 *
 * FOUR PROPERTIES, ALL LOAD-BEARING:
 *
 *  1. `is_canonical = true`. albums.is_canonical is the "specials" exclusion. A non-canonical
 *     release must never enter a completion denominator, a discography heatmap row, or a
 *     recommendation pool. COPY THIS COMMENT next to any new query that filters on it; the
 *     television version's `season_number > 0` was pasted into three CTEs precisely because it
 *     is easy to omit in a fourth. Here the failure is visible and ugly: a deluxe edition sits
 *     beside the album it duplicates with the same nine cells twice.
 *  2. ROWS ARE CHRONOLOGICAL BY `original_release_date ?? release_date`. Ordering by the Deezer
 *     release date alone puts every remaster at the end of the career.
 *  3. CELLS ARE ORDERED BY `(disc_number, track_number)` — the addressable identity of a track,
 *     not the row id, which follows whatever order the provider returned.
 *  4. ROWS STAY RAGGED. A 22-track double LP beside a 4-track EP is not padded to the widest
 *     row, because padding implies tracks that do not exist. Television seasons are roughly
 *     uniform and music albums are not, which is the one place this view is harder than its
 *     source.
 *
 * FOUR QUERIES TOTAL, whatever the discography's size: albums, tracks, community aggregates,
 * viewer overlay. The rejected alternative was per-album aggregation, which on a thirty-album
 * catalogue is sixty statements to draw one grid.
 */
export async function getDiscographyHeatmap(
  artistId: number,
  viewerId?: number | null,
): Promise<DiscographyHeatmapRow[]> {
  const albumRows = await db
    .select({
      id: albums.id,
      title: albums.title,
      coverPath: albums.coverPath,
      discCount: albums.discCount,
      dated: sql<string | null>`coalesce(${albums.originalReleaseDate}, ${albums.releaseDate})`,
    })
    .from(albums)
    // albums.is_canonical — the "specials" exclusion. A non-canonical release must never enter
    // a completion denominator, a discography heatmap row, or a recommendation pool. COPY THIS
    // COMMENT next to any new query that filters on it; the television version's
    // `season_number > 0` was pasted into three CTEs precisely because it is easy to omit in a
    // fourth.
    .where(and(eq(albums.artistId, artistId), eq(albums.isCanonical, true)))
    .orderBy(
      sql`coalesce(${albums.originalReleaseDate}, ${albums.releaseDate}) ASC NULLS LAST`,
      sql`${albums.id} ASC`,
    );

  const ids = albumRows.map((row) => row.id);
  if (ids.length === 0) return []; // the caller renders "Track data has not been mirrored yet."

  const [trackRows, aggregates, viewerRatings, crowned] = await Promise.all([
    db
      .select({
        albumId: tracks.albumId,
        discNumber: tracks.discNumber,
        trackNumber: tracks.trackNumber,
        title: tracks.title,
        criticScore: tracks.criticScore,
      })
      .from(tracks)
      .where(inArray(tracks.albumId, ids))
      .orderBy(asc(tracks.albumId), asc(tracks.discNumber), asc(tracks.trackNumber)),
    getTrackAggregates(ids),
    getViewerTrackRatings(viewerId, ids),
    getCrownedTracks(viewerId, ids),
  ]);

  const byAlbum = new Map<number, typeof trackRows>();
  for (const track of trackRows) {
    const list = byAlbum.get(track.albumId);
    if (list) list.push(track);
    else byAlbum.set(track.albumId, [track]);
  }

  return albumRows.flatMap((album) => {
    const albumTracks = byAlbum.get(album.id);
    // An album whose tracklist has not been mirrored yet contributes NO ROW rather than an
    // empty one: an empty row reads as "we checked and this album has no tracks", which is a
    // claim about the record instead of a statement about our mirror.
    if (!albumTracks || albumTracks.length === 0) return [];
    return [
      {
        albumId: album.id,
        title: album.title,
        href: `/album/${albumSlug(album.title, album.id)}`,
        year: album.dated ? album.dated.slice(0, 4) : null,
        coverPath: album.coverPath,
        discCount: album.discCount,
        cells: buildHeatCells(album.id, albumTracks, aggregates, viewerRatings, crowned),
      },
    ];
  });
}

/* -------------------------------------------------------------------------- */
/* Discography completion — the second replacement for "progress"             */
/* -------------------------------------------------------------------------- */

/**
 * CLAMPING IS MORE NECESSARY HERE THAN IN TELEVISION, and this is the reason.
 *
 * A release group genuinely carries different track counts across its editions — single,
 * deluxe, remaster, regional pressing — and a member's logs are addressed by (disc, track)
 * position, not by track row. So a listener who played the 2011 remaster and then the original
 * can LEGITIMATELY hold more logged positions than the canonical edition has tracks. The logs
 * are correct; only the denominator is from one edition. "63 of 62" reads as a bug even when
 * nothing is wrong, so the numerator is clamped to the denominator.
 *
 * `total > 0` is the guard that keeps an unmirrored tracklist from reporting completion: an
 * album with zero known tracks can never be complete, and clamping to zero would report every
 * play as none.
 */
export function clampListened(listened: number, total: number): number {
  return total > 0 ? Math.min(listened, total) : listened;
}

export type Completion = {
  /** Canonical releases in the discography. The denominator the interface quotes. */
  albums: number;
  albumsStarted: number;
  albumsComplete: number;
  /** SUM(track_count) over canonical albums. Zero when nothing has been mirrored. */
  tracks: number;
  /** Clamped per album before summing, so one over-logged edition cannot inflate the total. */
  tracksListened: number;
  /** 0..100, clamped, for a meter. */
  percent: number;
  perAlbum: Map<number, { trackCount: number; listened: number; complete: boolean }>;
};

/**
 * Discography completion — the artist-level replacement for television's progress bar.
 *
 * This is where a completion denominator still means something in music: "9 of 11 studio
 * albums". The non-canonical exclusion does the work `season_number > 0` used to do, and it
 * does it in the `canonical` CTE below so every figure this function returns shares one
 * denominator.
 *
 * `DISTINCT` IS THE LOAD-BEARING WORD in the `listened` CTE: a replay is a new row, so without
 * it a member who played one track four times would be four tracks into the album. It is
 * `DISTINCT` rather than `DISTINCT ON` because nothing is being chosen — only counted — and
 * there is no guest filter because this is one member's own progress, never consensus.
 */
export async function getCompletion(userId: number, artistId: number): Promise<Completion> {
  const result = await db.execute<{ album_id: number; track_count: number; listened_count: number }>(sql`
    WITH canonical AS (
      SELECT a.id, a.track_count
      FROM albums a
      -- albums.is_canonical — the "specials" exclusion. A non-canonical release must never
      -- enter a completion denominator, a discography heatmap row, or a recommendation pool.
      -- COPY THIS COMMENT next to any new query that filters on it; the television version's
      -- "season_number > 0" was pasted into three CTEs precisely because it is easy to omit in
      -- a fourth, and nine specials marking an unfinished show finished is exactly what a
      -- deluxe edition's bonus tracks do to a discography.
      WHERE a.artist_id = ${artistId} AND a.is_canonical = true
    ),
    listened AS (
      -- DISTINCT: a replay must not count twice.
      SELECT DISTINCT l.album_id, l.disc_number, l.track_number
      FROM logs l
      WHERE l.user_id = ${userId}
        AND l.target_type = 'track'
        AND l.disc_number IS NOT NULL
        AND l.track_number IS NOT NULL
        AND l.album_id IN (SELECT id FROM canonical)
    ),
    per_album AS (
      SELECT album_id, COUNT(*)::int AS listened_count
      FROM listened
      GROUP BY album_id
    )
    SELECT c.id AS album_id,
           c.track_count,
           COALESCE(p.listened_count, 0)::int AS listened_count
    FROM canonical c
    LEFT JOIN per_album p ON p.album_id = c.id
  `);

  const perAlbum = new Map<number, { trackCount: number; listened: number; complete: boolean }>();
  let tracks = 0;
  let tracksListened = 0;
  let albumsStarted = 0;
  let albumsComplete = 0;

  for (const row of result.rows) {
    const listened = clampListened(row.listened_count, row.track_count);
    const complete = row.track_count > 0 && listened >= row.track_count;
    perAlbum.set(row.album_id, { trackCount: row.track_count, listened, complete });
    tracks += row.track_count;
    tracksListened += listened;
    if (listened > 0) albumsStarted += 1;
    if (complete) albumsComplete += 1;
  }

  return {
    albums: result.rows.length,
    albumsStarted,
    albumsComplete,
    tracks,
    tracksListened,
    // Clamped inside `meterPercent` as well, so a mirror lagging behind the provider cannot
    // report 104%.
    percent: meterPercent(tracksListened, tracks),
    perAlbum,
  };
}

/* -------------------------------------------------------------------------- */
/* Browse                                                                     */
/* -------------------------------------------------------------------------- */

export const ARTIST_SORTS = ["popular", "name", "albums"] as const;
export type ArtistSort = (typeof ARTIST_SORTS)[number];

/** The whitelist. A sort key never reaches SQL as text — it selects a branch. */
export function parseArtistSort(value: string | undefined | null): ArtistSort {
  return (ARTIST_SORTS as readonly string[]).includes(value ?? "") ? (value as ArtistSort) : "popular";
}

export type BrowseArtistsOptions = {
  genre?: string | null;
  sort?: ArtistSort;
  page?: number;
  perPage?: number;
};

export type BrowseResult<T> = { rows: T[]; page: number; hasMore: boolean };

/**
 * The /artists grid. Same pagination contract as `browseAlbums`: `perPage + 1` rows, one past
 * the window, no `COUNT(*)`.
 *
 * THERE IS NO `is_canonical` EQUIVALENT FOR ARTISTS and none is invented. The nearest
 * temptation is a `fans` floor to hide stub rows, and it is rejected: `fans` is popularity, so
 * a floor would quietly make the browse page a chart and an obscure artist with a real
 * discography unreachable by browsing. The recommender applies `MIN_NOTABILITY_FANS` because
 * ranking needs a notability signal; browsing does not.
 */
export async function browseArtists(options: BrowseArtistsOptions = {}): Promise<BrowseResult<ArtistRow>> {
  const perPage = options.perPage ?? 24;
  const page = Math.max(1, options.page ?? 1);
  const sort = options.sort ?? "popular";

  const conditions: SQL[] = [];
  if (options.genre) {
    // jsonb containment against a one-element array; exact, case-sensitive name matching,
    // because the genre vocabulary is Deezer's fixed list resolved to names at ingest.
    conditions.push(sql`${artists.genres} @> ${JSON.stringify([options.genre])}::jsonb`);
  }

  const rows = await db
    .select(artistRowColumns)
    .from(artists)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...artistOrder(sort))
    .limit(perPage + 1)
    .offset((page - 1) * perPage);

  return { rows: rows.slice(0, perPage), page, hasMore: rows.length > perPage };
}

/**
 * Every ordering ends in `artists.id DESC`: without a unique final key two artists with equal
 * fan counts can swap between page 1 and page 2, and one of them is never shown.
 */
function artistOrder(sort: ArtistSort): SQL[] {
  switch (sort) {
    case "name":
      return [sql`lower(${artists.name}) ASC`, sql`${artists.id} DESC`];
    case "albums":
      return [sql`${artists.albumCount} DESC`, sql`${artists.fans} DESC`, sql`${artists.id} DESC`];
    case "popular":
    default:
      return [sql`${artists.fans} DESC`, sql`${artists.id} DESC`];
  }
}

/* -------------------------------------------------------------------------- */
/* Search and id lookups                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Local artist search. ROUTED THROUGH `containsPattern` (I-6) — without it a raw `%` matches
 * every row and `/search?q=%` returns the whole catalogue, and a name containing `_` or `%`
 * can never be found by typing it.
 *
 * A prefix match leads, so searching "Boards" finds Boards of Canada rather than whichever
 * more popular artist merely contains the string.
 */
export async function searchLocalArtists(query: string, limit = 24): Promise<ArtistRow[]> {
  const term = query.trim();
  if (term.length === 0) return [];

  const contains = containsPattern(term);
  const prefix = startsWithPattern(term);

  return db
    .select(artistRowColumns)
    .from(artists)
    .where(sql`${artists.name} ILIKE ${contains}`)
    .orderBy(sql`(${artists.name} ILIKE ${prefix}) DESC`, sql`${artists.fans} DESC`, sql`${artists.id} DESC`)
    .limit(limit);
}

/**
 * Returns rows IN THE ORDER THE IDS WERE GIVEN, because every caller has already ranked them
 * and the database's natural order would silently discard that ranking. Missing ids are
 * dropped rather than returned as holes.
 */
export async function getArtistsByIds(ids: number[]): Promise<ArtistRow[]> {
  const unique = toIds(ids);
  if (unique.length === 0) return []; // `IN ()` is invalid SQL
  const rows = await db.select(artistRowColumns).from(artists).where(inArray(artists.id, unique));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/**
 * Artist album counts from the MIRROR rather than from `artists.album_count`, which is Deezer's
 * own figure and counts releases we have never mirrored.
 *
 * Both numbers are true and they answer different questions, which is why this exists rather
 * than overwriting the column: the provider's count belongs on the artist page ("14 releases"),
 * and this one belongs anywhere a link is offered, because linking to a discography of eleven
 * rows under a label reading fourteen is the kind of small lie that makes a whole page
 * untrustworthy.
 */
export async function getMirroredAlbumCounts(artistIds: number[]): Promise<Map<number, number>> {
  const ids = toIds(artistIds);
  if (ids.length === 0) return new Map();
  const result = await db.execute<{ artist_id: number; canonical: number; total: number }>(sql`
    SELECT a.artist_id,
           COUNT(*) FILTER (WHERE a.is_canonical)::int AS canonical,
           COUNT(*)::int                              AS total
    FROM albums a
    WHERE a.artist_id IN (${idList(ids)})
    GROUP BY a.artist_id
  `);
  // The canonical count is the one returned: it is the denominator the completion figure and
  // the heatmap both use, and three numbers for "how many albums" is two too many.
  return new Map(result.rows.map((row) => [row.artist_id, row.canonical]));
}

/** Re-exported so a page importing artist reads does not also need ./albums for one key. */
export { albumTrackKey };

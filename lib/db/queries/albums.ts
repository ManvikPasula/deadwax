import "server-only";

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db";
import { albums, artists, credits, desertIsland, logTags, tracks } from "@/lib/db/schema";
import { releaseYear } from "@/lib/format";
import { containsPattern, startsWithPattern } from "@/lib/like";
import { averageRating, histogramFromCounts, type HistogramBucket } from "@/lib/ratings";

/**
 * Every read path over albums and tracks, and five of the six `DISTINCT ON` aggregates.
 *
 * ---------------------------------------------------------------------------------------
 * THE CANONICAL AGGREGATE, AND WHY IT IS COPY-PASTED RATHER THAN FACTORED OUT
 * ---------------------------------------------------------------------------------------
 *
 * A replay is a NEW ROW (see the `logs` docblock in schema.ts), so a naive `AVG(rating)` lets
 * one enthusiastic member vote fifty times. Every aggregate therefore collapses to one row per
 * member FIRST, with `DISTINCT ON`:
 *
 *   WITH scoped AS (
 *     SELECT DISTINCT ON (l.user_id) l.user_id, l.rating, l.liked
 *     FROM logs l JOIN users u ON u.id = l.user_id
 *     WHERE ... AND u.is_guest = false
 *     ORDER BY l.user_id, (l.rating IS NOT NULL) DESC, l.created_at DESC
 *   )
 *   SELECT rating, COUNT(*) FILTER (WHERE rating IS NOT NULL)::int, COUNT(*)::int, ...
 *   FROM scoped GROUP BY rating;
 *
 * Three details, each load-bearing, and each commented again at every site below:
 *
 *  1. `(l.rating IS NOT NULL) DESC` — Postgres sorts false < true, so DESC puts RATED logs
 *     first and A MEMBER'S RATING SURVIVES A LATER UNRATED REPLAY MARK. Without it, playing a
 *     track again after rating it silently withdraws the rating from the community average
 *     (I-11). This matters MORE in music than in television: relistening is the norm, not the
 *     exception, so a member may genuinely hold dozens of logs for one track.
 *  2. `u.is_guest = false` on EVERY public aggregate (I-12). There is no database-level guard.
 *     One click of a guest's must not move a figure members read as consensus.
 *  3. An omitted disc/track is an EXPLICIT `IS NULL`, never an omitted predicate — otherwise
 *     an album-level query sweeps in every track row.
 *
 * SIX VARIANTS CARRY THIS PATTERN INDEPENDENTLY AND NOTHING CENTRALISES IT. That is a
 * deliberate copy of the original's shape, and the risk it carries is worth stating plainly:
 * CHANGING ONE WITHOUT THE OTHERS MAKES A RATING VANISH FROM ONE SURFACE WHILE PERSISTING ON
 * ANOTHER. The rejected alternative — one parameterised aggregate builder — loses because the
 * six differ in their DISTINCT ON key, their guest filter and their tiebreak, so the builder
 * would need four flags, and a four-flag aggregate is harder to audit than four explicit
 * statements. If you fix a bug in one, grep for `DISTINCT ON` and fix all of them in the same
 * commit. The sixth (`getAlbumAggregates`) lives in ./artists.ts beside the discography grid
 * it feeds.
 *
 * THE AVERAGE IS COMPUTED IN TYPESCRIPT with `averageRating`, never as SQL `AVG`. It returns
 * NULL, not 0, for an empty set, and it keeps the histogram and the average derived from the
 * same rows so the two can never disagree. The single exception is `getRatedAlbumsForTaste`,
 * and it is argued for where it happens.
 *
 * ---------------------------------------------------------------------------------------
 * TWO DRIVER TRAPS THAT APPLY TO EVERY RAW STATEMENT IN THIS FILE
 * ---------------------------------------------------------------------------------------
 *
 *  - `::int` ON EVERY COUNT AND SUM IS NOT DECORATION. `COUNT(*)` and `SUM(smallint)` are
 *    int8, and both drivers hand int8 back as a STRING rather than lose precision. An uncast
 *    count arrives as "7", and "7" + 1 is "71".
 *  - IN A RAW `db.execute`, BOTH DRIVERS RETURN `date` AND `timestamptz` AS STRINGS, while the
 *    query builder maps `timestamptz` to a `Date` and `date` to a string. So a `created_at`
 *    read through raw SQL must never be compared with one read through `db.select` (I-9);
 *    mixing them silently produces "Invalid Date". Nothing here returns a raw timestamp, for
 *    exactly that reason — only `date` columns, which are strings on both paths.
 */

/* -------------------------------------------------------------------------- */
/* Row shapes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The album projection every card, rail and grid reads.
 *
 * THIS TYPE AND `albumRowColumns` BELOW MUST BE EDITED TOGETHER. They are two declarations
 * rather than one inferred from the other because this is a public contract that several
 * modules import, and an inferred select type produces unreadable errors at the call site when
 * a column is renamed.
 *
 * `releaseDate` and `originalReleaseDate` are STRINGS: Drizzle maps `date` columns to strings
 * and `timestamptz` to `Date` objects, and mixing the two produces "Invalid Date" (I-9).
 */
export type AlbumRow = {
  id: number;
  deezerId: string;
  mbid: string | null;
  title: string;
  slug: string;
  coverPath: string | null;
  releaseDate: string | null;
  originalReleaseDate: string | null;
  recordType: string;
  isCanonical: boolean;
  label: string | null;
  explicit: boolean;
  genres: string[];
  tags: string[];
  trackCount: number;
  discCount: number;
  durationMs: number;
  meanTrackMs: number;
  /** POPULARITY, not quality. Never rendered as a rating or as stars. */
  fans: number;
  popularity: number;
  /** MusicBrainz, ALREADY on the stored 0..10 scale. NULL means no rating; never 0. */
  criticScore: number | null;
  criticVotes: number;
  artistId: number;
  artistName: string;
  artistSlug: string;
  artistPicturePath: string | null;
};

/** Edited together with `AlbumRow`. */
const albumRowColumns = {
  id: albums.id,
  deezerId: albums.deezerId,
  mbid: albums.mbid,
  title: albums.title,
  slug: albums.slug,
  coverPath: albums.coverPath,
  releaseDate: albums.releaseDate,
  originalReleaseDate: albums.originalReleaseDate,
  recordType: albums.recordType,
  isCanonical: albums.isCanonical,
  label: albums.label,
  explicit: albums.explicit,
  genres: albums.genres,
  tags: albums.tags,
  trackCount: albums.trackCount,
  discCount: albums.discCount,
  durationMs: albums.durationMs,
  meanTrackMs: albums.meanTrackMs,
  fans: albums.fans,
  popularity: albums.popularity,
  criticScore: albums.criticScore,
  criticVotes: albums.criticVotes,
  artistId: albums.artistId,
  artistName: artists.name,
  artistSlug: artists.slug,
  artistPicturePath: artists.picturePath,
} as const;

export type TrackRow = {
  id: number;
  albumId: number;
  artistId: number;
  deezerId: string;
  discNumber: number;
  trackNumber: number;
  title: string;
  durationMs: number;
  isrc: string | null;
  explicit: boolean;
  /** Signed and expiring. Route it through `previewSource` before rendering a play button. */
  previewUrl: string | null;
  /** POPULARITY — streams, not quality. Never a rating and never a heatmap colour source. */
  popularity: number;
  criticScore: number | null;
  criticVotes: number;
  /** The performing/featured credit, present only when it differs from the album artist. */
  artistName: string | null;
};

const trackRowColumns = {
  id: tracks.id,
  albumId: tracks.albumId,
  artistId: tracks.artistId,
  deezerId: tracks.deezerId,
  discNumber: tracks.discNumber,
  trackNumber: tracks.trackNumber,
  title: tracks.title,
  durationMs: tracks.durationMs,
  isrc: tracks.isrc,
  explicit: tracks.explicit,
  previewUrl: tracks.previewUrl,
  popularity: tracks.popularity,
  criticScore: tracks.criticScore,
  criticVotes: tracks.criticVotes,
  artistName: tracks.artistName,
} as const;

/** A track plus the album and artist context a track card cannot be rendered without. */
export type TrackContextRow = TrackRow & {
  albumTitle: string;
  albumSlug: string;
  albumCoverPath: string | null;
  albumMbid: string | null;
  albumReleaseDate: string | null;
  albumOriginalReleaseDate: string | null;
  discCount: number;
  albumArtistId: number;
  albumArtistName: string;
  albumArtistSlug: string;
};

const trackContextColumns = {
  ...trackRowColumns,
  albumTitle: albums.title,
  albumSlug: albums.slug,
  albumCoverPath: albums.coverPath,
  albumMbid: albums.mbid,
  albumReleaseDate: albums.releaseDate,
  albumOriginalReleaseDate: albums.originalReleaseDate,
  discCount: albums.discCount,
  albumArtistId: artists.id,
  albumArtistName: artists.name,
  albumArtistSlug: artists.slug,
} as const;

export type AlbumCredit = {
  id: number;
  personId: string;
  name: string;
  picturePath: string | null;
  role: string | null;
  kind: string;
  creditOrder: number;
};

/* -------------------------------------------------------------------------- */
/* Key helpers — two shapes, deliberately                                     */
/* -------------------------------------------------------------------------- */

/**
 * `${disc}:${track}` — the WITHIN-ONE-ALBUM key. Used by `getViewerAlbumState`, whose maps are
 * already scoped to a single album, and by the log dialog that reads them.
 */
export const trackKey = (disc: number, track: number): string => `${disc}:${track}`;

/**
 * `${albumId}:${disc}:${track}` — the ACROSS-ALBUMS key, for anything spanning a discography.
 *
 * The two shapes are not interchangeable, and a mismatched lookup fails SILENTLY: it returns
 * undefined, which renders as an uncoloured cell rather than as an error. Hence two named
 * helpers instead of inline template strings at twenty call sites.
 */
export const albumTrackKey = (albumId: number, disc: number, track: number): string =>
  `${albumId}:${disc}:${track}`;

/** `IN (${idList(ids)})`. Every caller guards the empty array first: `IN ()` is invalid SQL. */
function idList(ids: number[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/** Dedupes and normalises a one-or-many id argument. */
function toIds(input: number | number[]): number[] {
  return [...new Set(Array.isArray(input) ? input : [input])];
}

/* ========================================================================== *
 * VARIANT 1 — getRatingStats: DISTINCT ON (user_id), the canonical form
 * ========================================================================== */

/**
 * The three loggable tiers, in the shape a query needs them.
 *
 * An artist-level target is anchored on `artist_id`; album and track targets are anchored on
 * `album_id`, which is the narrower key and the one the `logs_target_*` indexes lead with.
 */
export type RatingTarget =
  | { type: "artist"; artistId: number }
  | { type: "album"; albumId: number }
  | { type: "track"; albumId: number; disc: number; track: number };

export type RatingStats = {
  /** A genuine weighted mean on the stored 0..10 scale. NULL for no ratings — never 0. */
  average: number | null;
  ratingCount: number;
  /** Members holding at least one log for this target, rated or not. */
  listenedBy: number;
  /** `logs.liked` — the authors' own hearts on what they played, not the `likes` table. */
  likes: number;
  /** Always exactly ten buckets, even at zero ratings. */
  histogram: HistogramBucket[];
};

type RatingStatsSqlRow = {
  rating: number | null;
  rating_count: number;
  listened_by: number;
  likes: number;
};

export async function getRatingStats(target: RatingTarget): Promise<RatingStats> {
  const anchor =
    target.type === "artist" ? sql`l.artist_id = ${target.artistId}` : sql`l.album_id = ${target.albumId}`;

  /**
   * DETAIL 3 — an omitted ordinal becomes an EXPLICIT `IS NULL`.
   *
   * And these two lines are NOT redundant with `l.target_type`, which is the tempting reading.
   * `target_type` is an unconstrained `varchar(8)` written by application code — the schema
   * says plainly that a bug can write 'albumm' and nothing stops it. The ordinal columns are
   * the structural truth about what a row addresses, so a row saved with the wrong
   * `target_type` is still kept out of this album's average by these predicates.
   */
  const discPredicate = target.type === "track" ? sql`l.disc_number = ${target.disc}` : sql`l.disc_number IS NULL`;
  const trackPredicate =
    target.type === "track" ? sql`l.track_number = ${target.track}` : sql`l.track_number IS NULL`;

  const result = await db.execute<RatingStatsSqlRow>(sql`
    WITH scoped AS (
      SELECT DISTINCT ON (l.user_id) l.user_id, l.rating, l.liked
      FROM logs l
      JOIN users u ON u.id = l.user_id
      WHERE l.target_type = ${target.type}
        AND ${anchor}
        AND ${discPredicate}
        AND ${trackPredicate}
        -- DETAIL 2 (I-12): there is no database-level guard, so every public aggregate says
        -- this. One click of a guest's must not move a figure members read as consensus.
        AND u.is_guest = false
      -- DETAIL 1 (I-11): false < true, so DESC puts rated logs first and a member's rating
      -- survives a later unrated replay mark.
      ORDER BY l.user_id, (l.rating IS NOT NULL) DESC, l.created_at DESC
    )
    SELECT rating,
           COUNT(*) FILTER (WHERE rating IS NOT NULL)::int AS rating_count,
           COUNT(*)::int                                   AS listened_by,
           COUNT(*) FILTER (WHERE liked)::int              AS likes
    FROM scoped
    GROUP BY rating
  `);

  const rows = result.rows;
  // `GROUP BY rating` returns at most eleven rows — ten ratings plus the unrated group — so the
  // totals are summed here rather than in a second statement.
  let ratingCount = 0;
  let listenedBy = 0;
  let likes = 0;
  for (const row of rows) {
    ratingCount += row.rating_count;
    listenedBy += row.listened_by;
    likes += row.likes;
  }

  const histogram = histogramFromCounts(rows.map((row) => ({ rating: row.rating, count: row.rating_count })));
  return { average: averageRating(histogram), ratingCount, listenedBy, likes, histogram };
}

/* ========================================================================== *
 * VARIANT 2 — getTrackAggregates: DISTINCT ON (user_id, album_id, disc, track)
 * ========================================================================== */

export type TrackAggregate = {
  albumId: number;
  disc: number;
  track: number;
  average: number | null;
  ratingCount: number;
};

/**
 * THE QUERY THAT FEEDS BOTH HEATMAPS. Keyed by `albumTrackKey`.
 *
 * Accepts one album id or many: the track strip asks for one, the discography heatmap asks for
 * every canonical album in one round trip. The rejected alternative was a per-album call in a
 * loop, which on a thirty-album discography is thirty statements to draw one grid.
 *
 * WHY THERE IS NO `(rating IS NOT NULL) DESC` TIEBREAK HERE. It is not missing, it is
 * unnecessary: `l.rating IS NOT NULL` is already in the WHERE, so the newest surviving row is
 * by construction the newest RATED row, which is exactly what the tiebreak computes. THE TWO
 * GO TOGETHER — if you ever relax that filter to count unrated listens, add the tiebreak back
 * in the same edit or you reintroduce I-11 here.
 */
export async function getTrackAggregates(albumId: number | number[]): Promise<Map<string, TrackAggregate>> {
  const ids = toIds(albumId);
  if (ids.length === 0) return new Map(); // `IN ()` is invalid SQL

  const result = await db.execute<{
    album_id: number;
    disc_number: number;
    track_number: number;
    rating: number;
    count: number;
  }>(sql`
    WITH scoped AS (
      SELECT DISTINCT ON (l.user_id, l.album_id, l.disc_number, l.track_number)
             l.user_id, l.album_id, l.disc_number, l.track_number, l.rating
      FROM logs l
      JOIN users u ON u.id = l.user_id
      WHERE l.target_type = 'track'
        AND l.album_id IN (${idList(ids)})
        -- Explicit NOT NULL: a row saved with the wrong target_type must not colour a cell.
        AND l.disc_number IS NOT NULL
        AND l.track_number IS NOT NULL
        AND l.rating IS NOT NULL
        AND u.is_guest = false -- I-12
      ORDER BY l.user_id, l.album_id, l.disc_number, l.track_number, l.created_at DESC
    )
    SELECT album_id, disc_number, track_number, rating, COUNT(*)::int AS count
    FROM scoped
    GROUP BY album_id, disc_number, track_number, rating
  `);

  // Buckets first, then one weighted mean per track — the same two-step the canonical form
  // uses, so a cell's colour and an album's average can never disagree about the same rows.
  const buckets = new Map<string, Array<{ value: number; count: number }>>();
  const identity = new Map<string, { albumId: number; disc: number; track: number }>();
  for (const row of result.rows) {
    const key = albumTrackKey(row.album_id, row.disc_number, row.track_number);
    const list = buckets.get(key);
    if (list) {
      list.push({ value: row.rating, count: row.count });
    } else {
      buckets.set(key, [{ value: row.rating, count: row.count }]);
      identity.set(key, { albumId: row.album_id, disc: row.disc_number, track: row.track_number });
    }
  }

  const out = new Map<string, TrackAggregate>();
  for (const [key, list] of buckets) {
    const where = identity.get(key);
    if (!where) continue;
    out.set(key, {
      ...where,
      average: averageRating(list),
      ratingCount: list.reduce((total, bucket) => total + bucket.count, 0),
    });
  }
  return out;
}

/* ========================================================================== *
 * VARIANT 4 — getMostRatedAlbums: DISTINCT ON (user_id, album_id), then GROUP BY album_id
 * ========================================================================== */

export type CommunityAlbumRow = AlbumRow & {
  memberAverage: number | null;
  memberCount: number;
  viewerRating: number | null;
  replayCount: number;
};

/**
 * The community's most-rated albums. A PUBLIC aggregate, so it carries the guest filter.
 *
 * `viewerId` IS THE VIEWER, NOT THE SUBJECT: it only overlays that member's own rating and play
 * count onto the cards, and it never filters. "Most rated here" is a statement about the
 * community, and hiding the albums the viewer has already rated would quietly turn this rail
 * into a recommender — which is what /for-you is, with a model behind it and a stated reason
 * per row.
 */
export async function getMostRatedAlbums(viewerId?: number | null, limit = 12): Promise<CommunityAlbumRow[]> {
  const result = await db.execute<{
    album_id: number;
    rating: number;
    count: number;
    rating_count: number;
    fans: number;
  }>(sql`
    WITH scoped AS (
      SELECT DISTINCT ON (l.user_id, l.album_id) l.user_id, l.album_id, l.rating
      FROM logs l
      JOIN users u ON u.id = l.user_id
      WHERE l.target_type = 'album'
        AND l.album_id IS NOT NULL
        AND l.disc_number IS NULL   -- an omitted ordinal is an explicit IS NULL
        AND l.track_number IS NULL
        AND l.rating IS NOT NULL    -- pre-filtered, so the (rating IS NOT NULL) tiebreak is
                                    -- already satisfied; relax one and you must add the other
        AND u.is_guest = false      -- I-12
      ORDER BY l.user_id, l.album_id, l.created_at DESC
    ),
    tallied AS (
      SELECT s.album_id, COUNT(*)::int AS rating_count, MAX(a.fans)::int AS fans
      FROM scoped s
      JOIN albums a ON a.id = s.album_id
      -- albums.is_canonical — the "specials" exclusion. A non-canonical release must never
      -- enter a completion denominator, a discography heatmap row, or a recommendation pool.
      -- COPY THIS COMMENT next to any new query that filters on it; the television version's
      -- "season_number > 0" was pasted into three CTEs precisely because it is easy to omit in
      -- a fourth.
      WHERE a.is_canonical = true
      GROUP BY s.album_id
      -- The fans tiebreak is the profile rankings' argument again: two albums with three
      -- ratings each must not be ordered by however the rows happen to be stored.
      ORDER BY rating_count DESC, fans DESC, s.album_id DESC
      LIMIT ${limit}
    )
    SELECT s.album_id, s.rating, COUNT(*)::int AS count, t.rating_count, t.fans
    FROM scoped s
    JOIN tallied t ON t.album_id = s.album_id
    GROUP BY s.album_id, s.rating, t.rating_count, t.fans
  `);

  const buckets = new Map<number, Array<{ value: number; count: number }>>();
  const tally = new Map<number, { ratingCount: number; fans: number }>();
  for (const row of result.rows) {
    const list = buckets.get(row.album_id);
    if (list) {
      list.push({ value: row.rating, count: row.count });
    } else {
      buckets.set(row.album_id, [{ value: row.rating, count: row.count }]);
      tally.set(row.album_id, { ratingCount: row.rating_count, fans: row.fans });
    }
  }

  // The SQL already ordered `tallied`, but the outer GROUP BY does not preserve it, so the
  // ranking is reapplied here on the same three keys.
  const ids = [...tally.entries()]
    .sort(
      ([leftId, left], [rightId, right]) =>
        right.ratingCount - left.ratingCount || right.fans - left.fans || rightId - leftId,
    )
    .map(([id]) => id);
  if (ids.length === 0) return [];

  const [rows, overlay] = await Promise.all([getAlbumsByIds(ids), getViewerAlbumOverlay(viewerId, ids)]);
  const byId = new Map(rows.map((row) => [row.id, row]));

  return ids.flatMap((id) => {
    const row = byId.get(id);
    if (!row) return []; // deleted between the two statements
    const seen = overlay.get(id);
    return [
      {
        ...row,
        memberAverage: averageRating(buckets.get(id) ?? []),
        memberCount: tally.get(id)?.ratingCount ?? 0,
        viewerRating: seen?.rating ?? null,
        replayCount: seen?.plays ?? 0,
      },
    ];
  });
}

/* ========================================================================== *
 * VARIANT 5 — getTopArtists / getTopAlbums / getTopTracks: widening keys
 * ========================================================================== */

/**
 * THE THREE PROFILE RANKINGS.
 *
 * All three live in this file, including the artist one, because they are the variant most
 * likely to be edited as a set: they share the no-guest-filter rule, the rating order and the
 * popularity tiebreak. Putting `getTopArtists` in ./artists.ts beside the other artist reads
 * was the rejected alternative — it splits one pattern across two files, which is how a fix
 * lands in two of three places.
 *
 * NO `u.is_guest = false` AND NO `users` JOIN. This is the member's own profile, so their own
 * rows are exactly what is being reported. A guest filter here would blank a guest's own
 * profile — the surface guest mode exists to make work — and these numbers are attributed to
 * one named member rather than presented as consensus, so I-12's argument does not apply.
 *
 * THE TIEBREAK IS `fans DESC`, so a five-star given to a landmark leads a five-star given to
 * something obscure instead of the order falling out of however the rows happen to be stored.
 * For artists that is `artists.fans`: there is no album in scope to borrow a figure from.
 */
export async function getTopAlbums(userId: number, limit = 12): Promise<Array<AlbumRow & { viewerRating: number }>> {
  const result = await db.execute<{ album_id: number; rating: number }>(sql`
    WITH scoped AS (
      SELECT DISTINCT ON (l.user_id, l.album_id) l.user_id, l.album_id, l.rating
      FROM logs l
      WHERE l.user_id = ${userId}
        AND l.target_type = 'album'
        AND l.album_id IS NOT NULL
        AND l.disc_number IS NULL
        AND l.track_number IS NULL
        AND l.rating IS NOT NULL
      ORDER BY l.user_id, l.album_id, l.created_at DESC
    )
    SELECT s.album_id, s.rating
    FROM scoped s
    JOIN albums a ON a.id = s.album_id
    ORDER BY s.rating DESC, a.fans DESC, s.album_id DESC
    LIMIT ${limit}
  `);

  const ids = result.rows.map((row) => row.album_id);
  if (ids.length === 0) return [];
  const byId = new Map((await getAlbumsByIds(ids)).map((row) => [row.id, row]));
  return result.rows.flatMap((row) => {
    const album = byId.get(row.album_id);
    return album ? [{ ...album, viewerRating: row.rating }] : [];
  });
}

export async function getTopTracks(
  userId: number,
  limit = 12,
): Promise<Array<TrackContextRow & { viewerRating: number }>> {
  const result = await db.execute<{ track_id: number; rating: number }>(sql`
    WITH scoped AS (
      SELECT DISTINCT ON (l.user_id, l.album_id, l.disc_number, l.track_number)
             l.user_id, l.album_id, l.disc_number, l.track_number, l.rating
      FROM logs l
      WHERE l.user_id = ${userId}
        AND l.target_type = 'track'
        AND l.album_id IS NOT NULL
        AND l.disc_number IS NOT NULL
        AND l.track_number IS NOT NULL
        AND l.rating IS NOT NULL
      ORDER BY l.user_id, l.album_id, l.disc_number, l.track_number, l.created_at DESC
    )
    SELECT t.id AS track_id, s.rating
    FROM scoped s
    -- AN INNER JOIN, DELIBERATELY. A log addresses a POSITION, not a track row, so a log
    -- pointing at a position the mirror no longer carries — the album was re-synced from a
    -- different edition, which happens to real release groups — has no title to render and is
    -- dropped. The consequence worth knowing: this list can be SHORTER than the member's
    -- rated-track count, so any "N rated tracks" caption beside it must come from this query
    -- and not from a separate COUNT, or the heading contradicts the body (I-14).
    JOIN tracks t
      ON t.album_id = s.album_id AND t.disc_number = s.disc_number AND t.track_number = s.track_number
    JOIN albums a ON a.id = t.album_id
    ORDER BY s.rating DESC, a.fans DESC, t.id DESC
    LIMIT ${limit}
  `);

  const ids = result.rows.map((row) => row.track_id);
  if (ids.length === 0) return [];
  const byId = new Map((await getTracksByIds(ids)).map((row) => [row.id, row]));
  return result.rows.flatMap((row) => {
    const track = byId.get(row.track_id);
    return track ? [{ ...track, viewerRating: row.rating }] : [];
  });
}

export type TopArtist = {
  id: number;
  name: string;
  slug: string;
  picturePath: string | null;
  fans: number;
  albumCount: number;
  viewerRating: number;
};

export async function getTopArtists(userId: number, limit = 12): Promise<TopArtist[]> {
  const result = await db.execute<{
    id: number;
    name: string;
    slug: string;
    picture_path: string | null;
    fans: number;
    album_count: number;
    rating: number;
  }>(sql`
    WITH scoped AS (
      SELECT DISTINCT ON (l.user_id, l.artist_id) l.user_id, l.artist_id, l.rating
      FROM logs l
      WHERE l.user_id = ${userId}
        AND l.target_type = 'artist'
        AND l.album_id IS NULL      -- an artist log addresses no album
        AND l.disc_number IS NULL
        AND l.track_number IS NULL
        AND l.rating IS NOT NULL
      ORDER BY l.user_id, l.artist_id, l.created_at DESC
    )
    SELECT ar.id, ar.name, ar.slug, ar.picture_path, ar.fans, ar.album_count, s.rating
    FROM scoped s
    JOIN artists ar ON ar.id = s.artist_id
    ORDER BY s.rating DESC, ar.fans DESC, ar.id DESC
    LIMIT ${limit}
  `);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    picturePath: row.picture_path,
    fans: row.fans,
    albumCount: row.album_count,
    viewerRating: row.rating,
  }));
}

/* ========================================================================== *
 * VARIANT 6 — getRatedAlbumsForTaste: DISTINCT ON (album_id), one member
 * ========================================================================== */

export type RatedAlbumForTaste = {
  albumId: number;
  /** The EFFECTIVE rating: the album verdict if there is one, else the mean of rated tracks. */
  rating: number;
  ratingSource: "album" | "track";
  tracksRated: number;
  artistId: number;
  artistName: string;
  genres: string[];
  tags: string[];
  label: string | null;
  /** From `original_release_date ?? release_date`, so a remaster does not read as recent. */
  year: number | null;
  meanTrackMs: number;
  trackCount: number;
  criticScore: number | null;
  criticVotes: number;
  country: string | null;
};

/**
 * The taste model's only input query.
 *
 * NO `users` JOIN AND NO GUEST FILTER, and that is correct rather than an oversight: this reads
 * ONE member's own rows to model that member's own taste. A guest's /for-you has to work —
 * guest mode exists so the diary, the heatmaps and the taste model behave unchanged for
 * somebody without credentials — and no figure produced here is ever shown as consensus.
 *
 * TWO CTEs PRODUCE THE EFFECTIVE RATING, AND THE ALBUM RATING ALWAYS WINS, because it is the
 * more direct statement of how much they liked the thing. The track mean is the fallback for
 * the member who rates songs and never albums, which is a real listener shape — the television
 * original has the same shape in its episode-only raters.
 *
 * `AVG` IS USED HERE AND ONLY HERE. It is legitimate because `DISTINCT ON` has already
 * collapsed replays, because it is one member's own unweighted mean over their own rows rather
 * than a community consensus figure, and because nothing renders it — it feeds a model. The
 * `::float8` cast is not optional: `AVG` returns `numeric`, which both drivers hand back as a
 * STRING, and a string rating poisons every arithmetic term downstream without erroring.
 */
export async function getRatedAlbumsForTaste(userId: number): Promise<RatedAlbumForTaste[]> {
  const result = await db.execute<{
    album_id: number;
    rating: number | string;
    from_album: boolean;
    tracks_rated: number;
    artist_id: number;
    artist_name: string;
    genres: string[] | null;
    tags: string[] | null;
    label: string | null;
    year_date: string | null;
    mean_track_ms: number;
    track_count: number;
    critic_score: number | null;
    critic_votes: number;
    country: string | null;
  }>(sql`
    WITH album_level AS (
      SELECT DISTINCT ON (l.album_id) l.album_id, l.rating
      FROM logs l
      WHERE l.user_id = ${userId}
        AND l.target_type = 'album'
        AND l.album_id IS NOT NULL
        AND l.disc_number IS NULL
        AND l.track_number IS NULL
        AND l.rating IS NOT NULL
      ORDER BY l.album_id, l.created_at DESC
    ),
    track_scoped AS (
      SELECT DISTINCT ON (l.album_id, l.disc_number, l.track_number) l.album_id, l.rating
      FROM logs l
      WHERE l.user_id = ${userId}
        AND l.target_type = 'track'
        AND l.album_id IS NOT NULL
        AND l.disc_number IS NOT NULL
        AND l.track_number IS NOT NULL
        AND l.rating IS NOT NULL
      ORDER BY l.album_id, l.disc_number, l.track_number, l.created_at DESC
    ),
    track_level AS (
      SELECT album_id, AVG(rating)::float8 AS rating, COUNT(*)::int AS n
      FROM track_scoped
      GROUP BY album_id
    ),
    effective AS (
      -- A FULL OUTER JOIN because the two sides are genuinely independent: a member can rate
      -- an album without rating a track on it, and vice versa. An inner join would silently
      -- drop every album-only rating, which is most of them.
      SELECT COALESCE(al.album_id, tl.album_id)     AS album_id,
             COALESCE(al.rating::float8, tl.rating) AS rating,
             (al.rating IS NOT NULL)                AS from_album,
             COALESCE(tl.n, 0)::int                 AS tracks_rated
      FROM album_level al
      FULL OUTER JOIN track_level tl ON tl.album_id = al.album_id
    )
    SELECT e.album_id,
           e.rating,
           e.from_album,
           e.tracks_rated,
           a.artist_id,
           ar.name AS artist_name,
           a.genres,
           a.tags,
           a.label,
           COALESCE(a.original_release_date, a.release_date) AS year_date,
           a.mean_track_ms,
           a.track_count,
           a.critic_score,
           a.critic_votes,
           ar.country
    FROM effective e
    JOIN albums a ON a.id = e.album_id
    JOIN artists ar ON ar.id = a.artist_id
    WHERE e.rating IS NOT NULL
  `);

  return result.rows.map((row) => {
    const year = releaseYear(row.year_date);
    return {
      albumId: row.album_id,
      // `Number()` rather than a cast: float8 arrives as a number on both drivers, but this is
      // the one value in the file whose type depends on a SQL cast staying in place.
      rating: Number(row.rating),
      ratingSource: row.from_album ? ("album" as const) : ("track" as const),
      tracksRated: row.tracks_rated,
      artistId: row.artist_id,
      artistName: row.artist_name,
      genres: row.genres ?? [],
      tags: row.tags ?? [],
      label: row.label,
      year: year === null ? null : Number(year),
      meanTrackMs: row.mean_track_ms,
      trackCount: row.track_count,
      criticScore: row.critic_score,
      criticVotes: row.critic_votes,
      country: row.country,
    };
  });
}

/* ========================================================================== *
 * EXCEPTION 1 — getViewerAlbumState: no DISTINCT ON at all
 * ========================================================================== */

/**
 * The newest log a member holds for one target, in full.
 *
 * THIS SHAPE IS THE ENTIRE SAFETY MECHANISM FOR THE LOG DIALOG. The dialog always posts every
 * field, so patch semantics do not protect it — only the narrow one-key writers do. ANY CONTROL
 * THAT SAVES A LOG MUST BE PRIMED WITH THESE REAL VALUES. Priming a form with blanks and then
 * saving it is how a rating click silently erases a review: the form sends what it was told,
 * not what exists (SEC-01, I-1). `LogDialog`'s `initial` prop is required rather than optional
 * so that omitting it is a compile error instead of silent data loss.
 *
 * `listenedOn` is a STRING (I-9) and it is the MEMBER'S local calendar date, not a UTC instant,
 * so it must never be rebuilt from a `Date` on the server.
 */
export type ViewerLog = {
  id: number;
  rating: number | null;
  review: string | null;
  listenedOn: string | null;
  isReplay: boolean;
  liked: boolean;
  tags: string[];
};

export type ViewerAlbumState = {
  albumLog: ViewerLog | null;
  artistLog: ViewerLog | null;
  /** Keyed by `trackKey(disc, track)` — already scoped to this album. */
  trackLogs: Map<string, ViewerLog>;
  /**
   * Every track the member holds a log row for, whatever its `listened_on`. There is no
   * `listened` boolean in the schema: at track level "listened" means a track-targeted row
   * exists, so a rating saved with "Add to diary" unchecked still ticks the checkmark.
   */
  listenedTracks: Set<string>;
  /**
   * Log rows per track, keyed by `trackKey`. This is the "x4" badge number, so it counts EVERY
   * row including the first listen rather than only the ones flagged `is_replay` — the flag is
   * the member's own assertion in a checkbox they routinely leave alone, which would make a
   * genuinely thrice-played track read as played once.
   */
  replayCounts: Map<string, number>;
  /** The same count for the album-level logs. */
  albumPlays: number;
};

/**
 * DELIBERATELY NOT `DISTINCT ON`: it pulls every log the member has for one album and reduces
 * in TypeScript, first row seen wins, because an album's logs for one member are small (tens),
 * so one statement plus a reduce beats five separate aggregate queries.
 *
 * AND THE REDUCTION IS NEWEST-WINS, NOT RATED-FIRST — the opposite of the community aggregates,
 * on purpose. The aggregates answer "what does this member think of it", so a rating must
 * survive a later unrated replay (I-11). This answers "which row is the dialog about to edit",
 * and that is the newest row whether or not it carries a rating. Applying the rated-first
 * tiebreak here would make the dialog silently edit an older log than the one the member just
 * created.
 */
export async function getViewerAlbumState(userId: number, albumId: number): Promise<ViewerAlbumState> {
  const result = await db.execute<{
    id: number;
    target_type: string;
    disc_number: number | null;
    track_number: number | null;
    rating: number | null;
    review: string | null;
    listened_on: string | null;
    is_replay: boolean;
    liked: boolean;
  }>(sql`
    SELECT l.id, l.target_type, l.disc_number, l.track_number,
           l.rating, l.review, l.listened_on, l.is_replay, l.liked
    FROM logs l
    WHERE l.user_id = ${userId}
      -- THE OR IS PARENTHESISED (I-13). Drizzle's or() parenthesises in this version, but this
      -- is a raw template so the parentheses are ours to get right: without them AND binds
      -- tighter and "user_id = x AND album_id = y OR target_type = 'artist'" returns every
      -- artist log in the database, for every member.
      AND (
            l.album_id = ${albumId}
            OR (l.target_type = 'artist' AND l.artist_id = (SELECT artist_id FROM albums WHERE id = ${albumId}))
          )
    -- "id DESC" is the deterministic second key: two logs written in the same millisecond would
    -- otherwise pick their winner at the planner's discretion, and the dialog would prime from
    -- a different row on each render.
    ORDER BY l.created_at DESC, l.id DESC
  `);

  const trackLogs = new Map<string, ViewerLog>();
  const listenedTracks = new Set<string>();
  const replayCounts = new Map<string, number>();
  let albumLog: ViewerLog | null = null;
  let artistLog: ViewerLog | null = null;
  let albumPlays = 0;

  const build = (row: (typeof result.rows)[number]): ViewerLog => ({
    id: row.id,
    rating: row.rating,
    review: row.review,
    listenedOn: row.listened_on,
    isReplay: row.is_replay,
    liked: row.liked,
    tags: [],
  });

  for (const row of result.rows) {
    if (row.target_type === "artist") {
      artistLog ??= build(row);
      continue;
    }
    if (row.target_type === "album") {
      albumLog ??= build(row);
      albumPlays += 1;
      continue;
    }
    // A track row with a null ordinal is not addressable, so it can neither prime a form nor
    // tick a checkmark. Dropped rather than defaulted to disc 1: defaulting would attach
    // somebody's review to a track they never played.
    if (row.disc_number === null || row.track_number === null) continue;
    const key = trackKey(row.disc_number, row.track_number);
    if (!trackLogs.has(key)) trackLogs.set(key, build(row));
    listenedTracks.add(key);
    replayCounts.set(key, (replayCounts.get(key) ?? 0) + 1);
  }

  // Tags for the WINNING rows only. The rejected alternative was aggregating tags in the
  // statement above with a lateral array_agg, which fans the row set out by tag count for
  // every log including the ones the reduce is about to discard.
  const winners = [albumLog, artistLog, ...trackLogs.values()].filter((log): log is ViewerLog => log !== null);
  if (winners.length > 0) {
    const tagRows = await db
      .select({ logId: logTags.logId, tag: logTags.tag })
      .from(logTags)
      .where(
        inArray(
          logTags.logId,
          winners.map((log) => log.id),
        ),
      );
    const byLog = new Map<number, string[]>();
    for (const row of tagRows) {
      const list = byLog.get(row.logId);
      if (list) list.push(row.tag);
      else byLog.set(row.logId, [row.tag]);
    }
    for (const log of winners) log.tags = byLog.get(log.id) ?? [];
  }

  return { albumLog, artistLog, trackLogs, listenedTracks, replayCounts, albumPlays };
}

/* -------------------------------------------------------------------------- */
/* Viewer overlays — one member, many targets                                 */
/* -------------------------------------------------------------------------- */

/**
 * The viewer's own rating and play count for a set of albums, for card overlays.
 *
 * No guest filter: these are the viewer's own rows. The `(rating IS NOT NULL) DESC` tiebreak IS
 * here, though — the star on the viewer's own card must survive their later unrated replay for
 * exactly the reason the community average must (I-11). Returns an empty map for a signed-out
 * visitor rather than making every caller branch.
 */
export async function getViewerAlbumOverlay(
  userId: number | null | undefined,
  albumIds: number[],
): Promise<Map<number, { rating: number | null; plays: number }>> {
  const ids = toIds(albumIds);
  if (!userId || ids.length === 0) return new Map();

  const result = await db.execute<{ album_id: number; rating: number | null; plays: number }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (l.album_id) l.album_id, l.rating
      FROM logs l
      WHERE l.user_id = ${userId} AND l.target_type = 'album' AND l.album_id IN (${idList(ids)})
      ORDER BY l.album_id, (l.rating IS NOT NULL) DESC, l.created_at DESC
    ),
    plays AS (
      SELECT l.album_id, COUNT(*)::int AS plays
      FROM logs l
      WHERE l.user_id = ${userId} AND l.target_type = 'album' AND l.album_id IN (${idList(ids)})
      GROUP BY l.album_id
    )
    SELECT p.album_id, latest.rating, p.plays
    FROM plays p
    LEFT JOIN latest ON latest.album_id = p.album_id
  `);

  return new Map(result.rows.map((row) => [row.album_id, { rating: row.rating, plays: row.plays }]));
}

/**
 * The viewer's own track ratings across one or many albums, keyed by `albumTrackKey`.
 *
 * THIS USES `DISTINCT ON` WHERE `getViewerAlbumState` DOES NOT, and the difference is scale
 * rather than inconsistency: one album's logs for one member are tens of rows, which is why
 * that function reduces in TypeScript, but a whole discography's are thousands, and shipping
 * thousands of rows to colour a grid is the wrong trade. The rated-first tiebreak applies here
 * because this feeds the heatmap's "mine" colour source, which is a verdict, not an edit
 * target.
 */
export async function getViewerTrackRatings(
  userId: number | null | undefined,
  albumIds: number | number[],
): Promise<Map<string, number>> {
  const ids = toIds(albumIds);
  if (!userId || ids.length === 0) return new Map();

  const result = await db.execute<{
    album_id: number;
    disc_number: number;
    track_number: number;
    rating: number | null;
  }>(sql`
    SELECT DISTINCT ON (l.album_id, l.disc_number, l.track_number)
           l.album_id, l.disc_number, l.track_number, l.rating
    FROM logs l
    WHERE l.user_id = ${userId}
      AND l.target_type = 'track'
      AND l.album_id IN (${idList(ids)})
      AND l.disc_number IS NOT NULL
      AND l.track_number IS NOT NULL
    ORDER BY l.album_id, l.disc_number, l.track_number, (l.rating IS NOT NULL) DESC, l.created_at DESC
  `);

  const out = new Map<string, number>();
  for (const row of result.rows) {
    if (row.rating === null) continue; // a bare listen mark colours nothing
    out.set(albumTrackKey(row.album_id, row.disc_number, row.track_number), row.rating);
  }
  return out;
}

/**
 * The viewer's Desert Island marks over a set of albums, as `albumTrackKey` strings.
 *
 * Deliberately does NOT join the current rating. The five-star precondition is enforced when a
 * mark is GIVEN, never when it is read: a member who later lowers the rating keeps the mark
 * until they clear it themselves, rather than having the database silently discard a choice
 * they made.
 */
export async function getCrownedTracks(
  userId: number | null | undefined,
  albumIds: number | number[],
): Promise<Set<string>> {
  const ids = toIds(albumIds);
  if (!userId || ids.length === 0) return new Set();

  const rows = await db
    .select({
      albumId: desertIsland.albumId,
      discNumber: desertIsland.discNumber,
      trackNumber: desertIsland.trackNumber,
    })
    .from(desertIsland)
    .where(and(eq(desertIsland.userId, userId), inArray(desertIsland.albumId, ids)));

  return new Set(rows.map((row) => albumTrackKey(row.albumId, row.discNumber, row.trackNumber)));
}

/* -------------------------------------------------------------------------- */
/* The replay pillar                                                          */
/* -------------------------------------------------------------------------- */

export type ReplayCounts = {
  /** Album-level log rows. The "x4" badge number. */
  albumPlays: number;
  /** Of those, the ones the member flagged. Always <= albumPlays, and usually an undercount. */
  albumReplays: number;
  /** Earliest and latest diary dates across this album's logs. Date STRINGS, never `Date`s. */
  firstListenedOn: string | null;
  lastListenedOn: string | null;
  /** Log rows per track, keyed by `trackKey`. */
  trackPlays: Map<string, number>;
  /** Every album-level and track-level row for this album and member. */
  totalPlays: number;
};

/**
 * THE REPLAY PILLAR — the replacement for television's "progress".
 *
 * Nobody is partway through a 42-minute album, so a completion percentage at album level means
 * nothing here. What does mean something is HOW MANY TIMES AND WHEN, and in music that carries
 * a stronger signal than a rewatch count does in television, because relistening is the norm
 * rather than the exception. The poster overlay becomes a replay badge instead of a progress
 * bar for the same reason.
 *
 * `albumPlays` counts every row rather than only `is_replay = true` rows, because the first
 * listen is a play too and "x1" is the honest badge for it. `albumReplays` is reported
 * separately and is deliberately NOT the badge number: `is_replay` is the member's own
 * assertion in a checkbox they often leave alone, so a thrice-played record would read as
 * played once.
 *
 * `MIN`/`MAX` over `listened_on` ignore NULLs for free, which is the wanted behaviour: a rating
 * saved with "Add to diary" unchecked has no date and must not become the last-played date.
 */
export async function getReplayCounts(userId: number, albumId: number): Promise<ReplayCounts> {
  const result = await db.execute<{
    target_type: string;
    disc_number: number | null;
    track_number: number | null;
    plays: number;
    replays: number;
    first_listened_on: string | null;
    last_listened_on: string | null;
  }>(sql`
    SELECT l.target_type,
           l.disc_number,
           l.track_number,
           COUNT(*)::int                             AS plays,
           COUNT(*) FILTER (WHERE l.is_replay)::int  AS replays,
           MIN(l.listened_on)                        AS first_listened_on,
           MAX(l.listened_on)                        AS last_listened_on
    FROM logs l
    WHERE l.user_id = ${userId}
      AND l.album_id = ${albumId}
      AND l.target_type IN ('album', 'track')
    GROUP BY l.target_type, l.disc_number, l.track_number
  `);

  const trackPlays = new Map<string, number>();
  let albumPlays = 0;
  let albumReplays = 0;
  let totalPlays = 0;
  let firstListenedOn: string | null = null;
  let lastListenedOn: string | null = null;

  for (const row of result.rows) {
    totalPlays += row.plays;
    if (row.target_type === "album") {
      albumPlays += row.plays;
      albumReplays += row.replays;
    } else if (row.disc_number !== null && row.track_number !== null) {
      const key = trackKey(row.disc_number, row.track_number);
      trackPlays.set(key, (trackPlays.get(key) ?? 0) + row.plays);
    }
    // Date strings on both drivers, so a lexicographic compare IS a chronological compare for
    // ISO dates — which is the whole reason nothing here parses them into `Date` objects only
    // to format them back (I-9).
    if (row.first_listened_on && (firstListenedOn === null || row.first_listened_on < firstListenedOn)) {
      firstListenedOn = row.first_listened_on;
    }
    if (row.last_listened_on && (lastListenedOn === null || row.last_listened_on > lastListenedOn)) {
      lastListenedOn = row.last_listened_on;
    }
  }

  return { albumPlays, albumReplays, firstListenedOn, lastListenedOn, trackPlays, totalPlays };
}

/* -------------------------------------------------------------------------- */
/* Detail reads                                                               */
/* -------------------------------------------------------------------------- */

export type AlbumWithTracks = {
  album: AlbumRow;
  /**
   * Only what an album page needs of the artist. The full artist projection lives in
   * ./artists.ts; repeating a narrow one here keeps the runtime dependency one-way (that file
   * imports from this one, never the reverse) and keeps a bio out of an album query.
   */
  artist: {
    id: number;
    deezerId: string;
    name: string;
    slug: string;
    picturePath: string | null;
    fans: number;
    criticScore: number | null;
    criticVotes: number;
    country: string | null;
  };
  tracks: TrackRow[];
};

export async function getAlbumWithTracks(albumId: number): Promise<AlbumWithTracks | null> {
  const [row] = await db
    .select({
      ...albumRowColumns,
      artistDeezerId: artists.deezerId,
      artistFans: artists.fans,
      artistCriticScore: artists.criticScore,
      artistCriticVotes: artists.criticVotes,
      artistCountry: artists.country,
    })
    .from(albums)
    .innerJoin(artists, eq(artists.id, albums.artistId))
    .where(eq(albums.id, albumId))
    .limit(1);
  if (!row) return null;

  const trackRows = await db
    .select(trackRowColumns)
    .from(tracks)
    .where(eq(tracks.albumId, albumId))
    // The tracklist order IS (disc, track) and nothing else. Not `id`: an album re-synced from
    // a different edition inserts its rows in whatever order the provider returned them, so an
    // id order puts a bonus track in the middle of the record.
    .orderBy(asc(tracks.discNumber), asc(tracks.trackNumber));

  const { artistDeezerId, artistFans, artistCriticScore, artistCriticVotes, artistCountry, ...album } = row;
  return {
    album,
    artist: {
      id: album.artistId,
      deezerId: artistDeezerId,
      name: album.artistName,
      slug: album.artistSlug,
      picturePath: album.artistPicturePath,
      fans: artistFans,
      criticScore: artistCriticScore,
      criticVotes: artistCriticVotes,
      country: artistCountry,
    },
    tracks: trackRows,
  };
}

/**
 * Credits for one album.
 *
 * `credit_order` is `999 - appearances`, so ascending puts the most-credited person first.
 * `name` is the second key because a null-role credit and a role-carrying one for the same
 * person share an order, and an unstable order renders the same page two different ways.
 */
export async function getAlbumCredits(albumId: number): Promise<AlbumCredit[]> {
  return db
    .select({
      id: credits.id,
      personId: credits.personId,
      name: credits.name,
      picturePath: credits.picturePath,
      role: credits.role,
      kind: credits.kind,
      creditOrder: credits.creditOrder,
    })
    .from(credits)
    .where(eq(credits.albumId, albumId))
    .orderBy(asc(credits.creditOrder), asc(credits.name));
}

/* -------------------------------------------------------------------------- */
/* The heatmap cell vocabulary                                                */
/* -------------------------------------------------------------------------- */

/**
 * One cell of either heatmap. The discography grid and the track strip share this vocabulary
 * exactly, so the same track rendered on an album page and on the artist page cannot disagree
 * about its own colour.
 *
 * FOUR COLOUR SOURCES, SWITCHED AND NEVER BLENDED: `member`, `critic`, `mine`, and `predicted`
 * (which the taste module supplies on top of these fields). Switching rather than blending is
 * what keeps each number attributable. Deezer `popularity` is deliberately absent from this
 * type: it measures streams, not quality, and colouring a quality grid by streams is the one
 * dishonesty the whole rating subsystem exists to avoid. It belongs in a labelled "Popularity"
 * meter in the track row and nowhere else.
 */
export type HeatCell = {
  disc: number;
  track: number;
  title: string;
  /** Community average on the stored 0..10 scale. NULL means nobody has rated it. */
  memberAverage: number | null;
  memberCount: number;
  /** MusicBrainz, ALREADY on the stored 0..10 scale. Usually NULL at track level. */
  criticScore: number | null;
  viewerRating: number | null;
  crowned: boolean;
};

/**
 * Assembles the cells for one album.
 *
 * Exported because both heatmaps call it: this centralises the CELL SHAPE, which is safe, and
 * not the `DISTINCT ON` pattern, which is not.
 */
export function buildHeatCells(
  albumId: number,
  trackRows: Array<Pick<TrackRow, "discNumber" | "trackNumber" | "title" | "criticScore">>,
  aggregates: Map<string, TrackAggregate>,
  viewerRatings: Map<string, number>,
  crowned: Set<string>,
): HeatCell[] {
  return trackRows.map((track) => {
    const key = albumTrackKey(albumId, track.discNumber, track.trackNumber);
    const aggregate = aggregates.get(key);
    return {
      disc: track.discNumber,
      track: track.trackNumber,
      title: track.title,
      memberAverage: aggregate?.average ?? null,
      memberCount: aggregate?.ratingCount ?? 0,
      criticScore: track.criticScore,
      viewerRating: viewerRatings.get(key) ?? null,
      crowned: crowned.has(key),
    };
  });
}

export type DiscStrip = { disc: number; cells: HeatCell[] };

/**
 * The album page's strip: the same cell vocabulary, ONE ROW PER DISC.
 *
 * A double album gets two rows rather than one long one, because a 22-cell row beside a
 * tracklist scrolls and a disc boundary is real information about the record. Rows stay ragged
 * — no padding to the widest disc, because padding implies tracks that do not exist.
 */
export async function getTrackStrip(albumId: number, viewerId?: number | null): Promise<DiscStrip[]> {
  const [trackRows, aggregates, viewerRatings, crowned] = await Promise.all([
    db
      .select({
        discNumber: tracks.discNumber,
        trackNumber: tracks.trackNumber,
        title: tracks.title,
        criticScore: tracks.criticScore,
      })
      .from(tracks)
      .where(eq(tracks.albumId, albumId))
      .orderBy(asc(tracks.discNumber), asc(tracks.trackNumber)),
    getTrackAggregates(albumId),
    getViewerTrackRatings(viewerId, albumId),
    getCrownedTracks(viewerId, albumId),
  ]);

  const cells = buildHeatCells(albumId, trackRows, aggregates, viewerRatings, crowned);
  const byDisc = new Map<number, HeatCell[]>();
  for (const cell of cells) {
    const list = byDisc.get(cell.disc);
    if (list) list.push(cell);
    else byDisc.set(cell.disc, [cell]);
  }
  return [...byDisc.entries()].sort(([left], [right]) => left - right).map(([disc, list]) => ({ disc, cells: list }));
}

/* -------------------------------------------------------------------------- */
/* Browse                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 24 — divisible by 3, 4 and 6, which are every breakpoint's column count, so the final row is
 * never ragged.
 *
 * THE CANONICAL COPY OF THIS NUMBER LIVES BESIDE THE GRID'S COLUMN CLASSES, because it is only
 * correct as long as it agrees with them. This one exists so a query can be run without
 * importing a component, and the two must change together.
 */
export const BROWSE_PAGE_SIZE = 24;

/** Before recorded music, and absurd. The same bounds the diary and year pages use (I-4). */
export const DECADE_MIN = 1900;
export const DECADE_MAX = 2200;

export const ALBUM_SORTS = ["popular", "new", "fans", "title"] as const;
export type AlbumSort = (typeof ALBUM_SORTS)[number];

/**
 * The whitelist. A sort key never reaches SQL as text — it selects a branch of `albumOrder`.
 *
 * THERE IS DELIBERATELY NO "highest rated" SORT. It would need the `DISTINCT ON` aggregate over
 * the whole catalogue on every browse render, and — worse — with no ratings floor it puts one
 * five-star rating from one member at the top of the page, which reads as a claim the instance
 * cannot support. Highest-rated-with-a-floor is what the most-rated rail and /for-you are for.
 */
export function parseAlbumSort(value: string | undefined | null): AlbumSort {
  return (ALBUM_SORTS as readonly string[]).includes(value ?? "") ? (value as AlbumSort) : "popular";
}

/**
 * Snaps a year to its decade and bounds it. Returns NULL for anything outside 1900..2200 rather
 * than clamping, so the caller can decide between ignoring the filter and rendering a 404 —
 * silently clamping `?decade=1` to 1900 shows a page nobody asked for.
 */
export function parseDecade(value: string | undefined | null): number | null {
  if (!value || !/^\d{1,4}$/.test(value)) return null;
  const year = Number(value);
  if (!Number.isSafeInteger(year) || year < DECADE_MIN || year > DECADE_MAX) return null;
  return Math.floor(year / 10) * 10;
}

export type BrowseAlbumsOptions = {
  genre?: string | null;
  decade?: number | null;
  sort?: AlbumSort;
  page?: number;
  perPage?: number;
  /**
   * The artist page's album tab passes true so singles, EPs and compilations appear. Every
   * other surface leaves it alone.
   */
  includeNonCanonical?: boolean;
};

export type BrowseResult<T> = { rows: T[]; page: number; hasMore: boolean };

/**
 * The /albums grid.
 *
 * NO `COUNT(*)`. The grid needs to know whether there is a next page, not how many pages there
 * are, and a catalogue-wide count behind a jsonb genre predicate costs more than the page
 * itself. So it fetches `perPage + 1` rows — ONE PAST THE WINDOW, which is what makes a full
 * window distinguishable from the end. If a total is ever added it must be edited in the same
 * commit as the filters, or the heading desynchronises from the body (I-14).
 */
export async function browseAlbums(options: BrowseAlbumsOptions = {}): Promise<BrowseResult<AlbumRow>> {
  const perPage = options.perPage ?? BROWSE_PAGE_SIZE;
  const page = Math.max(1, options.page ?? 1);
  const sort = options.sort ?? "popular";

  const conditions: SQL[] = [];

  if (!options.includeNonCanonical) {
    // albums.is_canonical — the "specials" exclusion. A non-canonical release must never enter
    // a completion denominator, a discography heatmap row, or a recommendation pool. COPY THIS
    // COMMENT next to any new query that filters on it; the television version's
    // `season_number > 0` was pasted into three CTEs precisely because it is easy to omit in a
    // fourth.
    conditions.push(sql`${albums.isCanonical} = true`);
  }

  if (options.genre) {
    // jsonb containment against a one-element array. Exact, case-sensitive name matching, which
    // is right here because Deezer's genre vocabulary is a fixed list of about 28 names
    // resolved to strings at ingest — a fuzzy match would fold "Rock" into "Rock & Roll" and
    // make the two chips return the same page.
    conditions.push(sql`${albums.genres} @> ${JSON.stringify([options.genre])}::jsonb`);
  }

  const decade = options.decade ?? null;
  if (decade !== null && decade >= DECADE_MIN && decade <= DECADE_MAX) {
    // Bounded on BOTH sides, and applied to the FIRST-release date so a 2017 remaster of a 1997
    // record appears in the nineties where it belongs. Half-open, so 1999-12-31 is in the
    // nineties and 2000-01-01 is not.
    const from = `${decade}-01-01`;
    const to = `${decade + 10}-01-01`;
    conditions.push(
      sql`coalesce(${albums.originalReleaseDate}, ${albums.releaseDate}) >= ${from}::date
          AND coalesce(${albums.originalReleaseDate}, ${albums.releaseDate}) < ${to}::date`,
    );
  }

  const rows = await db
    .select(albumRowColumns)
    .from(albums)
    .innerJoin(artists, eq(artists.id, albums.artistId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...albumOrder(sort))
    .limit(perPage + 1)
    .offset((page - 1) * perPage);

  return { rows: rows.slice(0, perPage), page, hasMore: rows.length > perPage };
}

/**
 * Every ordering ends in `albums.id DESC`, and that last key is not cosmetic: without a unique
 * final key, two albums with equal popularity can swap places between page 1 and page 2, and
 * one of them is then never shown at all.
 */
function albumOrder(sort: AlbumSort): SQL[] {
  switch (sort) {
    case "new":
      return [
        sql`coalesce(${albums.originalReleaseDate}, ${albums.releaseDate}) DESC NULLS LAST`,
        sql`${albums.id} DESC`,
      ];
    case "fans":
      return [sql`${albums.fans} DESC`, sql`${albums.id} DESC`];
    case "title":
      // `lower()` because a plain sort puts every lower-cased band name after "Zeppelin".
      return [sql`lower(${albums.title}) ASC`, sql`${albums.id} DESC`];
    case "popular":
    default:
      // Popularity first, fans as the tiebreak: `popularity` is a 0..100 normalisation of
      // Deezer `rank`, so it ties constantly, and `fans` breaks those ties with a number from
      // the same family. NEITHER IS A RATING and neither is ever rendered as stars.
      return [sql`${albums.popularity} DESC`, sql`${albums.fans} DESC`, sql`${albums.id} DESC`];
  }
}

/* -------------------------------------------------------------------------- */
/* Search and id lookups                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Local album search. EVERY SEARCH STRING GOES THROUGH `containsPattern` (I-6).
 *
 * Without it a raw `%` matches every row — `/search?q=%` returned the whole catalogue and the
 * entire member list — and a title containing `_` or `%` can never be found by typing it. That
 * second half matters MORE here than in television: "100%", "_______", "N_E_R_D" and "50% Off"
 * are real records, and a member typing a real title and getting nothing back reads as a
 * missing catalogue rather than as an escaping bug, which is exactly why the defect survived
 * so long in the original.
 *
 * NOT FILTERED ON `is_canonical`, deliberately. Somebody typing "Abbey Road (Super Deluxe)"
 * means it, and returning nothing is the same failure the escaping bug produced.
 */
export async function searchLocalAlbums(query: string, limit = 24): Promise<AlbumRow[]> {
  const term = query.trim();
  if (term.length === 0) return [];

  const contains = containsPattern(term);
  const prefix = startsWithPattern(term);

  return db
    .select(albumRowColumns)
    .from(albums)
    .innerJoin(artists, eq(artists.id, albums.artistId))
    // The OR is parenthesised in the template itself. Drizzle's `or()` also parenthesises in
    // this version, but I-13 shipped because that was not always true, and a raw template puts
    // the responsibility back on the author: AND binds tighter, so an unparenthesised OR here
    // would drop the album filter entirely.
    .where(sql`(${albums.title} ILIKE ${contains} OR ${artists.name} ILIKE ${contains})`)
    // A prefix match leads. Without this, a search for "Kid A" is headed by whichever popular
    // record merely contains the string and the record you typed is below the fold.
    .orderBy(
      sql`(${albums.title} ILIKE ${prefix}) DESC`,
      sql`${albums.popularity} DESC`,
      sql`${albums.fans} DESC`,
      sql`${albums.id} DESC`,
    )
    .limit(limit);
}

/**
 * Returns rows IN THE ORDER THE IDS WERE GIVEN.
 *
 * Every caller has already ranked them — by rating, by recommendation score, by tally — and the
 * database's natural order would silently discard that ranking. Missing ids are dropped rather
 * than returned as holes, so a row deleted between two statements shortens the list instead of
 * crashing the render.
 */
export async function getAlbumsByIds(ids: number[]): Promise<AlbumRow[]> {
  const unique = toIds(ids);
  if (unique.length === 0) return []; // `IN ()` is invalid SQL
  const rows = await db
    .select(albumRowColumns)
    .from(albums)
    .innerJoin(artists, eq(artists.id, albums.artistId))
    .where(inArray(albums.id, unique));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/** Same contract as `getAlbumsByIds`: input order preserved, empty array guarded. */
export async function getTracksByIds(ids: number[]): Promise<TrackContextRow[]> {
  const unique = toIds(ids);
  if (unique.length === 0) return [];
  const rows = await db
    .select(trackContextColumns)
    .from(tracks)
    .innerJoin(albums, eq(albums.id, tracks.albumId))
    .innerJoin(artists, eq(artists.id, albums.artistId))
    .where(inArray(tracks.id, unique));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/**
 * One track by its ADDRESSABLE IDENTITY — (album, disc, track) — not by its serial id, because
 * that is what the URL carries and what a log row stores.
 */
export async function getTrackAt(albumId: number, disc: number, track: number): Promise<TrackContextRow | null> {
  const [row] = await db
    .select(trackContextColumns)
    .from(tracks)
    .innerJoin(albums, eq(albums.id, tracks.albumId))
    .innerJoin(artists, eq(artists.id, albums.artistId))
    .where(and(eq(tracks.albumId, albumId), eq(tracks.discNumber, disc), eq(tracks.trackNumber, track)))
    .limit(1);
  return row ?? null;
}

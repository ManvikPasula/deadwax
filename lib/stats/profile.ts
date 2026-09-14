import "server-only";

/**
 * Lifetime member statistics. Raw SQL through `db.execute`, one round trip per panel.
 *
 * WHY RAW SQL AND NOT THE QUERY BUILDER: nine numbers that all read the same DISTINCT track
 * set. Expressed through the builder they would be nine statements over the same scan, and
 * the profile is the most-visited authenticated page in the product.
 *
 * THE DUAL-DRIVER CONTRACT — the reason `npm run smoke` exists.
 *
 *   Every statement in this file must produce an IDENTICAL result shape on hosted Postgres
 *   (node-postgres) and on PGlite. If it ever differs, every one of these reads would
 *   silently return empty and the interface would look merely quiet rather than broken.
 *
 * A raw `db.execute` bypasses every Drizzle column mapper, so the drivers' own type parsers
 * are what you get, and they DO NOT AGREE. Measured, not assumed:
 *
 *   int8 (any bare COUNT)   node-postgres -> "12", a STRING; PGlite -> 12, a number
 *   numeric (a bare AVG)    both -> a string, because neither registers a numeric parser
 *   date                    node-postgres parses it to a Date at LOCAL midnight; PGlite to a
 *                           Date at UTC midnight. On a UTC-8 machine those are 480 minutes
 *                           apart, so the same stored row reports two different days.
 *
 * Hence three casting rules, applied without exception here and in lib/stats/year.ts:
 * every count `::int`, every mean `::float8`, every `date` `::text`. The `Number(...)` calls
 * at the JS boundary are belt and braces — the casts are what make the drivers agree, and the
 * coercion is what stops a future edit that drops one from shipping a string where a number
 * is expected. NOTHING HERE RETURNS A `timestamptz`: the ordering uses MAX(created_at) inside
 * SQL and never hands it out, and the member-facing fact is the diary date anyway. (I-9.)
 */

import { sql } from "drizzle-orm";
import { cache } from "react";

import { db } from "@/lib/db";

/* -------------------------------------------------------------------------- */
/* Honesty clamp                                                              */
/* -------------------------------------------------------------------------- */

/**
 * "63 of 62 tracks" reads as a bug even when the underlying logs are legitimate.
 *
 * AND THE LEGITIMATE CASE IS FAR MORE COMMON HERE THAN IN THE TELEVISION ORIGINAL. A
 * MusicBrainz release group carries several releases — single, deluxe, remaster, regional
 * edition — WITH DIFFERENT TRACK COUNTS, while `albums.track_count` mirrors exactly one of
 * them. A listener who played the deluxe edition while the mirror holds the standard one has
 * genuinely logged more tracks than the canonical count. So this is not defending against bad
 * data; it is defending against real data the denominator cannot express.
 *
 * `total <= 0` returns the raw count rather than zero: an album whose tracklist has never
 * been fetched has no denominator at all, and reporting "0 of 0" to a member who has played
 * nine tracks is a worse lie than reporting "9".
 */
export function clampListened(listened: number, total: number): number {
  return total > 0 ? Math.min(listened, total) : listened;
}

/* -------------------------------------------------------------------------- */
/* The nine lifetime numbers                                                  */
/* -------------------------------------------------------------------------- */

export type ProfileStats = {
  /** DISTINCT (album, disc, track) track-level logs against canonical releases. */
  tracksPlayed: number;
  /** SUM(tracks.duration_ms) / 60000 over that same DISTINCT set, floored. */
  minutesPlayed: number;
  /** Canonical albums with at least one track logged. */
  albumsStarted: number;
  /** Of those, the ones whose logged track count reached `albums.track_count`. */
  albumsCompleted: number;
  /** RAW: distinct artists across all three target levels. */
  artistsTouched: number;
  /** RAW: log rows with `rating IS NOT NULL`, all three levels. */
  ratingsGiven: number;
  /** On the STORED 1..10 scale, or null for no ratings. Render through intToStars. */
  averageRating: number | null;
  /** RAW: log rows with `review IS NOT NULL`, all three levels. */
  reviewsWritten: number;
  /** RAW: log rows with `listened_on IS NOT NULL`, all three levels. */
  diaryEntries: number;
};

type ProfileStatsRow = {
  tracks_played: number | null;
  minutes_played: number | null;
  albums_started: number | null;
  albums_completed: number | null;
  artists_touched: number | null;
  ratings_given: number | null;
  average_rating: number | null;
  reviews_written: number | null;
  diary_entries: number | null;
};

/**
 * Nine lifetime numbers in ONE round trip: four CTEs and nine scalar subqueries.
 *
 * WRAPPED IN REACT `cache()`, AND THE WRAPPER IS A BUG FIX RATHER THAN AN OPTIMISATION.
 * `db.execute` is not React-cached the way a Drizzle relational query under `cache()` is, so
 * in the television original the profile layout and the profile page each call this
 * independently and viewing one profile runs the four-CTE aggregate TWICE. `cache()` dedupes
 * per request only; it is not a cross-request cache and must not be read as one.
 *
 * The sibling readers below are deliberately NOT cached: each has exactly one caller per
 * render, and wrapping everything hides a genuine second call from review instead of
 * removing it.
 *
 * NOTE THE ASYMMETRY, WHICH IS DELIBERATE AND IS IN THE ORIGINAL:
 *
 *   tracks / minutes / albums   DISTINCT-track-based, and CANONICAL RELEASES ONLY
 *   ratings / reviews / diary   RAW LOG COUNTS across all three target levels
 *
 * The first group answers "how much music has this member actually heard", which a deluxe
 * edition's bonus tracks would inflate and a replay would double. The second answers "how
 * much has this member written down", and a review of a live album is a review. Merging the
 * two rules would make one of the two questions unanswerable.
 *
 * THE THREE NULLABILITY ENCODINGS READ BACK AS THREE COUNTERS, which is the whole reason
 * `logs` has no `listened` boolean and no separate ratings table:
 *   rating IS NOT NULL       -> ratings given
 *   review IS NOT NULL       -> reviews written
 *   listened_on IS NOT NULL  -> diary entries
 * `review IS NOT NULL` is exact rather than `<> ''` on purpose: the write path clears a
 * review to NULL, never to the empty string (I-1). If a write path ever stores '' this
 * counter starts lying, and the fix belongs in the write path.
 */
export const getProfileStats = cache(async function getProfileStats(userId: number): Promise<ProfileStats> {
  const result = await db.execute<ProfileStatsRow>(sql`
    WITH listened AS (
      -- DISTINCT IS THE LOAD-BEARING WORD: a replay must not count twice. logs has zero
      -- unique constraints precisely so a replay is a second row, and every lifetime figure
      -- in this statement would double for a member who relistens — which in music is the
      -- norm rather than the exception.
      --
      -- albums.is_canonical is the "specials" exclusion. A non-canonical release must never
      -- enter a completion denominator, a discography heatmap row, or a recommendation pool.
      -- COPY THIS COMMENT next to any new query that filters on it — the television
      -- original's season_number > 0 comment was pasted into three CTEs precisely because
      -- it is easy to omit in a fourth.
      --
      -- The filter sits HERE, in the base CTE, and not only in progress below, for the same
      -- reason the original put season_number > 0 in its base CTE: otherwise a deluxe
      -- edition's bonus tracks inflate tracks_played and minutes_played too and only the
      -- completion figure is protected. Music has no numeric sentinel, so expressing the
      -- same exclusion costs a join the television version did not need.
      SELECT DISTINCT l.album_id, l.disc_number, l.track_number
      FROM logs l
      JOIN albums a ON a.id = l.album_id AND a.is_canonical
      WHERE l.user_id = ${userId}
        AND l.target_type = 'track'
    ),
    timed AS (
      -- LISTENING TIME IS SUM(duration_ms) WITH NO FALLBACK BRANCH.
      --
      -- The television original sums COALESCE(e.runtime, s.episode_run_time, 0) and derives a
      -- median episode runtime per show, because TMDB's runtime field is empty for every show
      -- checked. Every Deezer track carries a reliable duration, so THE MEDIAN FALLBACK IS
      -- DELIBERATELY NOT PORTED — the brief says so explicitly. The COALESCE below covers a
      -- NOT NULL DEFAULT 0 column and exists only so a tracklist ingested before durations
      -- were written sums to zero rather than to NULL.
      --
      -- DO NOT "RESTORE" THE FALLBACK. If durations are ever missing the answer is to re-sync
      -- the album, not to invent a per-album median and present it as listening time.
      SELECT COALESCE(t.duration_ms, 0) AS ms
      FROM listened li
      JOIN tracks t
        ON t.album_id = li.album_id
       AND t.disc_number = li.disc_number
       AND t.track_number = li.track_number
    ),
    per_album AS (
      SELECT album_id, COUNT(*)::int AS listened_count
      FROM listened
      GROUP BY album_id
    ),
    progress AS (
      -- AN ALBUM WITH track_count = 0 CAN NEVER BE "COMPLETE". Without that guard every album
      -- whose tracklist has not been fetched reports itself finished the moment one track is
      -- logged, because 1 >= 0.
      --
      -- albums.is_canonical, again: this is the completion denominator itself, so the filter
      -- is repeated rather than inherited from listened. Belt and braces on the one query
      -- where omitting it marks a discography complete.
      SELECT p.album_id,
             (a.track_count > 0 AND p.listened_count >= a.track_count) AS complete
      FROM per_album p
      JOIN albums a ON a.id = p.album_id
      WHERE a.is_canonical
    )
    -- A top-level SELECT with no FROM, so this ALWAYS returns exactly one row — including for
    -- a member with no logs at all, where every counter is 0 and average_rating is NULL.
    -- There is no empty-result branch to write.
    SELECT
      (SELECT COUNT(*)::int FROM listened) AS tracks_played,
      -- Integer division, so this FLOORS. A member with thirty seconds logged has played zero
      -- minutes; rounding up would make this the only number on the profile larger than the
      -- truth.
      (SELECT (COALESCE(SUM(ms), 0) / 60000)::int FROM timed) AS minutes_played,
      (SELECT COUNT(*)::int FROM per_album) AS albums_started,
      (SELECT COUNT(*)::int FROM progress WHERE complete) AS albums_completed,
      -- RAW, and across all three tiers: an artist the member has only ever played a live
      -- album by is still an artist they have an opinion about. Rejected alternative:
      -- counting distinct artists inside listened, which would make this smaller than the
      -- number of artists the member has actually rated and read as a bug.
      (SELECT COUNT(DISTINCT artist_id)::int FROM logs WHERE user_id = ${userId}) AS artists_touched,
      (SELECT COUNT(*)::int FROM logs WHERE user_id = ${userId} AND rating IS NOT NULL) AS ratings_given,
      -- ::float8 because AVG(smallint) is numeric, which BOTH drivers hand back as a string.
      -- NULL for no ratings, never 0 — a displayed zero would be a measured verdict.
      (SELECT AVG(rating)::float8 FROM logs WHERE user_id = ${userId} AND rating IS NOT NULL) AS average_rating,
      (SELECT COUNT(*)::int FROM logs WHERE user_id = ${userId} AND review IS NOT NULL) AS reviews_written,
      (SELECT COUNT(*)::int FROM logs WHERE user_id = ${userId} AND listened_on IS NOT NULL) AS diary_entries
  `);

  const row = result.rows[0];
  const average = row?.average_rating;

  return {
    tracksPlayed: Number(row?.tracks_played ?? 0),
    minutesPlayed: Number(row?.minutes_played ?? 0),
    albumsStarted: Number(row?.albums_started ?? 0),
    albumsCompleted: Number(row?.albums_completed ?? 0),
    artistsTouched: Number(row?.artists_touched ?? 0),
    ratingsGiven: Number(row?.ratings_given ?? 0),
    // The one field that must stay nullable all the way to the component.
    averageRating: average === null || average === undefined ? null : Number(average),
    reviewsWritten: Number(row?.reviews_written ?? 0),
    diaryEntries: Number(row?.diary_entries ?? 0),
  };
});

/* -------------------------------------------------------------------------- */
/* Album progress rails                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The shape both album rails return. `coverPath` and `mbid` are handed out raw so the caller
 * can run them through `albumCover()` at whatever size it needs; resolving the URL here would
 * bake a display size into a database read.
 */
export type AlbumProgressRow = {
  albumId: number;
  title: string;
  slug: string;
  coverPath: string | null;
  mbid: string | null;
  /** 'YYYY-MM-DD' or null. A STRING, cast in SQL — see the module docblock on dates. */
  releaseDate: string | null;
  trackCount: number;
  discCount: number;
  artistId: number;
  artistName: string;
  artistSlug: string;
  /** Already through `clampListened`, so it can never exceed `trackCount`. */
  listenedCount: number;
  /** The member's most recent diary date for this album, or null if none is dated. */
  lastListenedOn: string | null;
};

type AlbumProgressSqlRow = {
  album_id: number;
  title: string;
  slug: string;
  cover_path: string | null;
  mbid: string | null;
  release_date: string | null;
  track_count: number;
  disc_count: number;
  artist_id: number;
  artist_name: string;
  artist_slug: string;
  listened_count: number;
  last_listened_on: string | null;
};

function toAlbumProgress(row: AlbumProgressSqlRow): AlbumProgressRow {
  const trackCount = Number(row.track_count ?? 0);
  return {
    albumId: Number(row.album_id),
    title: row.title,
    slug: row.slug,
    coverPath: row.cover_path,
    mbid: row.mbid,
    releaseDate: row.release_date,
    trackCount,
    discCount: Number(row.disc_count ?? 1),
    artistId: Number(row.artist_id),
    artistName: row.artist_name,
    artistSlug: row.artist_slug,
    // Clamped HERE rather than in the component, so no surface can render the unclamped
    // number by forgetting to. See clampListened for why the overflow is legitimate.
    listenedCount: clampListened(Number(row.listened_count ?? 0), trackCount),
    lastListenedOn: row.last_listened_on,
  };
}

/**
 * The one place both rails' SQL lives, parameterised by the completion predicate.
 *
 * The two queries differ in exactly one line, so they share a body: a copy-paste pair would
 * be two more places to forget `is_canonical`, and the point of every comment in this module
 * is that the fourth copy is the one that gets it wrong.
 *
 * ORDERED BY MAX(created_at), NOT BY MAX(listened_on). "What was I doing last" is when the
 * member wrote the row, and a rating saved with "Add to diary" unchecked has no listened_on
 * at all — ordering on the diary date would sink exactly those albums to the bottom. The
 * created_at value is never returned; see the module docblock.
 */
async function albumProgressRail(
  userId: number,
  completion: ReturnType<typeof sql>,
  limit: number,
): Promise<AlbumProgressRow[]> {
  if (limit <= 0) return [];

  const result = await db.execute<AlbumProgressSqlRow>(sql`
    WITH listened AS (
      -- DISTINCT: a replay must not count twice. albums.is_canonical is the "specials"
      -- exclusion — a non-canonical release must never enter a completion denominator, a
      -- discography heatmap row, or a recommendation pool. COPY THIS COMMENT next to any new
      -- query that filters on it.
      SELECT DISTINCT l.album_id, l.disc_number, l.track_number
      FROM logs l
      JOIN albums a ON a.id = l.album_id AND a.is_canonical
      WHERE l.user_id = ${userId}
        AND l.target_type = 'track'
    ),
    per_album AS (
      SELECT album_id, COUNT(*)::int AS listened_count
      FROM listened
      GROUP BY album_id
    ),
    touched AS (
      SELECT album_id,
             MAX(created_at) AS last_at,
             MAX(listened_on)::text AS last_listened_on
      FROM logs
      WHERE user_id = ${userId}
        AND album_id IS NOT NULL
      GROUP BY album_id
    )
    SELECT a.id                 AS album_id,
           a.title,
           a.slug,
           a.cover_path,
           a.mbid,
           a.release_date::text AS release_date,
           a.track_count,
           a.disc_count,
           ar.id                AS artist_id,
           ar.name              AS artist_name,
           ar.slug              AS artist_slug,
           p.listened_count,
           tc.last_listened_on
    FROM per_album p
    JOIN albums a ON a.id = p.album_id
    JOIN artists ar ON ar.id = a.artist_id
    JOIN touched tc ON tc.album_id = p.album_id
    -- track_count > 0 is shared by both rails: an album with no tracklist has no
    -- denominator, so it is neither in progress nor complete. Putting it in the shared body
    -- rather than in each predicate is what keeps the two rails a partition.
    WHERE a.track_count > 0 AND ${completion}
    ORDER BY tc.last_at DESC, a.id DESC
    LIMIT ${limit}
  `);

  return result.rows.map(toAlbumProgress);
}

/**
 * Albums with some tracks logged but not all — the continue-listening rail.
 *
 * Note this is NOT the television "progress" pillar wearing a new name. Nobody is partway
 * through a 42-minute album on purpose; this rail exists because a 2-hour double LP and an
 * interrupted evening are real, and because it is the cheapest surface for getting a member
 * back to a record they abandoned.
 */
export function getInProgressAlbums(userId: number, limit = 12): Promise<AlbumProgressRow[]> {
  return albumProgressRail(userId, sql`p.listened_count < a.track_count`, limit);
}

/** The mirror image: every track on the record logged at least once. */
export function getCompletedAlbums(userId: number, limit = 24): Promise<AlbumProgressRow[]> {
  return albumProgressRail(userId, sql`p.listened_count >= a.track_count`, limit);
}

/* -------------------------------------------------------------------------- */
/* Genre breakdown                                                            */
/* -------------------------------------------------------------------------- */

export type GenreCount = { genre: string; albums: number };

/**
 * The member's genre split, over the albums they have logged.
 *
 * `CROSS JOIN LATERAL jsonb_array_elements(a.genres)` means AN ALBUM WITH THREE GENRES
 * CONTRIBUTES TO THREE BUCKETS, so these counts sum ABOVE the album count and are not
 * percentages of anything. The component's denominator must be the sum of the rows it was
 * given, never `albumsStarted`; treating this as a partition of the library reports a split
 * adding to 180%.
 *
 * CANONICAL-ONLY, to agree with the tiles above it on the same page. A member whose live
 * albums were counted here but not in `albumsStarted` would see a genre split whose numbers
 * cannot be reconciled with the rest of the panel, which reads as a bug in whichever number
 * the reader trusts less.
 *
 * `#>> '{}'` RATHER THAN `::text`: `jsonb_array_elements` yields jsonb, and casting a jsonb
 * string to text KEEPS THE QUOTES — the legend would read "Rock" with the quotation marks
 * included. The `#>> '{}'` path extraction returns the unquoted value on both drivers.
 */
export async function getGenreBreakdown(userId: number, limit = 8): Promise<GenreCount[]> {
  if (limit <= 0) return [];

  const result = await db.execute<{ genre: string | null; albums: number }>(sql`
    WITH touched AS (
      -- DISTINCT album_id, so an album logged once at album level and eleven times at track
      -- level contributes its genres ONCE. albums.is_canonical is the "specials" exclusion:
      -- a non-canonical release must never enter a completion denominator, a discography
      -- heatmap row, or a recommendation pool. COPY THIS COMMENT next to any new query that
      -- filters on it.
      SELECT DISTINCT l.album_id
      FROM logs l
      JOIN albums a ON a.id = l.album_id AND a.is_canonical
      WHERE l.user_id = ${userId}
        AND l.album_id IS NOT NULL
    )
    SELECT genre.value #>> '{}' AS genre,
           COUNT(*)::int        AS albums
    FROM touched tc
    JOIN albums a ON a.id = tc.album_id
    CROSS JOIN LATERAL jsonb_array_elements(a.genres) AS genre(value)
    GROUP BY 1
    -- Ties break alphabetically rather than falling out of however the rows happen to be
    -- stored, so the panel does not reshuffle between two renders of identical data.
    ORDER BY albums DESC, genre ASC
    LIMIT ${limit}
  `);

  return result.rows
    .filter((row): row is { genre: string; albums: number } => typeof row.genre === "string" && row.genre.length > 0)
    .map((row) => ({ genre: row.genre, albums: Number(row.albums ?? 0) }));
}

/* -------------------------------------------------------------------------- */
/* The replay pillar                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One play is not a replay. A leaderboard of records played once is just the diary under a
 * different heading, and on a fresh account every row would tie at 1 and the ordering would
 * collapse to insertion order.
 *
 * This is the replacement for television's "progress" pillar, which does not survive the port
 * — nobody is partway through a 42-minute album — so the number it reports has to mean
 * something on its own.
 */
export const REPLAY_LEADER_MIN_PLAYS = 2;

export type ReplayAlbum = {
  albumId: number;
  title: string;
  slug: string;
  coverPath: string | null;
  mbid: string | null;
  artistId: number;
  artistName: string;
  artistSlug: string;
  /** Album-level log rows. See getReplayLeaders for why this is not derived from tracks. */
  plays: number;
  /** Of those, the ones the member flagged `is_replay`. */
  markedReplays: number;
  lastListenedOn: string | null;
};

export type ReplayTrack = {
  trackId: number;
  title: string;
  discNumber: number;
  trackNumber: number;
  albumId: number;
  albumTitle: string;
  albumSlug: string;
  coverPath: string | null;
  mbid: string | null;
  /** From `albums.disc_count`, so `trackLocator` can drop a redundant "1-". */
  discCount: number;
  artistId: number;
  artistName: string;
  artistSlug: string;
  plays: number;
  markedReplays: number;
  lastListenedOn: string | null;
};

/**
 * Most-played albums and most-played tracks — THE REPLAY PILLAR.
 *
 * NO `DISTINCT` ANYWHERE IN THIS FUNCTION, which is the opposite of every other read in the
 * file. Everything above counts what the member has HEARD, where a second row for the same
 * track is the same music twice. This counts HOW MANY TIMES, so the second row IS the datum.
 * A DISTINCT here would make every leader report exactly 1.
 *
 * ALBUM PLAYS ARE ALBUM-LEVEL LOG ROWS, not anything derived from track rows. Rejected
 * alternative: the maximum per-track play count on the record, which reports an album as
 * played eight times because the member looped one favourite track eight times. The known
 * cost of the choice is that a member who only ever logs individual tracks has no album
 * leaders at all — which is honest, because they never told us they played the record.
 *
 * `markedReplays` is `logs.is_replay`, the member's own flag, and is reported BESIDE `plays`
 * rather than instead of it. The two disagree often and for good reasons: the first logged
 * play of a record the member has owned for twenty years is legitimately flagged a replay,
 * and a member who never touches the checkbox has five plays and zero marked replays.
 * Neither number is a correction of the other.
 */
export async function getReplayLeaders(
  userId: number,
  limit = 6,
): Promise<{ albums: ReplayAlbum[]; tracks: ReplayTrack[] }> {
  if (limit <= 0) return { albums: [], tracks: [] };

  type AlbumRow = {
    album_id: number;
    title: string;
    slug: string;
    cover_path: string | null;
    mbid: string | null;
    artist_id: number;
    artist_name: string;
    artist_slug: string;
    plays: number;
    marked_replays: number;
    last_listened_on: string | null;
  };

  type TrackRow = {
    track_id: number;
    title: string;
    disc_number: number;
    track_number: number;
    album_id: number;
    album_title: string;
    album_slug: string;
    cover_path: string | null;
    mbid: string | null;
    disc_count: number;
    artist_id: number;
    artist_name: string;
    artist_slug: string;
    plays: number;
    marked_replays: number;
    last_listened_on: string | null;
  };

  // Two statements rather than one UNION: the column sets barely overlap, so a UNION would
  // force both halves through the wider shape and then need unpicking in JS. They are
  // independent, so they go in one Promise.all.
  const [albumResult, trackResult] = await Promise.all([
    db.execute<AlbumRow>(sql`
      SELECT a.id        AS album_id,
             a.title,
             a.slug,
             a.cover_path,
             a.mbid,
             ar.id       AS artist_id,
             ar.name     AS artist_name,
             ar.slug     AS artist_slug,
             COUNT(*)::int AS plays,
             (COUNT(*) FILTER (WHERE l.is_replay))::int AS marked_replays,
             MAX(l.listened_on)::text AS last_listened_on
      FROM logs l
      -- albums.is_canonical is the "specials" exclusion. A non-canonical release must never
      -- enter a completion denominator, a discography heatmap row, or a recommendation pool.
      -- COPY THIS COMMENT next to any new query that filters on it. Here it keeps a live
      -- album the member plays constantly from outranking their most-played studio record in
      -- a panel that reads as a statement about the discography.
      JOIN albums a ON a.id = l.album_id AND a.is_canonical
      JOIN artists ar ON ar.id = a.artist_id
      WHERE l.user_id = ${userId}
        AND l.target_type = 'album'
      GROUP BY a.id, ar.id
      HAVING COUNT(*) >= ${REPLAY_LEADER_MIN_PLAYS}
      -- Ties break alphabetically, for the same reason as the genre panel: a stable order
      -- between two renders of identical data.
      ORDER BY plays DESC, a.title ASC
      LIMIT ${limit}
    `),
    db.execute<TrackRow>(sql`
      SELECT t.id        AS track_id,
             t.title,
             t.disc_number,
             t.track_number,
             a.id        AS album_id,
             a.title     AS album_title,
             a.slug      AS album_slug,
             a.cover_path,
             a.mbid,
             a.disc_count,
             ar.id       AS artist_id,
             ar.name     AS artist_name,
             ar.slug     AS artist_slug,
             COUNT(*)::int AS plays,
             (COUNT(*) FILTER (WHERE l.is_replay))::int AS marked_replays,
             MAX(l.listened_on)::text AS last_listened_on
      FROM logs l
      -- Joined on the full addressable tuple, which is the tracks table's unique index. A log
      -- whose album has since been re-synced into a different tracklist drops out rather than
      -- joining to the wrong song.
      JOIN tracks t
        ON t.album_id = l.album_id
       AND t.disc_number = l.disc_number
       AND t.track_number = l.track_number
      -- THE CANONICAL FILTER IS DELIBERATELY NOT REPEATED HERE. A track leader is a statement
      -- about one recording, not about a discography, and a member's most-played take of a
      -- song is often the live one. The asymmetry with the album half above is the point.
      JOIN albums a ON a.id = t.album_id
      JOIN artists ar ON ar.id = t.artist_id
      WHERE l.user_id = ${userId}
        AND l.target_type = 'track'
      GROUP BY t.id, a.id, ar.id
      HAVING COUNT(*) >= ${REPLAY_LEADER_MIN_PLAYS}
      ORDER BY plays DESC, t.title ASC
      LIMIT ${limit}
    `),
  ]);

  return {
    albums: albumResult.rows.map((row) => ({
      albumId: Number(row.album_id),
      title: row.title,
      slug: row.slug,
      coverPath: row.cover_path,
      mbid: row.mbid,
      artistId: Number(row.artist_id),
      artistName: row.artist_name,
      artistSlug: row.artist_slug,
      plays: Number(row.plays ?? 0),
      markedReplays: Number(row.marked_replays ?? 0),
      lastListenedOn: row.last_listened_on,
    })),
    tracks: trackResult.rows.map((row) => ({
      trackId: Number(row.track_id),
      title: row.title,
      discNumber: Number(row.disc_number ?? 1),
      trackNumber: Number(row.track_number ?? 0),
      albumId: Number(row.album_id),
      albumTitle: row.album_title,
      albumSlug: row.album_slug,
      coverPath: row.cover_path,
      mbid: row.mbid,
      discCount: Number(row.disc_count ?? 1),
      artistId: Number(row.artist_id),
      artistName: row.artist_name,
      artistSlug: row.artist_slug,
      plays: Number(row.plays ?? 0),
      markedReplays: Number(row.marked_replays ?? 0),
      lastListenedOn: row.last_listened_on,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Discography completion                                                     */
/* -------------------------------------------------------------------------- */

export type DiscographyProgressRow = {
  artistId: number;
  name: string;
  slug: string;
  picturePath: string | null;
  /** Canonical albums by this artist the member has logged at any level. */
  loggedAlbums: number;
  /** Canonical albums by this artist THAT THE MIRROR HOLDS. See the caveat below. */
  totalAlbums: number;
};

/**
 * Artists whose canonical discography is partly logged — "9 of 11 studio albums".
 *
 * The second replacement for the dead progress pillar, and the artist tier is the one place in
 * music where a completion denominator still means something: nobody is partway through an
 * album, but everybody is partway through a discography.
 *
 * THE DENOMINATOR IS WHAT THE MIRROR HOLDS, NOT THE ARTIST'S TRUE OUTPUT. `ensureDiscography`
 * fills it in, so an artist first seen through a single album page reports "1 of 1" until the
 * artist page is visited. That is a known limitation and the honest one available: the
 * rejected alternative was `artists.album_count`, which is Deezer's count of EVERY release
 * including singles, EPs and compilations, so a complete discography would read "3 of 47" —
 * wrong in a way the member can see and nobody can explain.
 *
 * albums.is_canonical is the "specials" exclusion. A non-canonical release must never enter a
 * completion denominator, a discography heatmap row, or a recommendation pool. COPY THIS
 * COMMENT next to any new query that filters on it. It is doing the work `season_number > 0`
 * used to do, on BOTH sides of the fraction — numerator and denominator have to agree or the
 * panel reads "12 of 11".
 */
export async function getContinueDiscographies(userId: number, limit = 8): Promise<DiscographyProgressRow[]> {
  if (limit <= 0) return [];

  const result = await db.execute<{
    artist_id: number;
    name: string;
    slug: string;
    picture_path: string | null;
    logged_albums: number;
    total_albums: number;
  }>(sql`
    WITH touched AS (
      -- DISTINCT (artist, album): a replay, and an album logged at both album and track
      -- level, must count once. The artist comes from the ALBUM row rather than from
      -- logs.artist_id so a featured-credit log cannot attribute an album to the wrong
      -- discography — the same reasoning that keeps the client from supplying artist_id.
      SELECT DISTINCT a.artist_id, l.album_id
      FROM logs l
      JOIN albums a ON a.id = l.album_id AND a.is_canonical
      WHERE l.user_id = ${userId}
        AND l.album_id IS NOT NULL
    ),
    per_artist AS (
      SELECT artist_id, COUNT(*)::int AS logged_albums
      FROM touched
      GROUP BY artist_id
    ),
    totals AS (
      -- A SUBQUERY, not a JS-built list, so the empty case is IN (SELECT ...) over zero rows
      -- rather than the syntax error IN ().
      SELECT artist_id, COUNT(*)::int AS total_albums
      FROM albums
      WHERE is_canonical
        AND artist_id IN (SELECT artist_id FROM per_artist)
      GROUP BY artist_id
    ),
    touch_time AS (
      SELECT artist_id, MAX(created_at) AS last_at
      FROM logs
      WHERE user_id = ${userId}
      GROUP BY artist_id
    )
    SELECT ar.id        AS artist_id,
           ar.name,
           ar.slug,
           ar.picture_path,
           p.logged_albums,
           t.total_albums
    FROM per_artist p
    JOIN totals t ON t.artist_id = p.artist_id
    JOIN artists ar ON ar.id = p.artist_id
    JOIN touch_time tt ON tt.artist_id = p.artist_id
    -- PARTLY logged. A finished discography belongs in a different panel, and an artist with
    -- no canonical albums in the mirror has no fraction to report.
    WHERE t.total_albums > 0
      AND p.logged_albums < t.total_albums
    -- Furthest along first, then most recently touched: "one album to go" is the row worth
    -- acting on, and among equals the artist the member was just listening to.
    ORDER BY p.logged_albums DESC, tt.last_at DESC, ar.id DESC
    LIMIT ${limit}
  `);

  return result.rows.map((row) => {
    const totalAlbums = Number(row.total_albums ?? 0);
    return {
      artistId: Number(row.artist_id),
      name: row.name,
      slug: row.slug,
      picturePath: row.picture_path,
      // Clamped for the same reason as the album rails: editions differ, and "12 of 11 studio
      // albums" reads as a bug. The WHERE above already excludes that case; this is what
      // keeps it true if the predicate is ever loosened.
      loggedAlbums: clampListened(Number(row.logged_albums ?? 0), totalAlbums),
      totalAlbums,
    };
  });
}

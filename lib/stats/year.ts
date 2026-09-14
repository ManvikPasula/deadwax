import "server-only";

/**
 * Year in Review. Nine independent panels, one `Promise.all`, NOTHING CACHED.
 *
 * THE GOVERNING RULE, AND EVERY QUERY BELOW OBEYS IT:
 *
 *   Everything here is scoped by `listened_on`, NOT `created_at` — the year you played
 *   something is the year it belongs to, even if you logged it later. Ratings without a
 *   listen date are excluded from the year entirely rather than being attributed to whenever
 *   they were entered.
 *
 * That exclusion is the whole reason the sparse-year gate is `activeDays === 0` and not a
 * count of rows: a member who backfills a decade of listening in one evening gets ten real
 * years, and a member who rates fifty records without dating any of them gets no year at all
 * — which is correct, because they have not told us when any of it happened.
 *
 * Nothing is memoised. A year page is one render, each panel has one caller, and `cache()`
 * over nine statements would buy nothing while making a second caller invisible. Contrast
 * `getProfileStats`, which IS cached because it genuinely has two independent callers.
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
 *   numeric (bare AVG,      both -> a string, because neither registers a numeric parser —
 *   and bare EXTRACT)       and EXTRACT returns `numeric` on modern Postgres
 *   date                    node-postgres parses it to a Date at LOCAL midnight; PGlite to a
 *                           Date at UTC midnight. On a UTC-8 machine those are 480 minutes
 *                           apart, so the same stored row reports two different days.
 *
 * Hence three casting rules, applied without exception here and in lib/stats/profile.ts:
 * every count and EXTRACT `::int`, every mean `::float8`, every `date` `::text`. (I-9.)
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { type HistogramBucket, histogramFromCounts } from "@/lib/ratings";

/* -------------------------------------------------------------------------- */
/* Year bounds                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The same two numbers as the `BETWEEN '1900-01-01' AND '2200-01-01'` guard in
 * `getLoggedYears` below. THEY MOVE TOGETHER: exporting them is what lets the route parser
 * reject `/year/99999` with a 404 instead of handing an absurd year to nine queries.
 *
 * 1900 rather than television's 1930, because that is before recorded music rather than
 * before television.
 */
export const YEAR_MIN = 1900;
export const YEAR_MAX = 2200;

/* -------------------------------------------------------------------------- */
/* Panel shapes                                                               */
/* -------------------------------------------------------------------------- */

export type YearSummary = {
  /** DISTINCT (album, disc, track) track logs dated inside the year, canonical only. */
  tracksPlayed: number;
  /** SUM(duration_ms) / 60000 over that DISTINCT set, floored. No fallback branch. */
  minutesPlayed: number;
  /**
   * ALBUM-LEVEL DIARY ENTRIES — explicitly NOT completed albums. "You logged 61 albums" is a
   * count of times the member sat down and wrote a record into the diary. A completion figure
   * would need the track denominator and would be a different, much smaller number that
   * nobody reading this tile expects.
   */
  albumsLogged: number;
  /** Distinct artists across all three tiers, inside the year. */
  artistsPlayed: number;
  /** Every dated log row in the year, all three tiers. */
  diaryEntries: number;
  /**
   * DISTINCT `listened_on`. The sparse-year gate reads this and nothing else — see
   * `isSparseYear`.
   */
  activeDays: number;
  ratingsGiven: number;
  /**
   * On the STORED 1..10 scale, or null. THE COMPONENT MUST RENDER THIS THROUGH `intToStars`.
   * The television original prints "/ 10" on the year page while every other surface shows
   * 0.5–5 stars; that is a named honesty bug and it is not copied. The value is provided on
   * the stored scale because that is the only scale this module speaks.
   */
  averageRating: number | null;
  reviewsWritten: number;
  /** Dated rows the member flagged `is_replay`. The replay pillar's year figure. */
  replays: number;
};

/** One of exactly twelve. `month` is 1..12. */
export type MonthlyPoint = { month: number; entries: number };

export type YearTopAlbum = {
  albumId: number;
  title: string;
  slug: string;
  coverPath: string | null;
  mbid: string | null;
  artistId: number;
  artistName: string;
  artistSlug: string;
  /** DISTINCT (disc, track) pairs played inside the year. */
  tracksPlayed: number;
  /** Mean of the member's dated track ratings for this album that year, stored scale. */
  averageRating: number | null;
  lastListenedOn: string | null;
};

export type YearTopTrack = {
  trackId: number;
  title: string;
  discNumber: number;
  trackNumber: number;
  /** From `albums.disc_count`, so `trackLocator` can drop a redundant "1-". */
  discCount: number;
  albumId: number;
  albumTitle: string;
  albumSlug: string;
  coverPath: string | null;
  mbid: string | null;
  artistId: number;
  artistName: string;
  artistSlug: string;
  /** Stored 1..10, never null: the query filters on `rating IS NOT NULL`. */
  rating: number;
  listenedOn: string;
};

export type YearGenre = { genre: string; albums: number };

export type YearSession = {
  listenedOn: string;
  albumId: number;
  title: string;
  slug: string;
  coverPath: string | null;
  mbid: string | null;
  artistId: number;
  artistName: string;
  artistSlug: string;
  tracks: number;
};

export type YearBookend = {
  /** 'first' | 'last'. Carried as a SQL literal so one statement returns both. */
  which: "first" | "last";
  /** The log row id, so a caller can tell the two branches apart. See getYearReview. */
  logId: number;
  targetType: string;
  listenedOn: string;
  rating: number | null;
  artistId: number;
  artistName: string;
  artistSlug: string;
  albumId: number | null;
  albumTitle: string | null;
  albumSlug: string | null;
  coverPath: string | null;
  mbid: string | null;
  discNumber: number | null;
  trackNumber: number | null;
  trackTitle: string | null;
};

export type YearPlatform = {
  /** Members who logged ANYTHING dated inside the year. The averageTracks denominator. */
  members: number;
  /** Mean tracks per such member. Includes members who played nothing — see the query. */
  averageTracks: number;
  /** Flat mean over every dated rated log platform-wide, stored scale. Not a mean of means. */
  averageRating: number | null;
};

export type YearReview = {
  year: number;
  summary: YearSummary;
  /** ALWAYS TWELVE POINTS, missing months zero-filled. */
  monthly: MonthlyPoint[];
  /** Always ten buckets — `histogramFromCounts` guarantees it. */
  histogram: HistogramBucket[];
  topAlbums: YearTopAlbum[];
  topTracks: YearTopTrack[];
  genres: YearGenre[];
  longestSession: YearSession | null;
  bookends: { first: YearBookend | null; last: YearBookend | null };
  platform: YearPlatform;
};

/* -------------------------------------------------------------------------- */
/* Shared scoping                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The `dated` CTE, built once per call and embedded in eight of the nine statements.
 *
 * THE YEAR WINDOW IS A HALF-OPEN DATE RANGE, NOT `EXTRACT(YEAR FROM listened_on) = $2`, and
 * that is two fixes in one expression:
 *
 *   1. It can use `logs_user_listened_idx`. `EXTRACT` over the column cannot.
 *   2. IT IS IMMUNE TO I-4. Postgres accepts 'infinity' as a date; a stored 'infinity'
 *      satisfies `>= 1 January` but not `< 1 January next`, so it is filtered out BEFORE any
 *      EXTRACT sees it. One such row made `EXTRACT(YEAR ...)` throw on a member's public
 *      pages for every visitor, permanently, with no way to undo it from the interface. The
 *      `EXTRACT(MONTH ...)` in the monthly panel is therefore only ever applied to rows
 *      already inside the window.
 *
 * `listened_on IS NOT NULL` is not written because it cannot help: NULL fails both
 * comparisons. That is the governing rule enforced by the type system of SQL rather than by
 * a predicate somebody can delete.
 */
function datedLogs(userId: number, year: number) {
  const start = `${year}-01-01`;
  const end = `${year + 1}-01-01`;
  return sql`
    dated AS (
      SELECT l.id,
             l.target_type,
             l.artist_id,
             l.album_id,
             l.disc_number,
             l.track_number,
             l.rating,
             l.review,
             l.listened_on,
             l.is_replay
      FROM logs l
      WHERE l.user_id = ${userId}
        AND l.listened_on >= ${start}::date
        AND l.listened_on <  ${end}::date
    )
  `;
}

/** The same window with NO user filter, for the platform comparison. */
function yearWindow(year: number) {
  const start = `${year}-01-01`;
  const end = `${year + 1}-01-01`;
  return sql`listened_on >= ${start}::date AND listened_on < ${end}::date`;
}

/* -------------------------------------------------------------------------- */
/* Empty state and gates                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A structurally complete review with every number at zero.
 *
 * Exported because the page needs the same shape for an out-of-range year as for a real one,
 * and because `monthly.length === 12` has to hold even here — a chart that renders three bars
 * for a blank year is a different layout, and the smoke test asserts the twelve.
 */
export function emptyYearReview(year: number): YearReview {
  return {
    year,
    summary: {
      tracksPlayed: 0,
      minutesPlayed: 0,
      albumsLogged: 0,
      artistsPlayed: 0,
      diaryEntries: 0,
      activeDays: 0,
      ratingsGiven: 0,
      averageRating: null,
      reviewsWritten: 0,
      replays: 0,
    },
    monthly: zeroFilledMonths([]),
    histogram: histogramFromCounts([]),
    topAlbums: [],
    topTracks: [],
    genres: [],
    longestSession: null,
    bookends: { first: null, last: null },
    platform: { members: 0, averageTracks: 0, averageRating: null },
  };
}

/**
 * THE SPARSE-YEAR GATE IS `activeDays === 0`, NOT `tracksPlayed === 0`.
 *
 * A year of album ratings and reviews is a real year, and the track sections handle their own
 * empty cases. Gating on tracks would hide a member's entire written year behind a "nothing
 * here" panel because they rate records rather than logging individual songs.
 */
export function isSparseYear(review: YearReview): boolean {
  return review.summary.activeDays === 0;
}

/**
 * Twelve points, always, missing months zero-filled, SO THE CHART KEEPS A FULL-YEAR SHAPE.
 *
 * Without this a January-only year renders one bar occupying the whole width and reads as a
 * busy year rather than a quiet one.
 */
function zeroFilledMonths(rows: Array<{ month: number | null; entries: number | null }>): MonthlyPoint[] {
  const counts = new Array<number>(12).fill(0);
  for (const row of rows) {
    const month = Number(row.month ?? 0);
    if (!Number.isInteger(month) || month < 1 || month > 12) continue;
    counts[month - 1] = Number(row.entries ?? 0);
  }
  return counts.map((entries, index) => ({ month: index + 1, entries }));
}

/* -------------------------------------------------------------------------- */
/* The nine panels                                                            */
/* -------------------------------------------------------------------------- */

type SummaryRow = {
  tracks_played: number | null;
  minutes_played: number | null;
  albums_logged: number | null;
  artists_played: number | null;
  diary_entries: number | null;
  active_days: number | null;
  ratings_given: number | null;
  average_rating: number | null;
  reviews_written: number | null;
  replays: number | null;
};

/**
 * Nine independent queries in one `Promise.all`.
 *
 * Independent is the operative word: no panel reads another's output, so there is no waterfall
 * and the wall-clock cost of the page is the slowest single query rather than the sum. The
 * out-of-range guard returns the empty shape WITHOUT touching the database, so a hand-typed
 * `/year/0` costs nothing.
 */
export async function getYearReview(userId: number, year: number): Promise<YearReview> {
  if (!Number.isInteger(year) || year < YEAR_MIN || year > YEAR_MAX) return emptyYearReview(year);

  const dated = datedLogs(userId, year);
  // Not named `window`: shadowing the DOM global in a server module is the kind of thing a
  // future edit reads as a browser API.
  const platformWindow = yearWindow(year);

  const [
    summaryResult,
    monthlyResult,
    histogramResult,
    albumResult,
    trackResult,
    genreResult,
    sessionResult,
    bookendResult,
    platformResult,
  ] = await Promise.all([
      /* 1 — summary, ten fields ------------------------------------------- */
      db.execute<SummaryRow>(sql`
        WITH ${dated},
        listened_tracks AS (
          -- DISTINCT: a replay must not count twice in the headline tile. The histogram below
          -- deliberately does the opposite; see its comment.
          --
          -- albums.is_canonical is the "specials" exclusion. A non-canonical release must
          -- never enter a completion denominator, a discography heatmap row, or a
          -- recommendation pool. COPY THIS COMMENT next to any new query that filters on it.
          SELECT DISTINCT d.album_id, d.disc_number, d.track_number
          FROM dated d
          JOIN albums a ON a.id = d.album_id AND a.is_canonical
          WHERE d.target_type = 'track'
        ),
        timed AS (
          -- SUM(duration_ms) WITH NO FALLBACK BRANCH. The television original falls back to a
          -- per-show median because TMDB's runtime field is empty for every show checked;
          -- every Deezer track carries a reliable duration, so THE MEDIAN FALLBACK IS
          -- DELIBERATELY NOT PORTED. Do not "restore" it — re-sync the album instead.
          SELECT COALESCE(t.duration_ms, 0) AS ms
          FROM listened_tracks lt
          JOIN tracks t
            ON t.album_id = lt.album_id
           AND t.disc_number = lt.disc_number
           AND t.track_number = lt.track_number
        )
        -- No FROM, so exactly one row comes back even for a year with nothing in it.
        SELECT
          (SELECT COUNT(*)::int FROM listened_tracks) AS tracks_played,
          -- Integer division floors: thirty seconds logged is zero minutes played.
          (SELECT (COALESCE(SUM(ms), 0) / 60000)::int FROM timed) AS minutes_played,
          -- ALBUM-LEVEL DIARY ENTRIES, explicitly not completed albums. No canonical filter:
          -- a live album written into the diary is a diary entry.
          (SELECT COUNT(*)::int FROM dated WHERE target_type = 'album') AS albums_logged,
          (SELECT COUNT(DISTINCT artist_id)::int FROM dated) AS artists_played,
          (SELECT COUNT(*)::int FROM dated) AS diary_entries,
          (SELECT COUNT(DISTINCT listened_on)::int FROM dated) AS active_days,
          (SELECT COUNT(*)::int FROM dated WHERE rating IS NOT NULL) AS ratings_given,
          -- ::float8 because AVG(smallint) is numeric, which both drivers return as a string.
          (SELECT AVG(rating)::float8 FROM dated WHERE rating IS NOT NULL) AS average_rating,
          (SELECT COUNT(*)::int FROM dated WHERE review IS NOT NULL) AS reviews_written,
          (SELECT COUNT(*)::int FROM dated WHERE is_replay) AS replays
      `),

      /* 2 — monthly bars -------------------------------------------------- */
      db.execute<{ month: number | null; entries: number | null }>(sql`
        WITH ${dated}
        -- COUNTS LOG ROWS, AND CARRIES NO CANONICAL FILTER. THIS IS DELIBERATELY DIFFERENT
        -- FROM THE HEADLINE TILE ABOVE, which counts DISTINCT canonical tracks. The two
        -- numbers will not reconcile and are not meant to: the tile answers "how much music
        -- did you hear", the bars answer "when were you busy", and a night spent replaying one
        -- live album is a busy night. Making them agree would flatten the shape the chart
        -- exists to show.
        SELECT EXTRACT(MONTH FROM listened_on)::int AS month,
               COUNT(*)::int                        AS entries
        FROM dated
        GROUP BY 1
        ORDER BY 1
      `),

      /* 3 — rating histogram ---------------------------------------------- */
      db.execute<{ rating: number | null; count: number | null }>(sql`
        WITH ${dated}
        -- NO DISTINCT ON AT ALL, AND THAT IS NOT AN OVERSIGHT. A replay rated twice inside
        -- one year COUNTS TWICE, because this is a diary statistic — "what did rating things
        -- feel like this year" — and not a consensus figure. Every PUBLIC aggregate in the
        -- codebase carries DISTINCT ON (user_id ...) so a member votes once (I-10); this one
        -- is single-member by construction, so there is no vote to dedupe. DO NOT "FIX" IT.
        --
        -- All three target types, for the same reason: an artist rating is a rating.
        SELECT rating::int   AS rating,
               COUNT(*)::int AS count
        FROM dated
        WHERE rating IS NOT NULL
        GROUP BY 1
        ORDER BY 1
      `),

      /* 4 — top albums ---------------------------------------------------- */
      db.execute<{
        album_id: number;
        title: string;
        slug: string;
        cover_path: string | null;
        mbid: string | null;
        artist_id: number;
        artist_name: string;
        artist_slug: string;
        tracks_played: number | null;
        average_rating: number | null;
        last_listened_on: string | null;
      }>(sql`
        WITH ${dated}
        SELECT a.id      AS album_id,
               a.title,
               a.slug,
               a.cover_path,
               a.mbid,
               ar.id     AS artist_id,
               ar.name   AS artist_name,
               ar.slug   AS artist_slug,
               -- A POSTGRES ROW-CONSTRUCTOR DISTINCT. Counting the PAIR is what makes disc 2
               -- track 5 different from disc 1 track 5; COUNT(DISTINCT disc_number,
               -- track_number) is not legal aggregate syntax and a single-element (x)
               -- silently degrades to a plain expression, so the parentheses here are
               -- load-bearing rather than decorative.
               COUNT(DISTINCT (d.disc_number, d.track_number))::int AS tracks_played,
               AVG(d.rating)::float8    AS average_rating,
               MAX(d.listened_on)::text AS last_listened_on
        FROM dated d
        -- albums.is_canonical is the "specials" exclusion. A non-canonical release must never
        -- enter a completion denominator, a discography heatmap row, or a recommendation pool.
        -- COPY THIS COMMENT next to any new query that filters on it.
        JOIN albums a ON a.id = d.album_id AND a.is_canonical
        JOIN artists ar ON ar.id = a.artist_id
        WHERE d.target_type = 'track'
        GROUP BY a.id, ar.id
        -- TIES BREAK ALPHABETICALLY rather than falling out of however the rows happen to be
        -- stored, so two renders of the same year list the same six albums in the same order.
        ORDER BY tracks_played DESC, a.title ASC
        LIMIT 6
      `),

      /* 5 — top tracks ---------------------------------------------------- */
      db.execute<{
        track_id: number;
        title: string;
        disc_number: number;
        track_number: number;
        disc_count: number;
        album_id: number;
        album_title: string;
        album_slug: string;
        cover_path: string | null;
        mbid: string | null;
        artist_id: number;
        artist_name: string;
        artist_slug: string;
        rating: number;
        listened_on: string;
      }>(sql`
        WITH ${dated}
        -- A PLAIN JOIN WITH NO DISTINCT ON, so a track the member rated twice in one year
        -- TAKES TWO OF THE SIX SLOTS. Same reasoning as the histogram: this is a diary, and
        -- rating the same song twice in a year is itself the interesting fact. The original
        -- behaves this way and it is copied on purpose.
        SELECT t.id      AS track_id,
               t.title,
               t.disc_number,
               t.track_number,
               a.disc_count,
               a.id      AS album_id,
               a.title   AS album_title,
               a.slug    AS album_slug,
               a.cover_path,
               a.mbid,
               ar.id     AS artist_id,
               ar.name   AS artist_name,
               ar.slug   AS artist_slug,
               d.rating::int         AS rating,
               d.listened_on::text   AS listened_on
        FROM dated d
        -- Joined on the full addressable tuple, which is the tracks table's unique index, so a
        -- log whose album has since been re-synced into a different tracklist drops out rather
        -- than joining to the wrong song.
        JOIN tracks t
          ON t.album_id = d.album_id
         AND t.disc_number = d.disc_number
         AND t.track_number = d.track_number
        JOIN albums a ON a.id = t.album_id
        JOIN artists ar ON ar.id = t.artist_id
        WHERE d.target_type = 'track'
          AND d.rating IS NOT NULL
        ORDER BY d.rating DESC, d.listened_on DESC
        LIMIT 6
      `),

      /* 6 — genres -------------------------------------------------------- */
      db.execute<{ genre: string | null; albums: number | null }>(sql`
        WITH ${dated},
        touched AS (
          -- DISTINCT album_id: an album logged once at album level and eleven times at track
          -- level contributes its genres ONCE.
          SELECT DISTINCT album_id
          FROM dated
          WHERE album_id IS NOT NULL
        )
        -- AN ALBUM WITH THREE GENRES CONTRIBUTES TO THREE BUCKETS, so these counts SUM ABOVE
        -- the album count and are not percentages of anything. The chart's denominator is the
        -- sum of the rows it was handed, never the member's album total — treating this as a
        -- partition of the year reports a split adding up to 180%.
        --
        -- #>> '{}' rather than ::text: jsonb_array_elements yields jsonb, and casting a
        -- jsonb string to text KEEPS THE QUOTES, so the legend would read "Rock" with the
        -- quotation marks included.
        SELECT genre.value #>> '{}' AS genre,
               COUNT(*)::int        AS albums
        FROM touched tc
        JOIN albums a ON a.id = tc.album_id
        CROSS JOIN LATERAL jsonb_array_elements(a.genres) AS genre(value)
        GROUP BY 1
        ORDER BY albums DESC, genre ASC
        LIMIT 6
      `),

      /* 7 — longest session ----------------------------------------------- */
      db.execute<{
        listened_on: string;
        album_id: number;
        title: string;
        slug: string;
        cover_path: string | null;
        mbid: string | null;
        artist_id: number;
        artist_name: string;
        artist_slug: string;
        tracks: number | null;
      }>(sql`
        WITH ${dated}
        -- GROUPED BY (day, ALBUM) — PER-ALBUM-PER-DAY, NOT TOTAL TRACKS IN A DAY. "Your
        -- longest session: 14 tracks of Blue on 3 March" is a statement about sitting with one
        -- record. Grouping by day alone would report a day of shuffling as a session, which is
        -- the opposite of what the panel claims.
        SELECT d.listened_on::text AS listened_on,
               a.id                AS album_id,
               a.title,
               a.slug,
               a.cover_path,
               a.mbid,
               ar.id               AS artist_id,
               ar.name             AS artist_name,
               ar.slug             AS artist_slug,
               -- DISTINCT here even though the histogram above refuses it, and the difference
               -- is the noun: the field is called tracks, so replaying one song fourteen
               -- times must not report fourteen tracks. A count of PLAYS would be a different
               -- and honest statistic under a different label.
               COUNT(DISTINCT (d.disc_number, d.track_number))::int AS tracks
        FROM dated d
        JOIN albums a ON a.id = d.album_id
        JOIN artists ar ON ar.id = a.artist_id
        WHERE d.target_type = 'track'
        GROUP BY d.listened_on, a.id, ar.id
        -- Most recent wins a tie: the memorable session is the one the member can still
        -- remember.
        ORDER BY tracks DESC, d.listened_on DESC
        LIMIT 1
      `),

      /* 8 — bookends ------------------------------------------------------ */
      db.execute<{
        which: "first" | "last";
        log_id: number;
        target_type: string;
        listened_on: string;
        rating: number | null;
        artist_id: number;
        artist_name: string;
        artist_slug: string;
        album_id: number | null;
        album_title: string | null;
        album_slug: string | null;
        cover_path: string | null;
        mbid: string | null;
        disc_number: number | null;
        track_number: number | null;
        track_title: string | null;
      }>(sql`
        WITH ${dated}
        -- TWO PARENTHESISED SELECTS AND A UNION ALL WITH A LITERAL DISCRIMINATOR, so one
        -- round trip answers "what opened the year and what closed it". The parentheses are
        -- required: without them the ORDER BY and LIMIT would apply to the union rather than
        -- to each branch.
        --
        -- WITH EXACTLY ONE DATED LOG BOTH BRANCHES RETURN THE SAME ROW and the page shows it
        -- twice. That is the original's behaviour and it is kept; logId is returned so a
        -- caller that would rather render one card can compare the two ids itself, which is a
        -- presentation decision and does not belong in the query.
        --
        -- ::text on the discriminator because an untyped literal in a UNION leaves Postgres
        -- to infer unknown, and the two drivers need not agree about what that becomes.
        (
          SELECT 'first'::text        AS which,
                 d.id                 AS log_id,
                 d.target_type,
                 d.listened_on::text  AS listened_on,
                 d.rating::int        AS rating,
                 ar.id                AS artist_id,
                 ar.name              AS artist_name,
                 ar.slug              AS artist_slug,
                 a.id                 AS album_id,
                 a.title              AS album_title,
                 a.slug               AS album_slug,
                 a.cover_path,
                 a.mbid,
                 d.disc_number,
                 d.track_number,
                 t.title              AS track_title
          FROM dated d
          JOIN artists ar ON ar.id = d.artist_id
          -- LEFT JOINs: an artist-level log has no album, and an album-level log has no track.
          -- An inner join here would silently drop the bookend for a member whose year opened
          -- with an artist rating.
          LEFT JOIN albums a ON a.id = d.album_id
          LEFT JOIN tracks t
            ON t.album_id = d.album_id
           AND t.disc_number = d.disc_number
           AND t.track_number = d.track_number
          -- id breaks a same-day tie, so the pair is deterministic rather than dependent on
          -- physical row order.
          ORDER BY d.listened_on ASC, d.id ASC
          LIMIT 1
        )
        UNION ALL
        (
          SELECT 'last'::text         AS which,
                 d.id                 AS log_id,
                 d.target_type,
                 d.listened_on::text  AS listened_on,
                 d.rating::int        AS rating,
                 ar.id                AS artist_id,
                 ar.name              AS artist_name,
                 ar.slug              AS artist_slug,
                 a.id                 AS album_id,
                 a.title              AS album_title,
                 a.slug               AS album_slug,
                 a.cover_path,
                 a.mbid,
                 d.disc_number,
                 d.track_number,
                 t.title              AS track_title
          FROM dated d
          JOIN artists ar ON ar.id = d.artist_id
          LEFT JOIN albums a ON a.id = d.album_id
          LEFT JOIN tracks t
            ON t.album_id = d.album_id
           AND t.disc_number = d.disc_number
           AND t.track_number = d.track_number
          ORDER BY d.listened_on DESC, d.id DESC
          LIMIT 1
        )
      `),

      /* 9 — platform comparison ------------------------------------------- */
      db.execute<{ members: number | null; average_tracks: number | null; average_rating: number | null }>(sql`
        WITH per_member AS (
          -- NO USER FILTER AND NO GUEST FILTER, both deliberate.
          --
          -- No user filter because the panel's whole job is "you against everybody", so the
          -- member is one of the members being averaged. Excluding them would make a heavy
          -- listener's own contribution invisible from the number they are compared against.
          --
          -- No guest filter, which is the ONE aggregate in the codebase that omits
          -- u.is_guest = false on purpose. I-12 requires it on every PUBLIC aggregate,
          -- because forgetting it is a silent correctness bug — so read this as the documented
          -- exception rather than as precedent. A guest's diary is real listening, this figure
          -- names no member and exposes no guest row, and filtering them out would report a
          -- platform quieter than the platform actually is. IF THIS EVER GAINS A NAME, A
          -- USERNAME OR A LINK, IT NEEDS THE GUEST FILTER BACK.
          SELECT l.user_id,
                 -- FILTER rather than WHERE, and that choice IS the denominator: a member
                 -- whose whole year is album ratings stays in per_member with a zero, and
                 -- drags the mean down honestly. A WHERE would quietly restrict the average to
                 -- members who log individual tracks, which flatters everybody else.
                 COALESCE(
                   COUNT(DISTINCT (l.album_id, l.disc_number, l.track_number))
                     FILTER (WHERE l.target_type = 'track'),
                   0
                 )::int AS tracks
          FROM logs l
          WHERE ${platformWindow}
          GROUP BY l.user_id
        )
        SELECT
          (SELECT COUNT(*)::int FROM per_member) AS members,
          -- The mean over members who logged ANYTHING that year. COALESCE to 0 so an empty
          -- platform reports zero rather than null: nothing is at stake in "the average
          -- member played 0 tracks" when nobody played anything, unlike a rating average,
          -- where a zero would be a measured verdict.
          (SELECT COALESCE(AVG(tracks), 0)::float8 FROM per_member) AS average_tracks,
          -- A FLAT MEAN OVER EVERY DATED RATED LOG PLATFORM-WIDE, *NOT* A MEAN OF PER-MEMBER
          -- MEANS. The distinction matters and the two numbers differ: a flat mean lets a
          -- member with 400 ratings weigh 400 times a member with one, which is the right
          -- answer for "what does a rating on this platform look like" and the wrong answer
          -- for "what does a member look like". This panel asks the first question. Null
          -- rather than 0 when nobody rated anything.
          (SELECT AVG(rating)::float8 FROM logs WHERE rating IS NOT NULL AND ${platformWindow}) AS average_rating
      `),
    ]);

  const summaryRow = summaryResult.rows[0];
  const summaryAverage = summaryRow?.average_rating;

  const bookendFor = (which: "first" | "last"): YearBookend | null => {
    const row = bookendResult.rows.find((candidate) => candidate.which === which);
    if (!row) return null;
    return {
      which,
      logId: Number(row.log_id),
      targetType: row.target_type,
      listenedOn: row.listened_on,
      rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
      artistId: Number(row.artist_id),
      artistName: row.artist_name,
      artistSlug: row.artist_slug,
      albumId: row.album_id === null || row.album_id === undefined ? null : Number(row.album_id),
      albumTitle: row.album_title,
      albumSlug: row.album_slug,
      coverPath: row.cover_path,
      mbid: row.mbid,
      discNumber: row.disc_number === null || row.disc_number === undefined ? null : Number(row.disc_number),
      trackNumber: row.track_number === null || row.track_number === undefined ? null : Number(row.track_number),
      trackTitle: row.track_title,
    };
  };

  const sessionRow = sessionResult.rows[0];
  const platformRow = platformResult.rows[0];
  const platformAverage = platformRow?.average_rating;

  return {
    year,
    summary: {
      tracksPlayed: Number(summaryRow?.tracks_played ?? 0),
      minutesPlayed: Number(summaryRow?.minutes_played ?? 0),
      albumsLogged: Number(summaryRow?.albums_logged ?? 0),
      artistsPlayed: Number(summaryRow?.artists_played ?? 0),
      diaryEntries: Number(summaryRow?.diary_entries ?? 0),
      activeDays: Number(summaryRow?.active_days ?? 0),
      ratingsGiven: Number(summaryRow?.ratings_given ?? 0),
      averageRating: summaryAverage === null || summaryAverage === undefined ? null : Number(summaryAverage),
      reviewsWritten: Number(summaryRow?.reviews_written ?? 0),
      replays: Number(summaryRow?.replays ?? 0),
    },
    monthly: zeroFilledMonths(monthlyResult.rows),
    // Reusing histogramFromCounts rather than shaping buckets here is what guarantees TEN
    // buckets with a peak-relative ratio, identical to every other histogram in the product.
    // A second implementation would be a second place for the ten to become nine.
    histogram: histogramFromCounts(
      histogramResult.rows.map((row) => ({
        rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
        count: Number(row.count ?? 0),
      })),
    ),
    topAlbums: albumResult.rows.map((row) => ({
      albumId: Number(row.album_id),
      title: row.title,
      slug: row.slug,
      coverPath: row.cover_path,
      mbid: row.mbid,
      artistId: Number(row.artist_id),
      artistName: row.artist_name,
      artistSlug: row.artist_slug,
      tracksPlayed: Number(row.tracks_played ?? 0),
      averageRating:
        row.average_rating === null || row.average_rating === undefined ? null : Number(row.average_rating),
      lastListenedOn: row.last_listened_on,
    })),
    topTracks: trackResult.rows.map((row) => ({
      trackId: Number(row.track_id),
      title: row.title,
      discNumber: Number(row.disc_number ?? 1),
      trackNumber: Number(row.track_number ?? 0),
      discCount: Number(row.disc_count ?? 1),
      albumId: Number(row.album_id),
      albumTitle: row.album_title,
      albumSlug: row.album_slug,
      coverPath: row.cover_path,
      mbid: row.mbid,
      artistId: Number(row.artist_id),
      artistName: row.artist_name,
      artistSlug: row.artist_slug,
      rating: Number(row.rating),
      listenedOn: row.listened_on,
    })),
    genres: genreResult.rows
      .filter(
        (row): row is { genre: string; albums: number | null } =>
          typeof row.genre === "string" && row.genre.length > 0,
      )
      .map((row) => ({ genre: row.genre, albums: Number(row.albums ?? 0) })),
    longestSession: sessionRow
      ? {
          listenedOn: sessionRow.listened_on,
          albumId: Number(sessionRow.album_id),
          title: sessionRow.title,
          slug: sessionRow.slug,
          coverPath: sessionRow.cover_path,
          mbid: sessionRow.mbid,
          artistId: Number(sessionRow.artist_id),
          artistName: sessionRow.artist_name,
          artistSlug: sessionRow.artist_slug,
          tracks: Number(sessionRow.tracks ?? 0),
        }
      : null,
    bookends: { first: bookendFor("first"), last: bookendFor("last") },
    platform: {
      members: Number(platformRow?.members ?? 0),
      averageTracks: Number(platformRow?.average_tracks ?? 0),
      averageRating: platformAverage === null || platformAverage === undefined ? null : Number(platformAverage),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Which years exist                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The years this member has anything dated in, newest first.
 *
 * THE DEFENSIVE GUARD IS COPIED VERBATIM AND MUST STAY:
 *
 *   … AND listened_on BETWEEN '1900-01-01' AND '2200-01-01'
 *
 * Postgres accepts 'infinity' as a date, and EXTRACT then throws, which would take this
 * member's diary and year pages down for every visitor. Writes are validated now; this keeps
 * one bad row from being fatal. (Invariant I-4.)
 *
 * This is the ONE query in the file that has to use EXTRACT — it is discovering years rather
 * than filtering to one — which is exactly why it is the one that needs the guard written out.
 * The two literals are `YEAR_MIN` and `YEAR_MAX` above; they move together.
 */
export async function getLoggedYears(userId: number): Promise<number[]> {
  const result = await db.execute<{ year: number | null }>(sql`
    SELECT EXTRACT(YEAR FROM listened_on)::int AS year
    FROM logs
    WHERE user_id = ${userId}
      AND listened_on IS NOT NULL
      AND listened_on BETWEEN '1900-01-01' AND '2200-01-01'
    GROUP BY 1
    -- Newest first: the year tab and the picker both lead with the current year, and a member
    -- with fifteen years of diary should not have to scroll to reach this one.
    ORDER BY 1 DESC
  `);

  return result.rows
    .map((row) => Number(row.year ?? 0))
    .filter((year) => Number.isInteger(year) && year >= YEAR_MIN && year <= YEAR_MAX);
}

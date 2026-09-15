/**
 * Deadwax — the whole domain in one file.
 *
 * Twenty-two tables. Zero enums, zero views, zero check constraints, zero RLS policies —
 * every closed value set is a `varchar(n)` documented in a comment here and enforced by Zod
 * at the action boundary. Adding an enum value is DDL and a migration; `varchar` costs
 * nothing; and a database check would be a second copy of a rule that already exists once.
 * The price is that a bug can write `target_type = 'albumm'` and nothing stops it, which is
 * why `targetTypeOf()` derives the value and never accepts it from a client.
 *
 * WIDTHS THAT SIT EXACTLY AT THEIR LONGEST LEGAL VALUE. Adding a value one character longer
 * fails at INSERT, not at review time:
 *   logs.target_type       varchar(8)   must hold 'artist'      (6)
 *   list_items.target_type varchar(8)   must hold 'artist'      (6)
 *   likes.target_type      varchar(8)   must hold 'list'        (4)
 *   ads.status             varchar(8)   must hold 'archived'    (8)  <-- at the limit
 *   albums.record_type     varchar(12)  must hold 'compilation' (11)
 *   artist_similar.source  varchar(12)  must hold 'musicbrainz' (11)
 *
 * THE DIRECTION OF THE TREE. In the television original, `show_id` is always present and the
 * season/episode ordinals narrow it. Here `artist_id` is the always-present anchor,
 * `album_id` narrows it, and `(disc_number, track_number)` narrow that. The middle tier is
 * an *id*, not an ordinal — an album is not identified by its position in a discography the
 * way a season is identified by its position in a show.
 */

import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/* ========================================================================== *
 * CONTENT MIRROR (5 tables)
 *
 * The database is the read path; the providers are the fill path. Nothing crawls. A row is
 * mirrored the first time somebody looks at it and refreshed when it goes stale. Member
 * aggregates — rating histograms, per-member DISTINCT ON votes, listening-time sums, the
 * heatmaps — are SQL joins against these tables. Without a local mirror every aggregate
 * would need a network call.
 *
 * KEY STRATEGY: a local `serial` primary key with the external id as a unique secondary
 * column. Keeps every FK an integer, keeps the bounded-integer URL parsing that turns a
 * malformed id into a 404 instead of a 500, and localises provider coupling to one column
 * per table. Deezer album ids already reach ten digits and are climbing toward the int4
 * ceiling, so `text` is the honest type for them.
 * ========================================================================== */

export const artists = pgTable(
  "artists",
  {
    id: serial("id").primaryKey(),
    /** Deezer artist id. The resolution key for everything: albums, top tracks, related artists. */
    deezerId: text("deezer_id").notNull(),
    /** MusicBrainz artist MBID. Nullable — enrichment is optional and their API is flaky. */
    mbid: text("mbid"),
    name: varchar("name", { length: 200 }).notNull(),
    /** Recomputed on every detail sync, so a rename changes it. Deliberately NOT unique. */
    slug: text("slug").notNull(),
    picturePath: text("picture_path"),
    bio: text("bio"),
    /** ISO 3166-1 alpha-2, from MusicBrainz only — Deezer does not expose artist country. */
    country: varchar("country", { length: 2 }),
    beganOn: date("began_on"),
    endedOn: date("ended_on"),
    genres: jsonb("genres").$type<string[]>().notNull().default([]),
    /** MusicBrainz tags, already filtered to count >= 2. See mbTagsToAttributes. */
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    /**
     * Deezer `nb_fan`. THIS IS POPULARITY, NOT A RATING. It feeds retrieval, the notability
     * floor and the onboarding familiarity heuristic. It is never rendered as stars.
     */
    fans: integer("fans").notNull().default(0),
    albumCount: integer("album_count").notNull().default(0),
    /**
     * MusicBrainz artist rating, ALREADY DOUBLED onto the stored 0..10 scale — same one-place
     * bridge as albums.critic_score. Probing found artists carry real ratings too
     * (Radiohead: value 4.5, votes-count 80), which is better than the fallback the plan
     * assumed: the artist page can show a genuine attributed baseline rather than a mean of
     * that artist's rated albums wearing an artist's label.
     */
    criticScore: real("critic_score"),
    criticVotes: integer("critic_votes").notNull().default(0),
    /**
     * A release in the last 18 months. The `in_production` analogue: it is the only thing
     * that decides between the 1-day and 14-day refresh TTLs.
     */
    isActive: boolean("is_active").notNull().default(true),
    synced_at: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    /** Nullable: null means MusicBrainz enrichment has never run for this artist. */
    mbSyncedAt: timestamp("mb_synced_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("artists_deezer_id_uq").on(table.deezerId),
    uniqueIndex("artists_mbid_uq").on(table.mbid),
    index("artists_slug_idx").on(table.slug),
    index("artists_fans_idx").on(table.fans),
    index("artists_name_idx").on(table.name),
  ],
);

export const albums = pgTable(
  "albums",
  {
    id: serial("id").primaryKey(),
    deezerId: text("deezer_id").notNull(),
    /**
     * The MusicBrainz RELEASE-GROUP mbid, not a release mbid. MusicBrainz really has four
     * tiers (artist / release-group / release / recording); release-group and release are
     * collapsed here, which is the decision that lets the three-tier URL and rating scheme
     * survive. A specific pressing is not modelled.
     */
    mbid: text("mbid"),
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 300 }).notNull(),
    slug: text("slug").notNull(),
    coverPath: text("cover_path"),
    /** What displays. Deezer's release_date, which for a reissue is the reissue's date. */
    releaseDate: date("release_date"),
    /**
     * The release-GROUP first-release date from MusicBrainz. What the recommender's era term
     * uses. Without this every remaster reads as a recent album, which is the single most
     * common way a music catalogue lies about itself.
     */
    originalReleaseDate: date("original_release_date"),
    /** Deezer record_type: album | single | ep | compilation */
    recordType: varchar("record_type", { length: 12 }).notNull().default("album"),
    /** MusicBrainz secondary types: Live, Remix, Soundtrack, DJ-mix, Demo, Compilation, ... */
    secondaryTypes: jsonb("secondary_types").$type<string[]>().notNull().default([]),
    /**
     * THE "SPECIALS" EXCLUSION. Television's non-canonical items are season 0, detectable
     * with `season_number > 0`. Music has no numeric sentinel, so this boolean is derived at
     * ingest from record_type + secondary types + a title-noise regex.
     *
     * A non-canonical release must never enter a completion denominator, a discography
     * heatmap row, or a recommendation pool. COPY THIS COMMENT next to any new query that
     * filters on it — the original's `season_number > 0` comment was pasted into three CTEs
     * precisely because it is easy to omit in a fourth.
     */
    isCanonical: boolean("is_canonical").notNull().default(true),
    /** Normalised. Deezer returns free text: "Daft Life Ltd./ADA France" -> "Daft Life". */
    label: varchar("label", { length: 200 }),
    upc: varchar("upc", { length: 20 }),
    explicit: boolean("explicit").notNull().default(false),
    genres: jsonb("genres").$type<string[]>().notNull().default([]),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    trackCount: integer("track_count").notNull().default(0),
    discCount: integer("disc_count").notNull().default(1),
    /** SUM(tracks.duration_ms), written by one SQL statement at ingest. */
    durationMs: integer("duration_ms").notNull().default(0),
    /**
     * AVG(tracks.duration_ms). The recommender's format-separation signal: it is what
     * distinguishes a three-minute pop record from a nine-minute post-rock one inside a
     * single shared genre tag, which no genre vocabulary does reliably.
     */
    meanTrackMs: integer("mean_track_ms").notNull().default(0),
    fans: integer("fans").notNull().default(0),
    /** Deezer `rank` normalised to 0..100. POPULARITY, NOT QUALITY. Never rendered as stars. */
    popularity: integer("popularity").notNull().default(0),
    /**
     * MusicBrainz rating, ALREADY DOUBLED ONTO THE STORED 0..10 SCALE by mbRatingToStored().
     *
     * This is the single sharpest hazard in the whole port and it is closed here: MusicBrainz
     * rates 0..5 while member ratings are stored as 1..10 integers, so the two scales must
     * meet in exactly one place. They meet in the mapper, and a test pins it. Everything
     * downstream — the consensus card, reliableAverage, the heatmap's `critic` source,
     * <Stars> — speaks the stored 0..10 scale and nothing else.
     *
     * NULL means no rating exists, which is common. It is never 0: a release with zero votes
     * reports no score rather than a measured zero, because painting it as terrible is worse
     * than leaving it uncoloured.
     */
    criticScore: real("critic_score"),
    criticVotes: integer("critic_votes").notNull().default(0),
    synced_at: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    /** Nullable: null means the tracklist has never been fetched. */
    tracksSyncedAt: timestamp("tracks_synced_at", { withTimezone: true }),
    mbSyncedAt: timestamp("mb_synced_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("albums_deezer_id_uq").on(table.deezerId),
    index("albums_artist_idx").on(table.artistId),
    index("albums_slug_idx").on(table.slug),
    index("albums_popularity_idx").on(table.popularity),
    index("albums_release_idx").on(table.releaseDate),
    index("albums_artist_release_idx").on(table.artistId, table.releaseDate),
    index("albums_canonical_popularity_idx").on(table.isCanonical, table.popularity),
  ],
);

export const tracks = pgTable(
  "tracks",
  {
    id: serial("id").primaryKey(),
    albumId: integer("album_id")
      .notNull()
      .references(() => albums.id, { onDelete: "cascade" }),
    /**
     * Denormalised, exactly as the original's `episodes` carries `show_id`. It makes "this
     * member's top tracks" one join shorter and it is what lets the discography heatmap read
     * every track for an artist without going through albums.
     */
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    deezerId: text("deezer_id").notNull(),
    /** Deezer disk_number. Defaults to 1; a single-disc album never shows a redundant "1-". */
    discNumber: integer("disc_number").notNull().default(1),
    /** Deezer track_position. Min 0, not 1 — a pregap or hidden track is legitimately 0. */
    trackNumber: integer("track_number").notNull(),
    title: varchar("title", { length: 300 }).notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    isrc: varchar("isrc", { length: 15 }),
    explicit: boolean("explicit").notNull().default(false),
    /**
     * Deezer's 30-second preview mp3. The URL is SIGNED AND EXPIRING (it carries an `exp=`
     * parameter), so it is refreshed on every album sync and a stale one simply fails to
     * play. Do not treat it as a permanent identifier.
     */
    previewUrl: text("preview_url"),
    /** Normalised 0..100. POPULARITY — streams, not quality. Never a heatmap colour source. */
    popularity: integer("popularity").notNull().default(0),
    /** MusicBrainz per-recording rating, already on the stored 0..10 scale. Usually NULL. */
    criticScore: real("critic_score"),
    criticVotes: integer("critic_votes").notNull().default(0),
    /** Display-only: the performing/featured credit when it differs from the album artist. */
    artistName: varchar("artist_name", { length: 200 }),
  },
  (table) => [
    // The addressable identity of a track. Every column is non-null, so this dedupes
    // correctly — unlike `list_items`, which needs an expression index for the same job.
    uniqueIndex("tracks_album_disc_track_uq").on(table.albumId, table.discNumber, table.trackNumber),
    index("tracks_album_idx").on(table.albumId),
    index("tracks_artist_idx").on(table.artistId),
    index("tracks_deezer_idx").on(table.deezerId),
  ],
);

export const credits = pgTable(
  "credits",
  {
    id: serial("id").primaryKey(),
    albumId: integer("album_id")
      .notNull()
      .references(() => albums.id, { onDelete: "cascade" }),
    /** No people table. Person data is denormalised per row, as in the original. */
    personId: text("person_id").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    picturePath: text("picture_path"),
    /** 'Main' | 'Featured' | a MusicBrainz relation type. NULLABLE — see the trap below. */
    role: varchar("role", { length: 40 }),
    /** artist | crew */
    kind: varchar("kind", { length: 8 }).notNull(),
    /** 999 - appearances, so the most-credited person leads. */
    creditOrder: integer("credit_order").notNull().default(999),
  },
  (table) => [
    /**
     * TRAP, inherited deliberately from the original so the workaround stays visible:
     * this index includes the NULLABLE `role`, and Postgres treats NULLs as DISTINCT in a
     * unique index. So `onConflictDoNothing` will NOT dedupe rows with a null role.
     *
     * Ingest sidesteps it by DELETEing all credits for the album before inserting.
     * DO NOT "optimise" that DELETE into a pure upsert.
     */
    uniqueIndex("credits_album_person_role_uq").on(table.albumId, table.personId, table.kind, table.role),
    index("credits_album_idx").on(table.albumId),
  ],
);

/**
 * THE NEIGHBOUR GRAPH — the table the television original does not have.
 *
 * The +0.3..+1.0 neighbour term is the largest single term in the recommender and the reason
 * ranking works at all; without it, every candidate in a genre pool lands within a few
 * hundredths of every other and the ordering collapses to the provider's own popularity
 * order. Its source was the top risk in this port, because Spotify deprecated both of the
 * obvious endpoints for new applications in late 2024.
 *
 * Deezer's `GET /artist/{id}/related` works and is used. It is cached here rather than
 * re-fetched per render because re-fetching the neighbour set on every /for-you request
 * would dominate the outbound budget, and because a cached table makes retrieval a pure SQL
 * join in the warm case.
 */
export const artistSimilar = pgTable(
  "artist_similar",
  {
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    similarId: integer("similar_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    /** deezer | lastfm | musicbrainz */
    source: varchar("source", { length: 12 }).notNull().default("deezer"),
    synced_at: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.artistId, table.similarId] }),
    index("artist_similar_position_idx").on(table.artistId, table.position),
  ],
);

/* ========================================================================== *
 * MEMBER DATA (11 tables)
 * ========================================================================== */

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    /** varchar(32) while the schema caps input at 24 — deliberately roomier than the rule. */
    username: varchar("username", { length: 32 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: varchar("display_name", { length: 64 }),
    bio: text("bio"),
    avatarSeed: varchar("avatar_seed", { length: 32 }),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    /**
     * member | admin. Never settable through any member-facing path: there is no action that
     * writes this column outside app/actions/admin.ts, so the only way to become an admin is
     * the operator running `npm run admin:grant`. Privilege escalation has to be impossible
     * by construction, not merely unimplemented — and tests/no-escalation.test.ts asserts it
     * at the source level so a future action fails a test rather than quietly shipping.
     *
     * ALWAYS read from this column, never from the session token.
     */
    role: varchar("role", { length: 16 }).notNull().default("member"),
    /**
     * The entire guest feature at schema level. A real row rather than browser storage, so
     * the diary, the heatmaps, the taste model and every other read work unchanged — a guest
     * is just a member whose credentials do not exist yet. The cost of that choice is that
     * guests must be kept out of every public surface, so every public aggregate filters on
     * this column. There is no database-level guard.
     */
    isGuest: boolean("is_guest").notNull().default(false),
    /** free | pro. Operator-set only; there is no billing. Read from here, never the token. */
    plan: varchar("plan", { length: 16 }).notNull().default("free"),
    planUpdatedAt: timestamp("plan_updated_at", { withTimezone: true }),
    /**
     * The privacy flag the television original lacks, where /@anyone/watchlist is fully
     * public to signed-out visitors. Checked in BOTH the page body and generateMetadata,
     * because a check on one of two entry points is how the original leaked private list
     * titles through <title> tags.
     */
    wantlistPrivate: boolean("wantlist_private").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * FUNCTIONAL unique indexes on lower(...), not plain ones.
     *
     * Sign-up used to check for collisions with lower() while the index was case-sensitive,
     * so two concurrent registrations of 'bob' and 'Bob' could both commit — and since
     * profile lookups resolve case-insensitively, one member's profile then became
     * unreachable. A unique index cannot lose that race; a read-then-write can.
     */
    uniqueIndex("users_username_lower_uq").on(sql`lower(${table.username})`),
    uniqueIndex("users_email_lower_uq").on(sql`lower(${table.email})`),
  ],
);

/**
 * `logs` — ONE table for listening, rating, reviewing, liking and the diary.
 *
 * The load-bearing decision of the whole system. Playing a track and reviewing an album
 * differ only in which columns are filled, which is why there is one `saveLog` rather than
 * six near-identical actions.
 *
 * THREE ENCODINGS CARRIED BY NULLABILITY:
 *   a listen mark                    -> a row with rating IS NULL
 *   a rating that never hit the diary -> listened_on IS NULL
 *   a replay                          -> A SECOND ROW, not a mutation
 *
 * ZERO UNIQUE CONSTRAINTS, AND THE ABSENCE IS THE FEATURE. A member holds many logs for the
 * same target because a replay is a real, separately-dated, separately-rated event. The cost
 * is paid on every read by DISTINCT ON (user_id) — and it matters MORE here than in
 * television, because relistening is the norm rather than the exception, so a member may
 * genuinely hold dozens of logs for one track.
 *
 * THERE IS NO `listened` BOOLEAN. At track level, "listened" means a track-targeted log row
 * exists, regardless of listened_on. A rating saved with "Add to diary" unchecked still
 * ticks the checkmark.
 */
export const logs = pgTable(
  "logs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** artist | album | track. DERIVED by targetTypeOf(), never accepted from a client. */
    targetType: varchar("target_type", { length: 8 }).notNull(),
    /**
     * The always-present anchor. For an album or track log this is RESOLVED FROM THE ALBUM
     * ROW server-side and never read from the request, which closes a whole class of
     * "log a track against the wrong artist" forgery without needing its own check.
     */
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    /** NULL for an artist-level log. An id, not an ordinal. */
    albumId: integer("album_id").references(() => albums.id, { onDelete: "cascade" }),
    discNumber: integer("disc_number"),
    trackNumber: integer("track_number"),
    /** 1..10. NULL means "listened, not rated". There is no 0 — zero stars is unrepresentable. */
    rating: smallint("rating"),
    review: text("review"),
    /** The diary date, in the MEMBER'S local calendar. NULL = a rating not in the diary. */
    listenedOn: date("listened_on"),
    is_replay: boolean("is_replay").notNull().default(false),
    /** The AUTHOR'S OWN heart on the thing they played. Not the `likes` table, which is others'. */
    liked: boolean("liked").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("logs_user_created_idx").on(table.userId, table.createdAt), // feed, profile
    /*
     * THE GLOBAL READS, which every other index on this table cannot serve.
     *
     * Seven indexes existed and all seven lead with `user_id`, `album_id` or `artist_id`. Three
     * reads have none of those in their predicate: `getGlobalFeed` (ORDER BY created_at DESC
     * LIMIT 24), `getRecentReviews` (review IS NOT NULL, same order) and `getMostRatedAlbums`
     * (a DISTINCT ON across every album-level log). All three run on `/`, which declares
     * `revalidate = 0` — so the home page was a sequential scan of the whole table on every
     * request, and `logs` is the table that grows fastest by design (a replay is a new row).
     *
     * The partial index is the one that matters most: reviews are a small minority of log rows,
     * so `WHERE review IS NOT NULL` keeps the index a fraction of the table's size while making
     * `getRecentReviews` a bounded scan of exactly the rows it wants.
     */
    index("logs_created_idx").on(table.createdAt),
    index("logs_listened_idx").on(table.listenedOn),
    index("logs_review_created_idx")
      .on(table.createdAt)
      .where(sql`${table.review} IS NOT NULL`),
    index("logs_user_listened_idx").on(table.userId, table.listenedOn), // diary
    // "what did this member rate for this target" -> the DISTINCT ON aggregates
    index("logs_target_user_idx").on(
      table.albumId,
      table.discNumber,
      table.trackNumber,
      table.userId,
      table.createdAt,
    ),
    // per-target rating aggregates
    index("logs_target_rating_idx").on(
      table.albumId,
      table.targetType,
      table.discNumber,
      table.trackNumber,
      table.rating,
    ),
    index("logs_artist_target_idx").on(table.artistId, table.targetType, table.userId, table.createdAt),
    index("logs_artist_idx").on(table.artistId),
    index("logs_album_idx").on(table.albumId),
  ],
);

export const logTags = pgTable(
  "log_tags",
  {
    logId: integer("log_id")
      .notNull()
      .references(() => logs.id, { onDelete: "cascade" }),
    tag: varchar("tag", { length: 32 }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.logId, table.tag] }), index("log_tags_tag_idx").on(table.tag)],
);

/** The watchlist analogue. Albums only — nobody queues an artist. */
export const wantlist = pgTable(
  "wantlist",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    albumId: integer("album_id")
      .notNull()
      .references(() => albums.id, { onDelete: "cascade" }),
    note: text("note"),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.albumId] }),
    index("wantlist_user_added_idx").on(table.userId, table.addedAt),
  ],
);

/**
 * The pinned Top Four ALBUMS (albums are the natural profile-pin unit for music, not artists).
 *
 * Keyed by SLOT, not by album — so the database will happily let the same album occupy two
 * slots. `setFavorite` prevents it by DELETEing any row holding that album for that user
 * before the slot upsert. Those are two non-transactional statements, so a failure between
 * them leaves the album in no slot at all; any second write path must repeat the delete.
 */
export const favorites = pgTable(
  "favorites",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(), // 1..4
    albumId: integer("album_id")
      .notNull()
      .references(() => albums.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.position] })],
);

/**
 * DESERT ISLAND — a quota'd honour on an individual TRACK.
 *
 * A separate table rather than a `logs` column, for three reasons: the honour belongs to the
 * track rather than to one play of it; a member can hold several logs for the same track
 * after a replay; and the quota is counted per member, which is one index scan here instead
 * of a filtered count over every log they own.
 *
 * Tracks only, so album_id/disc_number/track_number are all non-null and a plain unique
 * index dedupes correctly.
 */
export const desertIsland = pgTable(
  "desert_island",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    albumId: integer("album_id")
      .notNull()
      .references(() => albums.id, { onDelete: "cascade" }),
    discNumber: integer("disc_number").notNull(),
    trackNumber: integer("track_number").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("desert_island_target_uq").on(table.userId, table.albumId, table.discNumber, table.trackNumber),
    index("desert_island_user_created_idx").on(table.userId, table.createdAt),
  ],
);

/**
 * A directed follow graph. The composite PK indexes the forward direction for free and makes
 * a duplicate follow impossible at the database level; the extra index serves the reverse.
 * No mutual/friend concept, no pending state, no block list. Nothing at DB level forbids a
 * self-follow — `toggleFollow` does.
 */
export const follows = pgTable(
  "follows",
  {
    followerId: integer("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followeeId: integer("followee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.followerId, table.followeeId] }),
    index("follows_followee_idx").on(table.followeeId),
  ],
);

export const lists = pgTable(
  "lists",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 120 }).notNull(),
    /**
     * NOT unique at any scope, and regenerated from the title on every update, so it is
     * neither unique nor stable. Nothing reads it as a key: parseListSlug throws the slug
     * away and uses only the trailing integer, so `/list/17` is a valid URL — which the
     * clone button relies on. Adding a uniqueness constraint would break `updateList` for
     * zero benefit.
     */
    slug: text("slug").notNull(),
    description: text("description"),
    isRanked: boolean("is_ranked").notNull().default(false),
    isPublic: boolean("is_public").notNull().default(true),
    /** Deliberately has NO foreign key: a clone must survive its source being deleted. */
    clonedFromId: integer("cloned_from_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("lists_user_updated_idx").on(table.userId, table.updatedAt),
    index("lists_public_updated_idx").on(table.isPublic, table.updatedAt),
  ],
);

/**
 * POLYMORPHIC list items — the one real structural change to the lists subsystem.
 *
 * The television original's list items can hold only series. A music list of TRACKS (a
 * playlist) is the obvious primary use case, so these carry the same target columns `logs`
 * does.
 */
export const listItems = pgTable(
  "list_items",
  {
    id: serial("id").primaryKey(),
    listId: integer("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    targetType: varchar("target_type", { length: 8 }).notNull(), // artist | album | track
    artistId: integer("artist_id")
      .notNull()
      .references(() => artists.id, { onDelete: "cascade" }),
    albumId: integer("album_id").references(() => albums.id, { onDelete: "cascade" }),
    discNumber: integer("disc_number"),
    trackNumber: integer("track_number"),
    position: integer("position").notNull().default(0),
    note: text("note"),
  },
  (table) => [
    /**
     * AN EXPRESSION INDEX, AND IT HAS TO BE.
     *
     * A plain unique index over (list_id, target_type, artist_id, album_id, disc_number,
     * track_number) would NOT dedupe album-level items, because disc_number and track_number
     * are NULL there and Postgres treats NULLs as distinct — so the same album could be added
     * to one list any number of times. COALESCE collapses them to a comparable 0.
     *
     * This is the entire duplicate-prevention mechanism, relied on by onConflictDoNothing().
     * Behaves identically on both drivers.
     */
    uniqueIndex("list_items_target_uq").on(
      table.listId,
      table.targetType,
      table.artistId,
      sql`coalesce(${table.albumId}, 0)`,
      sql`coalesce(${table.discNumber}, 0)`,
      sql`coalesce(${table.trackNumber}, 0)`,
    ),
    index("list_items_list_position_idx").on(table.listId, table.position),
  ],
);

/**
 * OTHER MEMBERS hearting a review or a list. Not logs.liked (the author's own heart) and not
 * lib/like.ts (SQL LIKE escaping). Three unrelated meanings of "like" in one codebase.
 *
 * The composite PK is the dedupe mechanism; the secondary index serves counting and the
 * popular sort. Counts are NEVER denormalised — always a correlated subquery, so no counter
 * can drift. `target_id` has no FK because the target is polymorphic.
 */
export const likes = pgTable(
  "likes",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetType: varchar("target_type", { length: 8 }).notNull(), // log | list
    targetId: integer("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.targetType, table.targetId] }),
    index("likes_target_idx").on(table.targetType, table.targetId),
  ],
);

/** Flat. No parent_id, no depth, no path — depth is exactly 1. */
export const comments = pgTable(
  "comments",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetType: varchar("target_type", { length: 8 }).notNull(), // log | list
    targetId: integer("target_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("comments_target_idx").on(table.targetType, table.targetId, table.createdAt)],
);

/* ========================================================================== *
 * OPERATIONAL (6 tables)
 * ========================================================================== */

/**
 * Two structurally identical token tables, DELIBERATELY not one, so a bug in one flow cannot
 * redeem a token minted by the other. Only the SHA-256 of a token is ever stored: a database
 * leak then yields nothing redeemable. SHA-256 rather than a slow KDF because the token is
 * 256 bits of CSPRNG output, so there is nothing to brute force.
 */
export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** Bound at issue, so a later email change cannot be confirmed by an old link. */
    email: varchar("email", { length: 255 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("email_verification_token_hash_uq").on(table.tokenHash),
    index("email_verification_user_idx").on(table.userId),
  ],
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("password_reset_token_hash_uq").on(table.tokenHash),
    index("password_reset_user_idx").on(table.userId),
  ],
);

/**
 * `actor_id` and `target_id` deliberately have NO foreign key, and the usernames are copied
 * at write time. Deleting a member wipes their logs, lists, pins and crowns — but leaves
 * these rows intact, because an audit trail that vanishes with the account it describes is
 * not an audit trail.
 *
 * "Append-only" is a convention, not an enforcement: no trigger, no REVOKE, no hash chain.
 * Anyone with database credentials can rewrite history — and database credentials are also
 * the grant mechanism, so the operator is fully trusted by construction.
 */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: serial("id").primaryKey(),
    actorId: integer("actor_id"),
    actorUsername: varchar("actor_username", { length: 32 }).notNull(),
    action: varchar("action", { length: 32 }).notNull(),
    targetId: integer("target_id"),
    targetUsername: varchar("target_username", { length: 32 }),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("admin_audit_created_idx").on(table.createdAt)],
);

/**
 * Fixed-window counters, kept in Postgres ON PURPOSE: an in-process counter is per-instance,
 * and serverless runs many instances, so an attacker spreading requests across them would
 * face no limit at all.
 *
 * Growth is bounded by distinct (bucket, identity) pairs forever — including every IP that
 * ever searched and EVERY EMAIL ADDRESS EVER TRIED AT SIGN-IN. That makes this table a list
 * of email addresses, so any data-retention or PII review must cover it. Unlike the original,
 * something actually prunes it: /api/cron/prune.
 */
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(), // "bucket:identity"
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
  count: integer("count").notNull().default(0),
});

/**
 * House ads. First-party rows only — no third-party script, no ad network, no pixel, which
 * is why the CSP needs no holes cut in it.
 *
 * THERE IS DELIBERATELY NO IMAGE COLUMN. Uploads would need a bucket, and remote images
 * would need host allowlisting plus a review process for what those hosts serve. A headline,
 * a line of copy and a credit are enough, and they cannot carry a tracking pixel.
 */
export const ads = pgTable(
  "ads",
  {
    id: serial("id").primaryKey(),
    /** general | indie — indie is the independent-artist / small-label spotlight. */
    kind: varchar("kind", { length: 8 }).notNull().default("general"),
    /** feed | sidebar | any */
    slot: varchar("slot", { length: 8 }).notNull().default("any"),
    /** draft | active | paused | archived  — 'archived' is 8 chars, exactly the width. */
    status: varchar("status", { length: 8 }).notNull().default("draft"),
    headline: varchar("headline", { length: 120 }).notNull(),
    body: varchar("body", { length: 240 }).notNull(),
    ctaLabel: varchar("cta_label", { length: 40 }).notNull(),
    targetUrl: text("target_url").notNull(),
    /** The indie credit block. An indie placement without a credit is just an ad with a blue border. */
    creatorName: varchar("creator_name", { length: 120 }),
    /** single | ep | lp | mixtape */
    projectKind: varchar("project_kind", { length: 12 }),
    label: varchar("label", { length: 120 }),
    /** A scoring BONUS (x2 weight on a match), never a filter. */
    genres: jsonb("genres").$type<string[]>().notNull().default([]),
    weight: smallint("weight").notNull().default(1), // 1..100
    startsAt: timestamp("starts_at", { withTimezone: true }),
    /** Half-open window: eligible while ends_at > now(). */
    endsAt: timestamp("ends_at", { withTimezone: true }),
    impressions: integer("impressions").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    /** The ONLY ON DELETE SET NULL foreign key in the schema. */
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("ads_status_kind_slot_idx").on(table.status, table.kind, table.slot)],
);

/**
 * ONE ROW PER AD PER DAY, never one row per impression: an advertiser needs a daily curve,
 * and nobody needs a log of which member saw which ad. That is a deliberate limit on what
 * this table can ever be used for, and a test asserts it by checking that the row's keys do
 * not include a user id.
 */
export const adStats = pgTable(
  "ad_stats",
  {
    id: serial("id").primaryKey(),
    adId: integer("ad_id")
      .notNull()
      .references(() => ads.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    impressions: integer("impressions").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
  },
  (table) => [uniqueIndex("ad_stats_ad_day_uq").on(table.adId, table.day)],
);

/* ========================================================================== *
 * RELATIONS — for `db.query.*` only. The aggregate reads are raw SQL.
 * ========================================================================== */

export const artistsRelations = relations(artists, ({ many }) => ({
  albums: many(albums),
  tracks: many(tracks),
}));

export const albumsRelations = relations(albums, ({ one, many }) => ({
  artist: one(artists, { fields: [albums.artistId], references: [artists.id] }),
  tracks: many(tracks),
  credits: many(credits),
}));

export const tracksRelations = relations(tracks, ({ one }) => ({
  album: one(albums, { fields: [tracks.albumId], references: [albums.id] }),
  artist: one(artists, { fields: [tracks.artistId], references: [artists.id] }),
}));

export const creditsRelations = relations(credits, ({ one }) => ({
  album: one(albums, { fields: [credits.albumId], references: [albums.id] }),
}));

export const logsRelations = relations(logs, ({ one, many }) => ({
  user: one(users, { fields: [logs.userId], references: [users.id] }),
  artist: one(artists, { fields: [logs.artistId], references: [artists.id] }),
  album: one(albums, { fields: [logs.albumId], references: [albums.id] }),
  tags: many(logTags),
}));

export const logTagsRelations = relations(logTags, ({ one }) => ({
  log: one(logs, { fields: [logTags.logId], references: [logs.id] }),
}));

export const listsRelations = relations(lists, ({ one, many }) => ({
  user: one(users, { fields: [lists.userId], references: [users.id] }),
  items: many(listItems),
}));

export const listItemsRelations = relations(listItems, ({ one }) => ({
  list: one(lists, { fields: [listItems.listId], references: [lists.id] }),
  artist: one(artists, { fields: [listItems.artistId], references: [artists.id] }),
  album: one(albums, { fields: [listItems.albumId], references: [albums.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  logs: many(logs),
  lists: many(lists),
}));

/* ========================================================================== *
 * INSERT / SELECT TYPES
 * ========================================================================== */

export type Artist = typeof artists.$inferSelect;
export type NewArtist = typeof artists.$inferInsert;
export type Album = typeof albums.$inferSelect;
export type NewAlbum = typeof albums.$inferInsert;
export type Track = typeof tracks.$inferSelect;
export type NewTrack = typeof tracks.$inferInsert;
export type Credit = typeof credits.$inferSelect;
export type NewCredit = typeof credits.$inferInsert;
export type ArtistSimilar = typeof artistSimilar.$inferSelect;
export type NewArtistSimilar = typeof artistSimilar.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Log = typeof logs.$inferSelect;
export type NewLog = typeof logs.$inferInsert;
export type List = typeof lists.$inferSelect;
export type NewList = typeof lists.$inferInsert;
export type ListItem = typeof listItems.$inferSelect;
export type NewListItem = typeof listItems.$inferInsert;
export type Ad = typeof ads.$inferSelect;
export type NewAd = typeof ads.$inferInsert;

/** The three loggable tiers. Derived by targetTypeOf(); never accepted from a client. */
export type TargetType = "artist" | "album" | "track";
/** The two likeable/commentable containers. Comments cannot be liked. */
export type SocialTargetType = "log" | "list";

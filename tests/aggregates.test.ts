import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The `DISTINCT ON` family, against a REAL throwaway Postgres.
 *
 * These are the three invariants the whole aggregation layer rests on, and all three fail
 * SILENTLY — the interface shows a plausible number, nothing crashes, and nobody can tell by
 * looking:
 *
 *   I-10  Every community aggregate needs `DISTINCT ON (user_id …)`. A plain AVG counts a
 *         member once per replay. Six queries carry the pattern INDEPENDENTLY; nothing
 *         centralises it, so each one needs its own assertion.
 *   I-11  Keep the `(rating IS NOT NULL) DESC` tiebreak. Without it, a bare listen mark added
 *         AFTER a rating silently withdraws that member's vote from the average.
 *   I-12  Every public aggregate needs `u.is_guest = false`. There is no database-level guard.
 *
 * I-10 and I-11 matter MORE here than in the television original, because relistening is the
 * norm in music rather than the exception: a member may hold dozens of rows for one track.
 */

let dataDir: string;

type Module = {
  db: typeof import("@/lib/db").db;
  schema: typeof import("@/lib/db/schema");
  albums: typeof import("@/lib/db/queries/albums");
  artists: typeof import("@/lib/db/queries/artists");
  profile: typeof import("@/lib/stats/profile");
};

let mod: Module;
let artistId: number;
let albumId: number;
let memberA: number;
let memberB: number;
let guestId: number;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "deadwax-agg-"));
  process.env.PGLITE_DATA_DIR = dataDir;
  delete process.env.DATABASE_URL; // ← non-negotiable

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const schema = await import("@/lib/db/schema");

  const client = new PGlite(dataDir);
  await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
  await client.close();

  mod = {
    db: (await import("@/lib/db")).db,
    schema,
    albums: await import("@/lib/db/queries/albums"),
    artists: await import("@/lib/db/queries/artists"),
    profile: await import("@/lib/stats/profile"),
  };
}, 120_000);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

beforeEach(async () => {
  const { db, schema } = mod;
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`TRUNCATE users, artists RESTART IDENTITY CASCADE`);

  const members = await db
    .insert(schema.users)
    .values([
      { username: "membera", email: "a@test.invalid", passwordHash: "x" },
      { username: "memberb", email: "b@test.invalid", passwordHash: "x" },
      { username: "guest_aaaaaaaaaa", email: "guest_aaaaaaaaaa@guest.invalid", passwordHash: "x", isGuest: true },
    ])
    .returning({ id: schema.users.id });
  memberA = members[0]!.id;
  memberB = members[1]!.id;
  guestId = members[2]!.id;

  const [artist] = await db
    .insert(schema.artists)
    .values({ deezerId: "a1", name: "Test Artist", slug: "test-artist" })
    .returning({ id: schema.artists.id });
  artistId = artist!.id;

  const [album] = await db
    .insert(schema.albums)
    .values({
      deezerId: "al1",
      artistId,
      title: "Test Album",
      slug: "test-album",
      trackCount: 4,
      isCanonical: true,
      releaseDate: "2001-01-01",
    })
    .returning({ id: schema.albums.id });
  albumId = album!.id;

  await db.insert(schema.tracks).values(
    [1, 2, 3, 4].map((n) => ({
      albumId,
      artistId,
      deezerId: `t${n}`,
      discNumber: 1,
      trackNumber: n,
      title: `Track ${n}`,
      durationMs: 240_000,
    })),
  );
});

type LogSpec = {
  userId: number;
  type: "artist" | "album" | "track";
  rating?: number | null;
  trackNumber?: number;
  liked?: boolean;
  replay?: boolean;
  listenedOn?: string;
};

async function log(spec: LogSpec): Promise<void> {
  await mod.db.insert(mod.schema.logs).values({
    userId: spec.userId,
    targetType: spec.type,
    artistId,
    albumId: spec.type === "artist" ? null : albumId,
    discNumber: spec.type === "track" ? 1 : null,
    trackNumber: spec.type === "track" ? (spec.trackNumber ?? 1) : null,
    rating: spec.rating === undefined ? null : spec.rating,
    liked: spec.liked ?? false,
    is_replay: spec.replay ?? false,
    listenedOn: spec.listenedOn ?? null,
  });
}

describe("I-10 — one vote per member, however many times they played it", () => {
  it("counts a member once no matter how many rated rows they hold", async () => {
    /**
     * A plain `AVG(rating)` would let one enthusiastic member vote five times. In music that is
     * not a corner case: `logs` has zero unique constraints precisely so a replay is a second
     * row, and a listener who plays a record weekly accumulates rows weekly.
     */
    await log({ userId: memberA, type: "album", rating: 10 });
    await log({ userId: memberA, type: "album", rating: 10, replay: true });
    await log({ userId: memberA, type: "album", rating: 10, replay: true });
    await log({ userId: memberB, type: "album", rating: 4 });

    const stats = await mod.albums.getRatingStats({ type: "album", albumId });
    expect(stats.ratingCount).toBe(2);
    // The honest mean of two members is 7, not the 8.5 a row-weighted mean would report.
    expect(stats.average).toBeCloseTo(7, 6);
  });

  it("takes the NEWEST rating when a member revises their verdict", async () => {
    // A replay is a separately-dated, separately-rated event, so the newest row is the one that
    // represents what they think now.
    await log({ userId: memberA, type: "album", rating: 3 });
    await log({ userId: memberA, type: "album", rating: 9, replay: true });

    const stats = await mod.albums.getRatingStats({ type: "album", albumId });
    expect(stats.ratingCount).toBe(1);
    expect(stats.average).toBe(9);
  });

  it("counts listeners separately from raters", async () => {
    // "Listened by" is a row existing at all; "rated by" is a row with a rating. A member who
    // played it without rating it is one listener and no votes.
    await log({ userId: memberA, type: "album", rating: 8 });
    await log({ userId: memberB, type: "album" });

    const stats = await mod.albums.getRatingStats({ type: "album", albumId });
    expect(stats.listenedBy).toBe(2);
    expect(stats.ratingCount).toBe(1);
  });

  it("holds at track scope, where relistening is heaviest", async () => {
    for (let index = 0; index < 6; index += 1) {
      await log({ userId: memberA, type: "track", trackNumber: 1, rating: 9, replay: index > 0 });
    }
    const stats = await mod.albums.getRatingStats({ type: "track", albumId, disc: 1, track: 1 });
    expect(stats.ratingCount).toBe(1);
  });

  it("holds at artist scope", async () => {
    await log({ userId: memberA, type: "artist", rating: 10 });
    await log({ userId: memberA, type: "artist", rating: 10, replay: true });
    const stats = await mod.albums.getRatingStats({ type: "artist", artistId });
    expect(stats.ratingCount).toBe(1);
  });

  it("holds in getTrackAggregates, which feeds the heatmaps", async () => {
    await log({ userId: memberA, type: "track", trackNumber: 2, rating: 10 });
    await log({ userId: memberA, type: "track", trackNumber: 2, rating: 10, replay: true });
    await log({ userId: memberB, type: "track", trackNumber: 2, rating: 6 });

    const map = await mod.albums.getTrackAggregates(albumId);
    const cell = map.get(mod.albums.albumTrackKey(albumId, 1, 2));
    expect(cell?.ratingCount).toBe(2);
    expect(cell?.average).toBeCloseTo(8, 6);
  });

  it("holds in getAlbumAggregates, which feeds the discography grid", async () => {
    await log({ userId: memberA, type: "album", rating: 10 });
    await log({ userId: memberA, type: "album", rating: 10, replay: true });
    const map = await mod.artists.getAlbumAggregates(artistId);
    expect(map.get(albumId)?.ratingCount).toBe(1);
  });
});

describe("I-11 — a rating survives a later unrated replay", () => {
  it("does NOT withdraw the vote when a bare listen mark is added afterwards", async () => {
    /**
     * THE MOST DANGEROUS ORDERING IN THE WHOLE QUERY LAYER, and the one that shipped broken in
     * the source project.
     *
     * `DISTINCT ON (user_id)` keeps the FIRST row per member under the ORDER BY. Ordering by
     * `created_at DESC` alone keeps the newest — which, if the newest row is a bare replay mark
     * with `rating IS NULL`, silently removes that member's rating from the community average.
     * Playing a track again is the single most common thing a listener does, so this failure
     * would fire constantly and look like nothing at all.
     *
     * `(rating IS NOT NULL) DESC` fixes it because Postgres sorts `false < true`, so DESC puts
     * RATED rows first.
     */
    await log({ userId: memberA, type: "album", rating: 9 });
    await log({ userId: memberA, type: "album", rating: null, replay: true });

    const stats = await mod.albums.getRatingStats({ type: "album", albumId });
    expect(stats.ratingCount).toBe(1);
    expect(stats.average).toBe(9);
  });

  it("holds at track scope too", async () => {
    await log({ userId: memberA, type: "track", trackNumber: 3, rating: 10 });
    await log({ userId: memberA, type: "track", trackNumber: 3, rating: null, replay: true });

    const map = await mod.albums.getTrackAggregates(albumId);
    expect(map.get(mod.albums.albumTrackKey(albumId, 1, 3))?.ratingCount).toBe(1);
    expect(map.get(mod.albums.albumTrackKey(albumId, 1, 3))?.average).toBe(10);
  });

  it("still reports the member as a listener when they have only a bare mark", async () => {
    await log({ userId: memberA, type: "album" });
    const stats = await mod.albums.getRatingStats({ type: "album", albumId });
    expect(stats.listenedBy).toBe(1);
    expect(stats.ratingCount).toBe(0);
    // NULL, never 0: a displayed zero would be a measured verdict.
    expect(stats.average).toBeNull();
  });
});

describe("I-12 — guests never move a figure members read as consensus", () => {
  it("excludes a guest from the community average", async () => {
    // "One click of a guest's must not move a figure members read as consensus." There is no
    // database-level guard, so forgetting this predicate on a new aggregate is a silent
    // correctness bug that only a test would catch.
    await log({ userId: memberA, type: "album", rating: 8 });
    await log({ userId: guestId, type: "album", rating: 1 });

    const stats = await mod.albums.getRatingStats({ type: "album", albumId });
    expect(stats.ratingCount).toBe(1);
    expect(stats.average).toBe(8);
  });

  it("excludes a guest from the listener count and the like count", async () => {
    await log({ userId: guestId, type: "album", rating: 9, liked: true });
    const stats = await mod.albums.getRatingStats({ type: "album", albumId });
    expect(stats.listenedBy).toBe(0);
    expect(stats.likes).toBe(0);
  });

  it("excludes a guest from the track aggregates that colour the heatmaps", async () => {
    await log({ userId: guestId, type: "track", trackNumber: 1, rating: 1 });
    const map = await mod.albums.getTrackAggregates(albumId);
    expect(map.get(mod.albums.albumTrackKey(albumId, 1, 1))).toBeUndefined();
  });

  it("STILL COUNTS A GUEST'S OWN WORK ON THEIR OWN SURFACES", async () => {
    /**
     * The other half of the rule, and the reason the filter is applied per-query rather than
     * globally: a guest is "just a member whose credentials do not exist yet", so their diary,
     * their profile and their own statistics must read normally. A blanket exclusion would make
     * guest mode a demo of an empty app.
     */
    await log({ userId: guestId, type: "album", rating: 9 });
    await log({ userId: guestId, type: "track", trackNumber: 1, rating: 8 });

    const stats = await mod.profile.getProfileStats(guestId);
    expect(stats.ratingsGiven).toBe(2);
    expect(stats.tracksPlayed).toBe(1);
  });
});

describe("the histogram", () => {
  it("always has ten buckets whose counts sum to the rating count", async () => {
    // The cross-check that bucketing loses nobody. A mismatch means the count and the buckets
    // were computed over different row sets, and both render as a plausible chart.
    await log({ userId: memberA, type: "album", rating: 10 });
    await log({ userId: memberB, type: "album", rating: 3 });

    const stats = await mod.albums.getRatingStats({ type: "album", albumId });
    expect(stats.histogram.length).toBe(10);
    expect(stats.histogram.reduce((total, bucket) => total + bucket.count, 0)).toBe(stats.ratingCount);
  });

  it("keeps its shape at zero ratings", async () => {
    const stats = await mod.albums.getRatingStats({ type: "album", albumId });
    expect(stats.histogram.length).toBe(10);
    expect(stats.histogram.every((bucket) => bucket.count === 0 && bucket.ratio === 0)).toBe(true);
  });
});

describe("profile statistics", () => {
  it("counts a replayed track ONCE in the distinct-track total", async () => {
    // `DISTINCT` is the load-bearing word: every lifetime figure would double for a member who
    // relistens, which in music is the norm rather than the exception.
    await log({ userId: memberA, type: "track", trackNumber: 1, rating: 8 });
    await log({ userId: memberA, type: "track", trackNumber: 1, rating: null, replay: true });
    await log({ userId: memberA, type: "track", trackNumber: 2, rating: 7 });

    const stats = await mod.profile.getProfileStats(memberA);
    expect(stats.tracksPlayed).toBe(2);
  });

  it("counts raw log rows for ratings, reviews and diary entries — the deliberate asymmetry", async () => {
    /**
     * Tracks and minutes are DISTINCT-based; ratings, reviews and diary entries are RAW COUNTS
     * across all three tiers. That asymmetry is deliberate and is in the source too: "how many
     * tracks have I heard" is a question about the catalogue, whereas "how many ratings have I
     * given" is a question about the member's own activity, and a replay rated again IS a
     * second rating.
     */
    await log({ userId: memberA, type: "track", trackNumber: 1, rating: 8, listenedOn: "2026-01-01" });
    await log({ userId: memberA, type: "track", trackNumber: 1, rating: 9, replay: true, listenedOn: "2026-02-01" });

    const stats = await mod.profile.getProfileStats(memberA);
    expect(stats.tracksPlayed).toBe(1);
    expect(stats.ratingsGiven).toBe(2);
    expect(stats.diaryEntries).toBe(2);
  });

  it("sums listening time from real track durations with no fallback branch", async () => {
    // Every Deezer track carries a reliable duration, so the median-over-mirrored-rows
    // workaround the television original needs is deliberately not ported.
    await log({ userId: memberA, type: "track", trackNumber: 1 });
    await log({ userId: memberA, type: "track", trackNumber: 2 });
    const stats = await mod.profile.getProfileStats(memberA);
    // Two four-minute tracks.
    expect(stats.minutesPlayed).toBe(8);
  });

  it("never reports more listened tracks than an album has", async () => {
    /**
     * `clampListened` is MORE necessary here than in television. A MusicBrainz release group
     * carries multiple releases with different track counts — single, deluxe, remaster, regional
     * edition — so a listener's logged tracks can GENUINELY exceed the canonical count, and
     * "63 of 62" reads as a bug even when the underlying logs are correct.
     */
    await mod.db
      .update(mod.schema.albums)
      .set({ trackCount: 2 })
      .where((await import("drizzle-orm")).eq(mod.schema.albums.id, albumId));

    for (const trackNumber of [1, 2, 3, 4]) {
      await log({ userId: memberA, type: "track", trackNumber });
    }

    const completion = await mod.artists.getCompletion(memberA, artistId);
    expect(completion.tracksListened).toBeLessThanOrEqual(completion.tracks);
    expect(completion.percent).toBeLessThanOrEqual(100);
  });
});

describe("the taste signal", () => {
  it("prefers the ALBUM rating over the mean of its tracks", async () => {
    /**
     * `effective = COALESCE(album_level, track_level)`. The album rating always wins, "because
     * it is the more direct statement of how much they liked the thing" — an album verdict is
     * about the record, and a track mean is about the songs.
     */
    await log({ userId: memberA, type: "album", rating: 6 });
    await log({ userId: memberA, type: "track", trackNumber: 1, rating: 10 });
    await log({ userId: memberA, type: "track", trackNumber: 2, rating: 10 });

    const rated = await mod.albums.getRatedAlbumsForTaste(memberA);
    expect(rated.length).toBe(1);
    expect(rated[0]?.rating).toBe(6);
  });

  it("falls back to the track mean for a member who only rates tracks", async () => {
    // The leaf-only listener. Without the COALESCE their profile is empty and they are told
    // there is "not enough to go on", which looks like a cold start rather than a defect.
    await log({ userId: memberA, type: "track", trackNumber: 1, rating: 9 });
    await log({ userId: memberA, type: "track", trackNumber: 2, rating: 7 });

    const rated = await mod.albums.getRatedAlbumsForTaste(memberA);
    expect(rated.length).toBe(1);
    expect(rated[0]?.rating).toBeCloseTo(8, 6);
  });

  it("collapses a member's replays before averaging the tracks", async () => {
    await log({ userId: memberA, type: "track", trackNumber: 1, rating: 10 });
    await log({ userId: memberA, type: "track", trackNumber: 1, rating: 10, replay: true });
    await log({ userId: memberA, type: "track", trackNumber: 2, rating: 4 });

    const rated = await mod.albums.getRatedAlbumsForTaste(memberA);
    // Two distinct tracks, not three rows: 7, not 8.
    expect(rated[0]?.rating).toBeCloseTo(7, 6);
  });
});

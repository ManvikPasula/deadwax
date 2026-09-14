import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Desert Island, against a REAL throwaway Postgres.
 *
 * These seven cases are the reason the rule lives in `lib/desert-island/` rather than inside
 * a Server Action: "an action is a shell, and a rule that only exists inside one is a rule
 * nobody can prove." The quota is the most concurrency-sensitive code in the app, and every
 * one of its edges is a state a member can actually reach.
 *
 * THE BOOTSTRAP IS NOT BOILERPLATE. The database instance is memoised at first property read,
 * so `PGLITE_DATA_DIR` must be set and `DATABASE_URL` DELETED before anything imports
 * `@/lib/db` — which is why every import below is dynamic. A top-level static import in this
 * file would bind the wrong database, silently. And Vitest loads `.env.local`, so a developer
 * with a `DATABASE_URL` there would have `npm test` point at real Postgres were it not for the
 * explicit delete. NEVER REMOVE THAT LINE.
 */

let dataDir: string;

type Module = {
  db: typeof import("@/lib/db").db;
  schema: typeof import("@/lib/db/schema");
  cinema: typeof import("@/lib/desert-island");
};

let mod: Module;
let userId: number;
let artistId: number;
let albumId: number;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "deadwax-desert-"));
  process.env.PGLITE_DATA_DIR = dataDir;
  delete process.env.DATABASE_URL; // ← non-negotiable; see the docblock

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const schema = await import("@/lib/db/schema");

  const client = new PGlite(dataDir);
  await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
  await client.close();

  const dbModule = await import("@/lib/db");
  const cinema = await import("@/lib/desert-island");
  mod = { db: dbModule.db, schema, cinema };
}, 120_000);

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** Rewrites the world from scratch. The cascade graph is what makes this cheap. */
beforeEach(async () => {
  const { db, schema } = mod;
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`TRUNCATE users, artists RESTART IDENTITY CASCADE`);

  const [user] = await db
    .insert(schema.users)
    .values({ username: "islander", email: "islander@test.invalid", passwordHash: "x" })
    .returning({ id: schema.users.id });
  userId = user!.id;

  const [artist] = await db
    .insert(schema.artists)
    .values({ deezerId: "a1", name: "Test Artist", slug: "test-artist" })
    .returning({ id: schema.artists.id });
  artistId = artist!.id;

  const [album] = await db
    .insert(schema.albums)
    .values({ deezerId: "al1", artistId, title: "Test Album", slug: "test-album" })
    .returning({ id: schema.albums.id });
  albumId = album!.id;

  // Fifteen tracks, so the quota of ten has somewhere to overflow to.
  await db.insert(schema.tracks).values(
    Array.from({ length: 15 }, (_, index) => ({
      albumId,
      artistId,
      deezerId: `t${index + 1}`,
      discNumber: 1,
      trackNumber: index + 1,
      title: `Track ${index + 1}`,
      durationMs: 200_000,
    })),
  );
});

/** Writes a track-level rating, as a member would. A replay is a SECOND ROW, never an update. */
async function rate(trackNumber: number, rating: number | null): Promise<void> {
  await mod.db.insert(mod.schema.logs).values({
    userId,
    targetType: "track",
    artistId,
    albumId,
    discNumber: 1,
    trackNumber,
    rating,
  });
}

const target = (trackNumber: number) => ({ albumId, discNumber: 1, trackNumber, artistId });

describe("the entry condition", () => {
  it("refuses a track that has never been rated", async () => {
    const result = await mod.cinema.crownTrack(userId, target(1));
    expect(result).toEqual({ ok: false, reason: "not-five-star" });
  });

  it("refuses a track rated below the maximum — not 9, not 8", async () => {
    // "Five stars is the whole entry condition." Nine is not five stars.
    await rate(1, 9);
    expect(await mod.cinema.crownTrack(userId, target(1))).toEqual({ ok: false, reason: "not-five-star" });
  });

  it("accepts a track whose rating is the maximum", async () => {
    await rate(1, 10);
    const result = await mod.cinema.crownTrack(userId, target(1));
    expect(result.ok).toBe(true);
    expect(result.ok && result.marked).toBe(true);
    expect(result.ok && result.used).toBe(1);
  });

  it("asks what they think of it NOW, not whether they ever gave it five stars", async () => {
    /**
     * The `ORDER BY created_at DESC LIMIT 1` is the whole point of the gate. A member who rated
     * a track 10 and later revised it down to 6 must not be able to crown it — the qualifying
     * question is the current verdict.
     */
    await rate(1, 10);
    await rate(1, 6); // a later, lower rating
    expect(await mod.cinema.crownTrack(userId, target(1))).toEqual({ ok: false, reason: "not-five-star" });
  });

  it("ignores an unrated replay mark when finding the latest rating", async () => {
    // A bare replay row carries rating NULL. It must not shadow the real rating underneath it,
    // which is the same hazard the `(rating IS NOT NULL) DESC` tiebreak exists for in the
    // community aggregates.
    await rate(1, 10);
    await rate(1, null);
    const result = await mod.cinema.crownTrack(userId, target(1));
    expect(result.ok).toBe(true);
  });
});

describe("the quota", () => {
  async function crownTen(): Promise<void> {
    for (let track = 1; track <= 10; track += 1) {
      await rate(track, 10);
      const result = await mod.cinema.crownTrack(userId, target(track));
      expect(result.ok).toBe(true);
    }
  }

  it("allows exactly ten and refuses the eleventh", async () => {
    await crownTen();
    expect(await mod.cinema.countHeld(userId)).toBe(mod.cinema.DESERT_ISLAND_QUOTA);

    await rate(11, 10);
    expect(await mod.cinema.crownTrack(userId, target(11))).toEqual({ ok: false, reason: "quota-full" });
  });

  it("is IDEMPOTENT AT THE BOUNDARY — re-crowning the tenth is not refused", async () => {
    /**
     * THE CASE THIS TEST EXISTS FOR, and the reason the idempotence check precedes the quota
     * check in the transaction. At ten held, a naive order — count, compare, insert — would
     * refuse the member their OWN tenth crown on a second click, which reads as the feature
     * being broken.
     */
    await crownTen();
    const again = await mod.cinema.crownTrack(userId, target(10));
    expect(again.ok).toBe(true);
    expect(again.ok && again.marked).toBe(true);
    // And it must not have consumed a slot.
    expect(await mod.cinema.countHeld(userId)).toBe(10);
  });

  it("frees a slot the instant a mark is cleared — the limit is on marks HELD", async () => {
    await crownTen();
    await mod.cinema.uncrownTrack(userId, target(3));
    expect(await mod.cinema.countHeld(userId)).toBe(9);

    await rate(11, 10);
    const result = await mod.cinema.crownTrack(userId, target(11));
    expect(result.ok).toBe(true);
    expect(await mod.cinema.countHeld(userId)).toBe(10);
  });

  it("counts across every artist, not per artist", async () => {
    // "Ten marks held at once, ACROSS ALL ARTISTS." A per-artist quota would make the honour
    // meaningless for anyone with a broad library.
    const { db, schema } = mod;
    const [other] = await db
      .insert(schema.artists)
      .values({ deezerId: "a2", name: "Other", slug: "other" })
      .returning({ id: schema.artists.id });
    const [otherAlbum] = await db
      .insert(schema.albums)
      .values({ deezerId: "al2", artistId: other!.id, title: "Other Album", slug: "other-album" })
      .returning({ id: schema.albums.id });
    await db.insert(schema.tracks).values({
      albumId: otherAlbum!.id,
      artistId: other!.id,
      deezerId: "ot1",
      discNumber: 1,
      trackNumber: 1,
      title: "Other Track",
      durationMs: 1000,
    });

    await crownTen();
    await db.insert(schema.logs).values({
      userId,
      targetType: "track",
      artistId: other!.id,
      albumId: otherAlbum!.id,
      discNumber: 1,
      trackNumber: 1,
      rating: 10,
    });
    const result = await mod.cinema.crownTrack(userId, {
      albumId: otherAlbum!.id,
      discNumber: 1,
      trackNumber: 1,
      artistId: other!.id,
    });
    expect(result).toEqual({ ok: false, reason: "quota-full" });
  });
});

describe("uncrowning", () => {
  it("NEVER re-checks the rating", async () => {
    /**
     * "A member who has cooled on a song must be able to take the mark back, and requiring the
     * five stars to still be in place would TRAP THE SLOT behind a rating they no longer agree
     * with."
     */
    await rate(1, 10);
    await mod.cinema.crownTrack(userId, target(1));
    await rate(1, 2); // they have gone right off it
    const result = await mod.cinema.uncrownTrack(userId, target(1));
    expect(result.ok).toBe(true);
    expect(await mod.cinema.countHeld(userId)).toBe(0);
  });

  it("is a silent no-op on something never crowned", async () => {
    const result = await mod.cinema.uncrownTrack(userId, target(7));
    expect(result.ok).toBe(true);
    expect(result.used).toBe(0);
  });
});

describe("the mark outlives the rating that earned it", () => {
  it("keeps a crown after the rating is lowered, rather than silently discarding their choice", async () => {
    /**
     * The five-star precondition is DELIBERATELY NOT A DATABASE CONSTRAINT, and the profile read
     * deliberately does not filter on it either: "a member who later lowers the rating should
     * keep the mark until they clear it themselves rather than have the database silently
     * discard their choice."
     */
    await rate(1, 10);
    await mod.cinema.crownTrack(userId, target(1));
    await rate(1, 3);
    expect(await mod.cinema.isCrowned(userId, target(1))).toBe(true);
    expect(await mod.cinema.countHeld(userId)).toBe(1);
  });
});

describe("isolation between members", () => {
  it("does not let one member's crowns consume another's quota", async () => {
    const { db, schema } = mod;
    const [second] = await db
      .insert(schema.users)
      .values({ username: "other", email: "other@test.invalid", passwordHash: "x" })
      .returning({ id: schema.users.id });

    for (let track = 1; track <= 10; track += 1) {
      await rate(track, 10);
      await mod.cinema.crownTrack(userId, target(track));
    }

    await db.insert(schema.logs).values({
      userId: second!.id,
      targetType: "track",
      artistId,
      albumId,
      discNumber: 1,
      trackNumber: 1,
      rating: 10,
    });
    const result = await mod.cinema.crownTrack(second!.id, target(1));
    expect(result.ok).toBe(true);
    expect(await mod.cinema.countHeld(second!.id)).toBe(1);
    expect(await mod.cinema.countHeld(userId)).toBe(10);
  });
});

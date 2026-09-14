import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Guest mode and both conversion paths, against a REAL throwaway Postgres.
 *
 * The property being proved is the one the product promises in words: **"keep your logs" is a
 * FACT rather than a promise.** Path A claims the row in place so nothing moves at all; Path B
 * moves everything in one transaction, because "a half-merged guest would leave logs stranded
 * under a row nobody can sign into, which is indistinguishable from losing them."
 *
 * The bootstrap is not boilerplate — see tests/desert-island.test.ts for why every import here
 * is dynamic and why the `delete process.env.DATABASE_URL` line must never be removed.
 */

let dataDir: string;

type Module = {
  db: typeof import("@/lib/db").db;
  schema: typeof import("@/lib/db/schema");
  guest: typeof import("@/lib/auth/guest");
  claim: typeof import("@/lib/auth/claim");
  logs: typeof import("@/lib/db/queries/logs");
};

let mod: Module;
let artistId: number;
let albumId: number;
let otherAlbumId: number;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "deadwax-guest-"));
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
    guest: await import("@/lib/auth/guest"),
    claim: await import("@/lib/auth/claim"),
    logs: await import("@/lib/db/queries/logs"),
  };
}, 120_000);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

beforeEach(async () => {
  const { db, schema } = mod;
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`TRUNCATE users, artists RESTART IDENTITY CASCADE`);

  const [artist] = await db
    .insert(schema.artists)
    .values({ deezerId: "a1", name: "Test Artist", slug: "test-artist" })
    .returning({ id: schema.artists.id });
  artistId = artist!.id;

  const [album] = await db
    .insert(schema.albums)
    .values({ deezerId: "al1", artistId, title: "Album One", slug: "album-one", trackCount: 3 })
    .returning({ id: schema.albums.id });
  albumId = album!.id;

  const [other] = await db
    .insert(schema.albums)
    .values({ deezerId: "al2", artistId, title: "Album Two", slug: "album-two", trackCount: 3 })
    .returning({ id: schema.albums.id });
  otherAlbumId = other!.id;

  for (const target of [albumId, otherAlbumId]) {
    await db.insert(schema.tracks).values(
      [1, 2, 3].map((n) => ({
        albumId: target,
        artistId,
        deezerId: `t${target}-${n}`,
        discNumber: 1,
        trackNumber: n,
        title: `Track ${n}`,
        durationMs: 180_000,
      })),
    );
  }
});

async function makeMember(username: string, email: string): Promise<number> {
  const [row] = await mod.db
    .insert(mod.schema.users)
    .values({ username, email, passwordHash: "x", emailVerifiedAt: new Date() })
    .returning({ id: mod.schema.users.id });
  return row!.id;
}

describe("createGuest", () => {
  it("mints an undeliverable identity and discards the plaintext", async () => {
    const account = await mod.guest.createGuest("198.51.100.7");

    expect(account.username.startsWith("guest_")).toBe(true);

    /**
     * THE RETURN TYPE DELIBERATELY OMITS THE EMAIL, so it is read from the row instead.
     *
     * `GuestAccount` is `{ id, username, avatarSeed }` and nothing more, which is right: the
     * address is a `.invalid` placeholder that exists only to satisfy a NOT NULL column, and
     * putting it in the value that becomes a session would invite a surface to display it. The
     * source shipped exactly that bug in a different place — a banner asking a guest to confirm
     * `guest_46ee4182c3@guest.invalid`.
     */
    const row = await mod.db.query.users.findFirst({
      where: (await import("drizzle-orm")).eq(mod.schema.users.id, account.id),
    });

    /**
     * `.invalid` IS AN RFC 2606 RESERVED TLD THAT CAN NEVER BE DELIVERED TO. `users.email` is
     * NOT NULL and a guest genuinely has no address, so the column needs a value that is
     * well-formed, unique per row and PROVABLY undeliverable. A plausible domain would
     * eventually receive real mail from a future flow that forgot to check `is_guest`.
     */
    expect(row?.email.endsWith("@guest.invalid")).toBe(true);
    expect(row?.isGuest).toBe(true);
    /**
     * The hash is of 32 random bytes whose PLAINTEXT WAS DISCARDED — not an empty string and
     * not a fixed sentinel, because "both would let one leaked value authenticate as every
     * guest at once if a login path ever stopped checking is_guest".
     */
    expect(row?.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    // Safe defaults, and they must never be derivable from anything a client sends.
    expect(row?.role).toBe("member");
    expect(row?.plan).toBe("free");
    expect(row?.emailVerifiedAt).toBeNull();
  });

  it("mints distinct identities", async () => {
    const a = await mod.guest.createGuest("198.51.100.8");
    const b = await mod.guest.createGuest("198.51.100.8");
    expect(a.id).not.toBe(b.id);
    expect(a.username).not.toBe(b.username);

    // The address is derived from the same random identity as the username, so distinctness
    // there follows — but it is the column with a unique index on it, so assert it directly.
    const { inArray } = await import("drizzle-orm");
    const rows = await mod.db
      .select({ email: mod.schema.users.email })
      .from(mod.schema.users)
      .where(inArray(mod.schema.users.id, [a.id, b.id]));
    expect(new Set(rows.map((row) => row.email)).size).toBe(2);
  });
});

describe("guestActivity — the nudge counts DISTINCT ALBUMS, not log rows", () => {
  it("reports one album for a whole record played through", async () => {
    /**
     * THE UNIT IS THE WHOLE CORRECTION. The television original counts rows, but one 40-minute
     * record played once through is eleven track rows — so a row count fires the nudge at
     * somebody who has engaged with a SINGLE ALBUM, which is precisely the "nagging somebody
     * who has not yet got anything worth keeping" the threshold was raised to avoid.
     */
    const account = await mod.guest.createGuest("198.51.100.9");
    const userId = account.id;

    for (const trackNumber of [1, 2, 3]) {
      await mod.db.insert(mod.schema.logs).values({
        userId,
        targetType: "track",
        artistId,
        albumId,
        discNumber: 1,
        trackNumber,
        rating: 8,
      });
    }

    const activity = await mod.guest.guestActivity(userId);
    expect(activity.logCount).toBe(3);
    expect(activity.distinctAlbums).toBe(1);
    // The nudge threshold compares against distinctAlbums, so three track logs must not trip it.
    expect(activity.distinctAlbums).toBeLessThan(mod.guest.GUEST_NUDGE_AFTER);
  });

  it("counts the leaving warning from the FIRST entry, which is a separate threshold", async () => {
    // The two are separated because the costs are not symmetric: a premature banner is noise,
    // and a missed leaving warning is permanent data loss.
    const account = await mod.guest.createGuest("198.51.100.10");
    const userId = account.id;
    expect((await mod.guest.guestActivity(userId)).logCount).toBe(0);

    await mod.db.insert(mod.schema.logs).values({
      userId,
      targetType: "album",
      artistId,
      albumId,
      rating: 9,
    });
    expect((await mod.guest.guestActivity(userId)).logCount).toBe(1);
  });
});

describe("the review cap, and the exclusion that makes it humane", () => {
  async function writeReview(userId: number, target: { albumId?: number; trackNumber?: number }): Promise<void> {
    await mod.db.insert(mod.schema.logs).values({
      userId,
      targetType: target.trackNumber !== undefined ? "track" : target.albumId !== undefined ? "album" : "artist",
      artistId,
      albumId: target.albumId ?? null,
      discNumber: target.trackNumber !== undefined ? 1 : null,
      trackNumber: target.trackNumber ?? null,
      review: "A real opinion.",
    });
  }

  it("counts reviews and reaches the cap at three", async () => {
    const account = await mod.guest.createGuest("198.51.100.11");
    const userId = account.id;

    expect(mod.guest.guestReviewCapReached(0)).toBe(false);
    await writeReview(userId, { albumId });
    await writeReview(userId, { albumId: otherAlbumId });
    expect(await mod.logs.countReviewsBy(userId)).toBe(2);
    expect(mod.guest.guestReviewCapReached(2)).toBe(false);

    await writeReview(userId, { albumId, trackNumber: 1 });
    expect(await mod.logs.countReviewsBy(userId)).toBe(3);
    expect(mod.guest.guestReviewCapReached(3)).toBe(true);
  });

  it("EXCLUDES THE TARGET BEING EDITED, so somebody at the cap can still revise their own words", async () => {
    /**
     * "A cap on new reviews is an offer; a cap on editing is a punishment." Without the
     * exclusion the count sees the member's own existing review, refuses, and freezes them out
     * of the three they already wrote.
     */
    const account = await mod.guest.createGuest("198.51.100.12");
    const userId = account.id;
    await writeReview(userId, { albumId });
    await writeReview(userId, { albumId: otherAlbumId });
    await writeReview(userId, { albumId, trackNumber: 1 });

    expect(await mod.logs.countReviewsBy(userId)).toBe(3);
    const excluding = await mod.logs.countReviewsBy(userId, { artistId, albumId });
    expect(excluding).toBe(2);
    expect(mod.guest.guestReviewCapReached(excluding)).toBe(false);
  });

  it("COUNTS ARTIST-LEVEL REVIEWS WHILE EXCLUDING AN ALBUM TARGET — the SQL NULL trap", async () => {
    /**
     * THE BUG THIS TEST EXISTS FOR, and it shipped in a deleted duplicate of this function
     * whose comment asserted it could not happen.
     *
     * The exclusion has to negate "is this the target being edited". A bare `NOT (artist_id = X
     * AND album_id = Y AND disc IS NULL AND track IS NULL)` looks safe — every operand is
     * either `IS NULL` or `= <literal>` — but that reasons about the SHAPE OF THE EXPRESSION
     * rather than the NULLABILITY OF THE COLUMN. `logs.album_id` is nullable, so `album_id = Y`
     * is NULL, not false, on every ARTIST-level row. `AND` propagates the NULL, `NOT NULL` is
     * NULL, and `WHERE NULL` DROPS THE ROW.
     *
     * The effect: editing an album-level review made every artist-level review the member held
     * stop counting, so A GUEST AT THE CAP WOULD BE HANDED ROOM THEY DID NOT HAVE. The
     * surviving implementation collapses the third value with `not coalesce(..., false)` before
     * negating, and this is the assertion that proves it.
     */
    const account = await mod.guest.createGuest("198.51.100.13");
    const userId = account.id;

    await writeReview(userId, {}); // artist-level: album_id IS NULL
    await writeReview(userId, { albumId }); // the one being edited
    await writeReview(userId, { albumId: otherAlbumId });

    expect(await mod.logs.countReviewsBy(userId)).toBe(3);

    // Excluding the album target must still count the ARTIST-level review. A bare NOT returns 1.
    const excluding = await mod.logs.countReviewsBy(userId, { artistId, albumId });
    expect(excluding).toBe(2);
  });

  it("ignores a whitespace-only review, because saveLog normalises it to NULL", async () => {
    // One definition of "has a review". A `<> ''` guard here would be a second rule about the
    // same thing, and two rules about one thing drift the first time either moves.
    const account = await mod.guest.createGuest("198.51.100.14");
    const userId = account.id;
    await mod.db.insert(mod.schema.logs).values({
      userId,
      targetType: "album",
      artistId,
      albumId,
      review: null,
      rating: 7,
    });
    expect(await mod.logs.countReviewsBy(userId)).toBe(0);
  });

  it("names the cap message so the client can render it as an offer", () => {
    // The log dialog detects the cap by this substring, because ActionResult has no
    // machine-readable code field. "A refusal that says 'create an account' is not an error the
    // member can fix by trying again."
    expect(mod.guest.GUEST_REVIEW_CAP_MESSAGE).toContain("Create an account");
    expect(mod.guest.GUEST_REVIEW_CAP).toBe(3);
  });
});

describe("Path A — sign up claims the row IN PLACE", () => {
  it("keeps the same users.id, so NOTHING MOVES and nothing can half-fail", async () => {
    /**
     * "Every log, wantlist row, list, favourite and crown already points at the right owner.
     * THIS IS WHAT MAKES 'KEEP YOUR LOGS' A FACT RATHER THAN A PROMISE."
     */
    const account = await mod.guest.createGuest("198.51.100.20");
    const guestId = account.id;
    await mod.db.insert(mod.schema.logs).values({
      userId: guestId,
      targetType: "album",
      artistId,
      albumId,
      rating: 9,
    });

    const won = await mod.claim.claimGuestAccount({
      guestId,
      username: "newcomer",
      email: "newcomer@example.test",
      passwordHash: "$2b$12$abcdefghijklmnopqrstuv",
      displayName: "Newcomer",
      avatarSeed: mod.claim.newAvatarSeed(),
    });
    expect(won).toBe(true);

    const { eq } = await import("drizzle-orm");
    const row = await mod.db.query.users.findFirst({ where: eq(mod.schema.users.id, guestId) });
    expect(row?.isGuest).toBe(false);
    expect(row?.username).toBe("newcomer");

    const kept = await mod.db
      .select({ id: mod.schema.logs.id })
      .from(mod.schema.logs)
      .where(eq(mod.schema.logs.userId, guestId));
    expect(kept.length).toBe(1);
  });

  it("lets only ONE of two concurrent claims believe it won", async () => {
    /**
     * THE `is_guest = true` PREDICATE IS INSIDE THE UPDATE, NOT IN A SELECT BEFORE IT (I-30).
     * With a read-then-write, both claims see a guest row and both proceed, and the second
     * overwrites the first one's credentials with its own — so the first member's account
     * silently becomes somebody else's.
     */
    const account = await mod.guest.createGuest("198.51.100.21");
    const guestId = account.id;
    const seed = mod.claim.newAvatarSeed();

    const first = await mod.claim.claimGuestAccount({
      guestId,
      username: "firstin",
      email: "first@example.test",
      passwordHash: "$2b$12$abcdefghijklmnopqrstuv",
      displayName: null,
      avatarSeed: seed,
    });
    const second = await mod.claim.claimGuestAccount({
      guestId,
      username: "secondin",
      email: "second@example.test",
      passwordHash: "$2b$12$abcdefghijklmnopqrstuv",
      displayName: null,
      avatarSeed: seed,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);

    const { eq } = await import("drizzle-orm");
    const row = await mod.db.query.users.findFirst({ where: eq(mod.schema.users.id, guestId) });
    expect(row?.username).toBe("firstin");
  });

  it("refuses to claim a row that is not a guest", async () => {
    const memberId = await makeMember("established", "established@example.test");
    const won = await mod.claim.claimGuestAccount({
      guestId: memberId,
      username: "hijacker",
      email: "hijacker@example.test",
      passwordHash: "$2b$12$abcdefghijklmnopqrstuv",
      displayName: null,
      avatarSeed: mod.claim.newAvatarSeed(),
    });
    expect(won).toBe(false);
  });
});

describe("Path B — sign in merges onto an existing account", () => {
  async function guestWithEverything(ip: string): Promise<number> {
    const account = await mod.guest.createGuest(ip);
    const userId = account.id;
    const { schema, db } = mod;

    await db.insert(schema.logs).values([
      { userId, targetType: "album", artistId, albumId, rating: 9, review: "Mine." },
      { userId, targetType: "track", artistId, albumId, discNumber: 1, trackNumber: 1, rating: 10 },
    ]);
    await db.insert(schema.wantlist).values({ userId, albumId: otherAlbumId });
    await db.insert(schema.lists).values({ userId, title: "Guest list", slug: "guest-list" });
    await db.insert(schema.favorites).values({ userId, position: 1, albumId });
    await db.insert(schema.desertIsland).values({ userId, artistId, albumId, discNumber: 1, trackNumber: 1 });
    return userId;
  }

  it("moves logs, wantlist, lists and crowns, and discards favourites", async () => {
    const guestId = await guestWithEverything("198.51.100.30");
    const targetId = await makeMember("target", "target@example.test");

    const summary = await mod.claim.mergeGuestInto(guestId, targetId);
    expect(summary).not.toBeNull();
    expect(summary!.logs).toBe(2);
    expect(summary!.wantlist).toBe(1);
    expect(summary!.lists).toBe(1);
    /**
     * **`desert_island` IS IN THE MERGE, AND IT IS THE TABLE THE SOURCE FORGOT.** Invariant
     * I-36: every table a guest can write must appear explicitly in the merge transaction or be
     * deliberately listed as discarded. The original's equivalent is neither, so a guest's
     * crowns are silently cascade-deleted with the guest row — work the member did, gone, with
     * no message.
     */
    expect(summary!.desertIsland).toBe(1);
    /**
     * FAVOURITES ARE DELETED, NOT MERGED, and that is a decision rather than an omission:
     * "pinned favourites are keyed by slot, and the target's four are a deliberate arrangement,
     * so a guest's pins are dropped rather than shuffled into whatever slots happen to be
     * free."
     */
    expect(summary!.favoritesDiscarded).toBe(1);

    const { eq } = await import("drizzle-orm");
    const moved = await mod.db
      .select({ id: mod.schema.logs.id })
      .from(mod.schema.logs)
      .where(eq(mod.schema.logs.userId, targetId));
    expect(moved.length).toBe(2);

    /**
     * THE GUEST ROW IS DELETED: "leaving behind an unreachable account is how a users table
     * fills with debris."
     */
    const ghost = await mod.db.query.users.findFirst({ where: eq(mod.schema.users.id, guestId) });
    expect(ghost).toBeUndefined();
  });

  it("respects the Desert Island quota rather than overfilling it", async () => {
    // Merging must not hand the target eleven crowns. The quota is on marks HELD, and it is a
    // per-member invariant that a merge has no licence to break.
    const targetId = await makeMember("collector", "collector@example.test");
    const { db, schema } = mod;

    // Fill the target to the quota across ten distinct tracks.
    await db.insert(schema.albums).values({ deezerId: "al3", artistId, title: "Album Three", slug: "album-three" });
    const { eq } = await import("drizzle-orm");
    const third = await db.query.albums.findFirst({ where: eq(schema.albums.deezerId, "al3") });
    await db.insert(schema.tracks).values(
      Array.from({ length: 12 }, (_, index) => ({
        albumId: third!.id,
        artistId,
        deezerId: `t3-${index}`,
        discNumber: 1,
        trackNumber: index + 1,
        title: `T${index + 1}`,
        durationMs: 1000,
      })),
    );
    await db.insert(schema.desertIsland).values(
      Array.from({ length: 10 }, (_, index) => ({
        userId: targetId,
        artistId,
        albumId: third!.id,
        discNumber: 1,
        trackNumber: index + 1,
      })),
    );

    const guestId = await guestWithEverything("198.51.100.31");
    const summary = await mod.claim.mergeGuestInto(guestId, targetId);
    expect(summary).not.toBeNull();

    const held = await db
      .select({ id: schema.desertIsland.id })
      .from(schema.desertIsland)
      .where(eq(schema.desertIsland.userId, targetId));
    expect(held.length).toBeLessThanOrEqual(10);
  });

  it("lets the TARGET's wantlist note and date win on a collision", async () => {
    const targetId = await makeMember("owner", "owner@example.test");
    await mod.db.insert(mod.schema.wantlist).values({ userId: targetId, albumId: otherAlbumId, note: "theirs" });

    const guestId = await guestWithEverything("198.51.100.32");
    const summary = await mod.claim.mergeGuestInto(guestId, targetId);
    expect(summary).not.toBeNull();
    // The guest's duplicate row contributed nothing, and the target's note survived.
    expect(summary!.wantlist).toBe(0);

    const { and, eq } = await import("drizzle-orm");
    const row = await mod.db.query.wantlist.findFirst({
      where: and(eq(mod.schema.wantlist.userId, targetId), eq(mod.schema.wantlist.albumId, otherAlbumId)),
    });
    expect(row?.note).toBe("theirs");
  });

  it("refuses every degenerate merge", async () => {
    const guestId = (await mod.guest.createGuest("198.51.100.33")).id;
    const memberId = await makeMember("plain", "plain@example.test");
    const otherGuest = (await mod.guest.createGuest("198.51.100.34")).id;

    // Self-merge would delete the row at the end and take every log with it via the cascade.
    expect(await mod.claim.mergeGuestInto(guestId, guestId)).toBeNull();
    // A non-guest source is not a conversion.
    expect(await mod.claim.mergeGuestInto(memberId, guestId)).toBeNull();
    // A guest target would leave the work under a row nobody can sign into.
    expect(await mod.claim.mergeGuestInto(guestId, otherGuest)).toBeNull();
    // A missing target.
    expect(await mod.claim.mergeGuestInto(guestId, 999_999)).toBeNull();
  });

  it("resolves the target from the authenticated address, never from a caller's claim", async () => {
    // "Resolve the target from THE ADDRESS THAT JUST AUTHENTICATED, never from anything the
    // caller sent" — otherwise the merge endpoint is a way to move somebody else's guest data
    // into your own account.
    const targetId = await makeMember("byemail", "byemail@example.test");
    const guestId = await guestWithEverything("198.51.100.35");

    const summary = await mod.claim.mergeGuestByEmail(guestId, "BYEMAIL@example.test");
    expect(summary).not.toBeNull();

    const { eq } = await import("drizzle-orm");
    const moved = await mod.db
      .select({ id: mod.schema.logs.id })
      .from(mod.schema.logs)
      .where(eq(mod.schema.logs.userId, targetId));
    expect(moved.length).toBe(2);

    // An address with no account is not a merge target.
    const another = await mod.guest.createGuest("198.51.100.36");
    expect(await mod.claim.mergeGuestByEmail(Number(another.id), "nobody@example.test")).toBeNull();
  });
});

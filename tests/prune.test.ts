import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The retention sweep, against a REAL throwaway Postgres.
 *
 * A DELETE IS THE ONE STATEMENT THAT CANNOT BE VERIFIED BY READING IT. Every assertion here is
 * paired: something that must go, and something sitting one predicate away that must stay. A
 * sweep that removes too much is a data-loss bug reported by the person whose account vanished,
 * and by then the row is gone — so the guard has to be a test rather than a careful eye.
 *
 * `is_guest = true` on the dead-guest sweep is the line that matters most in this file, and it
 * is asserted from both sides: an old guest goes, an equally old MEMBER does not.
 *
 * No session seam is needed. `lib/db/queries/prune.ts` deliberately does not self-gate (its only
 * caller is a scheduler with no session, and none of its functions takes a parameter), so it
 * imports no auth chain — which is why this suite can drive the genuine articles directly.
 */

let dataDir: string;

type Module = {
  db: typeof import("@/lib/db").db;
  schema: typeof import("@/lib/db/schema");
  prune: typeof import("@/lib/db/queries/prune");
};

let mod: Module;
let memberId: number;
let logId: number;
let listId: number;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "deadwax-prune-"));
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
    prune: await import("@/lib/db/queries/prune"),
  };
}, 120_000);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

/**
 * One artist, one album, one member, one log and one list — the minimum that lets a like or a
 * comment have a target that genuinely exists, so "orphan" means orphan rather than "the fixture
 * never created it".
 */
beforeEach(async () => {
  const { db, schema } = mod;
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`TRUNCATE users, artists, rate_limits RESTART IDENTITY CASCADE`);

  const [member] = await db
    .insert(schema.users)
    .values({ username: "keeper", email: "keeper@test.invalid", passwordHash: "x" })
    .returning({ id: schema.users.id });
  memberId = member!.id;

  const [artist] = await db
    .insert(schema.artists)
    .values({ deezerId: "p-1", name: "Prune Test", slug: "prune-test" })
    .returning({ id: schema.artists.id });

  const [album] = await db
    .insert(schema.albums)
    .values({ deezerId: "pa-1", artistId: artist!.id, title: "Sweep", slug: "sweep" })
    .returning({ id: schema.albums.id });

  const [log] = await db
    .insert(schema.logs)
    .values({ userId: memberId, targetType: "album", artistId: artist!.id, albumId: album!.id, rating: 8 })
    .returning({ id: schema.logs.id });
  logId = log!.id;

  const [list] = await db
    .insert(schema.lists)
    .values({ userId: memberId, title: "Keepers", slug: "keepers" })
    .returning({ id: schema.lists.id });
  listId = list!.id;
});

/* -------------------------------------------------------------------------- */
/* Orphaned interactions                                                      */
/* -------------------------------------------------------------------------- */

describe("orphaned likes and comments", () => {
  it("LEAVES A LIKE WHOSE LOG STILL EXISTS", async () => {
    // The paired half of every assertion below. If this one ever fails, the sweep is deleting
    // live interactions and every other passing test in this file is meaningless.
    await mod.db.insert(mod.schema.likes).values({ userId: memberId, targetType: "log", targetId: logId });
    expect(await mod.prune.sweepOrphanedInteractions("likes")).toBe(0);
  });

  it("removes a like whose log was deleted", async () => {
    const { eq } = await import("drizzle-orm");
    await mod.db.insert(mod.schema.likes).values({ userId: memberId, targetType: "log", targetId: logId });
    /*
     * THE EXACT SEQUENCE THE ROUTE EXISTS FOR. `likes.target_id` has no foreign key — it cannot
     * have one, the target is polymorphic — so deleting the log leaves the like behind. Nothing
     * else in the application will ever remove it.
     */
    await mod.db.delete(mod.schema.logs).where(eq(mod.schema.logs.id, logId));
    expect(await mod.prune.sweepOrphanedInteractions("likes")).toBe(1);
  });

  it("leaves a like on a LIST and removes one whose list went", async () => {
    const { eq } = await import("drizzle-orm");
    await mod.db.insert(mod.schema.likes).values({ userId: memberId, targetType: "list", targetId: listId });
    // The second branch of the predicate: a list-targeted like is checked against `lists`, not
    // against `logs`. Checking the wrong table would sweep every list like on the platform.
    expect(await mod.prune.sweepOrphanedInteractions("likes")).toBe(0);

    await mod.db.delete(mod.schema.lists).where(eq(mod.schema.lists.id, listId));
    expect(await mod.prune.sweepOrphanedInteractions("likes")).toBe(1);
  });

  it("removes a row whose target_type is outside the vocabulary", async () => {
    /*
     * No writer can produce this today — `target_type` is Zod-validated at every action
     * boundary. It is swept anyway because a row no reader recognises is unreachable by
     * definition, and the alternative is a table that silently accumulates rows nothing will
     * ever look at again after some future schema change.
     */
    await mod.db.insert(mod.schema.likes).values({ userId: memberId, targetType: "album", targetId: 1 });
    expect(await mod.prune.sweepOrphanedInteractions("likes")).toBe(1);
  });

  it("SWEEPS COMMENTS THROUGH THE SAME HELPER, despite the different primary key", async () => {
    /*
     * The reason this is its own test rather than a parameter on the one above: `likes` has a
     * COMPOSITE primary key and no `id` column, `comments` has a serial. The first version of
     * the shared statement said `RETURNING t.id` and failed against the real database for
     * `likes` only — so both tables have to be exercised, not just the one the helper was
     * written against.
     */
    const { eq } = await import("drizzle-orm");
    await mod.db
      .insert(mod.schema.comments)
      .values({ userId: memberId, targetType: "log", targetId: logId, body: "Still here." });
    expect(await mod.prune.sweepOrphanedInteractions("comments")).toBe(0);

    await mod.db.delete(mod.schema.logs).where(eq(mod.schema.logs.id, logId));
    expect(await mod.prune.sweepOrphanedInteractions("comments")).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Dead guests — the sweep with the most to lose                              */
/* -------------------------------------------------------------------------- */

describe("dead guests", () => {
  /** A member row dated by hand, because `created_at` is what the sweep reads. */
  async function seedAccount(username: string, isGuest: boolean, ageDays: number): Promise<number> {
    const { sql } = await import("drizzle-orm");
    const rows = await mod.db.execute<{ id: number }>(sql`
      insert into users (username, email, password_hash, is_guest, created_at)
      values (${username}, ${`${username}@test.invalid`}, 'x', ${isGuest},
              now() - make_interval(days => ${ageDays}))
      returning id
    `);
    return rows.rows[0]!.id;
  }

  it("removes a guest older than the grace period", async () => {
    await seedAccount("ghost", true, mod.prune.GUEST_GRACE_DAYS + 1);
    expect(await mod.prune.sweepDeadGuests()).toBe(1);
  });

  it("LEAVES AN OLD MEMBER ALONE — `is_guest = true` is the entire scope", async () => {
    /*
     * THE MOST IMPORTANT ASSERTION IN THIS FILE. Drop `is_guest = true` from the statement and
     * the sweep deletes every account older than three weeks — every test above still passes,
     * and the failure is discovered by the members whose accounts are gone.
     */
    await seedAccount("veteran", false, mod.prune.GUEST_GRACE_DAYS + 400);
    expect(await mod.prune.sweepDeadGuests()).toBe(0);
  });

  it("leaves a guest inside the grace period, including one right at the boundary", async () => {
    await seedAccount("fresh", true, 1);
    // One day short of the cut: the comparison is strictly-less-than, so the boundary day is a
    // keep. A guest who visited on day 13 holds a cookie good until day 27, which is why the
    // grace is the session's 14 days plus a week rather than 14 exactly.
    await seedAccount("edge", true, mod.prune.GUEST_GRACE_DAYS - 1);
    expect(await mod.prune.sweepDeadGuests()).toBe(0);
  });

  it("takes an old guest's logs with them, in one statement", async () => {
    const { eq, sql } = await import("drizzle-orm");
    const guestId = await seedAccount("loud-ghost", true, mod.prune.GUEST_GRACE_DAYS + 5);
    const [artist] = await mod.db
      .insert(mod.schema.artists)
      .values({ deezerId: "p-2", name: "Cascade", slug: "cascade" })
      .returning({ id: mod.schema.artists.id });
    await mod.db
      .insert(mod.schema.logs)
      .values({ userId: guestId, targetType: "artist", artistId: artist!.id, rating: 5 });

    expect(await mod.prune.sweepDeadGuests()).toBe(1);

    // The cascade is the schema's job, not the sweep's — 28 foreign keys carry it. Asserted
    // here because "the row went" and "their data went" are different claims.
    const left = await mod.db.select().from(mod.schema.logs).where(eq(mod.schema.logs.userId, guestId));
    expect(left.length).toBe(0);
    const audit = await mod.db.execute<{ count: number }>(sql`select count(*)::int as count from users`);
    // `keeper` survives; only the guest went.
    expect(audit.rows[0]!.count).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Spent tokens                                                               */
/* -------------------------------------------------------------------------- */

describe("spent and expired link tokens", () => {
  async function seedToken(
    table: "email_verification_tokens" | "password_reset_tokens",
    options: { consumed: boolean; expiresInHours: number },
  ): Promise<void> {
    const { sql } = await import("drizzle-orm");
    await mod.db.execute(sql`
      insert into ${sql.raw(table)} (user_id, token_hash, email, expires_at, consumed_at)
      values (
        ${memberId}, 'deadbeef', 'keeper@test.invalid',
        now() + make_interval(hours => ${options.expiresInHours}),
        ${options.consumed ? sql`now()` : sql`null` }
      )
    `);
  }

  it("removes a CONSUMED token even though it has not expired", async () => {
    /*
     * The case the `users` cascade never covers: a live account with a spent reset row. The
     * hash is not a credential, but the row is a second copy of an email address with no
     * remaining purpose.
     */
    await seedToken("password_reset_tokens", { consumed: true, expiresInHours: 1 });
    expect(await mod.prune.sweepSpentTokens()).toBe(1);
  });

  it("removes a token expired beyond the support grace", async () => {
    await seedToken("email_verification_tokens", {
      consumed: false,
      expiresInHours: -(mod.prune.TOKEN_GRACE_HOURS + 1),
    });
    expect(await mod.prune.sweepSpentTokens()).toBe(1);
  });

  it("LEAVES A LIVE TOKEN, and leaves a recently-expired one for support", async () => {
    await seedToken("password_reset_tokens", { consumed: false, expiresInHours: 1 });
    // Expired, but inside the grace: somebody is about to ask why their link says expired, and
    // the answer is in this row.
    await seedToken("email_verification_tokens", { consumed: false, expiresInHours: -1 });
    expect(await mod.prune.sweepSpentTokens()).toBe(0);
  });

  it("sweeps both token tables, not just the first one", async () => {
    await seedToken("email_verification_tokens", { consumed: true, expiresInHours: 1 });
    await seedToken("password_reset_tokens", { consumed: true, expiresInHours: 1 });
    expect(await mod.prune.sweepSpentTokens()).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* The whole sweep                                                            */
/* -------------------------------------------------------------------------- */

describe("pruneAll", () => {
  it("reports one count per sweep, and reports zeroes on a clean database", async () => {
    const counts = await mod.prune.pruneAll();
    /*
     * The SHAPE is asserted as well as the values, because the response of this function is what
     * an operator reads in a cron log to decide whether the schedule is working. A sweep silently
     * dropped from the object would read as "nothing to remove" rather than "not checked".
     */
    expect(Object.keys(counts).sort()).toEqual([
      "deadGuests",
      "orphanedComments",
      "orphanedLikes",
      "rateLimits",
      "spentTokens",
    ]);
    for (const value of Object.values(counts)) expect(value).toBe(0);
  });

  it("prunes an old rate-limit window and leaves a live one", async () => {
    const { sql } = await import("drizzle-orm");
    await mod.db.execute(sql`
      insert into rate_limits (key, window_start, count)
      values ('search:ip:1.2.3.4', now() - make_interval(days => 2), 9),
             ('search:ip:5.6.7.8', now(), 1)
    `);
    const counts = await mod.prune.pruneAll();
    expect(counts.rateLimits).toBe(1);

    /*
     * WHY THIS TABLE IS SWEPT AT ALL, restated where it is tested: its keys include every email
     * address ever tried at sign-in, so an unbounded `rate_limits` is a list of email addresses.
     * That is a retention problem before it is ever a disk problem.
     */
    const left = await mod.db.execute<{ key: string }>(sql`select key from rate_limits`);
    expect(left.rows.map((row) => row.key)).toEqual(["search:ip:5.6.7.8"]);
  });
});

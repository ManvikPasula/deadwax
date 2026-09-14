import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The authorization layer, against a REAL throwaway Postgres.
 *
 * THE SESSION SEAM. Exactly ONE module is mocked — `@/lib/auth`'s `auth()` — driven by a
 * `signInAs(user | null)` helper, with `beforeEach(() => signInAs(null))` **so a test that
 * needs a session has to say so**. EVERYTHING BELOW THAT SEAM IS GENUINE, including the
 * database-resolved admin role: "the authorization checks are the ones that ship."
 *
 * What this cannot do, and why the dynamic probe exists: Server Actions need a request context
 * and cannot be invoked here, so the HTTP-level attacks — header policy, same-origin checks,
 * cookie flags, malformed routes — live in scripts/security-probe.ts instead.
 */

let dataDir: string;

/** The one mocked seam. Set by `signInAs`, read by the real session helpers. */
let sessionUser: { id: number; username: string; avatarSeed?: string | null; isGuest?: boolean } | null = null;

vi.mock("@/lib/auth", () => ({
  auth: async () => (sessionUser ? { user: { ...sessionUser, id: String(sessionUser.id) } } : null),
  handlers: { GET: async () => new Response(), POST: async () => new Response() },
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

function signInAs(user: typeof sessionUser): void {
  sessionUser = user;
}

type Module = {
  db: typeof import("@/lib/db").db;
  schema: typeof import("@/lib/db/schema");
  session: typeof import("@/lib/auth/session");
  admin: typeof import("@/lib/auth/admin");
  limit: typeof import("@/lib/security/rate-limit");
};

let mod: Module;
let memberId: number;
let guestId: number;
let adminId: number;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "deadwax-sec-"));
  process.env.PGLITE_DATA_DIR = dataDir;
  delete process.env.DATABASE_URL; // ← non-negotiable
  process.env.AUTH_SECRET ??= "test-secret-not-a-real-one";

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
    session: await import("@/lib/auth/session"),
    admin: await import("@/lib/auth/admin"),
    limit: await import("@/lib/security/rate-limit"),
  };
}, 120_000);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

beforeEach(async () => {
  // A test that needs a session has to say so.
  signInAs(null);

  const { db, schema } = mod;
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`TRUNCATE users, artists RESTART IDENTITY CASCADE`);
  await db.execute(sql`DELETE FROM rate_limits`);

  const rows = await db
    .insert(schema.users)
    .values([
      { username: "member", email: "member@test.invalid", passwordHash: "x" },
      { username: "guest_aaaaaaaaaa", email: "guest_aaaaaaaaaa@guest.invalid", passwordHash: "x", isGuest: true },
      { username: "operator", email: "operator@test.invalid", passwordHash: "x", role: "admin" },
    ])
    .returning({ id: schema.users.id });
  memberId = rows[0]!.id;
  guestId = rows[1]!.id;
  adminId = rows[2]!.id;
});

describe("the session read ladder", () => {
  it("currentUser costs no database read and returns null with no session", async () => {
    expect(await mod.session.currentUser()).toBeNull();
  });

  it("currentUser refuses a token whose id is not a safe integer", async () => {
    /**
     * The JWT is attacker-influenced only if the signing secret leaks, but the cheap path is
     * used by ~20 pages and the header, so it validates rather than trusting: an id of
     * "1e30" or "abc" must not become a `WHERE user_id = NaN` further down.
     */
    signInAs({ id: Number.NaN, username: "member" });
    expect(await mod.session.currentUser()).toBeNull();

    signInAs({ id: 1.5, username: "member" });
    expect(await mod.session.currentUser()).toBeNull();
  });

  it("currentUser refuses a token with no username", async () => {
    signInAs({ id: memberId, username: "" });
    expect(await mod.session.currentUser()).toBeNull();
  });

  it("requireUser throws for an anonymous caller", async () => {
    await expect(mod.session.requireUser()).rejects.toThrow();
  });

  it("requireUser REFUSES A TOKEN WHOSE ACCOUNT ROW IS GONE (I-17)", async () => {
    /**
     * THE WHOLE REASON `requireUser` COSTS A QUERY. These are stateless JWTs valid for their
     * full 14-day lifetime, so a token keeps asserting an identity after the row behind it has
     * been deleted. Reads tolerate that; WRITES MUST NOT. This is also the single revocation
     * point if account suspension is ever added.
     */
    const { eq } = await import("drizzle-orm");
    signInAs({ id: memberId, username: "member" });
    expect((await mod.session.requireUser()).id).toBe(memberId);

    await mod.db.delete(mod.schema.users).where(eq(mod.schema.users.id, memberId));
    await expect(mod.session.requireUser()).rejects.toThrow();
  });

  it("requireMember admits a member and refuses a guest, naming the action", async () => {
    signInAs({ id: memberId, username: "member" });
    await expect(mod.session.requireMember("follow other members")).resolves.toBeTruthy();

    signInAs({ id: guestId, username: "guest_aaaaaaaaaa" });
    await expect(mod.session.requireMember("follow other members")).rejects.toThrow(/follow other members/);
  });

  it("requireMember READS is_guest FROM THE COLUMN, not from the token (I-18)", async () => {
    /**
     * The token's `isGuest` is PRESENTATION ONLY. A guest whose token claims otherwise must
     * still be refused, and a member whose token claims it is a guest must still be admitted —
     * because the column is the fact and the token is a copy of it taken at sign-in.
     */
    signInAs({ id: guestId, username: "guest_aaaaaaaaaa", isGuest: false });
    await expect(mod.session.requireMember("like a review")).rejects.toThrow();

    signInAs({ id: memberId, username: "member", isGuest: true });
    await expect(mod.session.requireMember("like a review")).resolves.toBeTruthy();
  });
});

describe("requireAdmin — the role is never in the token", () => {
  it("throws for an anonymous caller and for an ordinary member", async () => {
    await expect(mod.admin.requireAdmin()).rejects.toThrow();

    signInAs({ id: memberId, username: "member" });
    await expect(mod.admin.requireAdmin()).rejects.toThrow();
  });

  it("admits a member whose ROW says admin", async () => {
    signInAs({ id: adminId, username: "operator" });
    await expect(mod.admin.requireAdmin()).resolves.toBeTruthy();
  });

  it("REVOKES ON THE NEXT REQUEST, WITH NO RE-LOGIN — nothing is cached", async () => {
    /**
     * THE SINGLE STATED INVARIANT OF THE ADMIN SUBSYSTEM. If the role were carried in the JWT
     * for speed, revocation would take effect on TOKEN EXPIRY rather than on the next request —
     * up to fourteen days of privilege after it was withdrawn. This test flips the column and
     * back without touching the session, which is only possible because the role is resolved
     * per request.
     */
    const { eq } = await import("drizzle-orm");
    signInAs({ id: memberId, username: "member" });
    await expect(mod.admin.requireAdmin()).rejects.toThrow();

    await mod.db.update(mod.schema.users).set({ role: "admin" }).where(eq(mod.schema.users.id, memberId));
    await expect(mod.admin.requireAdmin()).resolves.toBeTruthy();

    await mod.db.update(mod.schema.users).set({ role: "member" }).where(eq(mod.schema.users.id, memberId));
    await expect(mod.admin.requireAdmin()).rejects.toThrow();
  });

  it("cannot be satisfied by a token that merely claims the role", async () => {
    // `SessionUser` has no role field at all, which is the structural half of the guarantee —
    // but assert the behaviour too, in case the type ever widens.
    signInAs({ id: memberId, username: "member", ...({ role: "admin" } as object) });
    await expect(mod.admin.requireAdmin()).rejects.toThrow();
  });

  it("throws rather than returning a flag, so a caller cannot forget to check", async () => {
    // A boolean return is a value somebody assigns and then does not branch on. A throw cannot
    // be ignored.
    signInAs({ id: memberId, username: "member" });
    let threw = false;
    try {
      await mod.admin.requireAdmin();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("safe defaults on a fresh account", () => {
  it("never derives privilege or paid status from anything a client sends", async () => {
    /**
     * "Privilege and paid status must never be the default, and must never be derivable from
     * anything the client sends at registration."
     */
    const [row] = await mod.db
      .insert(mod.schema.users)
      .values({ username: "brandnew", email: "brandnew@test.invalid", passwordHash: "x" })
      .returning();
    expect(row?.role).toBe("member");
    expect(row?.plan).toBe("free");
    expect(row?.emailVerifiedAt).toBeNull();
    expect(row?.planUpdatedAt).toBeNull();
    expect(row?.isGuest).toBe(false);
    // The privacy flag the source lacks entirely defaults to public, matching the product's
    // stated behaviour — but it exists, so a member can change it.
    expect(row?.wantlistPrivate).toBe(false);
  });
});

describe("the rate limiter", () => {
  const budget = { bucket: "test:bucket", limit: 3, windowSeconds: 60 };

  it("ALLOWS THE Nth REQUEST AND REFUSES THE (N+1)th", async () => {
    /**
     * `ok = count <= limit`. Any reimplementation using `count < limit` SILENTLY TIGHTENS EVERY
     * BUDGET BY ONE — including the five-attempt login limit, which would become four.
     */
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await mod.limit.consume(budget, "someone");
      expect(result.ok).toBe(true);
      expect(result.count).toBe(attempt);
    }
    const refused = await mod.limit.consume(budget, "someone");
    expect(refused.ok).toBe(false);
    expect(refused.count).toBe(4);
  });

  it("keys separately per identity", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) await mod.limit.consume(budget, "first");
    // A different identity starts fresh, or one noisy address would lock out a whole office.
    expect((await mod.limit.consume(budget, "second")).ok).toBe(true);
  });

  it("keys separately per bucket, so the two auth limits do not share a counter", async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) await mod.limit.consume(budget, "shared");
    const other = { bucket: "test:other", limit: 3, windowSeconds: 60 };
    expect((await mod.limit.consume(other, "shared")).ok).toBe(true);
  });

  it("starts a fresh window once the old one has aged out", async () => {
    /**
     * THE WINDOW IS AGED WITH SQL RATHER THAN BY SLEEPING. An earlier version of this test in
     * the source project relied on the clock advancing between two statements, and passed
     * locally while failing on a faster machine WHERE BOTH STATEMENTS SAW THE SAME `now()`.
     */
    const { sql } = await import("drizzle-orm");
    for (let attempt = 0; attempt < 4; attempt += 1) await mod.limit.consume(budget, "ager");
    expect((await mod.limit.consume(budget, "ager")).ok).toBe(false);

    await mod.db.execute(
      sql`UPDATE rate_limits SET window_start = now() - make_interval(secs => 600) WHERE key = ${"test:bucket:ager"}`,
    );
    const fresh = await mod.limit.consume(budget, "ager");
    expect(fresh.ok).toBe(true);
    expect(fresh.count).toBe(1);
  });

  it("reports a retry hint bounded by the window", async () => {
    const result = await mod.limit.consume(budget, "hinted");
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(budget.windowSeconds);
  });

  it("NEVER NAMES THE MECHANISM in a refusal", async () => {
    // A limiter that explains itself is a limiter that tells an attacker how to pace.
    for (let attempt = 0; attempt < 4; attempt += 1) await mod.limit.consume(budget, "leaky");
    const refused = await mod.limit.consume(budget, "leaky");
    const message = mod.limit.retryMessage(refused);
    expect(message).not.toMatch(/bucket|rate_limits|window_start|make_interval|\bselect\b|\binsert\b|postgres/i);
    expect(message.length).toBeGreaterThan(0);
  });

  it("declares two limits for every auth flow — one by subject, one by source", async () => {
    /**
     * "The two attacks look different": guessing one password against one account, versus
     * credential stuffing from one source across many accounts. Neither limit catches the other,
     * and BOTH ARE COUNTED BEFORE bcrypt RUNS so a flood cannot be used to burn CPU either.
     */
    const { BUDGETS } = mod.limit;
    expect(BUDGETS.loginByAccount.bucket).not.toBe(BUDGETS.loginByIp.bucket);
    expect(BUDGETS.loginByAccount.limit).toBeLessThan(BUDGETS.loginByIp.limit);
    expect(BUDGETS.passwordResetByEmail.bucket).not.toBe(BUDGETS.passwordResetByIp.bucket);
    expect(BUDGETS.verifyEmailByUser.bucket).not.toBe(BUDGETS.verifyEmailByIp.bucket);
  });

  it("keeps one platform-wide counter per outbound provider, not one per user", async () => {
    // The provider relationship is the scarce resource: being throttled takes the catalogue
    // down for everyone, so the identity is a literal rather than a caller.
    const { BUDGETS } = mod.limit;
    expect(BUDGETS.deezerOutbound.bucket).toBe("deezer:global");
    expect(BUDGETS.musicbrainzOutbound.bucket).toBe("musicbrainz:global");
    // MusicBrainz's published policy is ~1 req/s; the budget must respect it.
    expect(BUDGETS.musicbrainzOutbound.limit).toBeLessThanOrEqual(60);
  });

  it("prunes windows older than the cutoff", async () => {
    const { sql } = await import("drizzle-orm");
    await mod.limit.consume(budget, "old");
    await mod.limit.consume(budget, "new");
    await mod.db.execute(
      sql`UPDATE rate_limits SET window_start = now() - make_interval(secs => 200000) WHERE key = ${"test:bucket:old"}`,
    );

    // That table is also a list of email addresses, so a prune is a data-retention control as
    // well as a disk one. The source ships the helper with nothing scheduling it.
    const removed = await mod.limit.pruneRateLimits(86_400);
    expect(removed).toBe(1);

    const left = await mod.db.execute<{ key: string }>(sql`SELECT key FROM rate_limits`);
    expect(left.rows.map((row) => row.key)).toEqual(["test:bucket:new"]);
  });
});

describe("the action contract", () => {
  it("exempts by omission, so a new action is gated unless it is listed", async () => {
    /**
     * "Anything absent from this list requires verification, so a new action is gated by
     * OMISSION rather than by remembering to add a check." The list is typed as a
     * `Set<ActionLabel>`, so a typo in a label is a COMPILE error rather than a silent
     * "not exempt" — which in the source presents as a mysterious "confirm your email" on an
     * action that should be reachable.
     */
    const { VERIFICATION_EXEMPT } = await import("@/app/actions/result");

    // The flows that would otherwise be unreachable.
    for (const label of ["signUp", "signIn", "sendVerification", "confirmVerification", "requestPasswordReset", "resetPassword"] as const) {
      expect(VERIFICATION_EXEMPT.has(label)).toBe(true);
    }
    // Self-scoped edits and deletions, "which nobody else can see the effects of and which
    // should not be held hostage to slow mail".
    for (const label of ["updateProfile", "deleteLog", "deleteComment", "deleteList", "removeFromList", "unmarkAlbumListened"] as const) {
      expect(VERIFICATION_EXEMPT.has(label)).toBe(true);
    }
    // And the things that publish to other people are NOT exempt.
    for (const label of ["saveLog", "addComment", "toggleLike", "toggleFollow", "createList"] as const) {
      expect(VERIFICATION_EXEMPT.has(label)).toBe(false);
    }
  });

  it("whitelists only four fields in a logged error (I-35)", async () => {
    /**
     * Driver errors carry the failing SQL and, depending on the driver, its bound parameters —
     * which for this app means review bodies, email addresses and password hashes. Logs are not
     * a safe place for any of that, and hosted logs are readable by anyone with project access.
     */
    const { safeErrorDetail } = await import("@/app/actions/result");
    const hostile = Object.assign(new Error("boom"), {
      code: "23505",
      constraint: "users_email_lower_uq",
      stack: "at secret (/home/someone/app.ts:1:1)",
      query: "INSERT INTO users (email, password_hash) VALUES ($1, $2)",
      parameters: ["victim@example.com", "$2b$12$realhashhere"],
      detail: "Key (email)=(victim@example.com) already exists.",
    });

    const detail = safeErrorDetail(hostile);
    const serialised = JSON.stringify(detail);
    expect(serialised).toContain("boom");
    expect(serialised).toContain("23505");
    expect(serialised).not.toMatch(/INSERT INTO|password_hash|victim@example\.com|realhashhere|\/home\/someone/);
    for (const forbidden of ["stack", "query", "parameters", "detail"]) {
      expect(Object.keys(detail as object)).not.toContain(forbidden);
    }
  });
});

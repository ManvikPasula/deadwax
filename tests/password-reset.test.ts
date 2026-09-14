import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Password reset, against a REAL throwaway Postgres.
 *
 * The rule lives in `lib/auth/password-reset.ts` rather than inside the Server Action for one
 * reason, stated in the source: **"a single-use token that turns out to be reusable is not the
 * kind of thing to discover in production."** An action is a shell; a rule that only exists
 * inside one is a rule nobody can prove. This file is the proof.
 */

let dataDir: string;

type Module = {
  db: typeof import("@/lib/db").db;
  schema: typeof import("@/lib/db/schema");
  reset: typeof import("@/lib/auth/password-reset");
  tokens: typeof import("@/lib/security/tokens");
};

let mod: Module;
let userId: number;
let guestId: number;

const ORIGINAL_HASH = "$2b$12$originalhashvalueaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_HASH = "$2b$12$replacementhashvaluebbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "deadwax-reset-"));
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
    reset: await import("@/lib/auth/password-reset"),
    tokens: await import("@/lib/security/tokens"),
  };
}, 120_000);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

beforeEach(async () => {
  const { db, schema } = mod;
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`TRUNCATE users RESTART IDENTITY CASCADE`);

  const rows = await db
    .insert(schema.users)
    .values([
      { username: "member", email: "member@test.invalid", passwordHash: ORIGINAL_HASH },
      { username: "guest_aaaaaaaaaa", email: "guest_aaaaaaaaaa@guest.invalid", passwordHash: "x", isGuest: true },
    ])
    .returning({ id: schema.users.id });
  userId = rows[0]!.id;
  guestId = rows[1]!.id;
});

async function storedRows() {
  const { eq } = await import("drizzle-orm");
  return mod.db
    .select()
    .from(mod.schema.passwordResetTokens)
    .where(eq(mod.schema.passwordResetTokens.userId, userId));
}

describe("the token itself", () => {
  it("is 256 bits of CSPRNG output rendered as 43 base64url characters", async () => {
    const { token } = mod.tokens.createLinkToken();
    expect(token).toMatch(mod.tokens.looksLikeLinkToken);
    expect(token.length).toBe(43);
  });

  it("mints a distinct token every time", async () => {
    const seen = new Set(Array.from({ length: 50 }, () => mod.tokens.createLinkToken().token));
    expect(seen.size).toBe(50);
  });

  it("uses a SHORTER TTL than verification, because the two links do different damage", async () => {
    /**
     * "A confirmation link only proves an address; A RESET LINK TAKES OVER AN ACCOUNT, so the
     * interval in which a leaked mailbox or a forwarded message is dangerous should be as small
     * as is still usable."
     */
    expect(mod.tokens.PASSWORD_RESET_TTL_MINUTES).toBe(30);
    expect(mod.tokens.VERIFICATION_TTL_MINUTES).toBe(60);
    expect(mod.tokens.PASSWORD_RESET_TTL_MINUTES).toBeLessThan(mod.tokens.VERIFICATION_TTL_MINUTES);
  });
});

describe("issuing", () => {
  it("STORES ONLY THE HASH — the plaintext token is never written anywhere (I-27)", async () => {
    /**
     * A database leak then yields NOTHING REDEEMABLE. SHA-256 rather than a slow KDF because
     * the token is 256 bits of CSPRNG output, so there is nothing to brute force — the reason
     * to hash it is to make the stored value useless, not to make guessing expensive.
     */
    const issued = await mod.reset.issuePasswordReset(userId);
    const rows = await storedRows();

    expect(rows.length).toBe(1);
    expect(rows[0]!.tokenHash).toBe(mod.tokens.sha256hex(issued.token));
    // The plaintext appears nowhere in the row.
    expect(JSON.stringify(rows[0])).not.toContain(issued.token);
  });

  it("binds the address at issue time", async () => {
    // So a later email change cannot be confirmed by an old link.
    const issued = await mod.reset.issuePasswordReset(userId);
    const rows = await storedRows();
    expect(rows[0]!.email).toBe("member@test.invalid");
    expect(issued.email).toBe("member@test.invalid");
  });

  it("RETIRES EVERY OUTSTANDING TOKEN IN THE SAME TRANSACTION AS THE INSERT", async () => {
    /**
     * Otherwise a member who clicks "forgot password" three times has three live links, and the
     * two they abandoned stay valid for the full window — in a mailbox that may be the thing
     * that was compromised in the first place.
     */
    const first = await mod.reset.issuePasswordReset(userId);
    const second = await mod.reset.issuePasswordReset(userId);

    const rows = await storedRows();
    const live = rows.filter((row) => row.consumedAt === null);
    expect(live.length).toBe(1);
    expect(live[0]!.tokenHash).toBe(mod.tokens.sha256hex(second.token));

    // And the abandoned one is dead on arrival.
    const stale = await mod.reset.redeemPasswordReset({ token: first.token, passwordHash: NEW_HASH });
    expect(stale.ok).toBe(false);
  });

  it("refuses a guest, who has no address that could receive a link", async () => {
    await expect(mod.reset.issuePasswordReset(guestId)).rejects.toThrow();
  });

  it("refuses an account that no longer exists", async () => {
    await expect(mod.reset.issuePasswordReset(999_999)).rejects.toThrow();
  });
});

describe("the recipient lookup", () => {
  it("resolves case-insensitively, matching the functional unique index", async () => {
    // Both sides use Postgres' lower(), not JavaScript's toLowerCase(): the index is built on
    // lower(email), so a query that speaks a different dialect both misses rows and gives up
    // the index scan.
    const found = await mod.reset.findResetRecipient("MEMBER@TEST.INVALID");
    expect(found?.id).toBe(userId);
  });

  it("returns nothing for a guest and nothing for an unknown address", async () => {
    // The ACTION still answers identically in both cases — that is the membership-oracle
    // defence and it lives one layer up. Here the honest answer is null.
    expect(await mod.reset.findResetRecipient("guest_aaaaaaaaaa@guest.invalid")).toBeNull();
    expect(await mod.reset.findResetRecipient("nobody@test.invalid")).toBeNull();
  });
});

describe("redeeming", () => {
  it("sets the new password and consumes the token", async () => {
    const { eq } = await import("drizzle-orm");
    const issued = await mod.reset.issuePasswordReset(userId);

    const result = await mod.reset.redeemPasswordReset({ token: issued.token, passwordHash: NEW_HASH });
    expect(result.ok).toBe(true);

    const row = await mod.db.query.users.findFirst({ where: eq(mod.schema.users.id, userId) });
    expect(row?.passwordHash).toBe(NEW_HASH);

    const rows = await storedRows();
    expect(rows.every((token) => token.consumedAt !== null)).toBe(true);
  });

  it("IS SINGLE USE — a second redemption of the same token fails", async () => {
    // The whole reason this rule lives in a testable module rather than inside an action.
    const issued = await mod.reset.issuePasswordReset(userId);
    expect((await mod.reset.redeemPasswordReset({ token: issued.token, passwordHash: NEW_HASH })).ok).toBe(true);
    expect((await mod.reset.redeemPasswordReset({ token: issued.token, passwordHash: NEW_HASH })).ok).toBe(false);
  });

  it("CONFIRMS AN UNVERIFIED ADDRESS as a side effect", async () => {
    /**
     * "Redeeming this proves they read mail at that address, WHICH IS THE SAME THING EMAIL
     * VERIFICATION PROVES." Not doing it would leave a member who has just demonstrated control
     * of their mailbox still blocked from posting by the verification gate.
     */
    const { eq } = await import("drizzle-orm");
    const before = await mod.db.query.users.findFirst({ where: eq(mod.schema.users.id, userId) });
    expect(before?.emailVerifiedAt).toBeNull();

    const issued = await mod.reset.issuePasswordReset(userId);
    await mod.reset.redeemPasswordReset({ token: issued.token, passwordHash: NEW_HASH });

    const after = await mod.db.query.users.findFirst({ where: eq(mod.schema.users.id, userId) });
    expect(after?.emailVerifiedAt).not.toBeNull();
  });

  it("never clobbers an existing verification timestamp", async () => {
    // `coalesce(email_verified_at, now())`. Overwriting it would rewrite history for no gain.
    const { eq } = await import("drizzle-orm");
    const stamp = new Date("2020-01-01T00:00:00.000Z");
    await mod.db.update(mod.schema.users).set({ emailVerifiedAt: stamp }).where(eq(mod.schema.users.id, userId));

    const issued = await mod.reset.issuePasswordReset(userId);
    await mod.reset.redeemPasswordReset({ token: issued.token, passwordHash: NEW_HASH });

    const after = await mod.db.query.users.findFirst({ where: eq(mod.schema.users.id, userId) });
    expect(after?.emailVerifiedAt?.toISOString()).toBe(stamp.toISOString());
  });

  it("RETURNS ONE IDENTICAL REFUSAL FOR EVERY REASON", async () => {
    /**
     * Five distinct refusals — bad shape, no row, already consumed, expired, account gone —
     * ALL ANSWER THE SAME WAY, because distinguishing them tells a guesser WHICH TOKENS WERE
     * REAL. A "this link has expired" message is a confirmation that the link existed.
     */
    const outcomes: unknown[] = [];

    // 1. Bad shape — never reaches the database.
    outcomes.push(await mod.reset.redeemPasswordReset({ token: "far-too-short", passwordHash: NEW_HASH }));
    // 2. Well-formed but unknown.
    outcomes.push(
      await mod.reset.redeemPasswordReset({ token: mod.tokens.createLinkToken().token, passwordHash: NEW_HASH }),
    );
    // 3. Already consumed.
    const used = await mod.reset.issuePasswordReset(userId);
    await mod.reset.redeemPasswordReset({ token: used.token, passwordHash: NEW_HASH });
    outcomes.push(await mod.reset.redeemPasswordReset({ token: used.token, passwordHash: NEW_HASH }));
    // 4. Expired.
    const { eq, sql } = await import("drizzle-orm");
    const expired = await mod.reset.issuePasswordReset(userId);
    await mod.db.execute(
      sql`UPDATE password_reset_tokens SET expires_at = now() - make_interval(mins => 60)
          WHERE token_hash = ${mod.tokens.sha256hex(expired.token)}`,
    );
    outcomes.push(await mod.reset.redeemPasswordReset({ token: expired.token, passwordHash: NEW_HASH }));
    // 5. Account deleted between issue and redemption.
    const orphaned = await mod.reset.issuePasswordReset(userId);
    await mod.db.delete(mod.schema.users).where(eq(mod.schema.users.id, userId));
    outcomes.push(await mod.reset.redeemPasswordReset({ token: orphaned.token, passwordHash: NEW_HASH }));

    // Every one of the five is byte-for-byte the same value.
    const serialised = outcomes.map((outcome) => JSON.stringify(outcome));
    expect(new Set(serialised).size).toBe(1);
    expect(outcomes[0]).toMatchObject({ ok: false });
    // And none of them leaks which branch it took.
    expect(serialised[0]).not.toMatch(/expired|consumed|unknown|missing|deleted|shape/i);
  });

  it("does not change a password when it refuses", async () => {
    const { eq } = await import("drizzle-orm");
    await mod.reset.redeemPasswordReset({ token: mod.tokens.createLinkToken().token, passwordHash: NEW_HASH });
    const row = await mod.db.query.users.findFirst({ where: eq(mod.schema.users.id, userId) });
    expect(row?.passwordHash).toBe(ORIGINAL_HASH);
  });

  it("rejects a mutated token — changing four characters is enough", async () => {
    // The stored value is a hash, so a near-miss is not a near-miss: it is a different hash.
    const issued = await mod.reset.issuePasswordReset(userId);
    const mutated = `AAAA${issued.token.slice(4)}`;
    expect(mutated.length).toBe(issued.token.length);
    expect((await mod.reset.redeemPasswordReset({ token: mutated, passwordHash: NEW_HASH })).ok).toBe(false);
  });

  it("does not let one member's token reset another member's password", async () => {
    const { eq } = await import("drizzle-orm");
    const [second] = await mod.db
      .insert(mod.schema.users)
      .values({ username: "other", email: "other@test.invalid", passwordHash: ORIGINAL_HASH })
      .returning({ id: mod.schema.users.id });

    const issued = await mod.reset.issuePasswordReset(userId);
    await mod.reset.redeemPasswordReset({ token: issued.token, passwordHash: NEW_HASH });

    const untouched = await mod.db.query.users.findFirst({ where: eq(mod.schema.users.id, second!.id) });
    expect(untouched?.passwordHash).toBe(ORIGINAL_HASH);
  });
});

describe("the reset URL", () => {
  it("carries the token in a query parameter on the configured origin", async () => {
    const { token } = mod.tokens.createLinkToken();
    const url = new URL(mod.reset.passwordResetUrl(token));
    expect(url.pathname).toBe("/reset");
    expect(url.searchParams.get("token")).toBe(token);
  });

  it("does not mangle a token containing base64url's - and _ characters", async () => {
    // A token is base64url, so it contains - and _ but never + or /. Round-tripping it through
    // URL parsing must return it unchanged, or a valid link fails to redeem.
    const token = `${"a-b_c".padEnd(43, "x")}`;
    const url = new URL(mod.reset.passwordResetUrl(token));
    expect(url.searchParams.get("token")).toBe(token);
  });
});

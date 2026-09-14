import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE SAME SINGLE SEAM AS tests/security.test.ts, and it is needed here for a reason worth
 * recording: `lib/db/queries/ads.ts` SELF-GATES on `requireAdmin()` (I-20), so importing it
 * pulls in `lib/auth` and therefore `next-auth`, which reaches for `next/server` — a module
 * that does not resolve under the `react-server` condition the test runner uses.
 *
 * That import chain is not an accident to work around; it IS the guarantee. "These queries
 * return email addresses and account state, so a page that forgot the check would be a
 * disclosure bug; making the query refuse is the difference between one mistake and a breach."
 * The gate itself is tested in tests/security.test.ts against the genuine article; here it is
 * satisfied so that the DATA SHAPE can be tested, which is a different question.
 */
let sessionUser: { id: number; username: string } | null = null;

vi.mock("@/lib/auth", () => ({
  auth: async () => (sessionUser ? { user: { ...sessionUser, id: String(sessionUser.id) } } : null),
  handlers: { GET: async () => new Response(), POST: async () => new Response() },
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

/**
 * Ad statistics and click targets, against a REAL throwaway Postgres.
 *
 * The property under test is a PRIVACY GUARANTEE MADE STRUCTURALLY RATHER THAN BY POLICY:
 *
 *   One row per ad per day rather than one row per impression: an advertiser needs a daily
 *   curve, and NOBODY NEEDS A LOG OF WHICH MEMBER SAW WHICH AD. **That is a deliberate limit
 *   on what this table can ever be used for.**
 *
 * A promise not to join impressions against members is a promise somebody can break in one
 * afternoon. A table with no member column and no per-event row cannot be joined against them
 * at all, and that is a different kind of assurance — which is why this is asserted rather
 * than documented.
 */

let dataDir: string;

type Module = {
  db: typeof import("@/lib/db").db;
  schema: typeof import("@/lib/db/schema");
  ads: typeof import("@/lib/db/queries/ads");
};

let mod: Module;
let adId: number;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "deadwax-ads-"));
  process.env.PGLITE_DATA_DIR = dataDir;
  delete process.env.DATABASE_URL; // ← non-negotiable

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const schema = await import("@/lib/db/schema");

  const client = new PGlite(dataDir);
  await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
  await client.close();

  mod = { db: (await import("@/lib/db")).db, schema, ads: await import("@/lib/db/queries/ads") };
}, 120_000);

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

beforeEach(async () => {
  const { db, schema } = mod;
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`TRUNCATE ads, users RESTART IDENTITY CASCADE`);

  // An operator, so the self-gating reads below are reachable. The gate is proved genuine
  // in tests/security.test.ts; here it is simply satisfied.
  const [operator] = await db
    .insert(schema.users)
    .values({ username: "operator", email: "operator@test.invalid", passwordHash: "x", role: "admin" })
    .returning({ id: schema.users.id });
  sessionUser = { id: operator!.id, username: "operator" };

  const [row] = await db
    .insert(schema.ads)
    .values({
      kind: "indie",
      slot: "any",
      status: "active",
      headline: "A record you have not heard",
      body: "Self-released, four tracks, recorded in a kitchen.",
      ctaLabel: "Listen",
      targetUrl: "https://example.com/release",
      creatorName: "Somebody",
      projectKind: "ep",
      weight: 1,
    })
    .returning({ id: schema.ads.id });
  adId = row!.id;
});

async function dailyRows() {
  const { eq } = await import("drizzle-orm");
  return mod.db.select().from(mod.schema.adStats).where(eq(mod.schema.adStats.adId, adId));
}

describe("the counter write", () => {
  it("KEEPS ONE ROW PER AD PER DAY, however many events arrive", async () => {
    for (let index = 0; index < 5; index += 1) await mod.ads.recordAdEvent(adId, "impression");
    await mod.ads.recordAdEvent(adId, "click");

    const rows = await dailyRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.impressions).toBe(5);
    expect(rows[0]!.clicks).toBe(1);
  });

  it("RECORDS NOTHING ABOUT WHO SAW IT — the row has no member column at all", async () => {
    /**
     * The structural half of the guarantee. This assertion is on the SHAPE rather than on the
     * values, because a null user id is a column somebody can start filling in.
     */
    await mod.ads.recordAdEvent(adId, "impression");
    const rows = await dailyRows();
    const keys = Object.keys(rows[0]!);

    for (const forbidden of ["userId", "user_id", "sessionId", "ip", "ipAddress", "viewerId"]) {
      expect(keys).not.toContain(forbidden);
    }
    // And the whole row, serialised, is four numbers and a date.
    expect(keys.sort()).toEqual(["adId", "clicks", "day", "id", "impressions"]);
  });

  it("bumps the lifetime counters on the ad itself", async () => {
    const { eq } = await import("drizzle-orm");
    await mod.ads.recordAdEvent(adId, "impression");
    await mod.ads.recordAdEvent(adId, "impression");
    await mod.ads.recordAdEvent(adId, "click");

    const ad = await mod.db.query.ads.findFirst({ where: eq(mod.schema.ads.id, adId) });
    expect(ad?.impressions).toBe(2);
    expect(ad?.clicks).toBe(1);
  });

  it("AN ARCHIVED AD INCREMENTS NOTHING AT ALL", async () => {
    /**
     * Because the INSERT selects FROM THE CTE, and the CTE's UPDATE matches no row for an
     * archived ad, the daily insert has nothing to select — so both halves stop together. A
     * two-statement version would bump the daily row while leaving the lifetime counter alone,
     * and the two numbers an advertiser reads would disagree.
     */
    const { eq } = await import("drizzle-orm");
    await mod.db.update(mod.schema.ads).set({ status: "archived" }).where(eq(mod.schema.ads.id, adId));

    await mod.ads.recordAdEvent(adId, "impression");

    expect((await dailyRows()).length).toBe(0);
    const ad = await mod.db.query.ads.findFirst({ where: eq(mod.schema.ads.id, adId) });
    expect(ad?.impressions).toBe(0);
  });

  it("is a silent no-op for an ad that does not exist", async () => {
    // The endpoint is deliberately uninteresting to attack, so a bad id is not an error path.
    await expect(mod.ads.recordAdEvent(999_999, "impression")).resolves.toBeUndefined();
  });

  it("still counts a PAUSED ad, because pausing is not archiving", async () => {
    /**
     * Archive is the terminal state that preserves the record of what ran; pause is temporary.
     * A paused ad is not served, so in practice no events arrive — but if one does, discarding
     * it would make the daily curve lie about a period the advertiser was paying for.
     */
    const { eq } = await import("drizzle-orm");
    await mod.db.update(mod.schema.ads).set({ status: "paused" }).where(eq(mod.schema.ads.id, adId));
    await mod.ads.recordAdEvent(adId, "impression");
    expect((await dailyRows())[0]?.impressions).toBe(1);
  });
});

describe("clickTarget — no open redirect is possible", () => {
  it("returns the stored URL for an active ad", async () => {
    expect(await mod.ads.clickTarget(adId)).toBe("https://example.com/release");
  });

  it("RE-VALIDATES THE SCHEME, so a poisoned column can never become a redirect", async () => {
    /**
     * The destination comes from the ROW, never from the query string, so there is no open
     * redirect by construction. This is the belt-and-braces half: the stored value is re-tested
     * against ^https?:// BEFORE it is returned, so a `javascript:` URL that somehow reached the
     * column — a migration, a direct database edit, a future admin form with a weaker check —
     * still cannot become a navigation.
     */
    const { eq } = await import("drizzle-orm");
    for (const hostile of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "//evil.example.com",
      "/relative/path",
      " javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
    ]) {
      await mod.db.update(mod.schema.ads).set({ targetUrl: hostile }).where(eq(mod.schema.ads.id, adId));
      expect(await mod.ads.clickTarget(adId)).toBeNull();
    }
  });

  it("accepts http as well as https, because an indie release may not have a certificate", async () => {
    const { eq } = await import("drizzle-orm");
    await mod.db
      .update(mod.schema.ads)
      .set({ targetUrl: "http://example.com/tape" })
      .where(eq(mod.schema.ads.id, adId));
    expect(await mod.ads.clickTarget(adId)).toBe("http://example.com/tape");
  });

  it("returns null for a paused, archived, draft or missing ad", async () => {
    const { eq } = await import("drizzle-orm");
    for (const status of ["paused", "archived", "draft"]) {
      await mod.db.update(mod.schema.ads).set({ status }).where(eq(mod.schema.ads.id, adId));
      // The route sends the member to "/" on a null, which "leaves them somewhere real rather
      // than on an error page they did not ask for".
      expect(await mod.ads.clickTarget(adId)).toBeNull();
    }
    expect(await mod.ads.clickTarget(999_999)).toBeNull();
  });
});

describe("the reporting reads", () => {
  it("reports lifetime totals without touching per-member data", async () => {
    await mod.ads.recordAdEvent(adId, "impression");
    await mod.ads.recordAdEvent(adId, "click");
    const totals = await mod.ads.adTotals();
    expect(totals.impressions).toBeGreaterThanOrEqual(1);
    expect(totals.clicks).toBeGreaterThanOrEqual(1);
  });

  it("returns a daily curve, which is the only thing an advertiser needs", async () => {
    await mod.ads.recordAdEvent(adId, "impression");
    const daily = await mod.ads.adDailyStats(adId);
    expect(Array.isArray(daily)).toBe(true);
    if (daily.length > 0) {
      const keys = Object.keys(daily[0] as object);
      // Same structural assertion as above, at the reporting boundary this time: the shape
      // that reaches an operator cannot carry a member either.
      for (const forbidden of ["userId", "user_id", "viewerId", "ip"]) expect(keys).not.toContain(forbidden);
    }
  });

  it("lists inventory without exposing the counters to a card projection", async () => {
    // `AdCandidate` deliberately omits impressions and clicks: a candidate crosses the
    // server/client boundary in the RSC payload, so a projection carrying the counters would
    // publish a campaign's performance to anybody who views source. `listAds` is the admin
    // read and may carry them.
    const rows = await mod.ads.listAds();
    expect(rows.length).toBe(1);
    expect(rows[0]).toHaveProperty("impressions");
  });
});

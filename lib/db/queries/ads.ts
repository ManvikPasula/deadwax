import "server-only";

import { asc, desc, eq, sql } from "drizzle-orm";

import { requireAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { adStats, ads } from "@/lib/db/schema";

/**
 * Reads and counter writes over `ads` and `ad_stats`.
 *
 * TWO TIERS, AND THE LINE BETWEEN THEM IS THE POINT OF THE FILE:
 *
 *   PUBLIC  `recordAdEvent`, `clickTarget` — reached by `/api/ads/impression` and
 *           `/api/ads/[id]/click`, which have no session at all. These cannot self-gate and
 *           are written so that there is nothing worth gating: one increments an integer, the
 *           other returns a URL that came out of a row.
 *
 *   ADMIN   `listAds`, `adTotals`, `adDailyStats` — EACH CALLS `requireAdmin()` ITSELF (I-20),
 *           rather than trusting its caller to have done so.
 *
 * THE SOURCE BRIEF IS NOT UNIFORM HERE AND THIS FILE FIXES IT rather than reproducing it. In
 * the original, `lib/db/queries/admin.ts` self-gates and the ads query module does not — only
 * `import "server-only"` — so a future page that called `listAds()` without `requireAdmin()`
 * would leak the whole ad inventory and its revenue counters to anybody who found the route.
 *
 *   "These queries return inventory, schedules and revenue counters, so a page that forgot the
 *    check would be a disclosure bug; making the query refuse is the difference between one
 *    mistake and a breach."
 *
 * The cost is one extra indexed role lookup per admin query — several per /admin/ads render —
 * and it is accepted as the price of the property. The role is read from the column on every
 * call, never from the token (I-18), so a demotion takes effect on the next request.
 *
 * WHAT THIS TABLE CAN NEVER BECOME: one row per ad per day, never one row per impression. An
 * advertiser needs a daily curve, and nobody needs a log of which member saw which ad. That is
 * a deliberate limit on what `ad_stats` can ever be used for, and `tests/ads.test.ts` asserts
 * it by checking that the row's keys do not include a user id.
 */

/** The two counters, and the only two values that can reach `sql.raw` below. */
export type AdEventKind = "impression" | "click";

/**
 * THE CLOSED MAP FROM EVENT TO COLUMN. THIS IS THE INJECTION SURFACE, AND IT IS THIS SHAPE SO
 * THAT THERE ISN'T ONE.
 *
 * `sql.raw` interpolates without binding, which is exactly what a column name needs and
 * exactly what member input must never reach. The value handed to it here can only ever be one
 * of two string literals chosen by a lookup on a two-member union — so the route handler's
 * `kind` parameter never becomes SQL, however it was parsed. Writing
 * `sql.raw(kind === "click" ? "clicks" : "impressions")` inline would be equivalent today and
 * one careless edit away from `sql.raw(request.body.column)`.
 */
const EVENT_COLUMN: Record<AdEventKind, "impressions" | "clicks"> = {
  impression: "impressions",
  click: "clicks",
};

/**
 * ONE STATEMENT: a CTE that bumps the lifetime counter on `ads`, and an upsert into `ad_stats`
 * that SELECTS FROM THE CTE.
 *
 *   with bump as (update ads set <col> = <col> + 1, updated_at = now()
 *                  where id = $1 and status <> 'archived' returning id)
 *   insert into ad_stats (ad_id, day, <col>)
 *   select id, current_date, 1 from bump
 *   on conflict (ad_id, day) do update set <col> = ad_stats.<col> + 1
 *
 * BECAUSE THE INSERT SELECTS FROM THE CTE, AN ARCHIVED AD INCREMENTS NOTHING AT ALL. The
 * `status <> 'archived'` predicate lives inside the UPDATE, so when it fails the CTE returns
 * zero rows, the INSERT inserts zero rows, and there is no second statement that could have
 * disagreed with the first. The rejected alternative — SELECT the status, decide in
 * JavaScript, then write — is two round trips and a race, and the race loses a count rather
 * than gaining one, so nobody would ever notice it was wrong.
 *
 * ONLY 'archived' IS REFUSED, deliberately. A paused ad still counts: a member whose page was
 * rendered a minute before the operator paused it genuinely saw the unit, and the counter is
 * the record of what was served. Archiving is the one state that says "this campaign is over
 * and its numbers are final".
 *
 * IDENTIFIERS ARE WRITTEN LITERALLY RATHER THAN AS `${ads.impressions}`, AND THAT IS NOT
 * LAZINESS. Drizzle renders a column reference fully qualified — `"ads"."impressions"` — and
 * Postgres rejects a qualified target in an `UPDATE ... SET` clause. The same applies to the
 * `ON CONFLICT DO UPDATE SET` target. The table and column names are pinned by
 * `tests/ads.test.ts`, which exercises this statement against a real database.
 *
 * `current_date` is the SERVER's date, in the server's timezone. That is the right choice for a
 * reporting curve — an advertiser reading "Tuesday" wants one Tuesday, not one per member
 * timezone — and it is the opposite of the rule for `logs.listened_on`, which is deliberately
 * the member's own calendar date.
 */
export async function recordAdEvent(adId: number, kind: AdEventKind): Promise<void> {
  const column = EVENT_COLUMN[kind];

  await db.execute(sql`
    with bump as (
      update ads
         set ${sql.raw(column)} = ${sql.raw(column)} + 1,
             updated_at = now()
       where id = ${adId}
         and status <> 'archived'
      returning id
    )
    insert into ad_stats (ad_id, day, ${sql.raw(column)})
    select id, current_date, 1 from bump
    on conflict (ad_id, day) do update
      set ${sql.raw(column)} = ad_stats.${sql.raw(column)} + 1
  `);
}

/**
 * The click destination, or null.
 *
 * THE SCHEME IS RE-TESTED ON THE STORED VALUE BEFORE IT IS RETURNED, not only on the way in.
 * `createAd` validates the URL, and this validates it again on the way out, because the two
 * checks defend against different things: the first defends against an operator pasting
 * something odd into a form, and this one defends against a value that reached the column by
 * some other route — a migration, a psql session, a future import tool, a bug. A
 * `javascript:` URL in `ads.target_url` can therefore never become a redirect, and
 * `tests/ads.test.ts` writes exactly that row and asserts this returns null.
 *
 * NO OPEN REDIRECT IS POSSIBLE, and the reason is structural rather than careful: the
 * destination comes from the row, keyed by an integer id. There is no parameter in which a
 * caller could supply a URL, so there is nothing to validate at the boundary.
 *
 * A NON-ACTIVE OR MISSING AD RETURNS NULL, and the route sends the member to `/`. That leaves
 * somebody who clicked a link somewhere real rather than on an error page they did not ask
 * for.
 *
 * NOT SELF-GATED: its caller is an unauthenticated GET. It returns one row's public
 * destination — the same URL the card was already rendering as an href — and nothing else.
 */
export async function clickTarget(adId: number): Promise<string | null> {
  const rows = await db
    .select({ targetUrl: ads.targetUrl, status: ads.status })
    .from(ads)
    .where(eq(ads.id, adId))
    .limit(1);

  const row = rows[0];
  if (!row || row.status !== "active") return null;

  const url = row.targetUrl.trim();
  return /^https?:\/\//i.test(url) ? url : null;
}

/* -------------------------------------------------------------------------- */
/* The admin reads — every one of them self-gates                             */
/* -------------------------------------------------------------------------- */

/**
 * The inventory row the panel renders.
 *
 * This one DOES carry the counters, the status, the schedule and `created_by`, because it is
 * only ever reachable behind `requireAdmin()`. That is the whole reason `AdCandidate` in
 * lib/ads/plan.ts is a separate, narrower type rather than this one reused.
 */
export type AdRow = {
  id: number;
  kind: string;
  slot: string;
  status: string;
  headline: string;
  body: string;
  ctaLabel: string;
  targetUrl: string;
  creatorName: string | null;
  projectKind: string | null;
  label: string | null;
  genres: string[];
  weight: number;
  startsAt: Date | null;
  endsAt: Date | null;
  impressions: number;
  clicks: number;
  createdBy: number | null;
  createdAt: Date;
  updatedAt: Date;
};

/** /admin/ads lists this many. There is no pagination; an operator with more needs SQL. */
export const AD_LIST_LIMIT = 100;

/**
 * The whole inventory, running campaigns first.
 *
 * ORDERED BY STATUS AND THEN BY AGE. The rejected alternative is `created_at desc` alone,
 * which is what the panel started with and which buries the three ads that are actually
 * running under every draft the operator has ever abandoned — so the first question the page
 * exists to answer ("what is live right now") is the one it answers worst. Archived rows sort
 * last because they are a record rather than inventory.
 *
 * `id` is the final tiebreaker for the same reason `getActiveMembers` carries one: Postgres is
 * free to return rows with equal keys in any order, and a list that reshuffles between
 * identical requests reads as a broken page.
 */
export async function listAds(limit = AD_LIST_LIMIT): Promise<AdRow[]> {
  await requireAdmin();

  const statusRank = sql`case ${ads.status}
    when 'active' then 0
    when 'paused' then 1
    when 'draft' then 2
    else 3
  end`;

  return db
    .select({
      id: ads.id,
      kind: ads.kind,
      slot: ads.slot,
      status: ads.status,
      headline: ads.headline,
      body: ads.body,
      ctaLabel: ads.ctaLabel,
      targetUrl: ads.targetUrl,
      creatorName: ads.creatorName,
      projectKind: ads.projectKind,
      label: ads.label,
      genres: ads.genres,
      weight: ads.weight,
      startsAt: ads.startsAt,
      endsAt: ads.endsAt,
      impressions: ads.impressions,
      clicks: ads.clicks,
      createdBy: ads.createdBy,
      createdAt: ads.createdAt,
      updatedAt: ads.updatedAt,
    })
    .from(ads)
    .orderBy(asc(statusRank), desc(ads.createdAt), desc(ads.id))
    .limit(Math.max(1, Math.min(Math.floor(limit) || AD_LIST_LIMIT, AD_LIST_LIMIT)));
}

export type AdTotals = {
  ads: number;
  active: number;
  /** Active indie rows. The number an operator needs to answer "is the reservation servable?" */
  indieActive: number;
  impressions: number;
  clicks: number;
};

/**
 * Five scalars in ONE round trip (N+1 pattern 4), because they are always rendered together in
 * the panel header and never apart.
 *
 * THE COUNTERS INCLUDE ARCHIVED ROWS AND THAT IS THE POINT. `ads.impressions` and `ads.clicks`
 * are lifetime figures, and archiving a campaign must not change the total of what the house
 * has served — an operator reconciling a month cannot have the history move under them.
 *
 * `indieActive` counts ACTIVE indie rows rather than all of them, because the question it
 * answers is operational: with none of these, every reserved slot falls back to a general ad
 * and the third the panel promises is being quietly given back to the paid inventory.
 *
 * `::int` on each aggregate is not decoration — `count(*)` is a bigint and `sum()` over an
 * integer column returns numeric, and node-postgres hands both back as STRINGS. A string in
 * a total renders as "12" + "5" = "125" the first time somebody adds two of them.
 */
export async function adTotals(): Promise<AdTotals> {
  await requireAdmin();

  const result = await db.execute<AdTotals>(sql`
    select
      count(*)::int as ads,
      count(*) filter (where ${ads.status} = 'active')::int as active,
      count(*) filter (where ${ads.status} = 'active' and ${ads.kind} = 'indie')::int as "indieActive",
      coalesce(sum(${ads.impressions}), 0)::int as impressions,
      coalesce(sum(${ads.clicks}), 0)::int as clicks
    from ${ads}
  `);

  return result.rows[0] ?? { ads: 0, active: 0, indieActive: 0, impressions: 0, clicks: 0 };
}

export type AdDailyRow = {
  /**
   * `YYYY-MM-DD`. A STRING, because Drizzle and both drivers return a `date` column as a JS
   * string and a `timestamptz` as a `Date` (I-9). Handing this to `new Date(...)` and
   * formatting it is how a chart axis ends up one day off for every reader west of UTC.
   */
  day: string;
  impressions: number;
  clicks: number;
};

/** Two weeks is what a curve needs to show a shape without needing a scroll bar. */
export const AD_STATS_DEFAULT_DAYS = 14;
/** Bounded so a hand-typed query string cannot ask for a full-table scan. */
const AD_STATS_MAX_DAYS = 90;

/**
 * The daily curve, summed across the whole house or narrowed to one ad.
 *
 * ASCENDING BY DAY, because the consumer is a chart and a chart reads left to right. A
 * `desc` here would produce a mirrored curve that looks like a collapse in traffic.
 *
 * DAYS WITH NO ACTIVITY ARE SIMPLY ABSENT — there is no generated date series. The panel draws
 * what it is given, and a gap in a fourteen-bar chart is honest: nothing was served that day.
 * Generating the series in SQL would be one `generate_series` join for a cosmetic difference.
 *
 * `days` is clamped rather than trusted, the same rule as every bounded id (I-5): the value
 * arrives from a query string, and `current_date - $1::int` with a nonsense `$1` is a 500
 * where a small default belongs.
 */
export async function adDailyStats(
  days: number = AD_STATS_DEFAULT_DAYS,
  adId?: number,
): Promise<AdDailyRow[]> {
  await requireAdmin();

  const span = Math.max(1, Math.min(Math.floor(days) || AD_STATS_DEFAULT_DAYS, AD_STATS_MAX_DAYS));
  const onlyOneAd = typeof adId === "number" ? sql`and ${adStats.adId} = ${adId}` : sql``;

  const result = await db.execute<AdDailyRow>(sql`
    select
      ${adStats.day} as day,
      sum(${adStats.impressions})::int as impressions,
      sum(${adStats.clicks})::int as clicks
    from ${adStats}
    where ${adStats.day} > current_date - ${span}::int
      ${onlyOneAd}
    group by ${adStats.day}
    order by ${adStats.day} asc
  `);

  return result.rows;
}

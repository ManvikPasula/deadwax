/**
 * /admin/ads — the house-ad inventory and its counters.
 *
 * ============================================================================
 * THE SAME FOUR GATES AS /admin, FOR THE SAME REASONS
 *
 *   1. THE ROUTE       `notFound()` on `ForbiddenError` — **and everything else rethrown**
 *   2. THE METADATA    `robots: noindex`, `referrer: "no-referrer"`
 *   3. THE QUERY       `listAds`, `adTotals` and `adDailyStats` each call `requireAdmin()`
 *   4. THE ACTION      `requireAdmin()` as the first statement inside `guard()`
 *
 * Gate 3 is the one worth pointing at here: **the brief's original does not self-gate its ad
 * queries**, only its account queries, and that non-uniformity is exactly how a second admin
 * page ships without the check. Every privileged read in this repository refuses on its own.
 * ============================================================================
 *
 * `notFound()` is called OUTSIDE the try block for the reason spelled out in `app/admin/page.tsx`:
 * it signals by throwing, so a catch around it would swallow its own sentinel and the rethrow
 * would convert a deliberate 404 into a 500.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THE DAILY CURVE IS READ HERE AND THEN SUMMARISED RATHER THAN CHARTED
 * ---------------------------------------------------------------------------------------
 *
 * `ad_stats` holds one row per ad per day — never one per impression — because an advertiser
 * needs a daily curve and **nobody needs a log of which member saw which ad.** That is a
 * deliberate limit on what the table can ever be used for, and a test asserts the shape rather
 * than trusting the policy: the row is exactly `adId`, `clicks`, `day`, `id`, `impressions`,
 * with no member column to start filling in.
 *
 * The fortnight is rendered as a compact bar strip in plain CSS rather than a chart component,
 * matching `YearCharts` — two series over fourteen points does not need a charting dependency,
 * and most charting libraries inject markup or a stylesheet at runtime, which is a fight with
 * the strict CSP for no gain.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdManager } from "@/components/admin/ad-manager";
import { Eyebrow, SectionHeading } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/auth/admin";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/session";
import {
  AD_STATS_DEFAULT_DAYS,
  type AdDailyRow,
  adDailyStats,
  adTotals,
  type AdRow,
  type AdTotals,
  listAds,
} from "@/lib/db/queries/ads";
import { formatCount } from "@/lib/format";

export const metadata: Metadata = {
  title: "House ads",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type AdsData = {
  ads: AdRow[];
  totals: AdTotals;
  daily: AdDailyRow[];
};

/** Returns `null` for "refuse this visitor"; anything else propagates and becomes a 500. */
async function loadAds(): Promise<AdsData | null> {
  try {
    /* Called for the gate's error, not for a flag: `requireAdmin` throws rather than returning
       a boolean precisely so a caller cannot forget to check the result (I-18). */
    await requireAdmin();
    const [ads, totals, daily] = await Promise.all([listAds(), adTotals(), adDailyStats()]);
    return { ads, totals, daily };
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof UnauthorizedError) return null;
    throw error;
  }
}

export default async function AdminAdsPage() {
  const data = await loadAds();
  if (!data) notFound();

  return (
    <div className="space-y-10">
      <header className="letterbox">
        <Eyebrow>Operator</Eyebrow>
        <h1 className="mt-2 font-display text-3xl leading-tight text-paper sm:text-4xl">House ads</h1>
        <p className="mt-2 text-sm text-muted">
          First-party rows only — no network, no third-party script, no pixel, which is why the
          content security policy needs no holes cut in it.{" "}
          <Link href="/spotlight" className="transition-colors hover:text-amber">
            The public spotlight page
          </Link>{" "}
          lists every indie placement currently running.
        </p>
      </header>

      <DailyStrip daily={data.daily} />

      <AdManager ads={data.ads} totals={data.totals} />

      <p className="text-[0.75rem] leading-relaxed text-faint">
        Every action on this page writes an audit row inside the same transaction as its effect —
        the row cannot exist without the change, and the change cannot exist without the row.{" "}
        <Link href="/admin" className="text-muted transition-colors hover:text-amber">
          Accounts
        </Link>
        .
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The fortnight                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Fourteen days of impressions and clicks, in CSS.
 *
 * DAYS WITH NO ACTIVITY ARE ABSENT FROM THE QUERY, not zero-valued — `ad_stats` only holds rows
 * for days something happened — so this renders the rows it was given rather than a fixed
 * fourteen columns. A gap in the strip is the truth about a quiet day, and padding the series
 * with synthetic zeroes would put numbers in the interface that no row anywhere supports.
 *
 * The bar heights are normalised against the largest impression count in the window, so the
 * strip shows SHAPE and the numbers underneath carry the magnitude. Normalising each day
 * against itself would make every bar full height.
 */
function DailyStrip({ daily }: { daily: AdDailyRow[] }) {
  if (daily.length === 0) {
    return (
      <section>
        <SectionHeading as="h2" eyebrow={`Last ${AD_STATS_DEFAULT_DAYS} days`} title="Nothing served yet" />
        <p className="text-sm text-muted">
          Counters start when an active placement is half on screen. Nothing has been recorded in
          the window.
        </p>
      </section>
    );
  }

  const peak = Math.max(...daily.map((row) => row.impressions), 1);
  const impressions = daily.reduce((sum, row) => sum + row.impressions, 0);
  const clicks = daily.reduce((sum, row) => sum + row.clicks, 0);

  return (
    <section>
      <SectionHeading
        as="h2"
        eyebrow={`Last ${AD_STATS_DEFAULT_DAYS} days`}
        title={`${formatCount(impressions)} seen, ${formatCount(clicks)} clicked`}
      />
      {/*
        `aria-hidden` on the strip and a real list underneath would be two copies of the same
        data. Instead each bar is a `<div>` inside a labelled figure, and the accessible content
        is the caption: the numbers that matter are already in the heading above, so the strip is
        decoration over data rather than the only way to read it.
      */}
      <figure className="space-y-2">
        <div className="flex items-end gap-1" aria-hidden="true">
          {daily.map((row) => (
            <div key={row.day} className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-sm bg-amber/30"
                /* An inline height is a style attribute set from a trusted computed value —
                   exactly the case `style-src 'unsafe-inline'` is kept for. */
                style={{ height: `${Math.max(2, Math.round((row.impressions / peak) * 48))}px` }}
              />
              {/* Clicks as a second, shorter bar in the replay tone rather than a stacked
                  series: stacking would make the taller bar's height mean two things. */}
              <div
                className="w-full rounded-sm bg-teal/40"
                style={{ height: `${Math.max(1, Math.round((row.clicks / peak) * 48))}px` }}
              />
            </div>
          ))}
        </div>
        <figcaption className="font-mono text-[0.625rem] uppercase tracking-wider text-faint">
          Impressions in amber, clicks in teal, over {daily.length}{" "}
          {daily.length === 1 ? "day" : "days"} with activity.
        </figcaption>
      </figure>
    </section>
  );
}

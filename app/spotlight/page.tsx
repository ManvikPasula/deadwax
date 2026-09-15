/**
 * /spotlight — every independent release currently reserved a slot, on one page.
 *
 * ---------------------------------------------------------------------------------------
 * WHY A PAGE OF ADVERTISING IS INDEXABLE AND FOOTER-LINKED
 * ---------------------------------------------------------------------------------------
 *
 * The house-ad system reserves one slot in three for `kind: "indie"` — a self-released record
 * with a named artist behind it. That reservation is the promise the whole ad surface is built
 * around, and a promise nobody can inspect is a promise. This page is the inspection: it lists
 * the reservation in full, so the claim on the ad card ("Indie spotlight") is checkable rather
 * than decorative.
 *
 * It is **indexable**, unlike every other surface that renders an ad unit, because for the
 * artists in it this is the only page on the site that is about them. `rel="sponsored nofollow"`
 * on the outbound link (set once in `AdCard`) is what keeps that from being a link-selling
 * scheme: the page can be found, and it passes no ranking.
 *
 * It is **footer-linked and not in the header**, which is a considered ranking rather than an
 * oversight: the spotlight is worth finding, and it is not one of the things somebody opens
 * the app to do. A nav item for it would put paid placement at the same level as the diary.
 *
 * ---------------------------------------------------------------------------------------
 * THE TWO WAYS THIS PAGE DELIBERATELY DIFFERS FROM EVERY OTHER AD SURFACE
 * ---------------------------------------------------------------------------------------
 *
 * 1. **`MAX_ADS_PER_PAGE` does not apply.** The ceiling of 2 exists because an ad unit on a
 *    content page is an interruption, and three interruptions in one column is a different
 *    product. Here the placements ARE the content; capping them at two would leave the other
 *    advertisers off the one page that exists to list them.
 *
 * 2. **The Pro exemption does not apply.** Everywhere else, `adsEnabledFor` is checked at the
 *    point of fetch so a Pro member's page runs no candidate query at all. Applying it here
 *    would serve a paying member an empty page for a route they deliberately opened — the plan
 *    buys freedom from interruption, not a worse version of a page they asked for. Stated here
 *    so the omission reads as a decision instead of a missing check.
 *
 * Both differences are why this page calls `fetchAdCandidates` directly rather than `serveAds`:
 * `serveAds` is the interruption planner — seed, cap, kind rotation, frequency — and none of
 * those four jobs is wanted on a page whose whole purpose is the complete list.
 *
 * ---------------------------------------------------------------------------------------
 * IMPRESSIONS STILL COUNT HERE, AND THAT IS CORRECT
 * ---------------------------------------------------------------------------------------
 *
 * `AdCard` carries its own `AdImpression` beacon, so a card seen on this page counts exactly
 * like a card seen in a feed — half the unit on screen, once per mount. An advertiser's daily
 * curve should include the people who came looking, and the counter has no per-member row to
 * distinguish them with anyway (`ad_stats` is one row per ad per day, by construction).
 */

import type { Metadata } from "next";
import Link from "next/link";
import { AdCard } from "@/components/ads/ad-card";
import { Button } from "@/components/ui/button";
import { EmptyState, Eyebrow, SectionHeading } from "@/components/ui/primitives";
import { INDIE_EVERY } from "@/lib/ads/plan";
import { fetchAdCandidates } from "@/lib/ads/serve";
import { plural } from "@/lib/format";

export const metadata: Metadata = {
  title: "Indie spotlight",
  description:
    "Self-released records with a slot reserved for them on Deadwax. One placement in three is kept for an independent artist.",
};

export default async function SpotlightPage() {
  /*
   * `"feed"` is the placement argument, and it is not a filter here.
   *
   * `fetchAdCandidates` selects on status and schedule only — the slot match happens later, in
   * `pickAd`, because an ad marked `sidebar` is still a legitimate candidate for a page that
   * has no sidebar concept. This page has neither, so the argument is inert and the whole
   * active, in-schedule inventory comes back; the filter that matters is the one below.
   */
  const candidates = await fetchAdCandidates("feed");
  const indie = candidates.filter((ad) => ad.kind === "indie");

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header className="letterbox">
        <Eyebrow>{indie.length === 0 ? "Indie spotlight" : plural(indie.length, "release")}</Eyebrow>
        <h1 className="mt-2 font-display text-3xl leading-tight text-paper text-balance sm:text-4xl">
          Indie spotlight
        </h1>
        {/*
          THE POLICY IN PROSE, WITH THE REAL CONSTANT INTERPOLATED. If `INDIE_EVERY` changes,
          this sentence changes with it — a hard-coded "one in three" is how a page ends up
          describing a reservation the code stopped honouring two releases ago.
        */}
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted">
          One advertising slot in {INDIE_EVERY} across Deadwax is reserved for a self-released
          record, and every reserved placement names the artist behind it. This page is the whole
          list, so the reservation can be checked rather than taken on trust.
        </p>
      </header>

      {indie.length === 0 ? (
        <EmptyState
          title="No independent releases running right now"
          description="The slot is still reserved — when nothing is booked into it, the space goes to a general placement rather than sitting empty."
          action={
            <Button asChild variant="secondary">
              <Link href="/albums">Browse the catalogue instead</Link>
            </Button>
          }
        />
      ) : (
        <section>
          <SectionHeading
            as="h2"
            eyebrow="Currently running"
            title="Records in the reservation"
          />
          {/*
            TWO COLUMNS, NOT A RAIL. `AdCard` uses `mt-auto` on its call to action so a grid of
            them lines their buttons up whatever the copy's length; a horizontally-scrolling
            rail would hide most of a list whose completeness is the point of the page.
          */}
          <ul className="grid gap-4 sm:grid-cols-2">
            {indie.map((ad) => (
              <li key={ad.id} className="flex">
                {/* `AdCard` renders its own "Indie spotlight" badge, its own credit block and
                    its own impression beacon — nothing about the unit is re-stated here. */}
                <AdCard ad={ad} className="w-full" />
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="max-w-prose text-[0.8125rem] leading-relaxed text-faint">
        Deadwax runs first-party placements only: rows in our own database, rendered by our own
        components. There is no ad network, no third-party script and no tracking pixel anywhere
        in the product, and the counters behind these cards record one row per placement per day
        with no record of who saw what.
      </p>
    </div>
  );
}

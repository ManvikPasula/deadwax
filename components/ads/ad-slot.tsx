/**
 * One planned unit on a page — OR NOTHING AT ALL.
 *
 * ============================================================================
 * AN EMPTY SLOT RENDERS NOTHING. NOT A FRAME, NOT A PLACEHOLDER, NOT A SKELETON.
 *
 * `planPage` omits a slot whose pool was empty rather than filling it, so `plan[1]` being
 * `undefined` is a DESIGNED OUTCOME and not an error: an empty shelf is the normal state of a
 * house-ad system with a handful of rows in it, and a two-slot page with one ad in inventory
 * is honestly rendered as one unit. This component's entire contract is to keep that true all
 * the way to the DOM.
 *
 * The rejected alternative is the one every ad integration reaches for — a bordered box
 * reading "advertisement" or a reserved-height div to stop layout shift. On a page with no
 * eligible inventory that is a hole the member is asked to look at, and on a new deployment
 * with an empty `ads` table it is a hole on every page.
 * ============================================================================
 *
 * THE PAGE SERVES, THE SLOT RENDERS. `serveAds` is called ONCE per page and returns up to
 * `MAX_ADS_PER_PAGE` units; a page then places them (`<AdSlot ad={plan[0]} />` in the
 * sidebar, `<AdSlot ad={plan[1]} />` after the fifth feed row). Making this component async
 * and letting it serve itself would be the tempting simplification and it breaks two
 * properties at once: two slots serving independently have no shared `placed` set, so a
 * single-row inventory renders the same card twice; and each serve costs its own candidate
 * query and affinity read.
 *
 * NO `"use client"`. The beacon inside `AdCard` is the only client island in the subtree.
 */

import { AdCard } from "@/components/ads/ad-card";
import type { PlannedAd } from "@/lib/ads/plan";

export type AdSlotProps = {
  /**
   * One entry from `serveAds`, or nothing.
   *
   * `undefined` IS THE EXPECTED CALL, not a defensive signature: a page indexes into a plan
   * that may be shorter than the number of positions it has room for, and `plan[1]` on a
   * one-unit plan is `undefined`. `null` is accepted for the surfaces that compute a plan
   * conditionally.
   *
   * IT IS THE WHOLE `PlannedAd`, and `AdCard` receives only `ad` — see that file's docblock
   * on why the planned `kind` must never reach a badge.
   */
  ad?: PlannedAd | null;
  className?: string;
};

export function AdSlot({ ad, className }: AdSlotProps) {
  if (!ad) return null;

  return (
    /*
     * A `complementary` LANDMARK, WHICH IS WHAT MAKES THE UNIT SKIPPABLE.
     *
     * `<aside>` with a name puts the ad in the landmark list, so somebody navigating by region
     * can jump over it in one move instead of tabbing through a headline and a CTA on every
     * page. The label says "Advertisement" for both kinds: the card's own badge distinguishes
     * a spotlight from a general placement, and a landmark whose name changed with the row
     * would be a different region on every page load.
     *
     * The word is spelled out rather than shortened to "Ad", because a landmark name is read
     * aloud in isolation and "ad" is ambiguous when heard rather than seen.
     */
    <aside aria-label="Advertisement" className={className}>
      <AdCard ad={ad.ad} />
    </aside>
  );
}

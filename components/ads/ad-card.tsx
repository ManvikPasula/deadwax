/**
 * One house ad. A headline, a line of copy, a CTA, and — on an indie placement — a credit.
 *
 * NO `"use client"`. The only thing in this subtree that needs the browser is the impression
 * beacon, which is its own client island; the card itself is markup.
 *
 * ============================================================================
 * THERE IS NO IMAGE, AND THAT IS A DECISION RATHER THAN A GAP.
 *
 * > Uploads would need a bucket, and remote images would need host allowlisting plus a review
 * > process for what those hosts serve. A headline, a line of copy and a credit are enough,
 * > and they cannot carry a tracking pixel.
 *
 * The last clause is the one that settles it. `ads` has no image column at all, so there is
 * nothing in this system that fetches a third-party URL on a member's behalf — no referrer
 * leak, no IP disclosed to an advertiser, no 1×1 GIF, and no hole cut in the CSP in proxy.ts.
 * Adding an `<img src={ad.imageUrl}>` here would undo all of that in one line and none of it
 * would look wrong.
 * ============================================================================
 *
 * THE BADGE READS `ad.kind`, AND THIS COMPONENT CANNOT SEE THE PLANNED KIND AT ALL.
 *
 * `PlannedAd` carries two kinds: `kind` is the one DRAWN for the slot, and `ad.kind` is the
 * one that was actually served. They differ whenever the fallback fires — `pickAd` treats the
 * reservation as a preference, not a lock, so a slot drawn for indie on a page with no indie
 * inventory serves a general ad, which is the NORMAL state of a house-ad system with a
 * handful of rows in it. A badge rendered from the planned kind would therefore label a
 * general advertiser "indie spotlight" on every page where the indie shelf happened to be
 * empty: a false claim about a paying placement, made invisibly.
 *
 * This card therefore takes an `AdCandidate` and not a `PlannedAd`. The unwrapping happens in
 * components/ads/ad-slot.tsx, so the wrong field is not merely discouraged here — it is not
 * in scope.
 *
 * THE CTA IS A `GET` THAT WRITES, DELIBERATELY AND WITH THE TRADE WRITTEN DOWN.
 *
 * > A click has to survive being middle-clicked and opened in a new tab, and a form post
 * > cannot do that.
 *
 * `/api/ads/{id}/click` counts and then redirects to the row's own `target_url`. Over the
 * rate limit the click still forwards, it is just not counted, because refusing to forward
 * somebody who clicked a link is worse than an uncounted click; and no open redirect is
 * possible because the destination comes from the row rather than from the query string.
 */

import { ArrowRight } from "lucide-react";

import { AdImpression } from "@/components/ads/ad-impression";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import type { AdCandidate } from "@/lib/ads/plan";
import { cn } from "@/lib/utils";

/**
 * `ads.project_kind` is a `varchar` WITH NO CHECK CONSTRAINT (§2.5), so this map is a
 * whitelist and not a formatter: an unrecognised value renders nothing rather than being
 * echoed into the credit line in whatever case it was typed. Same defensive posture as the
 * row-to-candidate mapping in lib/ads/serve.ts — anything unrecognised degrades rather than
 * throwing.
 *
 * The four keys are `createAdSchema`'s own enum. EP and LP are upper-cased because they are
 * initialisms and "Ep" reads as a typo in a credit block that is naming somebody's record.
 */
const PROJECT_KINDS: Record<string, string> = {
  single: "Single",
  ep: "EP",
  lp: "LP",
  mixtape: "Mixtape",
};

export type AdCardProps = {
  /**
   * The served ad — `PlannedAd.ad`, never the `PlannedAd` itself. See the docblock: the
   * planned kind is deliberately out of reach in here.
   *
   * `AdCandidate` carries no `impressions`, `clicks`, `status` or `createdBy`, and that
   * omission is what lets this object cross the server/client boundary: props travel in the
   * RSC payload, so a projection carrying the counters would publish a campaign's performance
   * to anybody who views source.
   */
  ad: AdCandidate;
  className?: string;
};

export function AdCard({ ad, className }: AdCardProps) {
  const indie = ad.kind === "indie";
  const projectKind = ad.projectKind ? PROJECT_KINDS[ad.projectKind] : undefined;
  /*
   * An indie row is refused at creation without a `creatorName` — an indie placement without
   * a credit is just an ad with a blue border, spending a third of all impressions on nothing
   * — but the column is nullable, so rows written before that rule existed still render.
   * The credit block is therefore conditional on the name rather than on the kind.
   */
  const credit = indie && ad.creatorName ? ad.creatorName : null;

  return (
    /*
     * `relative` IS REQUIRED BY THE BEACON. `AdImpression` is an `absolute inset-0` span, so
     * without a positioned ancestor here it would size itself against whatever container
     * further up happens to be positioned — and the 50% threshold would then be measuring
     * some other element's visibility.
     */
    <div
      className={cn(
        "card relative flex flex-col gap-3 p-4",
        // THE DESERT-BLUE RIM IS THE INDIE UNIT'S VISUAL DISTINCTION. `desert` is the Desert
        // Island colour and is used for nothing else in the app, which is the point: the
        // spotlight is the one other place the product says "this one is special", and
        // borrowing the honour's own blue is what makes the rim read as an endorsement rather
        // than as a second neutral border. It replaces `.card`'s hairline rather than adding
        // to it, because `.card` sits in `@layer components` and a utility wins.
        indie && "border-desert/40",
        className,
      )}
    >
      {/* THE FIRST CHILD OF EVERY AD CARD. See ad-impression.tsx. */}
      <AdImpression adId={ad.id} />

      {/*
        THE UNIT IS LABELLED IN TEXT, NOT ONLY BY ITS RIM. A colour-coded frame is not a
        disclosure: somebody who cannot see the blue, or who is reading this in a feed of
        twenty cards, needs the word. "Indie spotlight" also says what the reservation is for,
        which a bare "Ad" on an independent artist's EP would not.

        `self-start` so the pill is its own width rather than the column's — a `Badge` is an
        `inline-flex`, and a flex child stretches to the cross axis without it.
      */}
      {indie ? (
        <Badge tone="desert" className="self-start">
          Indie spotlight
        </Badge>
      ) : (
        <Badge className="self-start">Ad</Badge>
      )}

      <div className="min-w-0">
        {/*
          Display serif, and `text-lg` rather than the `text-2xl` a section heading gets: an
          ad headline is a headline and belongs in the display family, but it must not outrank
          the heading of the section it is sitting inside.
        */}
        <p className="font-display text-lg leading-tight text-paper text-balance">{ad.headline}</p>
        <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted">{ad.body}</p>
      </div>

      {credit ? (
        /*
         * THE CREDIT BLOCK — the whole justification for the indie reservation. Mono at 11px,
         * like every other piece of metadata in the product, and separated by a hairline
         * because it is a different kind of statement from the copy above it: the copy is
         * what the advertiser wants to say, and this is who they are.
         */
        <dl className="border-t border-line pt-3 font-mono text-[0.6875rem] tracking-wider">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <dt className="sr-only">Artist</dt>
            <dd className="text-paper">{credit}</dd>
            {projectKind ? (
              <>
                <dt className="sr-only">Release</dt>
                <dd className="text-faint">{projectKind}</dd>
              </>
            ) : null}
            {ad.label ? (
              <>
                <dt className="sr-only">Label</dt>
                <dd className="text-faint">{ad.label}</dd>
              </>
            ) : null}
          </div>
        </dl>
      ) : null}

      {/*
        `mt-auto` so the CTA sits on the bottom edge whatever the copy's length — two ad cards
        side by side in a feed otherwise have their buttons at different heights, which reads
        as a broken grid rather than as two different amounts of text.
      */}
      <div className="mt-auto">
        <Button asChild variant={indie ? "outline" : "secondary"} size="sm">
          <a
            href={`/api/ads/${ad.id}/click`}
            /*
             * `sponsored` IS THE HONEST REL AND `nofollow` IS THE BELT AND BRACES. The href is
             * our own redirect endpoint rather than the advertiser's URL, so a crawler cannot
             * see where it leads — which is a reason to declare the relationship rather than a
             * reason not to. `noopener` costs nothing on a same-tab link and covers the member
             * who middle-clicks it, which is the gesture this GET exists to support.
             */
            rel="sponsored nofollow noopener"
            /*
             * The visible label is free text an operator wrote ("Listen now", "Pre-order"), so
             * on a page carrying two units the accessible names would otherwise be
             * indistinguishable. The headline is appended rather than substituted, so the
             * visible text remains the start of the accessible name — which is what WCAG 2.5.3
             * asks for, and what lets somebody driving the page by voice say the words they
             * can see.
             */
            aria-label={`${ad.ctaLabel} — ${ad.headline}`}
          >
            {ad.ctaLabel}
            <ArrowRight />
          </a>
        </Button>
      </div>
    </div>
  );
}

/**
 * The taste-driven home rail — the most valuable thing on the signed-in home page and the
 * slowest, which is why the page wraps it in `<Suspense>` and streams it in last.
 *
 * AN ASYNC SERVER COMPONENT. `getRecommendations` is seven retrieval sources, up to eight
 * sequential detail syncs and a scoring pass; behind a Suspense boundary the rest of the home
 * page — the stat tiles, the recent plays, the following feed — flushes immediately and this
 * arrives when it is ready. `PersonalRailsSkeleton` below is the fallback.
 *
 * THE BOUNDARY IS SAFE HERE AND WOULD NOT BE ON A CONTENT ROUTE (I-3): nothing in this
 * component can raise `notFound()`, so nothing it does can decide a response status after the
 * shell has already flushed as a 200.
 *
 * ---------------------------------------------------------------------------------------
 * UP TO TWO REASONS PER CARD. NOT ONE.
 * ---------------------------------------------------------------------------------------
 *
 * `AlbumPrediction.reasons` holds at most three strings, pushed INSIDE the branch that actually
 * moved the score, in a fixed order — and the neighbour reason ("Listeners of Aphex Twin tend
 * to play this too") is pushed first whenever the album arrived through the neighbour graph,
 * which is the single largest term in the model and therefore most of the list.
 *
 * So rendering `reasons[0]` alone — which is what the source surface does — means the attribute
 * reasons (genre lean, label, era, the member's own consensus alignment) are computed, ranked
 * on, and then NEVER SEEN by anybody, because a neighbour reason is standing in front of every
 * one of them. Two is the number that fits a 152px card at 11px without clamping to a stub, and
 * it is the number that makes the second-largest term visible.
 *
 * ---------------------------------------------------------------------------------------
 * ONE RANKED RAIL, NOT ONE RAIL PER PROVENANCE
 * ---------------------------------------------------------------------------------------
 *
 * The tempting split is "Because you play X" for the neighbour-sourced items and "From your
 * ratings" for the rest — better headings, and `neighbourOf` is right there on every item. It
 * is rejected because it destroys the one ordering the model produced: `rankingScore` shrinks
 * each prediction toward the member's own mean by its confidence, so the list is a single
 * ranking, and cutting it in two hands the best rows to the first rail and leaves the second
 * looking like the leftovers.
 *
 * ---------------------------------------------------------------------------------------
 * THE PREDICTION NEVER ENTERS THE CARD'S AVERAGE SLOT
 * ---------------------------------------------------------------------------------------
 *
 * `cardFromAlbumRow` leaves `memberAverage` null for these rows and that is deliberate: the
 * card's star figure means "what members here rated this", and a model estimate wearing it
 * would be indistinguishable from a real community average. The prediction is printed BELOW the
 * card, in its own line, with the word "predicted" attached to it.
 */

import Link from "next/link";

import { CoverCard } from "@/components/album/cover-card";
import { CoverRail } from "@/components/album/cover-rail";
import { Stars } from "@/components/rating/stars";
import { Button } from "@/components/ui/button";
import { EmptyState, Eyebrow, Meter, SectionHeading, Spinner } from "@/components/ui/primitives";
import { formatRating } from "@/lib/ratings";
import { getRecommendations } from "@/lib/taste/recommend";
import { cardFromAlbumRow } from "@/lib/view";

/** A rail's worth, the same twelve every other rail on the page uses. */
const RAIL_SIZE = 12;

/** How many placeholder sleeves the fallback draws. Eight is a wide screen's worth. */
const SKELETON_FRAMES = 8;

export type PersonalRailsProps = {
  /** The signed-in member. There is nothing to predict for a signed-out visitor, so the page
      renders `HomeRails` instead rather than passing null here. */
  userId: number;
  limit?: number;
  className?: string;
};

export async function PersonalRails({ userId, limit = RAIL_SIZE, className }: PersonalRailsProps) {
  const result = await getRecommendations(userId, limit);

  /* ================================================================== *
   * THE THREE COLD-START GATES — THREE DISTINCT MESSAGES
   * ================================================================== */
  /*
   * THE COPY IS THE SERVER'S, VERBATIM. `RecommendationResult` has four arms and three of them
   * carry their own `title` and `message`; there is deliberately no shared `message` field, so
   * this component CANNOT render one apology for all three situations. Nothing below writes a
   * sentence about the gate — only button labels, which are navigation rather than an
   * explanation.
   *
   * *Ten indistinguishable predictions dressed as a ranked list is worse than saying there is
   * nothing to say yet.*
   *
   * `withheld` is the discriminant rather than an `ok` flag because a withheld list is a PASS,
   * not a failure: the flat rater is supposed to be refused.
   */
  if (result.withheld) {
    return (
      <section className={className}>
        <Eyebrow className="mb-3">For you</Eyebrow>
        <EmptyState
          title={result.title}
          description={result.message}
          action={
            <div className="flex flex-col items-center gap-4">
              {/*
                THE PROGRESS BAR EXISTS FOR ONE ARM ONLY. `needed` is carried by the `too-few`
                arm and by nothing else, so TypeScript's own narrowing is what stops a bar being
                drawn for a member whose ratings are merely too alike — where there is no
                number to count toward and a bar would imply that rating five more of the same
                thing would unlock it.
              */}
              {result.reason === "too-few" ? (
                <div className="w-56 space-y-1.5">
                  <p className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
                    {result.ratedAlbums} of {result.needed} albums rated
                  </p>
                  {/*
                    `ratio` IS 0..1 — `Meter`'s own docblock warns that passing a percentage
                    pins every bar at 100%, which looks like a working feature. The count is
                    printed directly above, so the bar takes no `label` and is hidden from
                    assistive technology.
                  */}
                  <Meter ratio={result.ratedAlbums / result.needed} tone="amber" />
                </div>
              ) : null}
              <Button asChild variant="primary">
                <Link href="/albums">Find records to rate</Link>
              </Button>
            </div>
          }
        />
      </section>
    );
  }

  /*
   * `items` IS NON-EMPTY HERE BY CONSTRUCTION: `getRecommendations` returns the `cold-pool` arm
   * — handled above — whenever the pool, the candidate set or the final list comes back empty.
   * There is no fourth empty state to design.
   */
  return (
    <section className={className}>
      <SectionHeading
        eyebrow="Predicted for you"
        title="Records to try next"
        action={
          <Button asChild variant="ghost" size="sm">
            <Link href="/for-you">All recommendations</Link>
          </Button>
        }
      />

      <CoverRail>
        {result.items.map((item) => {
          // UP TO TWO — see the docblock. `slice` rather than `[0]` and `[1]`, because a
          // prediction with a single reason is ordinary and two lookups would render "undefined".
          const reasons = item.reasons.slice(0, 2);
          return (
            // THE WRAPPER CARRIES NO WIDTH. `CoverRail` sizes its direct children itself
            // (`[&>*]:w-[132px] sm:[&>*]:w-[152px]`, `[&>*]:shrink-0`), which is also why the
            // card is wrapped at all rather than dropped in bare: the prediction line and the
            // reasons have to travel inside the same sized child, or they would become rail
            // children of their own and each take a 132px column.
            <div key={item.id} className="space-y-1.5">
              <CoverCard album={cardFromAlbumRow(item)} />

              <p className="flex items-center gap-1.5 font-mono text-[0.6875rem] tabular text-faint">
                {/*
                  `label={null}` because the sentence after it carries the whole readout — the
                  glyphs would otherwise announce "4 out of 5 stars" and then the sr-only text
                  would say it again with the word "predicted" attached, and only the second
                  version is true.
                */}
                <Stars value={item.rating} size="xs" label={null} />
                <span aria-hidden="true">predicted</span>
                <span className="sr-only">
                  {`Predicted ${formatRating(item.rating)} out of 5 stars — an estimate, not a rating anybody has given.`}
                </span>
              </p>

              {/*
                THE CONFIDENCE FIGURE IS DELIBERATELY NOT HERE. It exists on every item and it
                is printed on /for-you, where the 90% ceiling is explained beside it. On a rail
                of twelve, twelve percentages invite comparing two numbers that differ by noise,
                and the explanation has nowhere to live at 11px.
              */}
              {reasons.length > 0 ? (
                <ul className="space-y-0.5">
                  {reasons.map((reason) => (
                    // `line-clamp-2` rather than `truncate`: these sentences name an artist or
                    // a label and cutting them at one line loses exactly the noun that makes
                    // the reason a reason.
                    <li key={reason} className="line-clamp-2 text-[0.6875rem] leading-snug text-faint">
                      {reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </CoverRail>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The Suspense fallback                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The fallback for the boundary the home page puts around `PersonalRails`.
 *
 * IT REUSES `.sleeve` FOR THE PLACEHOLDERS rather than inventing a grey box: the class already
 * carries the 1:1 geometry, the `surface-2` field and the inset hairline, so the skeleton has
 * the exact dimensions of the rail that replaces it and the page does not jump when it does.
 *
 * NO SHIMMER, NO PULSE, AND THAT IS NOT A SHORTCUT. globals.css's blanket reduced-motion block
 * sets `animation-duration: 0.001ms !important` on everything, so a pulsing skeleton is a
 * STILL GREY BOX for any member who asked for reduced motion — and a grid of still grey boxes
 * with no text says "broken", not "working". `Spinner` carries the `sr-only` label that says
 * it, for exactly the same reason its own docblock gives.
 */
export function PersonalRailsSkeleton({ className }: { className?: string }) {
  return (
    <section className={className} aria-busy="true">
      <SectionHeading
        eyebrow="Predicted for you"
        title="Working out what to play"
        action={<Spinner label="Working out your recommendations" />}
      />
      {/*
        `aria-hidden`: the placeholders are furniture, and the spinner above is the one thing
        that should be announced.

        NOT `CoverRail`, and this is the one place the rail's child width is written out again.
        `overflow-hidden` rather than `overflow-x-auto`: there is nothing to scroll TO yet, and
        a scrollable skeleton invites a gesture that does nothing and then loses the scroll
        position when the real rail replaces it. The 132/152 pair is copied deliberately so the
        fallback occupies exactly the space `CoverRail` will — the whole point of a skeleton is
        that the page does not jump.
      */}
      <div aria-hidden="true" className="flex gap-4 overflow-hidden py-2">
        {Array.from({ length: SKELETON_FRAMES }, (_, index) => (
          <div key={index} className="w-[132px] shrink-0 sm:w-[152px]">
            <div className="sleeve" />
            <div className="mt-2 h-3 w-4/5 rounded-sm bg-surface-2" />
            <div className="mt-1.5 h-3 w-2/5 rounded-sm bg-surface-2" />
          </div>
        ))}
      </div>
    </section>
  );
}

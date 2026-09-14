"use client";

/**
 * One card's worth of onboarding: stars, and "not heard it".
 *
 * > The smallest possible control: stars, and "not heard it" to clear the card out of the way.
 * > No dialog, no diary date, no review — those are worth discovering later, and asking for
 * > them now is how a first session ends early.
 *
 * So this deliberately does NOT reuse `LogDialog`, which is the obvious alternative and is
 * already built. That control is correct everywhere else in the product and wrong here: it
 * asks for a date, a replay flag, tags and a review body, and a grid of twenty-four albums
 * behind it means twenty-four openings of a modal to answer a question nobody asked. The
 * things it offers are worth finding on an album page, once somebody has decided they are
 * staying.
 *
 * ---------------------------------------------------------------------------------------
 * OPTIMISTIC, BECAUSE THE ALTERNATIVE MAKES THE PAGE LOOK BROKEN
 * ---------------------------------------------------------------------------------------
 *
 * > A star that waits for a round trip before filling makes a grid of twenty albums feel
 * > broken.
 *
 * `StarInput` splits its two callbacks for exactly this shape: `onChange` fires on the same
 * frame as the gesture and moves the glyphs, `onCommit` fires 250 ms after the last gesture
 * and is the only network write. A member sweeping across three stars on one card therefore
 * produces one `saveLog`, not five.
 *
 * ROLLBACK RESTORES THE PROP, NOT THE PREVIOUS LOCAL VALUE.
 *
 * > Put the star back where it was rather than showing a filled star for a rating that does
 * > not exist.
 *
 * `optimistic` is `number | null | undefined`, and THE THREE VALUES ARE THREE DIFFERENT
 * THINGS: a number is a guessed rating, `null` is a guessed clear, and `undefined` means
 * "trust the prop". Collapsing the last two — the natural `useState<number | null>(rating)` —
 * loses the ability to drop the guess at all, so a failed clear would leave the stars empty
 * for a rating that is still in the database. The prop itself is server truth: /start
 * prefills it from the viewer's existing logs, because an onboarding grid that offers back the
 * albums somebody just rated reads as though the ratings did not save.
 *
 * `useOptimistic` was rejected for the same reason `FollowButton` rejects it: it resets when
 * the transition ends, and the transition and the `router.refresh()` do not end in a
 * guaranteed order, so the stars can visibly empty for a frame before the new tree lands.
 *
 * ---------------------------------------------------------------------------------------
 * "NOT HEARD IT" WRITES NOTHING. IT IS LOCAL STATE AND NOTHING ELSE.
 * ---------------------------------------------------------------------------------------
 *
 * There is no "not heard it" in the schema and there must not be one: `logs` records what
 * somebody DID, and the absence of a row already says the absence of a listen. The button
 * fades the card and collapses the control so the grid reads as a shrinking pile of decisions
 * rather than a wall of twenty-four unanswered ones — which is the whole job, and it is a job
 * for `useState`.
 *
 * It is offered only while the card is unrated, because "I have not heard this" and a
 * four-star rating are contradictory statements and a control that can express both at once
 * is a control that has to decide which one wins.
 *
 * DISMISSAL SURVIVES A `router.refresh()`, and that is deliberate: the refresh re-renders the
 * server tree without remounting this component, so a card cleared away stays cleared while
 * the eyebrow above the grid counts up. It does not survive a real navigation, which is the
 * same "per page load" scope the guest strip's dismissal uses.
 */

import { EyeOff, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { saveLog } from "@/app/actions/logs";
import { StarInput } from "@/components/rating/star-input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export type QuickRateProps = {
  /** `albums.id`. The row must already exist — /start calls `cacheAlbumSummaries` first. */
  albumId: number;
  /**
   * The album's title, for the star slider's accessible name: "Your rating for Kid A".
   * REQUIRED, because a grid of twenty-four glyph-only sliders all named "Your rating" tells a
   * screen-reader user nothing about which card they are on.
   */
  title: string;
  /**
   * The viewer's existing rating on the stored 1..10 scale, or `null`.
   *
   * THIS IS THE ROLLBACK TARGET. See the docblock: a failed write drops the local guess and
   * lets this prop be the truth again.
   */
  rating: number | null;
  /**
   * The cover card this control belongs to, rendered above it.
   *
   * Passed as children rather than rebuilt here so the card stays SERVER-rendered: `CoverCard`
   * is the most-rendered component in the product and has no state, and a client copy of it
   * would ship twenty-four covers' worth of markup twice — once as HTML, once as props. It is
   * a child rather than a sibling because "not heard it" has to clear THE CARD out of the way,
   * and a component cannot fade an element it does not contain.
   */
  children?: React.ReactNode;
  className?: string;
};

export function QuickRate({ albumId, title, rating, children, className }: QuickRateProps) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [optimistic, setOptimistic] = React.useState<number | null | undefined>(undefined);
  const [cleared, setCleared] = React.useState(false);
  /*
   * THE PENDING FLAG IS DELIBERATELY DISCARDED, AND THIS IS THE ONE PLACE IN THE APP THAT
   * DISCARDS IT.
   *
   * Every other write in the product disables its control while in flight, because pressing
   * "Follow" twice or "Delete" twice means something. Here the control IS the feedback: the
   * glyphs are already filled before the request leaves, and `router.refresh()` keeps a
   * transition pending for as long as the server takes to re-render the page. Disabling on
   * that would grey out the stars — `StarInput` drops its hit targets entirely when
   * `disabled` — for a few hundred milliseconds after every single rating, on the one screen
   * whose whole purpose is to absorb twenty-four of them in a row. That is exactly the
   * "feels broken" the optimistic update exists to avoid.
   *
   * A second gesture during the flight is harmless: `StarInput` re-debounces and this
   * component schedules another write, which is the same edit the member asked for.
   */
  const [, startTransition] = React.useTransition();

  const shown = optimistic === undefined ? rating : optimistic;

  /** The debounced write. `StarInput` has already moved the glyphs by the time this runs. */
  function commit(next: number | null) {
    setError(null);

    startTransition(async () => {
      const result = await saveLog({
        albumId,
        rating: next,
        /**
         * AN EXPLICIT `null`, NOT AN OMISSION, AND THE TWO ARE DIFFERENT INSTRUCTIONS.
         *
         * `saveLogSchema` makes every mutable field `.nullable().optional()` precisely so that
         * `undefined` means "leave this column alone" and `null` means "clear it". Omitting
         * `listenedOn` here would leave a diary date in place on a row that already had one,
         * so an onboarding session — twenty-four ratings of records heard over twenty years —
         * would flood the diary with today's date or keep a date the member never chose. A
         * rating is not a play, and /start asks for ratings.
         */
        listenedOn: null,
      });

      if (!result.ok) {
        setError(result.error);
        // ROLL BACK TO THE PROP. Not to `!next`, and not to whatever the previous local value
        // happened to be: between the gesture and the failure the server tree may already have
        // moved for another reason, and inventing a third answer is worse than deferring.
        setOptimistic(undefined);
        return;
      }

      /*
       * The write feeds the eyebrow above the grid ("{n} rated · {m} more unlocks
       * recommendations"), the taste profile and every aggregate the album carries, none of
       * which this component can see. Re-render the server tree and drop the guess in the same
       * transition, so the prop is the truth again without a frame of disagreement.
       */
      setOptimistic(undefined);
      router.refresh();
    });
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/*
        The card is faded rather than unmounted when cleared. Unmounting it would reflow the
        grid under the cursor — every later card would shift up into the gap, and the next
        press would land on a different album than the one it was aimed at.
      */}
      <div className={cn("transition-opacity duration-150", cleared && "opacity-40")}>{children}</div>

      {cleared ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setCleared(false)}
          // The toggle's state is announced as well as painted: opacity is not information.
          aria-pressed={true}
          aria-label={`Not heard ${title} — undo`}
        >
          <Undo2 />
          Undo
        </Button>
      ) : (
        <>
          <StarInput
            value={shown}
            // Immediate, so the glyphs fill on the frame of the click. Wrapped rather than
            // passed as `setOptimistic` directly: a bare setter would read a function argument
            // as an updater, and nothing should be able to turn a rating into a callback.
            onChange={(next) => setOptimistic(next)}
            // Debounced by 250 ms inside StarInput, and flushed on blur and on unmount — so a
            // rating given and immediately navigated away from is still written.
            onCommit={commit}
            size="md"
            label={`Your rating for ${title}`}
          />

          {/*
            Hidden once there is a rating: see the docblock. Not DISABLED — a disabled control
            teaches that the option exists and is currently refused, and here it simply does
            not apply.
          */}
          {shown === null ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCleared(true)}
              aria-pressed={false}
              aria-label={`Not heard ${title} — clear it from the grid`}
              className="self-start"
            >
              <EyeOff />
              Not heard it
            </Button>
          ) : null}
        </>
      )}

      <FormError message={error} />
    </div>
  );
}

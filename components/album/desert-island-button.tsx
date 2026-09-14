"use client";

/**
 * The Desert Island crown. `"use client"` for the optimistic state and the transition.
 *
 * ---------------------------------------------------------------------------------------
 * IT RENDERS ONLY AT FIVE STARS
 * ---------------------------------------------------------------------------------------
 *
 * `viewerRating === MAX_RATING` IS THE ENTIRE ENTRY CONDITION, so the control does not exist
 * anywhere else. Not disabled-with-a-reason, as it is when the quota is full: the quota is a
 * state the member is in and can trade their way out of, while a four-star track is a verdict
 * they have just expressed — offering the honour beside it would invite a click the server is
 * required to refuse ("Give it five stars first"). The three surfaces that show this control
 * all gate on the same expression.
 *
 * The rating is passed rather than read, and the gate is repeated SERVER-SIDE in
 * `crownTrack` against the LATEST rating for the track. This branch is the invitation; that
 * one is the rule.
 *
 * ---------------------------------------------------------------------------------------
 * THE OPTIMISTIC ARITHMETIC, AND WHY IT IS THE WHOLE COMPONENT
 * ---------------------------------------------------------------------------------------
 *
 *     held      = used + (optimistic === null || optimistic === marked ? 0 : optimistic ? 1 : -1)
 *     exhausted = !isMarked && held >= quota
 *
 * `used` IS A GLOBAL COUNT ACROSS EVERY ARTIST, and it ALREADY INCLUDES THIS TRACK when
 * `marked` is true — `crownTrack` reports `used` as `held` on the idempotent path precisely so
 * that this arithmetic can assume it. Hence the delta is applied only when the optimistic
 * answer DISAGREES with the prop: `optimistic === marked` is a click that landed on the state
 * we already had, and adding one for it would double-count the member's own mark.
 *
 * WHILE A CLICK IS IN FLIGHT IT HAS TO MOVE LOCALLY TOO, OR THE LAST FREE SLOT STILL READS AS
 * FREE. Ten crowns held, the member clears one, and the ninth row's button must stop saying
 * "full" on the same frame — `router.refresh()` has not returned yet, and until it does `used`
 * is stale by exactly one. This is the same shape `LikeButton` uses for its count and the
 * reason both are written as a signed delta rather than as a local mirror of the number.
 *
 * ROLLBACK IS TO THE PROP (`setOptimistic(null)`), never a flip. Flipping looks identical in
 * the common case and diverges permanently the moment two writes overlap.
 *
 * ---------------------------------------------------------------------------------------
 * EXHAUSTED DISABLES RATHER THAN HIDES
 * ---------------------------------------------------------------------------------------
 *
 * Ten marks is the point of the feature, so THE BUTTON SPENDS MOST OF ITS LIFE TELLING SOMEBODY
 * THEY WOULD HAVE TO GIVE SOMETHING UP. That is the feature working, not a failure state, so
 * the exhausted button explains itself rather than disappearing — a control that vanishes at
 * the ceiling teaches nothing about why, and the member is left thinking the honour is
 * unavailable on this record rather than spent elsewhere. The explanation is in `title` AND in
 * `sr-only` text inside the button, because a disabled button is skipped by Tab while a screen
 * reader's virtual cursor still reads its contents — the same pairing the heatmap's disabled
 * source buttons use.
 *
 * `quota` IS NEVER HARD-CODED AS 10. It arrives as a prop from `DESERT_ISLAND_QUOTA` and is
 * re-adopted from `toggleDesertIsland`'s own payload on every success, so the ceiling the
 * button draws and the ceiling the server enforces cannot drift.
 */

import { Palmtree } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { toggleDesertIsland } from "@/app/actions/logs";
import { FormError } from "@/components/ui/field";
import { MAX_RATING } from "@/lib/ratings";
import { cn } from "@/lib/utils";

export type DesertIslandButtonProps = {
  albumId: number;
  discNumber: number;
  trackNumber: number;
  /** For the accessible name. "Add Aerodynamic to your Desert Island". */
  trackTitle: string;
  /**
   * The viewer's own rating on the stored 1..10 scale. THE CONTROL RENDERS NOTHING unless this
   * is exactly `MAX_RATING`; see the docblock.
   */
  viewerRating: number | null;
  /** Is this track crowned? From `getCrownedTracks`. THE ROLLBACK TARGET. */
  marked: boolean;
  /** `countHeld(userId)` — GLOBAL, and already counting this track when `marked` is true. */
  used: number;
  /** `DESERT_ISLAND_QUOTA`. Re-adopted from the action's payload on success. */
  quota: number;
  className?: string;
};

export function DesertIslandButton({
  albumId,
  discNumber,
  trackNumber,
  trackTitle,
  viewerRating,
  marked,
  used,
  quota,
  className,
}: DesertIslandButtonProps) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  /** null = defer to the `marked` prop. See the rollback note in the docblock. */
  const [optimistic, setOptimistic] = React.useState<boolean | null>(null);
  /**
   * The server's own ceiling, adopted from the last successful payload. Null until then, so the
   * prop is the answer on first render and a stale prop can only ever be corrected, never
   * replaced by a guess.
   */
  const [serverQuota, setServerQuota] = React.useState<number | null>(null);
  const [pending, startTransition] = React.useTransition();

  // FIVE STARS IS THE WHOLE ENTRY CONDITION. Evaluated after the hooks, never before them:
  // returning early above a `useState` would change the hook order the moment a member rates a
  // track from four stars to five, which React reports as a crash rather than as a re-render.
  if (viewerRating !== MAX_RATING) return null;

  const isMarked = optimistic ?? marked;
  const limit = serverQuota ?? quota;
  const held = used + (optimistic === null || optimistic === marked ? 0 : optimistic ? 1 : -1);
  const exhausted = !isMarked && held >= limit;

  function submit() {
    const next = !isMarked;
    setError(null);
    setOptimistic(next);

    startTransition(async () => {
      const result = await toggleDesertIsland({ albumId, discNumber, trackNumber, crowned: next });
      if (!result.ok) {
        setOptimistic(null); // ROLL BACK TO THE PROP
        setError(result.error);
        return;
      }
      // The ceiling comes back in the payload. `used` deliberately does not: the delta above
      // already moved it locally, and adopting both would count this click twice.
      setServerQuota(result.data.quota);
      /*
       * `router.refresh()`, unlike `LikeButton`. A crown moves the profile's Desert Island
       * strip, the crowned ring on every heatmap cell for this track, and the remaining-slot
       * arithmetic in every other row on the page — none of which this component can see.
       */
      router.refresh();
    });
  }

  const remaining = Math.max(0, limit - held);

  return (
    <span className={cn("inline-flex flex-col items-start gap-1", className)}>
      <button
        type="button"
        onClick={submit}
        disabled={pending || exhausted}
        aria-pressed={isMarked}
        aria-label={
          isMarked
            ? `Remove ${trackTitle} from your Desert Island`
            : `Add ${trackTitle} to your Desert Island, ${remaining} of ${limit} places left`
        }
        // The explanation a pointer gets. The `sr-only` sentence below is the same words for
        // everybody else, because a disabled control is not in the tab order.
        title={
          exhausted
            ? `Your Desert Island is full at ${limit}. Clear one to make room.`
            : isMarked
              ? `One of your ${limit} Desert Island tracks. Press to give the place back.`
              : `${remaining} of ${limit} places left.`
        }
        className={cn(
          "inline-flex items-center gap-1.5 rounded-card border px-2 py-1",
          "font-mono text-[0.6875rem] uppercase tracking-wider tabular transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "[&_svg]:size-3.5 [&_svg]:shrink-0",
          isMarked
            ? // `desert` is the honour's colour and nothing else uses it — the same hex as the
              // top rating bracket, held in globals.css so the badge and the heatmap's peak
              // cannot drift apart.
              "border-desert/40 bg-desert/12 text-desert"
            : "border-line bg-surface-2 text-faint hover:border-line-bright hover:text-paper",
        )}
      >
        <Palmtree fill={isMarked ? "currentColor" : "none"} aria-hidden="true" />
        {/*
          THE COUNT IS THE TEXT EQUIVALENT OF THE FILL, so nothing here is available only as a
          colour: "3 / 10" moves on every crown, and `aria-pressed` states the toggle.
        */}
        <span>
          {held} / {limit}
        </span>
        {exhausted ? <span className="sr-only"> — your Desert Island is full. Clear one to make room.</span> : null}
        {pending ? <span className="sr-only"> — saving</span> : null}
      </button>

      <FormError message={error} />
    </span>
  );
}

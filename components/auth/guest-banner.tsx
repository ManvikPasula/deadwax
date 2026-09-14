"use client";

/**
 * The guest strip's client half: the conversion offer, its dismissal, and the leaving warning.
 *
 * THE SERVER HALF IS components/auth/guest-strip.tsx, which decides that the viewer is a guest
 * and counts the three numbers below. This file is `"use client"` for exactly three reasons —
 * dismissal state, a `window` event listener, and an effect cleanup — and holds no data of its
 * own.
 *
 * ============================================================================
 * TWO THRESHOLDS, AND THEY ARE DELIBERATELY DIFFERENT NUMBERS ON DIFFERENT COLUMNS.
 *
 *   VISIBILITY   `distinctAlbums >= nudgeAfter`  (GUEST_NUDGE_AFTER = 12)
 *   THE WARNING  `logCount > 0`                  (the first entry, always)
 *
 * They are separate because the costs are not symmetric: A PREMATURE BANNER IS NOISE, AND A
 * MISSED LEAVING WARNING IS PERMANENT DATA LOSS.
 *
 * > Twelve, which is deliberately high. The strip used to show from the first page view,
 * > which is nagging somebody who has not yet got anything worth keeping — and a banner
 * > people learn to ignore is worse than no banner.
 *
 * > "Are you sure you want to leave" over an empty diary is the kind of prompt that teaches
 * > people to ignore prompts.
 *
 * THE VISIBILITY TEST IS ON `distinctAlbums`, NOT `logCount`, AND THAT IS THE WHOLE
 * CORRECTION. One 40-minute record played through front to back is eleven track rows, so a
 * row count fires the nudge at somebody who has engaged with a single album — which is
 * exactly the "nothing worth keeping yet" case the threshold was raised to avoid. The warning
 * uses `logCount` because it is about work, and an artist-level verdict (which contributes
 * nothing to `distinctAlbums`, since `count(distinct album_id)` ignores nulls) is work.
 * ============================================================================
 *
 * HIDDEN, NOT UNMOUNTED. When the offer does not apply this component still renders and still
 * runs its effect; only the markup is `display: none`. That is the point of the split: the
 * server half hands over from the first page load, the effect arms from the first entry, and
 * the visible offer arrives later. Returning `null` above the threshold instead would give a
 * guest with eleven rated albums no warning when they closed the tab, and nothing about the
 * interface would look wrong.
 *
 * DISMISSAL IS PER PAGE LOAD AND IS NOT PERSISTED — no cookie, no `localStorage`. A guest
 * session is one sitting, and a persisted dismissal would silence the offer for the rest of
 * it; the honest middle is "not now", which a navigation resets. It also means there is no
 * browser-storage key to keep in step with the server's idea of who this person is.
 *
 * DISMISSING DOES NOT DISARM THE WARNING. `dismissed` is read only by the class list below;
 * the effect depends on `logCount` alone. Adding it to that effect's condition would turn a
 * "not now" on a banner into consent to lose a diary.
 */

import { UserPlus, X } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type GuestBannerProps = {
  /**
   * Every log row this guest holds, at all three tiers. `> 0` ARMS THE LEAVING WARNING.
   *
   * From `guestActivity().logCount`. Not the visibility test — see the docblock.
   */
  logCount: number;
  /**
   * DISTINCT ALBUMS, from `guestActivity().distinctAlbums`. THIS is what is compared against
   * `nudgeAfter`, and it is also the number the copy prints.
   */
  distinctAlbums: number;
  /** Reviews written, rendered against `reviewCap` only when there are any. */
  reviewCount: number;
  /**
   * `GUEST_NUDGE_AFTER`. A prop rather than an import because lib/auth/guest.ts is
   * `server-only` — see the note at the call site in guest-strip.tsx.
   */
  nudgeAfter: number;
  /** `GUEST_REVIEW_CAP`, for the same reason. */
  reviewCap: number;
  className?: string;
};

export function GuestBanner({
  logCount,
  distinctAlbums,
  reviewCount,
  nudgeAfter,
  reviewCap,
  className,
}: GuestBannerProps) {
  const [dismissed, setDismissed] = React.useState(false);

  /**
   * THE LEAVING WARNING. Armed from the first entry, cleared on unmount.
   *
   * `event.preventDefault()` is what asks for the prompt; the assignment to `returnValue` is
   * the legacy form of the same request, kept because older engines gate the prompt on that
   * property rather than on the cancelled event. THE VALUE MUST BE NON-EMPTY — the
   * specification's test is literally "returnValue is not the empty string", so the obvious
   * `returnValue = ""` silently skips the legacy path — but THE STRING ITSELF IS IGNORED:
   * every current browser shows its own wording, which is why there is no copy to tune here.
   *
   * IT DOES NOT FIRE ON IN-APP NAVIGATION, and that is correct rather than a limitation:
   * `beforeunload` is a real document unload — closing the tab, typing a new address, going
   * back out of the site. Moving between Deadwax pages keeps the session cookie and keeps the
   * diary, so a prompt there would be the exact "teaches people to ignore prompts" failure.
   *
   * The cleanup is not optional. This component is mounted by the root layout, so it survives
   * navigation, but a sign-out or a conversion unmounts it — and a `beforeunload` handler left
   * registered after that would warn a signed-out visitor about a diary they no longer have.
   */
  React.useEffect(() => {
    if (logCount <= 0) return;

    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "Your guest diary is only reachable from this session.";
    }

    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [logCount]);

  const offer = distinctAlbums >= nudgeAfter && !dismissed;

  return (
    /*
     * `hidden` AS BOTH AN ATTRIBUTE AND A CLASS, on purpose.
     *
     * The attribute states the intent and is what removes the subtree from the accessibility
     * tree and the tab order; the Tailwind utility is what actually wins the cascade, because
     * any `display` utility on this element would beat the user-agent stylesheet's rule for
     * the attribute. `!offer && "hidden"` is ordered AFTER `className` in the `cn()` call —
     * inverting the usual escape-hatch order — so a caller cannot accidentally un-hide the
     * strip by passing a display utility through. That is the one property of this component
     * that must not be overridable.
     */
    <div
      hidden={!offer}
      className={cn("border-b border-line bg-amber/10", className, !offer && "hidden")}
    >
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-6">
        <UserPlus className="size-4 shrink-0 text-amber" aria-hidden="true" />

        <p className="min-w-0 flex-1 text-[0.8125rem] leading-relaxed text-paper">
          {/* Mono and `.tabular` on every number, so a count that ticks over does not jitter. */}
          <span className="font-mono tabular text-amber">{distinctAlbums}</span>
          {` ${distinctAlbums === 1 ? "album" : "albums"} rated in a guest session`}
          {reviewCount > 0 ? (
            <>
              {", "}
              <span className="font-mono tabular text-amber">{reviewCount}</span>
              {` of ${reviewCap} reviews written`}
            </>
          ) : null}
          {". "}
          {/*
            THE PESSIMISTIC FRAMING IS DELIBERATE AND IT IS TRUE OF WHAT A GUEST CAN DO. The
            row itself survives forever — nothing in the repository expires guest accounts —
            but the credentials provider refuses `is_guest` rows, so once this browser has
            forgotten the session there is no way back into that diary by any route. "Lost" is
            the honest word for a diary nobody can ever open again.
          */}
          <span className="text-muted">
            Create an account to keep them — this session is the only way back in.
          </span>
        </p>

        <div className="flex shrink-0 items-center gap-2">
          {/*
            Links, not router pushes: /signup and /login are real addresses, and both carry
            the conversion copy for a viewer who arrives already holding a guest session
            (`AuthForm`'s `isGuest` branch). Sign up CLAIMS this row in place; sign in MERGES
            it into an existing account. Both are offered because a guest is either a new
            person or somebody who already has an account elsewhere.
          */}
          <Button asChild variant="primary" size="sm">
            <Link href="/signup">Create an account</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setDismissed(true)}
            // An icon-only control owes its name here: "Dismiss" alone would not say what is
            // being dismissed or for how long, and "for now" is the honest scope — the offer
            // returns on the next page load.
            aria-label="Dismiss this reminder for now"
          >
            <X />
          </Button>
        </div>
      </div>
    </div>
  );
}

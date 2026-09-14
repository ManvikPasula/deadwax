"use client";

/**
 * The artist page's write controls.
 *
 * `"use client"` because there is local state, an event handler and a transition. That is the
 * whole test.
 *
 * ---------------------------------------------------------------------------------------
 * THE HOUSE CLIENT CONVENTION, AND WHY IT IS THE SAME EVERYWHERE
 * ---------------------------------------------------------------------------------------
 *
 * Twenty-plus call sites share one shape: optimistic state, `startTransition`, roll back to
 * THE PROP on failure, `router.refresh()` on success, and the message rendered through the
 * shared `<FormError>` beside the control that caused it.
 *
 * There is no `useActionState` and there is no error boundary for action failures, and both
 * absences are deliberate. A FAILURE RENDERS INLINE NEXT TO THE CONTROL THAT CAUSED IT rather
 * than replacing the page with an error boundary: a member who mis-clicks "mark the whole
 * discography" should not lose the page they were reading.
 *
 * `router.refresh()` ON SUCCESS, NOT A LOCAL PATCH. Everything derived from this write is
 * server-rendered — the completion meter in the hero, the replay counts on every card, the
 * viewer overlay on every heatmap cell, the profile totals. There is no honest way to
 * reconcile those in the browser, so the honest reconciliation is to re-render the server
 * tree and let the optimistic state be replaced by the truth.
 *
 * ROLLBACK IS TO THE PROP, NOT TO THE PREVIOUS LOCAL VALUE. The optimistic state is therefore
 * `boolean | null` where null means "defer to the server's answer", and rolling back is
 * setting it back to null — not flipping it. Flipping it looks identical in the common case
 * and diverges permanently as soon as two writes overlap.
 */

import { useRouter } from "next/navigation";
import { CheckCheck, Disc3, LoaderCircle } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { markDiscographyListened } from "@/app/actions/logs";
import { cn } from "@/lib/utils";

/**
 * The arm window, in milliseconds. Identical to the two destructive controls' window, and
 * that is the point: one dwell time in the whole app, so a member learns it once.
 */
const DISARM_MS = 4000;

export type ArtistActionsProps = {
  artistId: number;
  artistName: string;
  /**
   * `false` for a signed-out visitor. The control becomes an invitation rather than
   * disappearing: a hidden button teaches nothing about what an account is for.
   */
  canWrite: boolean;
  /** Where to come back to after signing in. A path inside Deadwax; the route validates it. */
  signInNext?: string;
  /**
   * `getCompletion(...)`: every canonical release fully listened. Drives the resting label, and
   * it is THE PROP the optimistic state rolls back to.
   */
  discographyComplete?: boolean;
  /** Canonical releases in the mirror — the number the button is about to write against. */
  albumCount?: number;
  /** The log dialog trigger for rating the artist as a whole. Rendered by the page. */
  rateControl?: React.ReactNode;
  className?: string;
};

export function ArtistActions({
  artistId,
  artistName,
  canWrite,
  signInNext,
  discographyComplete = false,
  albumCount = 0,
  rateControl,
  className,
}: ArtistActionsProps) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  /** null = defer to the prop. See the rollback note in the module docblock. */
  const [optimisticDone, setOptimisticDone] = React.useState<boolean | null>(null);
  const [armed, setArmed] = React.useState(false);

  const done = optimisticDone ?? discographyComplete;

  /*
   * TWO-PRESS ARM/CONFIRM WITH A 4000ms SELF-DISARM, borrowed from the destructive controls
   * rather than from the ordinary ones.
   *
   * This is not destructive, but it is BULK AND IRREVERSIBLE-BY-ONE-CLICK: a single press can
   * write a diary mark for every track of every canonical release, and there is no
   * "unmark discography" to answer it — `unmarkAlbumListened` is per album and deliberately
   * refuses to delete a row carrying a rating or a review. So the second press is the cheapest
   * honest confirmation available.
   *
   * A modal was the rejected alternative: it would be the only modal in the app that exists to
   * confirm a write rather than to collect one, and the arm/confirm pattern is already in the
   * member's hands from the delete controls.
   */
  React.useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), DISARM_MS);
    // Cleared on unmount and on re-arm, so navigating away mid-window cannot leave a timer
    // holding a reference to a component that no longer exists.
    return () => window.clearTimeout(timer);
  }, [armed]);

  function markAll() {
    setError(null);
    setArmed(false);
    // Optimistic, because the hero's meter and this label both read as stale otherwise for the
    // whole round trip — and a bulk write over thirty albums is not a fast round trip.
    setOptimisticDone(true);
    startTransition(async () => {
      const result = await markDiscographyListened({ artistId });
      if (!result.ok) {
        setOptimisticDone(null); // ROLL BACK TO THE PROP
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  if (!canWrite) {
    return (
      <div className={cn("flex flex-wrap items-center gap-2", className)}>
        <Button asChild variant="secondary" size="sm">
          {/* A link, not a router push: sign-in has a real address and this keeps middle-click
              and copy-link working. */}
          <a href={signInNext ? `/login?next=${encodeURIComponent(signInNext)}` : "/login"}>
            Sign in to log {artistName}
          </a>
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {rateControl}

        <Button
          type="button"
          size="sm"
          variant={armed ? "primary" : "secondary"}
          disabled={pending || done}
          // The accessible name carries the whole state, because the visible label shortens to
          // "Sure?" when armed and "Sure?" alone is not a description of anything.
          aria-label={
            done
              ? `Every mirrored release by ${artistName} is marked listened`
              : armed
                ? `Confirm: mark all ${albumCount} mirrored releases by ${artistName} listened`
                : `Mark all ${albumCount} mirrored releases by ${artistName} listened`
          }
          onClick={() => (armed ? markAll() : setArmed(true))}
        >
          {pending ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : done ? (
            <CheckCheck aria-hidden="true" />
          ) : (
            <Disc3 aria-hidden="true" />
          )}
          {/*
            THREE LABELS, ONE BUTTON. `done` DISABLES RATHER THAN HIDES, the same decision the
            Desert Island button makes when the quota is full: the button spends most of its
            life reporting a state, and that is the feature working rather than a failure.
          */}
          {done ? "Discography listened" : armed ? "Press again to confirm" : "Mark discography listened"}
          {/*
            The spinner is a STILL GLYPH for anybody who asked for reduced motion — the blanket
            kill switch in globals.css sets `animation-duration: 0.001ms !important` — so the
            word is the only thing that still says "working".
          */}
          {pending ? <span className="sr-only">Saving</span> : null}
        </Button>
      </div>

      {/*
        One shared `<FormError>`, placed AFTER the controls so a screen reader hears the control
        it belongs to first. It renders nothing at all for an absent message: a permanent empty
        alert region is one assistive technology has already learnt to ignore by the time it
        matters.
      */}
      <FormError message={error} />

      {/*
        PARTIAL FAILURE IS REPORTED, NOT SWALLOWED. `markDiscographyListened` runs its whole
        loop inside ONE `guard()` against internal unguarded helpers — one click, one rate-limit
        token — and returns a failure when part of it did not land. That message arrives here as
        `result.error` and is rendered verbatim rather than being flattened into a generic
        success, which is what the television original did.
      */}
    </div>
  );
}

"use client";

/**
 * "Start your diary" — the landing CTA, AND IT DOES NOT GO TO SIGN-UP.
 *
 * > Asking for an email before anybody has seen what the app does is how the funnel ends at
 * > the first screen.
 *
 * It opens a guest session through the `guest` Credentials provider and lands on /start with
 * twenty-four covers and a star control. The provider matters more than it looks: its
 * `credentials: {}` is empty, so THERE IS NOTHING A CALLER CAN SUPPLY TO BECOME A CHOSEN
 * GUEST — and certainly not a chosen member. `startGuestSession` is a thin door onto it
 * rather than an alternative to it; an action that signed in an id handed to it would be an
 * unauthenticated "become user N" endpoint one refactor away from working on non-guests.
 *
 * THE COPY IS NOT A PROP. "Start your diary" is the one sentence in the product that has been
 * argued about, and a `label` prop is how a second, weaker version of it appears on a second
 * page. The layout of the button is the caller's business (`size`, `className`); its promise
 * is not.
 *
 * WHY THIS IS A CLIENT COMPONENT. A Server Component could render
 * `<form action={startGuestSession}>` and open a session with no JavaScript at all, which is
 * the house default — and it was rejected because `createGuest` hashes a 32-byte secret at
 * bcrypt cost 12. That is a few hundred milliseconds of silence on the primary control of the
 * landing page, and a hero button that reports nothing when pressed reads as a dead button;
 * people press it again. The transition below is what turns that into "Opening your diary…".
 *
 * THERE IS NO `ActionResult` TO CHECK, uniquely among the writes in this application.
 * `startGuestSession` returns `Promise<void>` and signals itself by redirecting: to `/start`
 * on success, and to `/signup` when no session could be opened — because a REFUSED guest
 * (the `guestByIp` budget, 20 per hour, spent inside `createGuest`) and a FAILED guest must
 * look identical. The caller supplied nothing, so there is nothing to explain to them, and
 * /signup is the other door. The `catch` here is for the transport only.
 */

import { BookMarked } from "lucide-react";
import * as React from "react";

import { startGuestSession } from "@/app/actions/auth";
import { Button, type ButtonSize } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export type StartDiaryButtonProps = {
  /**
   * Where to land. Omitted ⇒ `/start`, which is what the landing page wants and what the
   * action defaults to.
   *
   * Allowlisted inside the action by `safeNextPath`, never here — see the same note in
   * components/auth/guest-start.tsx. Anything refused falls back to /start.
   */
  next?: string | null;
  /** `lg` in the hero; `md` for the empty states that offer the same door. */
  size?: ButtonSize;
  className?: string;
};

export function StartDiaryButton({ next, size = "lg", className }: StartDiaryButtonProps) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function begin() {
    setError(null);
    startTransition(async () => {
      try {
        await startGuestSession(next ?? null);
      } catch {
        setError("Could not start a session. Try again.");
      }
    });
  }

  return (
    <div className={cn("inline-flex flex-col items-start gap-1.5", className)}>
      {/*
        THE ONE AMBER BUTTON ON THE LANDING PAGE. The header's "Sign up" is deliberately
        `secondary` for this reason: at most one primary per view, and on the front page it is
        this one — the thing we actually want pressed.
      */}
      <Button type="button" variant="primary" size={size} onClick={begin} disabled={pending}>
        <BookMarked />
        {/*
          The pending label replaces the copy rather than sitting beside a spinner: the button
          is about to be replaced by a whole new page, so a progress indicator that outlives
          the press by one navigation is noise. Ellipsis, not three dots, so a screen reader
          reads a pause instead of "dot dot dot".
        */}
        {pending ? "Opening your diary…" : "Start your diary"}
      </Button>

      {/*
        NO "no email required" CAVEAT HERE. The hero copy around this button carries the
        explanation, and repeating it inside the control would make the one-line promise into
        two lines of hedging. The guest session's real cost is stated on arrival, in
        `IntroDialog`'s block below the rule, where it is the only thing on screen.
      */}
      <FormError message={error} />
    </div>
  );
}

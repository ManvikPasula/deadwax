"use client";

/**
 * The SECOND guest entry point, and the reason there are two.
 *
 * `StartDiaryButton` (components/onboarding/start-diary-button.tsx) is the landing CTA and
 * lands on /start with twenty-four covers. This one sits under the album sidebar's sign-in
 * wall:
 *
 * > Somebody is looking at a record they have an opinion about, and the sign-in wall is
 * > exactly where they would otherwise leave.
 *
 * So the two differ in exactly one respect and it is the important one: THIS ONE COMES BACK
 * TO THE PAGE THE VISITOR IS ALREADY ON. Sending them to /start from here would answer "let
 * me rate this record" with a grid of twenty-four other records, which is the funnel throwing
 * away the one thing it had — a stated intention about a specific album.
 *
 * ---------------------------------------------------------------------------------------
 * WHY IT IS A CLIENT COMPONENT WHEN A SERVER-RENDERED `<form>` WOULD ALMOST WORK
 * ---------------------------------------------------------------------------------------
 *
 * `startGuestSession` is a Server Action, so `<form action={startGuestSession}>` inside a
 * Server Component would open a session with no JavaScript at all — and it was rejected for
 * two reasons. The action's first parameter is `next`, and a form hands its action a
 * `FormData` instead, which `safeNextPath` correctly refuses (it is not a string), so every
 * press would silently fall back to /start and lose the whole point of this component; and
 * `createGuest` hashes a 32-byte secret at bcrypt cost 12, which is a few hundred
 * milliseconds during which a landing-page button that reported nothing would read as broken.
 * `.bind(null, next)` fixes the first problem and not the second.
 *
 * NO `ActionResult` HERE, and it is the only write in the app with none. `startGuestSession`
 * returns `Promise<void>`: it redirects on success and redirects to /signup when no session
 * could be opened, because a REFUSED guest and a FAILED guest must look identical — the
 * caller supplied nothing, so there is nothing to explain to them, and the page they land on
 * offers the other door. The `catch` below is therefore only for the transport: an action
 * call that never reached the server leaves the visitor on a button that did nothing, and
 * that is the one failure worth a sentence.
 */

import { Disc3 } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { startGuestSession } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export type GuestStartProps = {
  /**
   * Where to land, normally the path of the record being looked at — `/album/kid-a-42`.
   *
   * PASSED TO THE ACTION RAW AND ALLOWLISTED THERE. `safeNextPath` demands a leading slash,
   * refuses `//` anywhere, and permits only `[A-Za-z0-9/@._~-]`, so a query string cannot
   * survive it and an absolute URL cannot be expressed at all. A second, weaker copy of that
   * rule here would only be a way for the two to disagree; anything it rejects falls back to
   * /start, which is a real page rather than an error.
   *
   * Absent ⇒ /start, which is the right default for a surface with no particular record in
   * view.
   */
  next?: string | null;
  /**
   * The record being looked at, for the copy — "start rating Kid A". Optional, because this
   * also fits an empty state that is not about one album.
   */
  albumTitle?: string | null;
  className?: string;
};

export function GuestStart({ next, albumTitle, className }: GuestStartProps) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  function begin() {
    setError(null);
    startTransition(async () => {
      try {
        await startGuestSession(next ?? null);
      } catch {
        // The action itself cannot fail visibly (see the docblock) — reaching here means the
        // request never completed, so the honest report is that nothing happened.
        setError("Could not start a session. Try again.");
      }
    });
  }

  return (
    <div className={cn("space-y-2", className)}>
      {/*
        THE RECORD'S NAME AT THE POINT OF DECISION, which is the entire reason this component
        exists as well as the landing CTA. "Sign in to rate" is a statement about us; "rate
        Kid A" is a statement about the thing they came for. Omitted when there is no album in
        view, rather than replaced by a generic sentence nobody needs to read.
      */}
      {albumTitle ? (
        <p className="text-[0.8125rem] leading-relaxed text-paper">
          {"Got an opinion on "}
          <span className="text-amber">{albumTitle}</span>
          {"? Rate it now — no account needed."}
        </p>
      ) : null}

      <Button type="button" variant="primary" size="md" onClick={begin} disabled={pending} className="w-full">
        <Disc3 />
        {pending ? "Opening…" : "Start without an account"}
      </Button>

      <p className="text-[0.6875rem] leading-relaxed text-faint">
        {/*
          IT NAMES THE COST AS WELL AS THE OFFER. Everything a guest logs is kept, and signing
          up later claims the same `users.id` in place — which is what makes "keep your logs" a
          fact rather than a promise — but the session is the only key to that row, so the
          sentence says so here rather than at the moment somebody closes the tab.
        */}
        No email needed. Everything you rate is kept, and creating an account later keeps it in
        place — but this session is the only way back in.
      </p>

      {/*
        The other two doors, as links, because a visitor who already has an account should not
        be nudged into a second one. `?next=` carries the same destination through sign-in, and
        the pages honour it.
      */}
      <p className="text-[0.6875rem] text-faint">
        <Link href={nextHref("/login", next)} className="rounded-card text-muted hover:text-paper">
          Sign in
        </Link>
        {" · "}
        <Link href={nextHref("/signup", next)} className="rounded-card text-muted hover:text-paper">
          Create an account
        </Link>
      </p>

      <FormError message={error} />
    </div>
  );
}

/** `/login?next=/album/kid-a-42`. Encoded, because `next` is a path in a query parameter. */
function nextHref(path: string, next?: string | null): string {
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}

/**
 * Create an account.
 *
 * THE SAME GUARD AS /login AND FOR THE SAME REASON: `redirectSignedInMember` redirects
 * NON-GUEST MEMBERS ONLY. See the long note in app/login/page.tsx — a guest holds a session,
 * and these two pages are the only two doors out of guest mode, so a blanket "redirect
 * anybody with a session" would make guest mode a dead end from both directions.
 *
 * FOR A GUEST THIS PAGE IS PATH A OF THE CLAIM FLOW, not a second account. `signUp` UPDATEs
 * the same `users.id` with the chosen username, address and hash and flips `is_guest` to
 * false, with the `is_guest = true` predicate INSIDE the UPDATE (I-30) so two concurrent
 * claims cannot both believe they won. Nothing moves and nothing can half-fail, which is what
 * makes "your logs come with you" a fact rather than a promise — and `AuthForm` says so, in
 * the amber block it renders when `isGuest` is set, because *the offer has to be visible at
 * the door, not in a help page.*
 *
 * `?next=` IS HONOURED through the same `safeNextPath` allowlist. The interesting case is the
 * one the source's dead parameter loses: somebody sent to `/login?next=/verify` who presses
 * "create an account instead" arrives here with `?next=/verify` carried by the mode-switch
 * link, and must still land on /verify afterwards.
 *
 * WHAT IS NOT HERE, AND MUST NOT BE ADDED: the guest door. `StartDiaryButton` belongs on the
 * landing page and `GuestStart` belongs under the album sidebar's sign-in wall — offering
 * "start without an account" on the page somebody reached by deciding to create one is
 * answering a question they have already answered, and `startGuestSession` redirects HERE
 * when no guest session could be opened, so putting its own button on its own fallback page
 * would loop.
 */

import type { Metadata } from "next";

import { redirectSignedInMember, safeNextPath } from "@/app/actions/auth";
import { AuthForm } from "@/components/auth/auth-form";
import { Eyebrow } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Create an account",
  description:
    "Keep a diary of the records you play, rate albums and tracks, and follow people whose taste you already trust.",
};

export default async function SignUpPage({
  searchParams,
}: {
  /** A PROMISE in Next 16. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  // Before anything renders, and handed the raw parameter — the function owns the allowlist.
  await redirectSignedInMember(params.next);

  const viewer = await currentUser();
  const next = await safeNextPath(params.next);
  const isGuest = viewer?.isGuest === true;

  return (
    <div className="mx-auto max-w-sm py-12">
      <Eyebrow>{isGuest ? "Keep this diary" : "Start a shelf"}</Eyebrow>
      <h1 className="mt-2 font-display text-4xl leading-tight text-paper text-balance">
        {/*
          THE HEADLINE CHANGES FOR A GUEST, because they are not starting anything — they are
          keeping something they already have. "Create an account" over a diary somebody has
          spent twenty minutes filling reads as though it were about to be thrown away.
        */}
        {isGuest ? "Name the shelf you have been filling." : "Every record you play, on the record."}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        {isGuest
          ? "Pick a username and an address and this session becomes an account — the same rows, under a name you choose."
          : "Rate albums and tracks, keep a listening diary, and see the shape of a whole discography."}
      </p>

      <AuthForm mode="signup" next={next} isGuest={isGuest} className="mt-8" />
    </div>
  );
}

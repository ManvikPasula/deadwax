/**
 * Confirm an email address.
 *
 * ============================================================================
 * CONFIRMATION IS A BUTTON PRESS. NOTHING ON THIS PAGE REDEEMS ANYTHING ON LOAD (I-28).
 *
 * > Mail clients and security scanners follow links automatically, which would burn a
 * > single-use token before the member clicked it.
 *
 * Corporate mail scanners, link-preview bots and antivirus proxies all fetch URLs out of
 * mail. If this page called `confirmVerification` during its render — or if `VerifyControls`
 * called it from an effect — every one of those would reach it, because `/verify?token=…` is
 * a GET: the token would already be spent by the time the member opened the message, they
 * would be told "that link is no longer valid" about a link they had never clicked, and
 * "send another" would produce another dead link every time. The failure is invisible in
 * development, where nothing scans your inbox.
 *
 * The rejected alternative — redeem on load and only *show* a button on failure — has the
 * same defect with extra steps: the token is spent before the button renders. So the page's
 * whole job is to put the token in front of a control and stop.
 * ============================================================================
 *
 * `robots: { index: false, follow: false }` AND `referrer: "no-referrer"`, so the token never
 * reaches a search engine or a `Referer` header. Same reasoning as app/reset/page.tsx, and
 * the metadata is static for the same reason: a `generateMetadata` reading `searchParams`
 * could put a live token in a `<title>`.
 *
 * ---------------------------------------------------------------------------------------
 * AN ANONYMOUS CALLER IS REDIRECTED TO `/login?next=/verify`
 * ---------------------------------------------------------------------------------------
 *
 * `confirmVerification` requires a session and additionally requires that the token belong to
 * the account holding it — *a token belongs to the account it was issued for, not to whoever
 * is signed in* — so there is nothing an anonymous visitor can do here. Sending them to the
 * sign-in form with `?next=/verify` is the difference between a flow that completes and one
 * that dead-ends, and /login now HONOURS that parameter (the source ships it as a dead
 * parameter that nothing reads).
 *
 * THE TOKEN DELIBERATELY DOES NOT RIDE THROUGH THE REDIRECT, and that is a property rather
 * than a limitation. `safeNextPath`'s allowlist is `[A-Za-z0-9/@._~-]`, which excludes `?` and
 * `=`, so a query string cannot survive it at all — which means a credential can never be
 * smuggled into a `next` parameter, cannot be logged by the sign-in page's own request, and
 * cannot leak through the sign-in form's `Referer`. The member signs in, lands back here, and
 * follows the link from their inbox once more; the page tells them so rather than leaving
 * them looking at a send button they did not come for.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { BadgeCheck, MailWarning } from "lucide-react";

import { VerifyControls } from "@/components/auth/verify-controls";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { env } from "@/lib/env";

export const metadata: Metadata = {
  title: "Confirm your email",
  description: "Confirm the address on your account.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function VerifyPage({
  searchParams,
}: {
  /** A PROMISE in Next 16. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const viewer = await currentUser();
  // BEFORE ANY READ AND BEFORE ANY MARKUP. `redirect()` throws, so nothing below runs.
  if (!viewer) redirect("/login?next=/verify");

  /**
   * ONE ROW, READ DIRECTLY, for the same reason components/auth/verify-banner.tsx does it:
   * this page needs `users.email` and EVERY PROJECTION IN lib/db/queries DELIBERATELY OMITS
   * IT (compare `MemberRecord`), because those objects cross the server/client boundary in
   * the RSC payload. The address is rendered into markup here and is never handed to
   * `VerifyControls`, so that omission stays true — widening a shared projection to carry an
   * address would put one in the wire format of every page that renders a member.
   *
   * `is_guest` AND `email_verified_at` COME FROM THE COLUMN, NOT THE TOKEN (I-18). The
   * token's `isGuest` is presentation only, and both of these decide what this page is.
   */
  const rows = await db
    .select({ email: users.email, emailVerifiedAt: users.emailVerifiedAt, isGuest: users.isGuest })
    .from(users)
    .where(eq(users.id, viewer.id))
    .limit(1);

  const account = rows[0];
  // The token outlived the account — deleted, or a guest row consumed by a merge. A read
  // tolerates that (I-17); the right destination for that cookie's holder is the sign-in form.
  if (!account) redirect("/login?next=/verify");

  const token = typeof params.token === "string" ? params.token : null;

  /**
   * A GUEST HAS NOTHING TO CONFIRM, AND SAYING SO IS A FIX RATHER THAN A NICETY.
   *
   * A guest's address is `guest_ab12cd34@guest.invalid`, on an RFC 2606 reserved TLD that can
   * never be delivered to. The source shipped a banner asking guests to confirm exactly that,
   * which was not merely odd but impossible to follow. `sendVerification` refuses a guest with
   * the conversion offer, so rendering the controls here would render a button whose only
   * possible outcome is a refusal — and *a control that exists to refuse you is worse than one
   * that is not there.* The address is not printed in this branch: it is machine-generated and
   * naming it would invite somebody to try to receive mail at it.
   */
  if (account.isGuest) {
    return (
      <div className="mx-auto max-w-sm py-12">
        <Eyebrow>Guest session</Eyebrow>
        <h1 className="mt-2 font-display text-4xl leading-tight text-paper text-balance">
          There is no address to confirm yet.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Guest sessions are issued an address on a reserved domain that can never receive
          mail, so there is nothing here to send and nothing to click. Create an account and
          this session becomes yours — the same ratings, the same diary, under a name you
          choose.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button asChild variant="primary">
            <Link href="/signup?next=/verify">Create an account</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/start">Back to rating</Link>
          </Button>
        </div>
      </div>
    );
  }

  /** Already done. Reached by a second click on a message, or a link opened twice. */
  if (account.emailVerifiedAt) {
    return (
      <div className="mx-auto max-w-sm py-12">
        <Eyebrow>Confirmed</Eyebrow>
        <h1 className="mt-2 flex items-start gap-2 font-display text-4xl leading-tight text-paper text-balance">
          <BadgeCheck className="mt-1.5 size-7 shrink-0 text-teal" aria-hidden="true" />
          This address is already confirmed.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          <span className="font-mono text-paper">{account.email}</span> is on the account and
          there is nothing left to do. Any older link in your inbox has been retired.
        </p>
        <div className="mt-6 flex flex-wrap gap-2">
          <Button asChild variant="primary">
            <Link href="/for-you">See what to play next</Link>
          </Button>
          <Button asChild variant="ghost">
            <Link href="/settings">Settings</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm py-12">
      <Eyebrow>Confirm your email</Eyebrow>
      <h1 className="mt-2 font-display text-4xl leading-tight text-paper text-balance">
        {token ? "One press and it is done." : "Ask for a link."}
      </h1>

      <p className="mt-3 text-sm leading-relaxed text-muted">
        {token ? (
          <>
            Press the button to confirm{" "}
            <span className="font-mono text-paper">{account.email}</span>. We do not do it
            automatically: mail scanners follow links on their own, and a single-use link
            confirmed by a robot is a link that no longer works for you.
          </>
        ) : (
          <>
            There is no token in this address, so there is nothing to redeem yet. Send a link
            to <span className="font-mono text-paper">{account.email}</span> and follow it from
            your inbox.
          </>
        )}
      </p>

      {/*
        THE COPY NAMES CONSEQUENCES ONLY WHEN THE FLAG IS ON. `REQUIRE_EMAIL_VERIFICATION`
        defaults OFF, and with it off there is nothing this member cannot do — so the page
        asks for a favour rather than threatening a gate that is not switched on. The same
        rule `VerifyBanner` follows, and for the same reason: *a banner that threatens a gate
        which is not enabled teaches people that our warnings are noise.*
      */}
      <p className="mt-3 flex items-start gap-2 text-[0.8125rem] leading-relaxed text-faint">
        <MailWarning className="mt-0.5 size-4 shrink-0 text-amber" aria-hidden="true" />
        {env.requireEmailVerification
          ? "Until it is confirmed you can rate and keep a diary, but you cannot publish a review, a comment or a list."
          : "Nothing is locked until you do this. It secures the account and it is how a reset link reaches you."}
      </p>

      {/*
        THE CLIENT HALF, AND THE TOKEN IS HANDED TO IT RAW. `confirmVerification` tests the
        shape with `looksLikeLinkToken` before touching the database and returns one refusal
        for all five of its failure cases, so a second, weaker copy of that rule here would
        only be a way for the two to disagree. With a token the "Confirm" button appears;
        without one only the send does.
      */}
      <VerifyControls token={token} className="mt-8" />
    </div>
  );
}

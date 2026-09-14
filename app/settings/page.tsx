/**
 * Settings — a member's own account, and nothing else's.
 *
 * ============================================================================
 * TWO REFUSALS, AND THEY ARE DIFFERENT REFUSALS.
 *
 *   ANONYMOUS -> `/login?next=/settings`. There is no account to edit, and the `?next=` is
 *                what makes the round trip complete rather than dumping them on the homepage
 *                after they sign in (the source ships `?next=` as a dead parameter).
 *
 *   A GUEST   -> `/signup?next=/settings`. §9.3's list of what a guest cannot do names this
 *                page explicitly, and the reason is that every section below is about an
 *                account: an address to confirm, a password to reset, a permanent username.
 *                A guest has a machine-generated address on a reserved domain, no password at
 *                all, and a `guest_…` handle they did not choose — so three of the four
 *                sections could only tell them that they do not apply.
 *
 *                THE REJECTED ALTERNATIVE was a rendered refusal panel, which is what
 *                app/verify/page.tsx does for a guest. It wins there and loses here, and the
 *                difference is whether the page has anything to explain: on /verify the
 *                refusal is a structural fact about their address that the signup page cannot
 *                state, while here the entire content is fields they receive the moment they
 *                claim the row. Sending them to the one action that resolves it, with
 *                `?next=` to bring them straight back, is shorter than a page whose only
 *                message is "press this elsewhere".
 *
 * BOTH ARE READ FROM THE COLUMN, NOT THE TOKEN (I-18). `is_guest` in the session is
 * presentation only, and this decides access.
 * ============================================================================
 *
 * WHAT IS NOT ON THIS PAGE, and each absence is a decision:
 *
 *   NO ADDRESS FIELD. Changing an address has to re-verify the new one, retire every
 *   outstanding token and survive a collision with an existing account — that is a flow, not
 *   a field, and an input here would let somebody move their address without re-verifying.
 *   The section shows the address and the confirmation controls instead.
 *
 *   NO PASSWORD FIELD. The reset flow mails a single-use link, and it is deliberately the only
 *   way: a form that took a new password would be a session-scoped account takeover for
 *   anybody who found an unlocked laptop. The same reason `sendAccountPasswordReset` in the
 *   admin panel issues a link rather than setting a password.
 *
 *   NO DELETE BUTTON. `deleteAccount` exists, and it is an ADMIN action with a two-key rule
 *   (an admin cannot delete themselves, and cannot delete another admin without somebody
 *   demoting them at the CLI first). Self-service deletion is a real feature and this build
 *   does not have it; the page says so rather than leaving somebody hunting for it.
 *
 *   NO `robots: noindex`. There is no token in this URL and the page 302s anybody without a
 *   session, so a crawler reaches the sign-in form and indexes that instead.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { BadgeCheck, MailWarning } from "lucide-react";

import { SettingsForm } from "@/app/settings/settings-form";
import { VerifyControls } from "@/components/auth/verify-controls";
import { Button } from "@/components/ui/button";
import { Eyebrow, SectionHeading } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Settings",
  description: "Your display name, your bio, your avatar and who can see your wantlist.",
};

export default async function SettingsPage() {
  const viewer = await currentUser();
  if (!viewer) redirect("/login?next=/settings");

  /**
   * ONE ROW, READ DIRECTLY, for the reason components/auth/verify-banner.tsx gives: this page
   * needs `users.email` and every projection in lib/db/queries deliberately omits it, because
   * those objects cross the server/client boundary in the RSC payload. The address is rendered
   * into markup here and is never passed to `SettingsForm` or `VerifyControls`, so the
   * omission stays true.
   *
   * `password_hash` IS NOT IN THE PROJECTION and must never be: there is no question on this
   * page that a bcrypt hash answers.
   */
  const rows = await db
    .select({
      username: users.username,
      displayName: users.displayName,
      bio: users.bio,
      avatarSeed: users.avatarSeed,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      isGuest: users.isGuest,
      wantlistPrivate: users.wantlistPrivate,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, viewer.id))
    .limit(1);

  const account = rows[0];
  // The token outlived the row (I-17) — deleted, or a guest row consumed by a merge. The
  // right destination for that cookie's holder is the sign-in form they are about to need.
  if (!account) redirect("/login?next=/settings");

  // The column, not the token. See the header note.
  if (account.isGuest) redirect("/signup?next=/settings");

  const confirmed = account.emailVerifiedAt !== null;

  return (
    <div className="mx-auto max-w-2xl py-8">
      <Eyebrow>Settings</Eyebrow>
      <h1 className="mt-2 font-display text-4xl leading-tight text-paper text-balance">
        @{account.username}
      </h1>
      <p className="mt-2 font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
        Joined {formatDate(account.createdAt)}
      </p>

      {/* -- profile ----------------------------------------------------------------- */}
      <section className="mt-10">
        <SectionHeading as="h2" eyebrow="Profile" title="How you appear" />
        <div className="card p-5">
          <SettingsForm
            username={account.username}
            displayName={account.displayName}
            bio={account.bio}
            avatarSeed={account.avatarSeed}
            wantlistPrivate={account.wantlistPrivate}
          />
        </div>
      </section>

      {/* -- email ------------------------------------------------------------------- */}
      <section className="mt-10">
        <SectionHeading as="h2" eyebrow="Email" title="The address on the account" />
        <div className="card space-y-3 p-5">
          <p className="flex flex-wrap items-center gap-2 text-sm text-paper">
            <span className="font-mono text-muted">{account.email}</span>
            {confirmed ? (
              <span className="inline-flex items-center gap-1 font-mono text-[0.6875rem] uppercase tracking-wider text-teal">
                {/*
                  The glyph is decoration and the word beside it is the state: a tick on its
                  own is a colour carrying meaning, which this palette never asks anybody to
                  read unaided.
                */}
                <BadgeCheck className="size-3.5" aria-hidden="true" />
                Confirmed
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 font-mono text-[0.6875rem] uppercase tracking-wider text-amber">
                <MailWarning className="size-3.5" aria-hidden="true" />
                Not confirmed
              </span>
            )}
          </p>

          {confirmed ? (
            <p className="text-[0.8125rem] leading-relaxed text-faint">
              Confirmed {formatDate(account.emailVerifiedAt)}. The address cannot be changed
              here: moving it has to re-verify the new one, retire every outstanding link and
              survive a collision with an account that already holds it — that is a flow rather
              than a field, and a text box here would let an address move without proving
              anybody reads it.
            </p>
          ) : (
            <>
              <p className="text-[0.8125rem] leading-relaxed text-muted">
                {env.requireEmailVerification
                  ? "Until this is confirmed you can rate and keep a diary, but you cannot publish a review, a comment or a list."
                  : "Nothing is locked until you do this. It secures the account, and it is how a reset link reaches you."}
              </p>
              {/*
                THE SAME CLIENT HALF THE BANNER USES, WITH NO TOKEN. A member sitting on this
                page has no token in front of them — the token is in their inbox — so only the
                send control renders. Confirmation itself happens on /verify, on a button
                press, because mail scanners follow links and a single-use link redeemed on
                load is a link that no longer works for the person it was sent to (I-28).
              */}
              <VerifyControls />
            </>
          )}
        </div>
      </section>

      {/* -- password ---------------------------------------------------------------- */}
      <section className="mt-10">
        <SectionHeading as="h2" eyebrow="Password" title="Changing it" />
        <div className="card space-y-3 p-5">
          <p className="text-[0.8125rem] leading-relaxed text-muted">
            {/*
              THE REASON IS STATED, because "we will email you a link" reads as an
              inconvenience unless the alternative is named.
            */}
            We send a single-use link to your address rather than taking a new password here. A
            form on this page would let anybody who found an unlocked browser change the
            password without reading your mail, which is the whole thing a password is
            protecting.
          </p>
          <Button asChild variant="secondary" size="md">
            <Link href="/forgot">Send me a reset link</Link>
          </Button>
        </div>
      </section>

      {/* -- account ----------------------------------------------------------------- */}
      <section className="mt-10">
        <SectionHeading as="h2" eyebrow="Account" title="Leaving" />
        <div className="card p-5">
          <p className="text-[0.8125rem] leading-relaxed text-muted">
            There is no self-service deletion in this build, and rather than hide that behind a
            button that opens a support form: an operator can delete an account, and doing so
            removes every diary entry, rating, review, list, pin and crown with it — there is
            no undo and no soft delete anywhere in this product. Ask, and be sure.
          </p>
        </div>
      </section>
    </div>
  );
}

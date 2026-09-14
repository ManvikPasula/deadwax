"use client";

/**
 * The client half of the confirmation flow: the button that redeems a link, and the button
 * that asks for one.
 *
 * THE SERVER HALF IS components/auth/verify-banner.tsx, which decides whether the strip
 * applies at all and renders the address. This file never sees the address — the banner puts
 * it in markup and deliberately does not hand it down, so the "no projection in lib/db/queries
 * carries an email" promise stays true across the server/client boundary.
 *
 * ============================================================================
 * CONFIRMATION IS A BUTTON PRESS. THERE IS NO `useEffect` IN THIS FILE, AND THERE MUST NOT BE
 * ONE (I-28).
 *
 * > Mail clients and security scanners follow links automatically, which would burn a
 * > single-use token before the member clicked it.
 *
 * Corporate mail scanners, link-preview bots and antivirus proxies all fetch URLs out of
 * mail. An effect that called `confirmVerification` on mount would be reached by every one of
 * them, because `/verify?token=…` is a GET: the token would already be consumed by the time
 * the member opened the message, they would be told "that link is no longer valid" on a link
 * they had never clicked, and "send another" would produce another dead link every time. The
 * failure is invisible in development, where nothing scans your inbox.
 *
 * The rejected alternative — redeeming on load and only *showing* a button on failure — has
 * the same defect with extra steps: the token is spent before the button renders.
 * ============================================================================
 *
 * THE RE-SEND REPORTS `delivered` AGAINST `logged`, HONESTLY, and that is the whole reason
 * `VerificationSendResult` carries `via` as well as `delivered`. With no `RESEND_API_KEY`
 * configured, lib/email writes the link to the server log and still returns
 * `delivered: true` — an accurate statement about the transport and a lie about the inbox. An
 * admin telling somebody "check your email" needs to know that it will not arrive.
 *
 * NOTHING IS SENT AT SIGN-UP. `signUp` issues no token, so this button is the ONLY source of
 * a confirmation link in the whole application — which is why its first label is "Send the
 * link" rather than "Re-send", and why the copy after a send says where the link went.
 *
 * THE HOUSE CLIENT CONVENTION, as at twenty other call sites: `useTransition`, an inline
 * `<FormError>` next to the control that caused it, `router.refresh()` on success because
 * everything derived from the write (this banner, the gate in `assertEmailVerified`) is
 * server-rendered. There is nothing optimistic here and therefore nothing to roll back: the
 * result of a confirmation is a column on the member's row, and guessing at it would mean
 * hiding the banner for somebody whose token had just been refused.
 */

import { BadgeCheck, Mail, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { confirmVerification, sendVerification } from "@/app/actions/verification";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export type VerifyControlsProps = {
  /**
   * The raw `?token=` from /verify's `searchParams`, or absent.
   *
   * ABSENT IS THE COMMON CASE: the banner in app/layout.tsx renders this with no props at
   * all, because a member reading the banner has no token in front of them — the token is in
   * their inbox. With a token the "Confirm" button appears; without one only the send does.
   *
   * It is passed through unvalidated on purpose. `confirmVerification` tests the shape with
   * `looksLikeLinkToken` before it touches the database and returns one refusal for every
   * failure, so a second, weaker copy of that rule here would only add a way for the two to
   * disagree about what a token looks like.
   */
  token?: string | null;
  className?: string;
};

/**
 * "an hour" IS `VERIFICATION_TTL_MINUTES = 60` FROM lib/security/tokens.ts, SPELLED OUT.
 *
 * That module opens with `import "server-only"`, so a client component cannot import the
 * constant — the same constraint that makes `predictionKey` a duplicate in
 * components/artist/discography-heatmap.tsx. If the TTL moves, this sentence moves with it.
 * The rejected alternative was threading the number down as a prop from the banner, which
 * puts a server constant in the RSC payload of every page a member loads to say one word.
 */
const SENT_TO_INBOX = "Sent. The link is good for about an hour — check your spam folder too.";

/**
 * THE `via: "log"` SENTENCE, AND IT DOES NOT APOLOGISE OR HEDGE.
 *
 * It names what happened, says plainly that nothing will arrive, and names who can act on it.
 * "Sent!" here would be technically defensible and operationally useless.
 */
const SENT_TO_LOG =
  "No mail provider is configured on this deployment, so the link was written to the server log instead of being sent. It will not arrive in an inbox — an administrator can read it from the log.";

const ALREADY_CONFIRMED = "That address is already confirmed. Nothing was sent.";

/** A real transport failure: the provider refused the message or the request timed out. */
const NOT_DELIVERED = "The mail provider would not take the message. Try again in a few minutes.";

export function VerifyControls({ token, className }: VerifyControlsProps) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  /**
   * The delivery report. SEPARATE FROM `error` because it is not a failure — `SENT_TO_LOG` is
   * the successful outcome of a correctly configured development deployment, and rendering it
   * in rose through `<FormError>` would teach an operator to read a working flow as a broken
   * one.
   */
  const [notice, setNotice] = React.useState<string | null>(null);
  const [confirmed, setConfirmed] = React.useState(false);
  const [sentOnce, setSentOnce] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  function confirm() {
    if (!token) return;
    setError(null);
    setNotice(null);

    startTransition(async () => {
      const result = await confirmVerification({ token });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      /*
       * `confirmed` exists only to keep this button honest for the frame between the write
       * landing and the refreshed tree arriving. It is NOT the source of truth: the banner
       * above disappears because `users.email_verified_at` is now set and the server re-read
       * it, not because this flag is true.
       */
      setConfirmed(true);
      router.refresh();
    });
  }

  function resend() {
    setError(null);
    setNotice(null);

    startTransition(async () => {
      const result = await sendVerification();
      if (!result.ok) {
        // Every refusal the action can return is already member-readable — a rate-limit
        // retry window, the guest conversion offer, or the flat generic. Rendered as-is.
        setError(result.error);
        return;
      }

      setSentOnce(true);

      if (result.data.alreadyConfirmed) {
        setNotice(ALREADY_CONFIRMED);
        // The banner is stale: the column says confirmed and the page still shows the strip.
        // Re-render the server tree and it goes away.
        router.refresh();
        return;
      }

      if (!result.data.delivered) {
        setNotice(NOT_DELIVERED);
        return;
      }

      // `delivered` is true for both transports, so the branch is on `via` (see the docblock).
      setNotice(result.data.via === "resend" ? SENT_TO_INBOX : SENT_TO_LOG);
    });
  }

  return (
    <div className={cn("flex min-w-0 flex-col items-start gap-1.5", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {token ? (
          <Button type="button" variant="primary" size="sm" onClick={confirm} disabled={pending || confirmed}>
            {confirmed ? <BadgeCheck /> : <Mail />}
            {confirmed ? "Confirmed" : pending ? "Confirming…" : "Confirm my email"}
          </Button>
        ) : null}

        <Button
          type="button"
          // Secondary even on /verify, where it sits beside the primary confirm: there is at
          // most one amber control in a view, and on that page the amber one is the button
          // that finishes the job the member came to do.
          variant="secondary"
          size="sm"
          onClick={resend}
          disabled={pending || confirmed}
        >
          <Send />
          {sentOnce ? "Send it again" : "Send the link"}
        </Button>
      </div>

      {/*
        `role="status"` rather than `role="alert"`: this is the outcome of something the member
        just pressed, so it is announced politely at the next pause instead of interrupting.
        The region is rendered only when there is something in it — a permanently present
        empty live region on every page is one a screen reader has already learnt to skip.
      */}
      {notice ? (
        <p role="status" className="max-w-prose text-[0.8125rem] leading-relaxed text-muted">
          {notice}
        </p>
      ) : null}

      <FormError message={error} />
    </div>
  );
}

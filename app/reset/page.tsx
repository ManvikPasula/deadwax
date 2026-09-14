/**
 * Set a new password from a link token.
 *
 * ============================================================================
 * `robots: { index: false, follow: false }` AND `referrer: "no-referrer"`, SO THE TOKEN NEVER
 * REACHES A SEARCH ENGINE OR A `Referer` HEADER.
 *
 * The token is a bearer credential sitting in a URL, which is the one shape of secret that
 * leaks by being *visited*. Two escape routes exist and each header closes one:
 *
 *   `noindex`      A crawler that follows a link out of a mailing-list archive, a pasted URL
 *                  in a public issue, or a shared browser history would otherwise put the
 *                  live token in an index. `follow: false` matters too: without it a crawler
 *                  is told not to index this page but is still free to walk its links, and
 *                  the outbound request carries the referrer.
 *   `no-referrer`  Every link off this page — "sign in", the footer, the provider
 *                  attributions — would otherwise send the full URL, token and all, to
 *                  whatever it points at. proxy.ts already sets
 *                  `strict-origin-when-cross-origin` globally, which strips the path
 *                  cross-site but keeps the FULL URL for same-origin requests; one layer that
 *                  can be misconfigured is not enough for a credential in a query string, so
 *                  this page overrides it to send nothing at all.
 *
 * THE METADATA IS STATIC, DELIBERATELY. A `generateMetadata` that read `searchParams` could
 * put a token in a `<title>` or a canonical URL — the exact mistake the list pages fixed for
 * private titles (I-15) — and there is nothing about this page worth varying per request.
 * ============================================================================
 *
 * THE FORM NEVER SIGNS ANYBODY IN. `ResetForm` says "your password is set, sign in as
 * @username" and stops: whoever holds this link is only proven to have read one mailbox at
 * one moment, and signing them in here would turn a password reset into a session-minting
 * endpoint reachable with a forwarded email.
 *
 * NO AUTH GUARD. Somebody resetting a password may well be signed in elsewhere, and the
 * redemption path does not consult the session at all — `redeemPasswordReset` resolves the
 * account from the TOKEN's own row and refuses on a mismatch between the bound address and
 * the account's current one. A guard would only lock out the member who still has a live
 * cookie on the device they are fixing.
 *
 * A MISSING TOKEN IS A REAL STATE, not an error: somebody types `/reset` by hand, or a mail
 * client truncates the query string. It renders the way back rather than an empty form that
 * can only fail.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { ResetForm } from "@/components/auth/reset-form";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/primitives";
import { PASSWORD_RESET_TTL_MINUTES } from "@/lib/security/tokens";

export const metadata: Metadata = {
  title: "Set a new password",
  description: "Set a new password from a single-use link.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function ResetPage({
  searchParams,
}: {
  /** A PROMISE in Next 16. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  /**
   * TAKEN AS A STRING AND PASSED THROUGH UNVALIDATED, ON PURPOSE.
   *
   * `resetPassword` tests the shape with `looksLikeLinkToken` (`/^[A-Za-z0-9_-]{43}$/`) before
   * it touches the database, and every one of the redemption path's refusals — bad shape, no
   * row, already consumed, expired, account gone, email mismatch — returns ONE
   * indistinguishable message, because distinguishing them tells a guesser which tokens were
   * real. A second, weaker copy of that rule here would only be a way for the two to disagree
   * about what a token looks like, and it would have to choose which refusal to show.
   *
   * The array case is folded to absent rather than to `params.token[0]`: `?token=a&token=b` is
   * not a link this application ever sends, so the honest reading is "no usable token".
   */
  const token = typeof params.token === "string" ? params.token : null;

  return (
    <div className="mx-auto max-w-sm py-12">
      <Eyebrow>New password</Eyebrow>
      <h1 className="mt-2 font-display text-4xl leading-tight text-paper text-balance">
        {token ? "Cut a new key." : "That link is not complete."}
      </h1>

      {token ? (
        <>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Pick something you have not used elsewhere. The link you followed is spent once
            this succeeds.
          </p>
          <ResetForm token={token} className="mt-8" />
        </>
      ) : (
        <>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            There is no token in this address, so there is nothing to redeem. Reset links are
            good for {PASSWORD_RESET_TTL_MINUTES} minutes and mail clients sometimes cut the
            end off a long URL — ask for a fresh one and follow it in one go.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button asChild variant="primary">
              <Link href="/forgot">Send a new link</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/login">Back to sign in</Link>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

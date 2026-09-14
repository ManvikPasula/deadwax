/**
 * "Send me a reset link."
 *
 * ============================================================================
 * IT ALWAYS RENDERS THE SAME CONFIRMATION, WHATEVER HAPPENED.
 *
 * > A form that says "no account with that address" is a membership oracle answerable in bulk
 * > against a breach list.
 *
 * One POST per address, no failed-login trail on anybody's account, and the answer is exactly
 * the thing worth selling. So the whole flow is built to be silent: `requestPasswordReset`
 * returns the identical `ok()` for an unknown address, an unparseable address, and one
 * throttled by the per-address budget (`reset:email`, 3/hour), and `ForgotForm` shows one
 * confirmation for all of them. THE ONLY VISIBLE FAILURE IS THE PER-IP LIMIT (`reset:ip`,
 * 10/hour), and it is safe to show precisely because it is a fact about the caller rather
 * than about any account.
 * ============================================================================
 *
 * `robots: noindex` AND `referrer: "no-referrer"` EVEN THOUGH THIS URL CARRIES NO TOKEN.
 *
 * The route table groups /forgot with /reset, and the grouping is deliberate: this page is
 * where the *address* is typed, so a browser autofill entry, a search-engine snapshot of a
 * pre-filled form, or a `Referer` on the "back to sign in" link are all ways for the flow's
 * one identifying input to leave the page. There is nothing here worth indexing — the page's
 * entire content is one field — so the cost of the header is zero and it keeps the two halves
 * of one flow under one rule rather than two.
 *
 * `mailConfigured` IS A REQUIRED PROP AND THE PAGE IS WHERE IT IS READ.
 *
 * `emailDeliveryConfigured()` is a static fact about the DEPLOYMENT. Threading it in from here
 * rather than reporting the action's own per-request `via` is the whole trick: with no
 * RESEND_API_KEY the link is written to the server log and the confirmation says so, while
 * still never revealing whether a link was generated at all. Reporting the real per-request
 * transport would reintroduce the oracle from the other end — "sent" for a real address and
 * nothing for an unknown one is the same leak wearing a helpful face.
 *
 * `PASSWORD_RESET_TTL_MINUTES` IS PASSED DOWN because lib/security/tokens.ts opens with
 * `import "server-only"` and a client component cannot import it. The constant travels as a
 * prop so the sentence "it expires in 30 minutes" cannot drift from the number that enforces
 * it — and 30 rather than the verification link's 60 because *a confirmation link only proves
 * an address, while a reset link takes over an account.*
 */

import type { Metadata } from "next";

import { ForgotForm } from "@/components/auth/forgot-form";
import { Eyebrow } from "@/components/ui/primitives";
import { emailDeliveryConfigured } from "@/lib/email";
import { PASSWORD_RESET_TTL_MINUTES } from "@/lib/security/tokens";

export const metadata: Metadata = {
  title: "Forgot your password",
  description: "Ask for a single-use link to set a new password.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * NO AUTH GUARD, AND THAT IS NOT AN OVERSIGHT.
 *
 * A member who is signed in on one device and locked out on another still needs this form,
 * and somebody whose session is live but whose password is forgotten is the ordinary case
 * rather than a strange one. There is nothing here that depends on who is asking: the action
 * reads the address from the request, resolves the account itself, and mails the row's own
 * address — so there is no session for this page to consult and nothing a session would let
 * it do differently.
 */
export default function ForgotPage() {
  return (
    <div className="mx-auto max-w-sm py-12">
      <Eyebrow>Locked out</Eyebrow>
      <h1 className="mt-2 font-display text-4xl leading-tight text-paper text-balance">
        We will send you a new key.
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Type the address you signed up with. The link works once and then it is spent.
      </p>

      <ForgotForm
        mailConfigured={emailDeliveryConfigured()}
        ttlMinutes={PASSWORD_RESET_TTL_MINUTES}
        className="mt-8"
      />
    </div>
  );
}

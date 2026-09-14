"use server";

/**
 * Password reset, both ends: asking for a link, and redeeming one.
 *
 * These two are shells. The rules live in lib/auth/password-reset.ts, because
 *
 * > a single-use token that turns out to be reusable is not the kind of thing to discover in
 * > production
 *
 * and a rule that only exists inside a Server Action is a rule no test can drive against a
 * real database. What is left here is exactly what belongs in an action: the budgets, the
 * shared schemas, the bcrypt call, and the decision about what a caller is told.
 *
 * THE PASSWORD IS HASHED IN THIS FILE, NOT IN THE LIBRARY MODULE. That is the one deliberate
 * inversion of the usual layering, and the reason is `safeErrorDetail`: driver errors carry
 * their bound parameters, so whichever module holds the plaintext is the module that can leak
 * it into a log. This one holds it for the length of one `hash()` call and never writes it
 * anywhere; the module that talks to the database only ever sees the digest.
 *
 * BOTH LABELS ARE IN `VERIFICATION_EXEMPT`, and they have to be: you cannot reset a forgotten
 * password from behind a gate that requires you to read mail you may have lost access to.
 */

import { hash } from "bcryptjs";

import { BCRYPT_COST } from "@/lib/auth/guest";
import {
  findResetRecipient,
  issuePasswordReset,
  passwordResetUrl,
  redeemPasswordReset,
} from "@/lib/auth/password-reset";
import { type EmailVia, emailDeliveryConfigured, sendPasswordResetEmail } from "@/lib/email";
import { BUDGETS, clientAddress, consume, retryMessage } from "@/lib/security/rate-limit";
import { emailSchema, passwordSchema } from "@/lib/security/schemas";
import { PASSWORD_RESET_TTL_MINUTES, looksLikeLinkToken } from "@/lib/security/tokens";

import { type ActionResult, fail, guard, ok, safeErrorDetail } from "./result";

/**
 * THE ANSWER THE REQUEST FORM ALWAYS GIVES.
 *
 * `via` is derived from `emailDeliveryConfigured()`, WHICH IS A GLOBAL FACT ABOUT THE
 * DEPLOYMENT AND NOT A FACT ABOUT THIS REQUEST — and that is the only way to be honest and
 * silent at the same time. Reporting the real `EmailResult.via` would make the payload itself
 * the oracle the whole flow is built to avoid: "resend" would mean an account exists and
 * "log" (or nothing) would mean it does not.
 *
 * An operator still gets the truth, because the UI can say *"No email provider is configured —
 * the reset link was written to the server log instead of being sent"*, which is a sentence
 * about the deployment. A flow that claimed "check your inbox" with no provider configured
 * would leave somebody waiting for mail that was never sent, which is a worse outcome than
 * the awkward sentence.
 */
export type PasswordResetRequestResult = { via: EmailVia };

function uniformAnswer(): ActionResult<PasswordResetRequestResult> {
  return ok({ via: emailDeliveryConfigured() ? "resend" : "log" });
}

/** The one refusal every failed redemption returns. See `redeemPasswordReset`'s six refusals. */
const INVALID_LINK = "That reset link is no longer valid. Ask for a new one.";

/**
 * Asks for a reset link. ALWAYS ANSWERS IDENTICALLY.
 *
 * > A form that says "no account with that address" is a membership oracle answerable in bulk
 * > against a breach list.
 *
 * So: an unparseable address, an address with no account, an address whose per-address budget
 * is exhausted, and a successful send all return the same `ok()` with the same payload. THE
 * ONLY BRANCH THAT RETURNS A FAILURE IS THE PER-IP LIMIT, and it is safe precisely because it
 * is a fact about the caller rather than about the address they typed.
 *
 * TWO BUDGETS, AND THEY PROTECT DIFFERENT PEOPLE:
 *
 *   `reset:ip`    10/hour — the only limit standing between a guesser and unlimited attempts,
 *                 which is why it is the one allowed to speak.
 *   `reset:email`  3/hour — so that nobody can be made to receive a stream of reset mail by
 *                 an attacker cycling addresses of origin. THE RECIPIENT IS WHAT NEEDS
 *                 PROTECTING HERE, NOT US, and that is also why it stays silent: telling the
 *                 caller "that address has had three already" is the oracle again, one step
 *                 removed.
 *
 * ACCEPTED RESIDUAL: this is not constant-TIME. A hit performs an insert and waits on the mail
 * provider; a miss returns immediately, so the difference is measurable by somebody who cares
 * enough to measure it. Closing it properly needs a queue — hand the send to a worker and
 * return at once — which this build does not have. It is recorded here rather than left for a
 * reader to notice, because the alternative (an artificial delay) makes the endpoint slower
 * for everybody while still being measurable in aggregate.
 */
export async function requestPasswordReset(input: { email: string }): Promise<ActionResult<PasswordResetRequestResult>> {
  return guard("requestPasswordReset", async () => {
    const byIp = await consume(BUDGETS.passwordResetByIp, await clientAddress());
    if (!byIp.ok) return fail(retryMessage(byIp));

    const parsed = emailSchema.safeParse(input.email);
    // NOT a validation error. An attacker who can tell "that is not an address" from "that
    // address has no account" has a cheap way to learn which of their two guesses was
    // well-formed, and a member who typed their address wrongly is told the same thing either
    // way: check your mail, and ask again if nothing arrives.
    if (!parsed.success) return uniformAnswer();
    const email = parsed.data;

    // Lower-cased so that `Bob@x.com` and `bob@x.com` share one bucket — otherwise the
    // per-address limit is bypassed by changing the case of a letter. `emailSchema` bounds the
    // value at 255, which keeps `rate_limits.key` from becoming unbounded: that table grows by
    // distinct (bucket, identity) pairs.
    const byEmail = await consume(BUDGETS.passwordResetByEmail, email.toLowerCase());
    if (!byEmail.ok) return uniformAnswer();

    const recipient = await findResetRecipient(email);
    if (!recipient) return uniformAnswer();

    const issued = await issuePasswordReset(recipient.id);

    const result = await sendPasswordResetEmail({
      // THE ADDRESS FROM THE ROW, never the one in the request — the token was bound to it,
      // and a flow that mails whatever it was handed is a relay with our sending reputation
      // attached.
      to: issued.email,
      username: recipient.username,
      url: passwordResetUrl(issued.token),
      ttlMinutes: PASSWORD_RESET_TTL_MINUTES,
    });

    // The only place the real outcome is recorded, and it carries no address: the kind is
    // enough to answer "is mail leaving the building", and hosted logs are readable by anyone
    // with project access.
    if (!result.delivered) console.error("[requestPasswordReset] delivery failed", { via: result.via });

    return uniformAnswer();
  });
}

/**
 * Redeems a reset link and sets the new password. IT NEVER SIGNS THEM IN.
 *
 * The UI shows *"Your password is set. Sign in as @username."* and that extra step is the
 * point: the one thing we know about a reset link is that it travelled through a mailbox, and
 * a reset that also opened a session would turn a forwarded or intercepted message into an
 * account takeover with no further work. Making them type the new password proves they are the
 * person who just chose it.
 *
 * ORDER, and both reasons:
 *
 *   1. THE TOKEN SHAPE FIRST, because it is free, and because a refusal about the link is the
 *      one that matters — telling somebody their password is too short on a form whose token
 *      is already dead sends them to retype into a page that cannot work.
 *   2. THE SHARED `passwordSchema` SECOND (I-25). The same object sign-up uses, so a password
 *      that can be set here can always be signed in with: two copies of this rule is the
 *      defect that created accounts nobody could get into.
 *
 * The bcrypt call sits in front of the redemption, so a junk token costs one hash at cost 12.
 * That is bounded by `guard()`'s `writeByAnon` (30/60s), i.e. a few seconds of CPU per minute
 * per address, and the alternative — a "does this token exist" probe before hashing — is a
 * cheap oracle for which tokens are real. The CPU is the better thing to spend.
 */
export async function resetPassword(input: { token: string; password: string }): Promise<ActionResult<{ username: string }>> {
  return guard("resetPassword", async () => {
    if (!looksLikeLinkToken.test(input.token)) return fail(INVALID_LINK);

    const parsed = passwordSchema.safeParse(input.password);
    // The schema's own message: it explains the 72-BYTE rule, which is the one refusal here
    // nobody can guess at ("é".repeat(72) is 72 characters and 144 bytes).
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Choose a longer password.");

    const passwordHash = await hash(parsed.data, BCRYPT_COST);

    let result;
    try {
      result = await redeemPasswordReset({ token: input.token, passwordHash });
    } catch (error) {
      // The redemption is one transaction, so a throw here means nothing was changed. Logged
      // through the field whitelist because the failing statement binds a user id and a
      // password hash (I-35).
      console.error("[resetPassword] redemption failed", safeErrorDetail(error));
      throw error;
    }

    // ONE MESSAGE FOR ALL SIX REFUSALS (I-27). The module does not even report which one, so
    // this branch cannot accidentally start distinguishing them.
    if (!result.ok) return fail(INVALID_LINK);

    // The username, so the confirmation can name the account they have just recovered — on a
    // page reached from a mailbox, "sign in" without a name is a question rather than an
    // instruction.
    return ok({ username: result.username });
  });
}

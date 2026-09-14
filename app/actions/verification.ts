"use server";

/**
 * Email confirmation: send the link, and redeem it.
 *
 * `REQUIRE_EMAIL_VERIFICATION` DEFAULTS OFF, so both of these run whether or not the gate is
 * enforced — turning it on is a one-variable change rather than a feature launch. Enforcing it
 * without a verified sending domain would lock every new member out of posting with no
 * self-service fix, which is why the flag and the flow are separate things.
 *
 * BOTH LABELS ARE IN `VERIFICATION_EXEMPT`, AND THEY HAVE TO BE: gating the flow that confirms
 * an address behind a confirmed address is a closed loop. That set is default-deny by
 * omission, so the exemption is written down rather than implied.
 *
 * THE TOKEN MACHINERY IS INLINE HERE RATHER THAN IN A `lib/` MODULE, which is the one place
 * this file departs from the layering doctrine, so the reason is worth stating: the rule with
 * teeth in this flow is "redeemed by a button press, by the account it was issued for", and
 * both halves of that are authorization facts about a request — `requireUser()` and a
 * comparison against the session — which cannot exist outside an action. Password reset is the
 * opposite case (a single-use token redeemed by an anonymous caller, with no session to check
 * it against) and therefore lives in lib/auth/password-reset.ts where a test can drive it
 * against a real database.
 */

import { and, eq, isNull, sql } from "drizzle-orm";

import { UnauthorizedError, GuestNotAllowedError, requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { emailVerificationTokens, users } from "@/lib/db/schema";
import { type EmailVia, emailDeliveryConfigured, sendVerificationEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { BUDGETS, clientAddress, consume, retryMessage } from "@/lib/security/rate-limit";
import {
  VERIFICATION_TTL_MINUTES,
  createLinkToken,
  linkTokenExpiry,
  looksLikeLinkToken,
  sha256hex,
} from "@/lib/security/tokens";

import { type ActionResult, fail, guard, ok } from "./result";

/**
 * THE ONE REFUSAL EVERY FAILED CONFIRMATION RETURNS (I-27).
 *
 * Five different checks below return this exact string. Distinguishing them — "expired"
 * against "already used" against "that link belongs to another account" — tells a guesser
 * which of their candidates were REAL tokens, and the third one would tell them so even more
 * loudly: it confirms both that the token exists and that it belongs to somebody else.
 *
 * It names the recovery, because a member reading it has done nothing wrong: the usual cause
 * is a link that has been sitting in a mailbox for over an hour.
 */
const INVALID_LINK = "That confirmation link is no longer valid. Ask for a new one from the banner at the top of the page.";

export type VerificationSendResult = {
  /** Nothing was sent, and nothing needed to be. */
  alreadyConfirmed: boolean;
  /**
   * TRUE ALSO FOR `via: "log"`. It means the transport did its job, NOT that anything reached
   * an inbox — see the docblock in lib/email/index.ts. Branch on `via` for that.
   */
  delivered: boolean;
  /** `null` when no mail was attempted at all. */
  via: EmailVia | null;
};

/**
 * Issues a confirmation token, RETIRING EVERY OUTSTANDING ONE FOR THAT ACCOUNT IN THE SAME
 * TRANSACTION (I-27).
 *
 * THE ORDER OF THE TWO STATEMENTS IS LOAD-BEARING: retire, then insert. Reversed, the update's
 * `consumed_at IS NULL` predicate matches the row that was just written, and the flow issues a
 * token that is already dead — a bug with no symptom until somebody clicks the link.
 *
 * Not exported: an exported helper in a `"use server"` module is a public endpoint, and this
 * one mints a credential.
 */
async function issueVerificationToken(userId: number, email: string): Promise<string> {
  const { token, tokenHash } = createLinkToken();

  await db.transaction(async (tx) => {
    await tx
      .update(emailVerificationTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(emailVerificationTokens.userId, userId), isNull(emailVerificationTokens.consumedAt)));

    await tx.insert(emailVerificationTokens).values({
      userId,
      tokenHash,
      // BOUND AT ISSUE, so a later change of address cannot be confirmed by an old link.
      email,
      // A `Date`, because `expires_at` is `timestamptz` — Drizzle reads and writes those as
      // `Date`s and `date` columns as strings (I-9), and mixing them yields "Invalid Date".
      expiresAt: linkTokenExpiry(VERIFICATION_TTL_MINUTES),
    });
  });

  return token;
}

/**
 * Sends (or re-sends) the confirmation link to the address on the member's own row.
 *
 * TWO BUDGETS, because the two abuses look different and neither limit catches the other:
 * `verifyEmailByUser` 3/hour, because an account is otherwise a way to repeatedly deliver
 * mail to one address, and `verifyEmailByIp` 10/hour, because a source cycling accounts is a
 * way to deliver to many. THE RECIPIENT IS WHAT NEEDS PROTECTING HERE, NOT US.
 *
 * IT REPORTS THE TRUE PER-REQUEST OUTCOME, and the contrast with `requestPasswordReset` is
 * deliberate: there, the answer must be identical for every address on earth, because the
 * caller is anonymous and a differing answer is a membership oracle. Here the caller IS the
 * account — they are signed in, and they already know their own address — so there is nothing
 * to conceal and every reason to say plainly that no provider is configured.
 *
 * NO `revalidatePath`. The banner is rendered from the session and one column read, so the
 * client's `router.refresh()` after a success is the honest reconciliation; a path
 * revalidation here would be one of the dead paths this build does not carry.
 */
export async function sendVerification(): Promise<ActionResult<VerificationSendResult>> {
  /**
   * The type argument is EXPLICIT on purpose. `guard<T>` infers `T` from the callback's return,
   * and the callback's `ok({ alreadyConfirmed: true, … })` branch returns the LITERAL type
   * `true` rather than `boolean` — so inference picks the first branch's shape and then rejects
   * every later branch that reports `alreadyConfirmed: false`. Naming `VerificationSendResult`
   * here makes the declared contract the source of truth instead of whichever branch happens
   * to come first in the body.
   */
  return guard<VerificationSendResult>("sendVerification", async () => {
    const user = await requireUser();

    const [row] = await db
      .select({
        username: users.username,
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
        isGuest: users.isGuest,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    // `requireUser` just confirmed the row exists, so this is the window between the two
    // reads. Same refusal as no session at all, because that is what it now is.
    if (!row) throw new UnauthorizedError();

    /*
     * GUESTS ARE REFUSED HERE, NOT SILENTLY HUMOURED. A guest address is
     * `guest_ab12cd34@guest.invalid`, on an RFC 2606 reserved TLD, so the mail can never be
     * delivered and the instruction can never be followed. The original shipped exactly this
     * as a production bug — a banner asking a guest to confirm
     * `guest_46ee4182c3@guest.invalid` — and the refusal is phrased as the conversion offer
     * because that is the only action that can resolve it.
     */
    if (row.isGuest) throw new GuestNotAllowedError("confirm an email address");

    // Before the budgets, so a member whose address is already confirmed cannot burn their own
    // three-per-hour on a no-op — the banner that triggers this is server-rendered, and a
    // stale one is exactly how this gets called twice.
    if (row.emailVerifiedAt) return ok({ alreadyConfirmed: true, delivered: false, via: null });

    const byUser = await consume(BUDGETS.verifyEmailByUser, String(user.id));
    const byIp = await consume(BUDGETS.verifyEmailByIp, await clientAddress());
    // Both are consumed before either is checked, so the two counters cannot disagree about
    // how many attempts were made. The per-account limit is reported first: it is the one a
    // real member hits, and its retry window is the one they need.
    if (!byUser.ok) return fail(retryMessage(byUser));
    if (!byIp.ok) return fail(retryMessage(byIp));

    const token = await issueVerificationToken(user.id, row.email);

    const result = await sendVerificationEmail({
      to: row.email,
      username: row.username,
      // /verify reads `?token`, renders a BUTTON, and redeems nothing on load (I-28).
      url: `${env.siteUrl}/verify?token=${encodeURIComponent(token)}`,
      ttlMinutes: VERIFICATION_TTL_MINUTES,
    });

    return ok({
      alreadyConfirmed: false,
      delivered: result.delivered,
      // `via` already says this, and `emailDeliveryConfigured()` is asserted against it here
      // so a future transport that forgets to report itself cannot make the UI claim delivery.
      via: emailDeliveryConfigured() ? result.via : "log",
    });
  });
}

/**
 * Redeems a confirmation token. A BUTTON PRESS BY A SIGNED-IN MEMBER, NEVER A PAGE LOAD
 * (I-28).
 *
 * > Mail clients and security scanners follow links automatically, which would burn a
 * > single-use token before the member clicked it.
 *
 * That is not a hypothetical: corporate mail scanners, link-preview bots and antivirus
 * proxies all fetch URLs out of mail, and a `GET /verify?token=…` that consumed the token
 * would present to the member as "the link has already been used" on a link they have never
 * opened — with the "send another" button producing another dead link every time.
 *
 * FIVE REFUSALS, ONE MESSAGE, and the fifth is the interesting one: THE TOKEN MUST BELONG TO
 * THE ACCOUNT THAT IS SIGNED IN. A token belongs to the account it was issued for, not to
 * whoever is signed in — otherwise a link mailed to one address confirms whichever account
 * happens to hold the current cookie, which is a way to get somebody else's address marked as
 * confirmed on your own row.
 *
 * `requireUser()` RUNS BEFORE THE SHAPE CHECK on purpose: an anonymous caller should be told
 * to sign in, which is what /verify's own redirect to `/login?next=/verify` is for, rather
 * than being told their link is invalid when the link is fine.
 */
export async function confirmVerification(input: { token: string }): Promise<ActionResult> {
  return guard("confirmVerification", async () => {
    const user = await requireUser();

    // 1. The shape, before the database is touched. 43 characters of base64url is exactly what
    //    `createLinkToken` produces; a scanner hitting /verify with junk never becomes a query.
    if (!looksLikeLinkToken.test(input.token)) return fail(INVALID_LINK);

    const [record] = await db
      .select({
        userId: emailVerificationTokens.userId,
        email: emailVerificationTokens.email,
        consumedAt: emailVerificationTokens.consumedAt,
        /*
         * EXPIRY IS DECIDED BY THE DATABASE'S CLOCK, not this process's: `expires_at` was
         * written from `now()` plus an interval, and a serverless instance with a skewed clock
         * would otherwise honour a dead token or refuse a live one. Projected rather than
         * folded into the WHERE clause so the refusal stays legible as its own line.
         */
        live: sql<boolean>`${emailVerificationTokens.expiresAt} > now()`,
      })
      .from(emailVerificationTokens)
      // BY THE HASH, through `email_verification_token_hash_uq`. The plaintext is never stored,
      // so this is the only way to find the row — and a leak of this table yields nothing
      // redeemable (I-27).
      .where(eq(emailVerificationTokens.tokenHash, sha256hex(input.token)))
      .limit(1);

    if (!record) return fail(INVALID_LINK); // 2. no such token
    if (record.consumedAt) return fail(INVALID_LINK); // 3. single use, and it has been used
    if (!record.live) return fail(INVALID_LINK); // 4. older than VERIFICATION_TTL_MINUTES
    if (record.userId !== user.id) return fail(INVALID_LINK); // 5. not this account's token

    /*
     * The address must still be the one the token was issued for. The comparison is done by
     * Postgres' `lower()` rather than JavaScript's, matching `users_email_lower_uq`: the two
     * implementations disagree on some non-ASCII folding, and a second implementation of
     * "same address" is how a confirmation silently confirms nothing.
     */
    const [account] = await db
      .select({ addressMatches: sql<boolean>`lower(${users.email}) = lower(${record.email})` })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (!account || !account.addressMatches) return fail(INVALID_LINK);

    await db.transaction(async (tx) => {
      // EVERY outstanding token, not just this one. Leaving the others live would mean an old
      // message still carries a working confirmation for an address the member may have
      // changed since — and there is no reason to keep a second key to a door already open.
      await tx
        .update(emailVerificationTokens)
        .set({ consumedAt: new Date() })
        .where(and(eq(emailVerificationTokens.userId, user.id), isNull(emailVerificationTokens.consumedAt)));

      await tx
        .update(users)
        .set({
          // `coalesce` so a second confirmation cannot rewrite the original date: that
          // timestamp is the answer to "when did this account become real", and overwriting it
          // would make a long-standing account look newly confirmed. The column reference on
          // the right-hand side is the target table's own value, which is legal in a SET.
          emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`,
        })
        .where(eq(users.id, user.id));
    });

    return ok();
  });
}

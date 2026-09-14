import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { passwordResetTokens, users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import {
  PASSWORD_RESET_TTL_MINUTES,
  createLinkToken,
  linkTokenExpiry,
  looksLikeLinkToken,
  sha256hex,
} from "@/lib/security/tokens";

/**
 * Password reset, as a LIBRARY MODULE rather than as the body of a Server Action.
 *
 * > A single-use token that turns out to be reusable is not the kind of thing to discover in
 * > production.
 *
 * That is the whole reason this file exists. Everything here has a rule worth proving —
 * single use, one indistinguishable refusal, outstanding tokens retired in the same
 * transaction — and a rule that only exists inside an action is a rule nobody can test
 * against a real database. app/actions/password.ts is a shell over these four functions:
 * it validates, hashes, calls, and reports.
 *
 * THE PASSWORD IS HASHED IN THE ACTION, NOT HERE. `redeemPasswordReset` takes a hash, never a
 * password, so this module cannot log a plaintext even by accident — and that matters
 * specifically here, because `safeErrorDetail` exists because driver errors carry their bound
 * parameters, and the parameters of the statement below are a user id and a password hash.
 *
 * ONLY THE SHA-256 OF A TOKEN IS EVER STORED (I-27). The plaintext exists for the length of
 * one function call and one email. A database leak yields nothing redeemable.
 */

/**
 * The link that goes in the mail.
 *
 * Declared here rather than at the two call sites (the member's own request and the admin
 * panel's) so that both send the same URL to the same route. `encodeURIComponent` is belt and
 * braces — `createLinkToken` emits base64url precisely so that none of its 64 characters need
 * escaping in a query string — but the alternative is a function that is correct only because
 * of a property of a different module.
 *
 * The landing page sets `robots: noindex` and `referrer: "no-referrer"`, so this token never
 * reaches a search index or a `Referer` header.
 */
export function passwordResetUrl(token: string): string {
  return `${env.siteUrl}/reset?token=${encodeURIComponent(token)}`;
}

/**
 * Resolves an address to the account a reset may be issued for, or null.
 *
 * THE RETURNED `email` IS THE STORED ONE, not the one the caller passed. Mail goes to the
 * address on the row — a flow that mails an address a request supplied is a relay with our
 * sending reputation attached (see the module docblock in lib/email/index.ts) — and the
 * stored form is also the case-preserved one the member typed when they registered.
 *
 * `lower()` ON BOTH SIDES, IN POSTGRES: the predicate then matches the functional unique index
 * `users_email_lower_uq` in both shape (so it is an index scan) and semantics (JavaScript and
 * Postgres do not agree on all non-ASCII case folding, and an address stored through one
 * implementation and looked up through the other can miss).
 *
 * GUESTS ARE EXCLUDED HERE, which is the only place it needs doing. A guest's address is on a
 * reserved TLD and can never receive the mail; a guest cannot sign in with a password, so the
 * token would unlock nothing; and redeeming one would set `email_verified_at` on a row whose
 * address is undeliverable. Excluding them at issue is what makes "no reset token can exist
 * for a guest" true, which is why `redeemPasswordReset` does not need to re-check it.
 *
 * Deliberately local rather than added to lib/db/queries/users.ts, for the same reason
 * `findAccountByEmail` is local to lib/auth/index.ts: it is an authentication lookup with one
 * caller shape, and its projection is chosen to keep `password_hash` out of the result.
 */
export async function findResetRecipient(
  email: string,
): Promise<{ id: number; username: string; email: string } | null> {
  const [row] = await db
    .select({ id: users.id, username: users.username, email: users.email })
    .from(users)
    .where(and(sql`lower(${users.email}) = lower(${email})`, eq(users.isGuest, false)))
    .limit(1);

  return row ?? null;
}

export type PasswordResetIssue = {
  /** The plaintext, returned ONCE. It goes into one email and is then unrecoverable. */
  token: string;
  expiresAt: Date;
  /**
   * The address the token was BOUND to, read off the row inside the transaction. Returned so
   * the caller mails exactly what was bound rather than whatever it happened to be holding —
   * a mail sent to a different address than the token records is a link that will be refused
   * on redemption by the mismatch check.
   */
  email: string;
};

/**
 * Thrown when there is nothing to issue a token for: the row is gone, or it is a guest.
 *
 * Both call sites (the member's own request, through `findResetRecipient`, and the admin
 * panel, which checks `is_guest` explicitly) have already excluded both cases, so this is the
 * belt rather than the braces — but it is the belt that makes "no reset token can exist for a
 * guest" a property of this module rather than a property of two callers remembering. A guest
 * has no password to reset and an address on a reserved TLD that can never receive the mail.
 */
export class PasswordResetUnavailableError extends Error {
  constructor() {
    super("That account cannot be sent a password reset.");
    // Minification renames classes; `name` is what reaches the log.
    this.name = "PasswordResetUnavailableError";
  }
}

/**
 * Issues a reset token, RETIRING EVERY OUTSTANDING ONE FOR THAT USER IN THE SAME TRANSACTION
 * (I-27).
 *
 * IT TAKES AN ID AND READS THE ADDRESS ITSELF, rather than taking both. The address on the
 * token row is what the redemption check compares against, so a caller that could pass one
 * could bind a token to an address the account does not hold — and the row is the only
 * authority on that (see the recipient rule in lib/email/index.ts). Reading it inside the
 * transaction also means the bound value is the value as of the issue, not as of whenever the
 * caller last looked.
 *
 * The retirement is not housekeeping. Without it, every "send it again" press leaves another
 * live token in the mailbox, so the window in which a leaked or forwarded message takes over
 * the account is the union of all of them — and a member who resets because they suspect
 * somebody is in their mail has just been given no way to invalidate what that person already
 * received. One live token per account means the most recent request is the only one that
 * works, which is also what members expect.
 *
 * THE ORDER OF THE TWO STATEMENTS IS LOAD-BEARING: retire, then insert. Reversed, the update's
 * `consumed_at IS NULL` predicate matches the row that was just written and the flow issues a
 * token that is already dead — a bug with no symptom until somebody clicks the link.
 *
 * `expires_at` is a `Date` because the column is `timestamptz`, which Drizzle reads and writes
 * as a `Date` — unlike a `date` column, which it hands back as a string (I-9).
 *
 * The address is COPIED ONTO THE TOKEN ROW, so a later change of address cannot be confirmed
 * by an old link: `redeemPasswordReset` compares the two and refuses a mismatch.
 */
export async function issuePasswordReset(userId: number): Promise<PasswordResetIssue> {
  const { token, tokenHash } = createLinkToken();
  const expiresAt = linkTokenExpiry(PASSWORD_RESET_TTL_MINUTES);

  const email = await db.transaction(async (tx) => {
    const [account] = await tx
      .select({ email: users.email, isGuest: users.isGuest })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!account || account.isGuest) throw new PasswordResetUnavailableError();

    await tx
      .update(passwordResetTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.consumedAt)));

    await tx.insert(passwordResetTokens).values({
      userId,
      tokenHash,
      email: account.email,
      expiresAt,
    });

    return account.email;
  });

  return { token, expiresAt, email };
}

/**
 * The result of a redemption. `username` is here because the UI's whole job afterwards is to
 * say *"Your password is set. Sign in as @username."* — it does NOT sign them in.
 *
 * THE FAILURE ARM CARRIES ONE REASON AND WILL NEVER CARRY MORE. See `invalid()`.
 */
export type PasswordResetRedeemResult =
  | { ok: true; userId: number; username: string }
  | { ok: false; reason: "invalid" };

/**
 * ONE CONSTRUCTION SITE FOR THE REFUSAL (I-27).
 *
 * Six different things below return this identical object. Distinguishing them — "expired"
 * versus "already used" versus "no such token" — tells a guesser which of their candidates
 * were REAL tokens, which is the one bit of the answer worth having: it turns a 256-bit
 * search into a search with feedback. A single constructor is what stops a future edit from
 * helpfully adding a `detail` field to one branch.
 */
function invalid(): PasswordResetRedeemResult {
  return { ok: false, reason: "invalid" };
}

/**
 * Redeems a reset token and sets the new hash. SIX REFUSALS, ONE ANSWER.
 *
 * bad shape · no row · already consumed · expired · account gone · address mismatch
 *
 * (The brief calls it five; the sixth is the address mismatch, which was introduced with the
 * `email` column on the token table. Every one of them returns `invalid()`.)
 *
 * Then ONE TRANSACTION that does two things:
 *
 *   1. CONSUMES EVERY OUTSTANDING TOKEN FOR THAT USER, not just this one. A reset that left
 *      the member's other live links working would mean the person who triggered the reset can
 *      do it again from a message they already have.
 *   2. `email_verified_at = coalesce(email_verified_at, now())` — REDEEMING A RESET CONFIRMS AN
 *      UNVERIFIED ADDRESS, because *redeeming this proves they read mail at that address,
 *      which is the same thing email verification proves.* `coalesce` rather than a plain
 *      assignment so an already-confirmed address keeps its original date: that timestamp is
 *      the answer to "when did this account become real", and overwriting it on every reset
 *      would make every long-standing account look newly confirmed.
 */
export async function redeemPasswordReset(input: {
  token: string;
  passwordHash: string;
}): Promise<PasswordResetRedeemResult> {
  // 1. THE SHAPE, BEFORE THE DATABASE IS TOUCHED. 43 characters of base64url is exactly what
  //    `createLinkToken` produces, so a scanner hitting /reset?token=<junk> never becomes a
  //    query. It is a cheap filter, not a security control — everything below it is.
  if (!looksLikeLinkToken.test(input.token)) return invalid();

  const [record] = await db
    .select({
      userId: passwordResetTokens.userId,
      email: passwordResetTokens.email,
      consumedAt: passwordResetTokens.consumedAt,
      /*
       * EXPIRY IS DECIDED BY THE DATABASE'S CLOCK, not by this process's.
       *
       * `expires_at` was written by `now()` plus an interval measured against the same clock,
       * and a serverless instance with a skewed clock would otherwise either honour a dead
       * token or refuse a live one. Projecting the comparison keeps the refusal explicit —
       * folding it into the WHERE clause would collapse "expired" into "no row", which is the
       * same answer but a worse place to read the rule from.
       */
      live: sql<boolean>`${passwordResetTokens.expiresAt} > now()`,
    })
    .from(passwordResetTokens)
    // The lookup is BY THE HASH, through `password_reset_token_hash_uq`. There is no per-row
    // salt to iterate over, which is exactly why a plain digest is the right primitive here.
    .where(eq(passwordResetTokens.tokenHash, sha256hex(input.token)))
    .limit(1);

  if (!record) return invalid(); // 2. no row
  if (record.consumedAt) return invalid(); // 3. already consumed — single use, and this is it
  if (!record.live) return invalid(); // 4. expired

  /*
   * 5 and 6, in one round trip. The address comparison is done by Postgres' `lower()` for the
   * same reason the lookup above is: two implementations of case folding is one too many.
   *
   * The mismatch case is real rather than theoretical defence: the token row carries the
   * address it was issued to, so if the account's address changes between issue and redemption
   * the old link must stop working — otherwise a reset mailed to a former address survives the
   * member fixing it.
   */
  const [account] = await db
    .select({
      id: users.id,
      username: users.username,
      addressMatches: sql<boolean>`lower(${users.email}) = lower(${record.email})`,
    })
    .from(users)
    .where(eq(users.id, record.userId))
    .limit(1);

  if (!account) return invalid(); // 5. the account was deleted after the mail was sent
  if (!account.addressMatches) return invalid(); // 6. the address moved

  await db.transaction(async (tx) => {
    await tx
      .update(passwordResetTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(passwordResetTokens.userId, record.userId), isNull(passwordResetTokens.consumedAt)));

    await tx
      .update(users)
      .set({
        passwordHash: input.passwordHash,
        // The column reference on the right-hand side is the target table's own value, which
        // is legal in an UPDATE ... SET expression and is what makes this idempotent.
        emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())`,
      })
      .where(eq(users.id, record.userId));
  });

  return { ok: true, userId: account.id, username: account.username };
}

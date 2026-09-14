import "server-only";

import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

/**
 * The session read ladder. Four rungs, each costing strictly more than the one below, so a
 * caller picks by what it is about to do rather than by habit.
 *
 *   currentUser()   zero queries   reads the token. For rendering.
 *   requireUser()   one query      confirms the row still exists. For writing.
 *   requireMember() two queries    adds "not a guest". For anything other members can see.
 *   requireAdmin()  one query      role from the database (lib/auth/admin.ts).
 *
 * WHY THE LADDER EXISTS AT ALL: these are stateless JWTs, valid for their full 14 days, with
 * no server-side revocation list. A token keeps asserting an identity after the row behind it
 * is gone — a deleted account, a merged guest. READS TOLERATE THAT; WRITES MUST NOT (I-17).
 * `requireUser` is therefore the single revocation point in the application: deleting a
 * `users` row stops that session writing on its very next request, while its cookie keeps
 * decoding until it expires.
 */

/**
 * The parsed session. `id` is a NUMBER here and a string in the token, and the conversion
 * happens once, in `currentUser`.
 *
 * NO `role`, NO `plan`, NO `emailVerifiedAt` — by design, not by omission. See
 * types/next-auth.d.ts: anything that decides what a request may do is read from its column on
 * the request that needs it (I-18). `isGuest` is here and is presentation only.
 */
export type SessionUser = {
  id: number;
  username: string;
  avatarSeed: string | null;
  isGuest: boolean;
};

/* ========================================================================== *
 * THE FOUR DOMAIN ERRORS
 *
 * These are the ONLY four classes `guard()` converts into their own member-visible message
 * (app/actions/result.ts). Everything else becomes the flat "Something went wrong. Try
 * again." — so A NEW DOMAIN ERROR CLASS THAT IS NOT ADDED TO THAT LIST DISAPPEARS INTO A
 * GENERIC MESSAGE, which presents as a mysteriously silent feature rather than as a bug.
 *
 * `name` is assigned explicitly in each constructor because minification renames classes, and
 * `safeErrorDetail` logs `name`. Without it the log says "Error".
 * ========================================================================== */

/** No usable session: no cookie, a malformed one, or one whose account no longer exists. */
export class UnauthorizedError extends Error {
  constructor(message = "Sign in to do that.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * A guest reached something that involves other people.
 *
 * THE MESSAGE IS THE CONVERSION OFFER, which is why the action name is interpolated: every one
 * of these refusals is a place where signing up is the obvious next move, and *"Your logs will
 * come with you"* is the sentence that makes it true — Path A of the claim flow updates the
 * same `users.id` in place, so nothing moves and nothing can half-fail.
 */
export class GuestNotAllowedError extends Error {
  constructor(action = "do that") {
    super(`Create an account to ${action}. Your logs will come with you.`);
    this.name = "GuestNotAllowedError";
  }
}

/**
 * Thrown only when `REQUIRE_EMAIL_VERIFICATION` is on and the label is not exempt. The gate is
 * on publishing, not on authentication — `authorize()` deliberately does not check this
 * column, or an unconfirmed member could not reach the page that asks them to confirm.
 */
export class UnverifiedEmailError extends Error {
  constructor(message = "Confirm your email address first — there is a link in the banner at the top of the page.") {
    super(message);
    this.name = "UnverifiedEmailError";
  }
}

/**
 * Authenticated, but not allowed. Raised by `requireAdmin()` and by ownership checks.
 *
 * Admin ROUTES turn this into `notFound()` rather than a 403 (I-21): a 403 confirms the route
 * exists and that they found a real admin surface, while a 404 is indistinguishable from a
 * typo. Admin ACTIONS return its message, because by then the caller already knows the action
 * exists — they called it.
 */
export class ForbiddenError extends Error {
  constructor(message = "You do not have access to that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/* ========================================================================== *
 * THE RUNGS
 * ========================================================================== */

/**
 * ZERO DATABASE QUERIES. Decodes the cookie and returns what is in it.
 *
 * Used by every render — the header, the poster overlays, the "your rating" column — which is
 * why it must stay free. A version of this that confirmed the row would add one query to every
 * page in the application for a guarantee that no read needs.
 *
 * The three guards are not ceremony. `id` and `username` must both be present because a token
 * minted before either field existed still decodes after a deploy, and a `SessionUser` with an
 * empty username renders a link to `/@`. `Number.isSafeInteger` plus `> 0` because the value
 * came out of a JSON payload: `"1e30"` and `"-1"` both survive `Number()` and neither is a
 * `serial`, and passing either into a query is how you get an out-of-range 500 (I-5).
 */
export async function currentUser(): Promise<SessionUser | null> {
  const session = await auth();
  const raw = session?.user;
  if (!raw?.id || !raw.username) return null;

  const id = Number(raw.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  return {
    id,
    username: raw.username,
    avatarSeed: raw.avatarSeed ?? null,
    isGuest: raw.isGuest === true,
  };
}

/**
 * ONE INDEXED LOOKUP, and it is the revocation point (I-17).
 *
 * Selects only `id`: the question is "does this row exist", and widening the projection would
 * invite a caller to trust the returned row for authorization decisions that belong to
 * `requireMember` and `requireAdmin`.
 *
 * Every mutation starts here. A JWT for an account that was deleted, or for a guest row that
 * was consumed by a merge, decodes perfectly and must not write.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new UnauthorizedError();

  const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, user.id)).limit(1);
  if (!rows[0]) throw new UnauthorizedError();

  return user;
}

/**
 * `requireUser()` plus "not a guest", read FROM THE COLUMN (I-18).
 *
 * Two queries rather than one combined select, deliberately: `requireUser` is the single
 * revocation point, and a merged query would be a second copy of it — the kind of copy that
 * later loses the existence check when somebody optimises the guest read away.
 *
 * `action` is a verb phrase completing *"Create an account to …"*: `"follow people"`,
 * `"reply to a review"`. Guests are refused on exactly three things — follow, like, comment —
 * and each of them involves another person, which is the point: the restriction IS the reason
 * to sign up. Reviews are capped rather than refused, and ratings and diary entries are not
 * limited at all, because those are the habit and interrupting the habit teaches somebody to
 * leave.
 */
export async function requireMember(action = "do that"): Promise<SessionUser> {
  const user = await requireUser();

  const rows = await db.select({ isGuest: users.isGuest }).from(users).where(eq(users.id, user.id)).limit(1);
  const row = rows[0];
  // Deleted between the two reads. Not a guest problem, so not a guest message.
  if (!row) throw new UnauthorizedError();
  if (row.isGuest) throw new GuestNotAllowedError(action);

  return user;
}

/**
 * The email-verification gate's only implementation. Called by `guard()`, never by an action
 * directly.
 *
 * BOTH COLUMNS COME FROM THE DATABASE. The token's `isGuest` decides whether `guard()` spends
 * this query at all; this row decides the outcome (I-18).
 *
 * THE GUEST EARLY RETURN IS A SHIPPED PRODUCTION BUG EXPRESSED AS A RULE. In the original,
 * guest mode landed after verification, so the banner asked guests to confirm addresses like
 * `guest_46ee4182c3@guest.invalid` — a domain on an RFC 2606 reserved TLD that can never
 * receive mail, so the instruction was not merely odd but impossible to follow. Putting the
 * rule here rather than in the banner means every future caller inherits it.
 */
export async function assertEmailVerified(userId: number): Promise<void> {
  const rows = await db
    .select({ isGuest: users.isGuest, emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new UnauthorizedError();
  if (row.isGuest) return;
  if (!row.emailVerifiedAt) throw new UnverifiedEmailError();
}

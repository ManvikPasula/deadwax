"use server";

/**
 * Registration, sign-in, sign-out, and the two guest conversion paths.
 *
 * THIS MODULE IS A `"use server"` FILE, SO EVERY EXPORT IS A PUBLIC HTTP ENDPOINT. Two
 * consequences that shape the whole file:
 *
 *   1. EVERY EXPORT MUST BE AN ASYNC FUNCTION. That is why `safeNextPath` — a pure string
 *      filter with no I/O — is `async` and returns a promise. The alternative was a fourth
 *      module for one regex, or the far worse alternative of the login and signup pages each
 *      keeping their own copy of the allowlist. A rule with two copies is a rule that has
 *      already drifted.
 *   2. AN INTERNAL HELPER IS INTERNAL BECAUSE IT IS UNEXPORTED. `uniqueViolationMessage` and
 *      the two sign-in helpers below are deliberately not exported: an exported one would be
 *      callable directly, without the `guard()` that provides the rate limit and the
 *      verification gate.
 *
 * WHAT IS NOT HERE: any write to the two operator-only columns on `users`. Neither appears in
 * any statement in this file, or in any action anywhere in the application — see the comment
 * on the column in lib/db/schema.ts and tests/no-escalation.test.ts, which asserts it at the
 * source level so that a future action fails a test rather than quietly shipping.
 *
 * WHAT THE SIGN-IN BUDGETS ARE NOT: consumed here. `loginByIp` and `loginByAccount` are both
 * spent inside `authorize()` (lib/auth/index.ts), before bcrypt, so that a direct POST to
 * /api/auth/callback/credentials cannot reach the compare with nothing spent. Counting them
 * again here would halve every limit — `loginByAccount` at 5 per 15 minutes would become two
 * and a half attempts — and lock out members who simply mistyped.
 */

import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { AuthError } from "next-auth";
import { redirect, unstable_rethrow } from "next/navigation";

import { signIn as authSignIn, signOut as authSignOut } from "@/lib/auth";
import { claimGuestAccount, mergeGuestByEmail, newAvatarSeed } from "@/lib/auth/claim";
import { BCRYPT_COST } from "@/lib/auth/guest";
import { currentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { BUDGETS, clientAddress, consume, retryMessage } from "@/lib/security/rate-limit";
import { GENERIC_AUTH_FAILURE, signInSchema, signUpSchema } from "@/lib/security/schemas";

import { type ActionResult, fail, guard, safeErrorDetail } from "./result";

/* ========================================================================== *
 * ?next= — HONOURED, AND ALLOWLISTED
 * ========================================================================== */

/**
 * THE SOURCE SHIPS `?next=` AS A DEAD PARAMETER THAT NOTHING READS, and that is a named
 * defect: every guard in the application redirects to `/login?next=<where they were going>`,
 * and then sign-in drops them on the homepage. The member is sent back to find the page they
 * were already on, which is the same experience as the redirect not working.
 *
 * Honouring it is one line. Honouring it SAFELY is this function, because a `next` parameter
 * is the classic open redirect: `/login?next=https://evil.example/login` produces a real
 * login page, a real session, and then a hand-off to a convincing copy of ourselves.
 *
 * AN ALLOWLIST, NOT A DENYLIST — the same doctrine as `usernameSchema`. Four rules:
 *
 *   1. It must start with `/`, so the destination is origin-relative and a scheme
 *      (`https:`, `javascript:`, `data:`) cannot be expressed at all.
 *   2. NO `//` ANYWHERE. `//evil.example/x` is a protocol-relative URL: it starts with a
 *      slash, it passes rule 1, and a browser sends it straight off our origin. This is the
 *      rule the vulnerability actually lives behind, and it is checked separately from the
 *      pattern so that it cannot be lost in a future regex edit.
 *   3. `[A-Za-z0-9/@._~-]` only. `@` is in the set because profiles live at `/@name`; `%`,
 *      `?`, `#`, `\` and everything else are out. A QUERY STRING THEREFORE CANNOT SURVIVE
 *      THIS, which is deliberate: `%` is where an allowlist stops being a filter and becomes
 *      a URL parser, and every destination this needs (a profile, an album, /settings,
 *      /verify) is a bare path. A `next` carrying a query string is refused, not stripped.
 *   4. A length bound. 512 characters is not a destination anybody typed; it is somebody
 *      finding out what the parser does.
 *
 * `..` is allowed by the character set and is harmless: with rules 1 and 2 the result is
 * always origin-relative, so the worst a traversal can do is name one of our own pages.
 *
 * `unknown` RATHER THAN `string`, because the value comes from `searchParams`, where a
 * repeated parameter (`?next=/a&next=/b`) arrives as an ARRAY. Anything that is not a single
 * string is refused — "take the first one" is how a smuggled second value gets honoured.
 */
const NEXT_PATH_PATTERN = /^\/[A-Za-z0-9/@._~-]*$/;
const MAX_NEXT_PATH_LENGTH = 512;

export async function safeNextPath(value: unknown): Promise<string | null> {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_NEXT_PATH_LENGTH) return null;
  if (value.includes("//")) return null;
  if (!NEXT_PATH_PATTERN.test(value)) return null;
  return value;
}

/**
 * The guard `/login` and `/signup` call. REDIRECTS NON-GUEST MEMBERS ONLY.
 *
 * A blanket "redirect anyone with a session" is the obvious implementation and it TRAPS
 * GUESTS AWAY FROM BOTH UPGRADE PATHS: a guest holds a perfectly good session, so both pages
 * would bounce them to the homepage, and the two doors out of guest mode are exactly these
 * two pages. The original shipped the blanket version and had to fix it while wiring guest
 * mode.
 *
 * `is_guest` IS READ FROM THE COLUMN, NOT FROM THE TOKEN (I-18). The token's copy is
 * presentation only, and this decision gates access to the only two upgrade paths a guest
 * has — a stale `true` would be harmless (they see a sign-up form they do not need), but a
 * stale `false` would be the trap this function exists to avoid. One indexed read on two
 * pages that render rarely is the correct price.
 *
 * A session whose row is gone falls through without redirecting: the account was deleted or
 * merged, and the right thing for that cookie's holder is the sign-in form they are looking
 * at (I-17).
 */
export async function redirectSignedInMember(next?: unknown): Promise<void> {
  const user = await currentUser();
  if (!user) return;

  const [row] = await db.select({ isGuest: users.isGuest }).from(users).where(eq(users.id, user.id)).limit(1);
  if (!row || row.isGuest) return;

  redirect((await safeNextPath(next)) ?? "/");
}

/* ========================================================================== *
 * SIGN UP — PATH A OF THE CONVERSION
 * ========================================================================== */

export type SignUpActionInput = {
  username: string;
  email: string;
  password: string;
  next?: string | null;
};

/**
 * Maps a unique-index violation to the one sentence a member can act on.
 *
 * Both names are read off `constraint`, which is the index name for a functional unique index
 * — `users_username_lower_uq` tells an operator exactly which uniqueness lost the race, and
 * it tells this function which field to name. The fallback covers a driver that does not
 * report the constraint.
 *
 * NAMING WHICH FIELD COLLIDED IS NOT A MEMBERSHIP ORACLE, and it is worth saying why, because
 * the reflex is to hide it: the REFUSAL ITSELF is the oracle here. Sign-up cannot both create
 * the account and conceal that the address is taken, whatever the wording. Since the
 * granularity leaks nothing further, the ambiguous message buys nothing and costs a member
 * with a typo'd username the ability to fix it. The per-IP budget below is what actually
 * makes bulk enumeration through this endpoint expensive.
 */
function uniqueViolationMessage(error: unknown): string | null {
  const detail = safeErrorDetail(error);
  if (detail.code !== "23505") return null;
  if (detail.constraint === "users_username_lower_uq") return "That username is taken.";
  if (detail.constraint === "users_email_lower_uq") {
    return "There is already an account for that email address. Sign in instead.";
  }
  return "That username or email address is already taken.";
}

/**
 * Registration, and PATH A OF THE GUEST CONVERSION.
 *
 * ORDER, and each step's reason:
 *
 *  1. VALIDATE, using the SHARED `signUpSchema` (I-25). Two password schemas — one at
 *     registration, one at sign-in — created accounts that could not then be signed into, and
 *     that is the defect this import exists to make impossible.
 *
 *  2. SPEND `signUpByIp` (5/hour). AFTER validation, unlike the login budgets, and the
 *     asymmetry is deliberate: there, the budget protects a 250 ms bcrypt compare and an
 *     account-guessing surface, so a malformed flood must still pay. Here the expensive work
 *     is below this line, a malformed flood reaches only Zod, and `guard()`'s `writeByAnon`
 *     (30/60s) already meters it — while a member who mistypes their password twice must not
 *     lose two of their five daily chances to register.
 *
 *  3. HASH ONCE, at cost 12, before either branch, because both need it.
 *
 *  4. TRY THE CLAIM. The token's `isGuest` decides only whether the UPDATE is worth
 *     attempting; the `is_guest = true` predicate inside it is the enforcement (I-30). A
 *     signed-in member who somehow reaches this is refused by that predicate and falls
 *     through to a fresh row, which is the correct outcome rather than an error.
 *
 *  5. IF THE CLAIM DID NOT WIN, CREATE A FRESH ROW. Sign-up STILL SUCCEEDS — the guest's
 *     work is simply left behind under a row nobody will reach again. Failing the
 *     registration because a concurrent tab won the claim would be punishing the member for
 *     our race.
 *
 *  6. SIGN THEM IN. Not optional: the JWT carries `username` and `isGuest`, so a claimed
 *     guest whose session is not re-issued keeps rendering as `guest_ab12cd34` with the guest
 *     strip up for as long as fourteen days. This costs one `loginByAccount` token, which is
 *     acceptable because step 2's five-per-hour is the binding limit anyway.
 */
export async function signUp(input: SignUpActionInput): Promise<ActionResult> {
  return guard("signUp", async () => {
    const parsed = signUpSchema.safeParse(input);
    // The schema's own message, which is the one written to be read by a member ("Letters,
    // numbers and underscores only.", the 72-byte explanation). The first issue only: a form
    // that lists four complaints at once gets read as none of them.
    if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form and try again.");
    const { username, email, password } = parsed.data;

    const limit = await consume(BUDGETS.signUpByIp, await clientAddress());
    if (!limit.ok) return fail(retryMessage(limit));

    const passwordHash = await hash(password, BCRYPT_COST);
    // Derived server-side, never accepted from the caller: `signUpSchema` has no field for
    // either, so a request that sends them is stripped by `z.object`.
    const displayName = username;
    const avatarSeed = newAvatarSeed();

    const viewer = await currentUser();
    let claimed = false;

    try {
      if (viewer?.isGuest) {
        claimed = await claimGuestAccount({
          guestId: viewer.id,
          username,
          email,
          passwordHash,
          displayName,
          avatarSeed,
        });
      }

      if (!claimed) {
        await db.insert(users).values({
          username,
          email,
          passwordHash,
          displayName,
          avatarSeed,
          // Explicit rather than relying on the column default, because this is the one write
          // in the application that turns a session into a member and the value should be
          // readable at the site of the decision.
          isGuest: false,
        });
      }
    } catch (error) {
      // A 23505 from either path. NOT swallowed into the generic failure: "that username is
      // taken" is the one refusal here a member can actually do something about.
      const message = uniqueViolationMessage(error);
      if (message) return fail(message);
      throw error;
    }

    try {
      await authSignIn("credentials", { email, password, redirect: false });
    } catch (error) {
      unstable_rethrow(error);
      // The account exists and the session does not — almost always because the login budget
      // for this address is exhausted. Reported as a failure with the one instruction that
      // works, because the rejected alternative (redirect to /login with no message) looks
      // exactly like the sign-up having done nothing at all.
      if (error instanceof AuthError) {
        return fail("Your account is set up. Sign in to continue.");
      }
      throw error;
    }

    /*
     * WHERE THEY LAND. `next` wins when it is present and safe.
     *
     * Otherwise the two branches differ, because the two people differ: a claimed guest has
     * already been rating records and wants to carry on where they were, while somebody who
     * arrived at the form directly has an empty account and no recommendations, and /start is
     * twenty-four covers and a star control. Sending a claimed guest to /start would offer
     * them an onboarding grid full of albums they have already rated.
     */
    redirect((await safeNextPath(input.next)) ?? (claimed ? "/" : "/start"));
  });
}

/* ========================================================================== *
 * SIGN IN — PATH B OF THE CONVERSION
 * ========================================================================== */

export type SignInActionInput = {
  email: string;
  password: string;
  next?: string | null;
};

/**
 * Sign-in, and PATH B OF THE GUEST CONVERSION.
 *
 * THE ORDERING CONSTRAINT IS THE WHOLE SHAPE OF THIS FUNCTION: the guest id is captured
 * BEFORE authenticating, because signing in replaces the session and there is no other record
 * of which guest was at this keyboard. Read afterwards, `currentUser()` returns the account
 * they just signed into, and the merge would silently become a no-op — the guest's work would
 * stay under a row whose cookie has just been overwritten, which is the same thing as losing
 * it.
 *
 * THE TARGET IS RESOLVED FROM THE ADDRESS THAT JUST AUTHENTICATED, never from anything the
 * caller sent, and never from the new session's own token either — see `mergeGuestByEmail`.
 * The only evidence this function has is that one address completed a bcrypt compare against
 * a non-guest row, and that is exactly what it passes on.
 *
 * `signInSchema` IS THE SAME OBJECT `authorize()` USES (I-25), and its refusal is
 * `GENERIC_AUTH_FAILURE` for every cause — wrong password, no such account, a guest address,
 * an over-length value. A form that distinguishes them is a membership oracle answerable in
 * bulk against a breach list.
 */
export async function signIn(input: SignInActionInput): Promise<ActionResult> {
  return guard("signIn", async () => {
    const parsed = signInSchema.safeParse(input);
    if (!parsed.success) return fail(GENERIC_AUTH_FAILURE);
    const { email, password } = parsed.data;

    // BEFORE `authSignIn`. See the docblock — this line cannot move.
    const viewer = await currentUser();
    const guestId = viewer?.isGuest ? viewer.id : null;

    try {
      await authSignIn("credentials", { email, password, redirect: false });
    } catch (error) {
      unstable_rethrow(error);
      // Auth.js signals every credentials refusal — bad password, unknown account, a guest
      // row, an exhausted budget — as one `AuthError`, which is precisely the single failure
      // channel this flow wants. `console.warn` inside `authorize()` is how an operator tells
      // a throttled attempt from a wrong password; the member is told neither.
      if (error instanceof AuthError) return fail(GENERIC_AUTH_FAILURE);
      throw error;
    }

    if (guestId !== null) {
      try {
        const summary = await mergeGuestByEmail(guestId, email);
        if (summary) console.info("[signIn] guest merged", { guest: guestId, ...summary });
      } catch (error) {
        /*
         * A FAILED MERGE MUST NOT FAIL THE SIGN-IN. They are already in — the cookie was
         * replaced two statements ago — so throwing here would report "Something went wrong"
         * for an operation that succeeded, and the member would try again from a session that
         * is no longer a guest, at which point nothing can be merged at all.
         *
         * The merge is one transaction (I-31), so a failure leaves the guest row and every
         * one of its logs exactly where they were: unreachable by that member, but present,
         * and recoverable by an operator from the id in this log line.
         */
        console.error("[signIn] guest merge failed", { guest: guestId, ...safeErrorDetail(error) });
      }
    }

    redirect((await safeNextPath(input.next)) ?? "/");
  });
}

/* ========================================================================== *
 * SIGN OUT, AND OPENING A GUEST SESSION
 * ========================================================================== */

/**
 * DELIBERATELY NOT WRAPPED IN `guard()`, and `"signOut"` is deliberately absent from
 * `VERIFICATION_EXEMPT` for the same reason (see the comment beside that set).
 *
 * It takes no input, has no effect anybody else can see, and consumes no resource worth
 * metering. A verification gate on sign-out would trap an unconfirmed member inside a session
 * they are trying to leave, and a rate limit on it would mean the answer to "get me out of
 * this account" is sometimes "not yet". IF THIS IS EVER GUARDED, `"signOut"` MUST BE ADDED TO
 * THE EXEMPT SET IN THE SAME COMMIT.
 *
 * `redirectTo: "/"` rather than the current page: half the pages in the application render
 * differently or not at all without a session, and landing on a 404 or an empty diary is a
 * confusing way to be told that sign-out worked.
 */
export async function signOutAction(): Promise<void> {
  await authSignOut({ redirectTo: "/" });
}

/**
 * Opens a guest session. THE LANDING CTA'S WHOLE IMPLEMENTATION.
 *
 * > Asking for an email before anybody has seen what the app does is how the funnel ends at
 * > the first screen.
 *
 * So "Start your diary" comes here rather than to /signup, and lands on /start with
 * twenty-four covers and a star control.
 *
 * IT DELEGATES TO THE `guest` CREDENTIALS PROVIDER AND SUPPLIES NOTHING. That provider's
 * `credentials: {}` is the point: there is nothing a caller can send to become a CHOSEN guest,
 * and certainly not a chosen member. This function is a thin door onto it, not an
 * alternative to it — an action that signed in an id handed to it would be an
 * unauthenticated "become user N" endpoint one refactor away from working on non-guests.
 *
 * UNGUARDED, LIKE `signOutAction`, and for a stronger reason: the budget that belongs to this
 * flow is `guestByIp`, and it is spent inside `createGuest` — where the row is actually
 * written — rather than in front of it. `ActionLabel` has no entry for it because it has no
 * `guard()` call.
 */
export async function startGuestSession(next?: unknown): Promise<void> {
  const destination = (await safeNextPath(next)) ?? "/start";

  try {
    await authSignIn("guest", { redirectTo: destination });
  } catch (error) {
    // THE SUCCESS PATH ARRIVES HERE TOO: `signIn` with a `redirectTo` signals itself by
    // throwing, so anything that is not an `AuthError` has to leave untouched. This is what
    // `unstable_rethrow` is for, and getting it wrong turns every successful guest session
    // into a generic failure.
    unstable_rethrow(error);
    if (error instanceof AuthError) {
      // A REFUSED GUEST AND A FAILED GUEST LOOK IDENTICAL, which is correct: the caller
      // supplied nothing, so there is nothing to explain to them. They land on the page that
      // offers the other door. The reason is in the provider's own log line.
      console.warn("[startGuestSession] no session opened");
      redirect("/signup");
    }
    throw error;
  }
}

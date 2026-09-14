import "server-only";

import { unstable_rethrow } from "next/navigation";

import {
  assertEmailVerified,
  ForbiddenError,
  GuestNotAllowedError,
  UnauthorizedError,
  UnverifiedEmailError,
  currentUser,
} from "@/lib/auth/session";
import { env } from "@/lib/env";
import { BUDGETS, clientAddress, consume, retryMessage } from "@/lib/security/rate-limit";

/**
 * The action contract. Every Server Action in the application returns an `ActionResult` and is
 * wrapped in `guard()`.
 *
 * THIS FILE IS NOT A `"use server"` MODULE. It exports a type, two constructors and a
 * higher-order function; a `"use server"` directive would require every export to be an async
 * function and would turn `ok` and `fail` into network round trips.
 */

/**
 * A conditional-mapped discriminated union.
 *
 * When `T` is the default, the success arm's `data` is optional and absent, so `return ok()`
 * type-checks. When `T` is concrete, `data` is REQUIRED, so an action declared
 * `ActionResult<{logId: number}>` cannot forget to return the id — the caller that renders the
 * new log would otherwise get `undefined` and no compiler complaint.
 */
export type ActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? { data?: undefined } : { data: T }))
  | { ok: false; error: string };

export function ok(): ActionResult;
export function ok<T>(data: T): ActionResult<T>;
export function ok<T>(data?: T): ActionResult<T> {
  return { ok: true, data } as ActionResult<T>;
}

/**
 * `ActionResult<never>` IS THE FAILURE ARM ALONE, and that is why the payload type is `never`.
 *
 * `T extends undefined` is a distributive conditional over a naked type parameter, and
 * distributing over `never` yields `never` — so the success arm vanishes and what is left is
 * exactly `{ ok: false; error: string }`. That type is assignable to every `ActionResult<T>`,
 * which lets a failure be returned from any typed action WITHOUT A CAST. Changing the payload
 * to `undefined` or `unknown` here would reintroduce the cast at forty call sites.
 */
export function fail(error: string): ActionResult<never> {
  return { ok: false, error };
}

/**
 * The message for anything that is not one of the four domain errors.
 *
 * Flat and identical for every cause: a non-admin who reached an admin action gets the same
 * refusal as a signed-out visitor and the same refusal as a unique-constraint violation. No
 * hint about what the action was, or that they were close to reaching it.
 */
export const GENERIC_FAILURE = "Something went wrong. Try again.";

/**
 * EVERY ACTION IN THE APPLICATION, AS A UNION OF LITERAL STRINGS.
 *
 * DEADWAX IMPROVEMENT over the original, where the label is free text. There, a typo in a
 * `guard()` call — `"unmarkAlbumListend"` — silently means "not exempt", because the exempt
 * check is a `Set<string>.has()` that simply returns false. The symptom is a member being told
 * to confirm their email by an action that should not be gated at all, and nothing in the code
 * points at the misspelling. Typing the union makes it a compile error at the call site.
 *
 * A new action therefore costs one line here. That is the intended friction: the list is also
 * the inventory a reviewer reads to ask "should this one be exempt?".
 */
export type ActionLabel =
  | "signUp"
  | "signIn"
  | "signOut"
  | "sendVerification"
  | "confirmVerification"
  | "requestPasswordReset"
  | "resetPassword"
  | "updateProfile"
  | "saveLog"
  | "toggleTrackListened"
  | "markAlbumListened"
  | "unmarkAlbumListened"
  | "markDiscographyListened"
  | "deleteLog"
  | "toggleDesertIsland"
  | "createList"
  | "updateList"
  | "deleteList"
  | "addToList"
  | "removeFromList"
  | "reorderList"
  | "cloneList"
  | "quickAddToList"
  | "toggleWantlist"
  | "setFavorite"
  | "clearFavorite"
  | "toggleFollow"
  | "toggleLike"
  | "addComment"
  | "deleteComment"
  | "setAccountPlan"
  | "deleteAccount"
  | "sendAccountPasswordReset"
  | "resyncAlbum"
  | "createAd"
  | "setAdStatus"
  | "setAdWeight"
  | "archiveAd";

/**
 * DEFAULT-DENY BY OMISSION. Anything absent from this set requires a confirmed email address
 * when `REQUIRE_EMAIL_VERIFICATION` is on, so a NEW action is gated by omission rather than by
 * somebody remembering to add a check. The inverse list — "actions that need verification" —
 * would fail silently in exactly the direction that matters.
 *
 * Three groups, and the group is the justification:
 */
export const VERIFICATION_EXEMPT: ReadonlySet<ActionLabel> = new Set<ActionLabel>([
  // 1. FLOWS THAT WOULD OTHERWISE BE UNREACHABLE. Gating these is a closed loop: you cannot
  //    confirm an address without being able to run the action that confirms it, and you
  //    certainly cannot reset a forgotten password from behind a gate that requires you to
  //    read mail you may have lost access to.
  "signUp",
  "signIn",
  "sendVerification",
  "confirmVerification",
  "requestPasswordReset",
  "resetPassword",

  // 2. SELF-SCOPED EDITS AND DELETIONS — nobody else can see the effects, so they should not
  //    be held hostage to slow mail. Somebody who cannot receive our confirmation must still
  //    be able to fix their own bio, delete their own entry, and untick something they ticked
  //    by accident. Note what is NOT here: `saveLog`, `addComment`, `createList` — anything
  //    that PUBLISHES. The gate is on publishing, which is the whole point of the flag.
  "updateProfile",
  "deleteLog",
  "deleteComment",
  "deleteList",
  "removeFromList",
  "unmarkAlbumListened",

  // 3. ADMIN AND ADS, already behind a stronger gate. `requireAdmin()` reads the role from the
  //    database on every call, and an admin's address is verified by the operator who granted
  //    the role; adding this check would only add a way for the panel to break.
  "setAccountPlan",
  "deleteAccount",
  "sendAccountPasswordReset",
  "resyncAlbum",
  "createAd",
  "setAdStatus",
  "setAdWeight",
  "archiveAd",
]);

// `signOut` is deliberately absent, and `signOutAction` is deliberately NOT wrapped in
// `guard()` — it takes no input, has no effect anybody else can see, and consumes no
// resource worth metering. IF IT IS EVER GUARDED IT MUST BE ADDED ABOVE: a verification gate
// on sign-out would trap an unconfirmed member inside a session they are trying to leave.

/**
 * `guard(label, body)` — three jobs, in this order.
 *
 * 1. RATE LIMIT. `writeByUser` 120/60s for a signed-in caller, else `writeByAnon` 30/60s
 *    keyed on the client address.
 *
 *    THE LIMIT LIVES HERE RATHER THAN IN EACH ACTION SO THAT A NEW ACTION CANNOT BE WRITTEN
 *    WITHOUT ONE. Per-endpoint limits are the kind of control that gets forgotten exactly
 *    once, and the forgotten one is the one that gets used. The price is that the budget is
 *    uniform across actions that are not equally expensive, which is accepted: the tight,
 *    subject-keyed limits live on the flows that need them (sign-in, sign-up, mail) and are
 *    consumed at their own boundaries.
 *
 *    It is consumed BEFORE `requireUser()` runs inside the body, so an unauthenticated flood
 *    is metered on the way in rather than after a database round trip.
 *
 * 2. THE EMAIL-VERIFICATION GATE. See `VERIFICATION_EXEMPT`.
 *
 * 3. ERROR CONVERSION. Exactly four classes get their own message; everything else is logged
 *    through `safeErrorDetail` and flattened.
 */
export async function guard<T>(label: ActionLabel, body: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    const user = await currentUser();

    /* ---- 1. rate limit ---------------------------------------------------------- */
    const identity = user ? String(user.id) : await clientAddress();
    const actor = user ? `user:${user.id}` : `ip:${identity}`;
    const limit = await consume(user ? BUDGETS.writeByUser : BUDGETS.writeByAnon, identity);
    if (!limit.ok) {
      console.warn("[action:rate-limited]", { label, actor });
      return fail(retryMessage(limit));
    }

    /* ---- 2. the verification gate ----------------------------------------------- */
    // ANONYMOUS CALLERS ARE SKIPPED, because an anonymous request should hear "sign in" —
    // which is what the action's own `requireUser()` says — and not "confirm your email",
    // which names an account the caller has not claimed to hold.
    //
    // `user.isGuest` here is the TOKEN's copy and decides only whether the query below is
    // worth spending. `assertEmailVerified` re-reads both `is_guest` and `email_verified_at`
    // from the row and decides the outcome (I-18).
    if (env.requireEmailVerification && user && !user.isGuest && !VERIFICATION_EXEMPT.has(label)) {
      await assertEmailVerified(user.id);
    }

    return await body();
  } catch (error) {
    /* ---- 3. error conversion ---------------------------------------------------- */
    // FIRST, because `redirect()` and `notFound()` signal themselves by throwing. An action
    // that redirects on success would otherwise have its redirect swallowed and reported to
    // the member as "Something went wrong" — while having already done the work.
    unstable_rethrow(error);

    // THE FOUR. A domain error class that is not in this list disappears into the generic
    // message below: the action refuses, the member is told nothing useful, and the log says
    // only that something threw. Add the class here at the same time as you write it.
    if (error instanceof UnauthorizedError) return fail(error.message);
    if (error instanceof UnverifiedEmailError) return fail(error.message);
    if (error instanceof GuestNotAllowedError) return fail(error.message);
    if (error instanceof ForbiddenError) return fail(error.message);

    console.error("[action:failed]", { label, ...safeErrorDetail(error) });
    return fail(GENERIC_FAILURE);
  }
}

/**
 * The ONLY four fields of an error that reach a log: `name`, `message`, `code`, `constraint`.
 * (I-35.)
 *
 * DO NOT ADD `stack`, `query`, `parameters` OR `detail`, and do not log the error object
 * itself. Driver errors carry the failing SQL and, depending on the driver, its bound
 * parameters — which for this application means review bodies, email addresses and PASSWORD
 * HASHES, because `findAccountByEmail` binds an address and the sign-up insert binds a hash.
 * Logs are not a safe place for any of that, and hosted logs are readable by anyone with
 * project access, including people who were never given database credentials.
 *
 * `code` and `constraint` are kept because they are the two fields that make a Postgres error
 * actionable — `23505` plus `users_username_lower_uq` tells an operator exactly which
 * uniqueness lost a race — and neither can contain member data.
 */
export function safeErrorDetail(error: unknown): {
  name?: string;
  message?: string;
  code?: string;
  constraint?: string;
} {
  if (!error || typeof error !== "object") {
    return { message: typeof error === "string" ? error : "unknown error" };
  }

  const candidate = error as { name?: unknown; message?: unknown; code?: unknown; constraint?: unknown };
  const detail: { name?: string; message?: string; code?: string; constraint?: string } = {};

  if (typeof candidate.name === "string") detail.name = candidate.name;
  if (typeof candidate.message === "string") detail.message = candidate.message;
  // Postgres error codes are strings ("23505"); some drivers surface numeric codes.
  if (typeof candidate.code === "string" || typeof candidate.code === "number") {
    detail.code = String(candidate.code);
  }
  if (typeof candidate.constraint === "string") detail.constraint = candidate.constraint;

  return detail;
}

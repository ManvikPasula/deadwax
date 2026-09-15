import "server-only";

import { compare } from "bcryptjs";
import { sql } from "drizzle-orm";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

// Phase 7 owns lib/auth/guest.ts; the contract it must satisfy is `GuestAccount` below. Until
// that file lands this is the one unresolved import in the auth layer, and it is deliberate:
// the alternative — a registration hook that guest.ts installs — cannot work, because the
// credentials callback runs in a route handler whose module graph would never load guest.ts.
import { createGuest } from "@/lib/auth/guest";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { BUDGETS, clientAddress, consume } from "@/lib/security/rate-limit";
import { signInSchema } from "@/lib/security/schemas";

/**
 * Auth.js v5. FOUR CONFIGURATION KEYS, NO ADAPTER, NO OAUTH — and therefore zero Auth.js
 * tables.
 *
 * The whole identity system is `users.password_hash` plus a signed cookie. No accounts table,
 * no sessions table, no verification-tokens table: the three tables an adapter would add exist
 * only to serve OAuth and database sessions, and this app has neither. `users` is the identity
 * store and the member profile at once, which is also what makes guest mode one boolean column
 * instead of a parallel identity model.
 *
 * FOURTEEN DAYS, NOT THIRTY. These are stateless JWTs with no server-side revocation list, so
 * the token's lifetime IS the exposure window for a stolen cookie — there is nothing to delete
 * when a member says "sign me out everywhere".
 *
 * **THE FOURTEEN DAYS ARE A HARD CAP. SESSIONS ARE NOT RE-ISSUED.** This block used to carry
 * an `updateAge: 1 day` and a paragraph explaining that daily re-issue meant "somebody who uses
 * the site is never logged out while a stolen token still ages out". That paragraph described
 * behaviour this application does not have, and the configuration achieving it was inert:
 *
 *   `updateAge` only takes effect if something writes the refreshed `Set-Cookie` back to the
 *   browser. In next-auth 5's RSC branch, `auth()` called with no arguments resolves the
 *   session and DISCARDS the `Set-Cookie` headers the session action produced — only the API
 *   Routes branch forwards them. `await auth()` from `currentUser()` is the only call site in
 *   this repository; `proxy.ts` deliberately never calls `auth()` (I-34), there is no
 *   `SessionProvider`, and nothing client-side fetches `/api/auth/session`. So no code path
 *   could re-issue the cookie, and the JWT's `exp` was fixed at sign-in + 14 days regardless.
 *
 * The inert setting is gone rather than made real, and the reason is the second-order effect:
 * making re-issue work means adding a `proxy.ts` that calls `auth()` — which contradicts I-34 —
 * and rolling sessions indefinitely would then make `GUEST_GRACE_DAYS` in
 * `lib/db/queries/prune.ts` start deleting the diary of a guest who visited yesterday, which is
 * the exact outcome that constant was written to prevent. A hard cap is the smaller, more
 * honest guarantee: fourteen days from sign-in, for everybody, always.
 *
 * The single revocation point is `requireUser()` in lib/auth/session.ts, which re-reads the
 * row on every mutation (I-17). Deleting the row stops writes on the next request; the cookie
 * keeps decoding until it expires, and reads tolerate that.
 */

/**
 * A REAL bcrypt hash at the real cost factor (12), not a placeholder string.
 *
 * INVARIANT I-23 / SEC-09. `authorize` ALWAYS runs exactly one `compare()`, against this when
 * the account does not exist. An early `return null` on the not-found path turns this endpoint
 * into an oracle for "does this person have an account here" — bcrypt at cost 12 takes
 * ~250 ms and a missing-row path takes ~2 ms, which is a difference you can measure over the
 * open internet. That question is answerable in bulk against a breach list, and it leaves no
 * failed-login trail on any account because no account was touched.
 *
 * It must be a hash `compare()` will actually work on: a fake string like "$2b$12$x" makes
 * bcryptjs bail out early on a malformed salt, which restores the timing difference the
 * constant exists to remove. The plaintext behind this hash is a discarded random string.
 */
const DUMMY_HASH = "$2b$12$/ffpupMJN.AK3hWA0JH0KelffEADXmA60QPUDO/BZVut7xFj0R8Vy";

/** 14 days. See the docblock — this number is an exposure window, not a convenience setting. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

/**
 * The account fields `authorize` needs, and nothing else.
 *
 * Note `passwordHash` leaves the database here and is compared in this module. It is never put
 * in a log, never returned to a caller, and never reaches the JWT — and `safeErrorDetail` in
 * app/actions/result.ts exists partly because a driver error from this very query would carry
 * it as a bound parameter.
 */
type Account = {
  id: number;
  username: string;
  avatarSeed: string | null;
  passwordHash: string;
  isGuest: boolean;
};

/**
 * What `createGuest(address)` must resolve to. Declared here so lib/auth/guest.ts can be
 * written against it (`satisfies (address: string) => Promise<GuestAccount>`) rather than
 * against this file's call site.
 *
 * `isGuest` is absent on purpose: the guest provider hard-codes `true`, because a factory that
 * could report `false` would be a way to mint a non-guest session with no password.
 */
export type GuestAccount = {
  id: number;
  username: string;
  avatarSeed: string | null;
};

/**
 * Resolved through Postgres' `lower()`, matching the functional unique index on
 * `lower(email)` — the index that makes case-insensitive uniqueness a database guarantee
 * rather than a read-then-write that can lose a race (I-26).
 *
 * BOTH SIDES USE POSTGRES' `lower()`, NOT JavaScript's `toLowerCase()`. They are not the same
 * function: JS folds `İ` to two code units and Postgres folds it under the database
 * collation, so an address stored through one and looked up through the other can miss. Since
 * the index is built on `lower(email)`, the query has to speak the index's dialect or it also
 * gives up the index scan.
 *
 * Deliberately local rather than imported from `lib/db/queries/users.ts`: this is the one
 * lookup whose failure mode is "nobody can sign in", and it is only ever one indexed select.
 */
async function findAccountByEmail(email: string): Promise<Account | null> {
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      avatarSeed: users.avatarSeed,
      passwordHash: users.passwordHash,
      isGuest: users.isGuest,
    })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The bucket key for `loginByAccount`, taken from the RAW credentials before validation.
 *
 * It has to be read before `signInSchema` runs, because the budget is spent whether or not the
 * payload is well-formed — otherwise a flood of malformed payloads is free. Truncated at 255
 * (the column width for an address) so a caller cannot make `rate_limits.key` a megabyte:
 * that table is keyed by `bucket:identity` and grows by distinct pairs, so an unbounded
 * identity is an unbounded row.
 *
 * An absent or non-string field collapses to `"malformed"`, which shares one 5-per-15-minutes
 * bucket across every such attempt. That is intentional — none of them can succeed, so
 * throttling them together costs nothing a real member will notice.
 */
function accountBucketKey(raw: Partial<Record<string, unknown>>): string {
  const value = raw.email;
  if (typeof value !== "string") return "malformed";
  const trimmed = value.trim().toLowerCase().slice(0, 255);
  return trimmed || "malformed";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: {
    strategy: "jwt",
    maxAge: SESSION_MAX_AGE_SECONDS,
    // NO `updateAge`. See the module docblock: it cannot work through the RSC `auth()` branch,
    // so it was configuration describing a behaviour that did not exist.

  },
  pages: { signIn: "/login" },
  /**
   * The host comes from the forwarded headers. Safe here for the same reason
   * `clientAddress()` is: the platform terminates every request and overwrites them. Off a
   * platform that does, this and every per-IP budget in the app change together (I-34).
   */
  trustHost: true,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      /**
       * DEADWAX FIXES A KNOWN DEFECT HERE (brief defect #6).
       *
       * In the original both sign-in budgets are consumed by the Server Action, so a direct
       * POST to `/api/auth/callback/credentials` — which is a public endpoint, documented, and
       * reachable with curl — skips the action entirely and reaches bcrypt at cost 12 with no
       * budget spent. That makes the most expensive operation in the application the cheapest
       * one to trigger.
       *
       * Both budgets are therefore consumed HERE, before the compare, and a refusal returns
       * null. Two consequences a caller must know:
       *
       *   1. THE SIGN-IN SERVER ACTION MUST NOT CONSUME THESE BUDGETS AGAIN. Counting a form
       *      submission twice would halve every limit — `loginByAccount` at 5 per 15 minutes
       *      becomes two and a half attempts — and lock out members who simply mistyped.
       *   2. A throttled attempt is indistinguishable from a wrong password to the caller,
       *      because this provider has exactly one failure channel. That is the same
       *      `GENERIC_AUTH_FAILURE` the form shows for everything else, so nothing leaks; the
       *      cost is that the member is not told to wait. The `console.warn` below is how an
       *      operator tells the two apart.
       */
      authorize: async (raw) => {
        const address = await clientAddress();
        const byIp = await consume(BUDGETS.loginByIp, address);
        const byAccount = await consume(BUDGETS.loginByAccount, accountBucketKey(raw));
        if (!byIp.ok || !byAccount.ok) {
          console.warn("[auth:rate-limited]", {
            bucket: byAccount.ok ? BUDGETS.loginByIp.bucket : BUDGETS.loginByAccount.bucket,
          });
          return null;
        }

        // THE SAME SCHEMA OBJECT THE SERVER ACTION USES (I-25). Two copies of the password
        // rule created accounts that could not then be signed into, because the stricter copy
        // ran at registration and the laxer one at sign-in — or the other way around, which is
        // worse. `signInSchema.password` is min(1) by design: a member whose password predates
        // the current rule must still be able to get in.
        const parsed = signInSchema.safeParse(raw);
        if (!parsed.success) return null;

        const account = await findAccountByEmail(parsed.data.email);

        // ONE COMPARE, ALWAYS. See DUMMY_HASH.
        const hash = account?.passwordHash ?? DUMMY_HASH;
        const valid = await compare(parsed.data.password, hash);
        if (!account || !valid) return null;

        // A guest has a hash of discarded random bytes, so the compare above already cannot
        // succeed for one. This is the second defence, and the readable one: it says what the
        // rule is instead of relying on a property of how guest rows are created.
        if (account.isGuest) return null;

        // DELIBERATELY NO `emailVerifiedAt` CHECK. The verification gate is on PUBLISHING, not
        // on authentication — see VERIFICATION_EXEMPT in app/actions/result.ts. Refusing
        // sign-in would mean an unconfirmed member cannot reach the page that asks them to
        // confirm, which is the loop the flag was introduced to avoid.
        return {
          id: String(account.id),
          username: account.username,
          avatarSeed: account.avatarSeed,
          isGuest: false,
        };
      },
    }),

    /**
     * GUEST MODE IS A CREDENTIALS PROVIDER WITH AN EMPTY `credentials` OBJECT, NOT A SERVER
     * ACTION, and the empty object is the point: THERE IS NOTHING A CALLER CAN SUPPLY. No id,
     * no username, no "resume this guest" handle. An action that signed in an id handed to it
     * would be an unauthenticated "become user N" endpoint one refactor away from working on
     * non-guests; a provider with no inputs cannot become one.
     *
     * `createGuest` owns the row: the per-IP budget, the discarded random password hash, the
     * `guest_<hex>@guest.invalid` identity on an RFC 2606 reserved TLD, and the retry loop
     * against the case-insensitive unique indexes. See lib/auth/guest.ts.
     */
    Credentials({
      id: "guest",
      credentials: {},
      authorize: async () => {
        try {
          const guest = await createGuest(await clientAddress());
          return {
            id: String(guest.id),
            username: guest.username,
            avatarSeed: guest.avatarSeed,
            isGuest: true,
          };
        } catch (error) {
          // A refused guest and a failed guest look identical to the caller, which is correct:
          // the landing CTA simply does not open a session, and the page it lands on offers
          // sign-up instead. Only the name is logged — see `safeErrorDetail` for why a raw
          // driver error is not.
          console.warn("[auth:guest-refused]", { error: error instanceof Error ? error.name : "unknown" });
          return null;
        }
      },
    }),
  ],
  callbacks: {
    /**
     * `user` is present only on the request that signs in; every later request re-decodes the
     * token, so the copy made here is what the session serves for up to 14 days. That is
     * exactly why the list is four presentation fields and no authorization fields.
     */
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.username = user.username;
        token.avatarSeed = user.avatarSeed;
        token.isGuest = user.isGuest;
      }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id ?? "";
      session.user.username = token.username ?? "";
      session.user.avatarSeed = token.avatarSeed ?? null;
      // Presentation only. Anything that enforces the distinction reads the column. (I-18)
      session.user.isGuest = token.isGuest === true;
      return session;
    },
  },
});

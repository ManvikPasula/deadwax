/**
 * What the session token carries, at the type level.
 *
 * FOUR FIELDS, AND THE LIST IS A SECURITY BOUNDARY. `id`, `username`, `avatarSeed`, `isGuest`
 * — enough to render a header without a query. Deliberately absent: `role`, `plan`,
 * `emailVerifiedAt`. Those decide what a request is allowed to do, and these are stateless
 * JWTs with no server-side revocation list, so a copy in the token would stay true until the
 * token expires (up to 14 days). Revocation has to take effect on the NEXT request, which
 * means the column (I-18). If you add `role` here for speed, you have broken the single stated
 * authorization invariant.
 *
 * `isGuest` is in the token and is PRESENTATION ONLY — it decides whether the guest strip
 * renders. Anything that enforces the distinction re-reads `users.is_guest`.
 *
 * The augmented `User` fields are REQUIRED rather than optional so that an `authorize()` that
 * forgets one is a compile error. `JWT`'s are optional because a token minted before a field
 * existed is a real thing that arrives at `callbacks.jwt` after a deploy.
 */

import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  /** The object `authorize()` returns. */
  interface User {
    username: string;
    /** Nullable in the column: an account can exist before an avatar is generated. */
    avatarSeed: string | null;
    isGuest: boolean;
  }

  interface Session {
    user: {
      /** A STRING here and a number everywhere else. `SessionUser.id` is the parsed form. */
      id: string;
      username: string;
      avatarSeed: string | null;
      isGuest: boolean;
    } & DefaultSession["user"];
  }
}

/**
 * `@auth/core/jwt`, NOT `next-auth/jwt`, AND THE DIFFERENCE IS NOT COSMETIC.
 *
 * `next-auth/jwt` is a star re-export (`export * from "@auth/core/jwt"`), so a declaration
 * merge aimed at it creates a SECOND, UNRELATED `JWT` interface rather than extending the one
 * the callbacks are typed against. The symptom is quiet: `token.id` stays `unknown` (it
 * inherits `Record<string, unknown>`), so every read of it needs a cast and every write of a
 * misspelled field compiles. `Session` and `User` above are named re-exports, which do merge —
 * hence the two different module specifiers in one file.
 */
declare module "@auth/core/jwt" {
  interface JWT {
    id?: string;
    username?: string;
    avatarSeed?: string | null;
    isGuest?: boolean;
  }
}

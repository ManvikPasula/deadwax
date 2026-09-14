/**
 * Reserved usernames. PURE and client-safe — the sign-up form imports this to refuse a name
 * before it costs a round trip, and `lib/security/schemas.ts` imports it for the real rule.
 *
 * WHY A LIST AT ALL. Profiles live at `/@name`, so a username is also a URL segment. It is
 * additionally a `revalidatePath` argument and, in the original, was interpolated into cache
 * tags. A member called `admin` is not a security hole on its own — `/@admin` and `/admin` are
 * different routes — but it is an impersonation surface, and every name here is either a route
 * segment that exists, one that plausibly will, or a word that reads as staff.
 *
 * THIS LIST IS REGENERATED FROM DEADWAX'S ROUTE TREE, NOT COPIED FROM THE TELEVISION
 * ORIGINAL. The original reserves `show`, `shows` and `cliffhanger`, which are meaningless
 * here, and does not reserve `album`, `artist`, `track` or `label`, which are the segments
 * this app actually has. A stale reserved list is worse than none: it reads as though somebody
 * checked.
 *
 * Names are compared LOWER-CASED, because `users.username` sits behind a functional unique
 * index on `lower(username)` — so `Admin` and `admin` are the same name to the database and
 * must be the same name here.
 */

/**
 * Thirty-three names. Grouped by why they are here rather than alphabetically, because the
 * reason is the thing a future maintainer needs when deciding whether to add a thirty-fourth.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  // Operator and staff impersonation.
  "admin",
  "administrator",
  "moderator",
  "root",
  "staff",
  "support",
  "system",
  "deadwax",

  // Top-level route segments that exist today (see ARCHITECTURE.md §12).
  "album",
  "albums",
  "artist",
  "artists",
  "list",
  "lists",
  "log",
  "login",
  "logout",
  "members",
  "search",
  "settings",
  "signup",
  "spotlight",
  "start",
  "track",
  "tracks",

  // Route segments the domain makes likely: a label page is the third recommender axis.
  "label",
  "labels",
  "me",

  // Infrastructure prefixes. `api` is a real route; the rest are conventional and reserving
  // them costs nothing while un-reserving one later costs a migration.
  "api",
  "dev",
  "debug",
  "internal",
  "test",
]);

/**
 * The comparison form for a username: trimmed and lower-cased.
 *
 * Used for the reserved check and for the `guest_` prefix check. It is NOT what gets stored —
 * `users.username` is case-preserving so a member can be `DeadWax_Dan` on their own profile —
 * and it is not a substitute for the database's `lower(username)` unique index (I-26): a
 * read-then-write can lose the race, a unique index cannot.
 */
export function normaliseUsername(name: string): string {
  return name.trim().toLowerCase();
}

/** True if this name is reserved. Case- and whitespace-insensitive. */
export function isReserved(name: string): boolean {
  return RESERVED_USERNAMES.has(normaliseUsername(name));
}

/**
 * The guest identity prefix, in one place.
 *
 * `lib/auth/guest.ts` mints `guest_<10 hex>`; `usernameSchema` refuses any name starting with
 * it. Without the ban a member could register `guest_ab12cd34` and be taken for a guest — or,
 * worse, a guest could be taken for them by any surface that decides "is this a guest" by
 * looking at the name instead of at `users.is_guest`.
 */
export const GUEST_USERNAME_PREFIX = "guest_";

export function hasGuestPrefix(name: string): boolean {
  return normaliseUsername(name).startsWith(GUEST_USERNAME_PREFIX);
}

import "server-only";

import { randomBytes } from "node:crypto";

import { hash } from "bcryptjs";
import { eq, sql } from "drizzle-orm";

import type { GuestAccount } from "@/lib/auth";
import { db } from "@/lib/db";
import { logs, users } from "@/lib/db/schema";
import { BUDGETS, consume } from "@/lib/security/rate-limit";
import { GUEST_USERNAME_PREFIX } from "@/lib/username";

/**
 * Guest mode. ONE BOOLEAN COLUMN, and this file is everything that puts a row behind it.
 *
 * > A real row rather than browser storage, so the diary, the heatmaps, the taste model and
 * > every other read work unchanged — a guest is just a member whose credentials do not exist
 * > yet. The cost of that choice is that guests must be kept out of every public surface.
 *
 * The rejected alternative was browser storage plus a "sync on sign-up" step. It costs a
 * second implementation of every write (one against the database, one against a browser
 * object), a migration path between them, and a class of bug where the two disagree — and it
 * makes "keep your logs" a promise rather than a fact, because the logs are not anywhere yet.
 * The price of the row is that `is_guest = false` has to appear in every public aggregate
 * (I-12), which is a filter a test can check; the price of browser storage is a parallel
 * product.
 *
 * WHAT A GUEST CAN DO: rate and log at all three tiers with diary dates, replay flags and
 * tags (UNCAPPED, deliberately), wantlist, lists CRUD, pin favourites, crown Desert Island
 * tracks, write up to `GUEST_REVIEW_CAP` reviews, and have a working profile, diary, heatmaps,
 * listening stats and taste model.
 *
 * WHAT A GUEST CANNOT DO: follow, like another member's post, reply to a review (the three
 * `requireMember` sites), write one more review than the cap, sign in with a password, reset a
 * password, be asked to confirm an address, or appear on any public surface. Each restriction
 * is chosen to BE the reason to sign up — the blocked actions are exactly the ones that
 * involve other people.
 *
 * GUEST LIFETIME IS TWO INDEPENDENT THINGS, AND NEITHER IS A ROW TTL. The session is the
 * ordinary 14-day JWT; lose the cookie and there is no way back into the row, because the
 * credentials provider refuses `is_guest` rows by design. The row itself lives until a merge
 * consumes it. Nothing here expires one, and the UI copy is deliberately more pessimistic
 * than that ("close this tab and it is gone") — a member who believes their work is fragile
 * signs up, and the truthful version of the sentence is the one nobody acts on.
 */

/**
 * bcrypt cost 12, EVERYWHERE: this throwaway hash, sign-up, password reset, and the dummy
 * hash in lib/auth/index.ts.
 *
 * Declared once rather than repeated at each call site because a cost factor that differs
 * between two write paths is invisible until somebody measures it — a cheaper registration
 * hash is a weaker password store with no symptom at all. lib/security/ would be the better
 * home and is frozen; this is the first module in build order that actually hashes something,
 * so it is the one that owns the number, and every other caller imports it.
 */
export const BCRYPT_COST = 12;

/**
 * THREE.
 *
 * > Enough to find out what writing one here feels like — which is the only thing that makes
 * > an account worth having — and few enough that the wall arrives while they still care
 * > about the fourth.
 *
 * RATINGS AND DIARY ENTRIES ARE NOT CAPPED. Those are the habit, and interrupting the habit
 * teaches somebody to leave. The cap is on the one thing that has an audience.
 *
 * NOT REACHABLE FROM A CLIENT COMPONENT: this module is `server-only`, so a control that
 * renders the cap receives it as a prop from the server rather than importing it.
 */
export const GUEST_REVIEW_CAP = 3;

/**
 * TWELVE DISTINCT ALBUMS — NOT twelve log rows, and the unit is the whole correction.
 *
 * The television original counts rows. Here one 40-minute record played once through is
 * eleven track rows, so a row count fires the nudge at somebody who has engaged with a single
 * album — which is precisely the "nagging somebody who has not yet got anything worth
 * keeping" that the threshold was raised to avoid. `guestActivity().distinctAlbums` is the
 * number to compare against this one; `logCount` is not.
 *
 * Twelve is deliberately high: roughly a session of onboarding, at which point the offer is
 * about something real they would be annoyed to lose.
 *
 * THE LEAVING WARNING IS A SEPARATE THRESHOLD AND FIRES FROM THE FIRST ENTRY
 * (`logCount > 0`). The two are separated because the costs are not symmetric: a premature
 * banner is noise, and a missed leaving warning is permanent data loss.
 */
export const GUEST_NUDGE_AFTER = 12;

/**
 * FIVE ATTEMPTS against the case-insensitive unique indexes.
 *
 * Not tuned to a measured collision rate — 40 bits of identity means a platform holding a
 * million guest rows collides on roughly one insert in a million. It exists because the
 * alternative, on a public unauthenticated row-creating path, is an unhandled 23505: the
 * identity is "handled by retrying on the unique index rather than by hoping". Five rather
 * than two because the retries are free in the case that matters (nobody is waiting on the
 * fifth) and the count is what makes the throw below honest.
 */
const GUEST_INSERT_ATTEMPTS = 5;

/**
 * 5 bytes -> 10 hex characters -> `guest_ab12cd34ef` (16 characters, inside `varchar(32)`).
 *
 * lib/username.ts owns the prefix and `usernameSchema` refuses any member name that starts
 * with it, so the two halves of "a guest cannot be impersonated by name" cannot drift apart.
 */
const GUEST_ID_BYTES = 5;

/**
 * `.invalid` IS AN RFC 2606 RESERVED TLD THAT CAN NEVER BE DELIVERED TO.
 *
 * `users.email` is NOT NULL and a guest genuinely has no address, so the column needs a value
 * that is well-formed, unique per row, and provably undeliverable. A plausible domain would
 * eventually receive real mail from a future flow that forgot to check `is_guest`; an empty
 * string would collide on the second guest.
 */
const GUEST_EMAIL_DOMAIN = "guest.invalid";

/**
 * The two refusals, as distinct classes for ONE reason: the guest provider in
 * lib/auth/index.ts logs `error.name` and nothing else, so the class name is the entire
 * operational diagnostic. "We are throttling a shared address" and "the CSPRNG lost five coin
 * flips" are wildly different events and must not share a log line.
 *
 * DELIBERATELY NOT among the four classes `guard()` converts (app/actions/result.ts). Neither
 * can reach an action: guest creation happens inside a Credentials provider that catches
 * everything and returns null, because a refused guest and a failed guest must look identical
 * to a caller who supplied nothing.
 */
export class GuestRateLimitedError extends Error {
  constructor() {
    super("Too many guest sessions from this address.");
    // Minification renames classes, and `name` is what gets logged.
    this.name = "GuestRateLimitedError";
  }
}

export class GuestIdentityCollisionError extends Error {
  constructor() {
    super(`Could not mint a unique guest identity in ${GUEST_INSERT_ATTEMPTS} attempts.`);
    this.name = "GuestIdentityCollisionError";
  }
}

/**
 * Creates the row behind a guest session. Four steps, in this order.
 *
 * THE RETURN TYPE IS THE CONTRACT lib/auth/index.ts DECLARES (`GuestAccount`), imported as a
 * type so the two files agree at compile time instead of by comment. It is a type-only import
 * of a module that imports this one; `import type` is erased, so there is no runtime cycle.
 * `isGuest` is absent from that type on purpose — the provider hard-codes `true`, because a
 * factory that could report `false` would be a way to mint a credential-less member session.
 */
export async function createGuest(ipAddress: string): Promise<GuestAccount> {
  /*
   * 1. THE BUDGET, FIRST, because everything below it writes a row. 20 per hour per address,
   *    "set generously enough for a shared address (an office, a campus, a phone network) to
   *    keep working" — a campus NAT is one address to us and a thousand people to itself, and
   *    the failure mode of a tight limit here is that the product does not open at all for a
   *    whole institution. The limiter fails open (I-33), which is the right trade for a
   *    control whose worst case is unwanted rows rather than unwanted access.
   */
  const limit = await consume(BUDGETS.guestByIp, ipAddress);
  if (!limit.ok) throw new GuestRateLimitedError();

  /*
   * 2. A REAL BCRYPT HASH OF 32 RANDOM BYTES, AND THE PLAINTEXT IS DISCARDED ON THIS LINE.
   *
   *    Not an empty string and not a fixed sentinel: either would let ONE leaked value
   *    authenticate as EVERY guest at once if a login path ever stopped checking `is_guest`.
   *    This way the credentials provider's `compare()` cannot succeed for a guest even with
   *    every other defence removed, because nothing anywhere knows the input.
   *
   *    Hashed ONCE, outside the retry loop: it is ~250 ms of deliberate work, it is not a
   *    function of the identity, and a username collision is not a reason to redo it.
   */
  const passwordHash = await hash(randomBytes(32).toString("hex"), BCRYPT_COST);

  for (let attempt = 0; attempt < GUEST_INSERT_ATTEMPTS; attempt += 1) {
    /*
     * 3. THE IDENTITY. `randomBytes`, not a counter and not a timestamp: a sequential guest
     *    name would let anybody read the platform's signup rate off a profile URL, and a
     *    timestamp would do the same with more precision.
     */
    const handle = `${GUEST_USERNAME_PREFIX}${randomBytes(GUEST_ID_BYTES).toString("hex")}`;

    /*
     * 4. INSERT, AND LET THE UNIQUE INDEX ARBITRATE (I-26). No pre-flight SELECT: a
     *    read-then-write loses that race by construction and the functional indexes on
     *    `lower(username)` and `lower(email)` cannot. `onConflictDoNothing()` carries NO
     *    target because either of those two indexes could refuse this row and both mean the
     *    same thing here — try another name.
     *
     *    NO `display_name` AND NO `avatar_seed`:
     *      - a shared display name is what turned I-13's missing brackets into a
     *        platform-wide leak, because every guest was findable by searching the literal
     *        string "Guest User". The username is already an honest label and it reads as
     *        provisional, which is the thing a guest should see.
     *      - guests never reach `avatarGradient()`; the short-circuit lives in
     *        components/ui/avatar.tsx because a generated avatar is an identity and a guest
     *        does not have one yet. A seed here would be dead data, and the claim writes a
     *        real one at the moment the identity becomes real.
     *
     *    NOTHING sets `email_verified_at` either: a guest address is on a reserved TLD, so it
     *    can never be confirmed, and `assertEmailVerified` returns early for guests rather
     *    than asking them to read mail nobody can send — that instruction shipped in the
     *    original.
     */
    const [row] = await db
      .insert(users)
      .values({
        username: handle,
        email: `${handle}@${GUEST_EMAIL_DOMAIN}`,
        passwordHash,
        isGuest: true,
      })
      .onConflictDoNothing()
      .returning({ id: users.id, username: users.username, avatarSeed: users.avatarSeed });

    if (row) return row;
  }

  throw new GuestIdentityCollisionError();
}

/**
 * What the guest strip and the guest banner need, IN ONE ROUND TRIP.
 *
 * Three numbers because three different decisions read them, and they are not
 * interchangeable:
 *
 *   `logCount`       arms the LEAVING WARNING, from the first entry.
 *   `distinctAlbums` is the number compared against `GUEST_NUDGE_AFTER` (see that constant).
 *   `reviewCount`    renders "1 of 3 reviews written" beside the cap.
 *
 * One statement rather than three, for the same reason `getFollowCounts` is one: they are
 * always rendered together, on a strip that appears on every page a guest loads.
 *
 * `count(distinct album_id)` IGNORES NULLS, so an artist-level log contributes nothing to
 * `distinctAlbums`. That is correct rather than incidental — the unit is "records engaged
 * with", and an opinion about an artist is not a record. `logCount` still counts it, because
 * the leaving warning is about work and an artist verdict is work.
 *
 * `albums.is_canonical` is deliberately NOT joined in. This is not a completion denominator,
 * a discography row or a recommendation pool; a guest whose session was live albums and
 * compilations has still built something they would be annoyed to lose.
 */
export type GuestActivity = {
  logCount: number;
  distinctAlbums: number;
  reviewCount: number;
};

export async function guestActivity(userId: number): Promise<GuestActivity> {
  const [row] = await db
    .select({
      logCount: sql<number>`count(*)::int`,
      distinctAlbums: sql<number>`count(distinct ${logs.albumId})::int`,
      reviewCount: sql<number>`count(*) filter (where ${logs.review} is not null)::int`,
    })
    .from(logs)
    .where(eq(logs.userId, userId));

  // An aggregate with no GROUP BY always returns exactly one row. The fallback is here so no
  // caller can be handed `undefined` by a future edit that adds a grouping.
  return row ?? { logCount: 0, distinctAlbums: 0, reviewCount: 0 };
}

/**
 * `countReviewsBy` AND ITS `ReviewTarget` USED TO LIVE HERE, AND HAVE BEEN DELETED. Import
 * them from `@/lib/db/queries/logs` (`countReviewsBy`, `LogTarget`).
 *
 * This module briefly carried a second implementation of the same rule, which is the exact
 * defect class this codebase is organised to avoid — "two of the defects found in audit came
 * from copies drifting apart". They had already drifted, and the copy here was the wrong one.
 *
 * THE CORRECTION IS WORTH RECORDING, because the reasoning error is easy to repeat. This
 * version excluded the edited target with a bare `not(and(...))`, under a comment asserting
 * that was safe "because every operand is `IS NULL` or `= <literal>`, neither of which can
 * evaluate to NULL".
 *
 * That is wrong, and it reasons about the SHAPE OF THE EXPRESSION rather than the NULLABILITY
 * OF THE COLUMN. `logs.album_id` is nullable, so `album_id = 5` is NULL — not false — on every
 * artist-level row. `AND` propagates the NULL, `NOT NULL` is NULL, and `WHERE NULL` drops the
 * row. The effect: when a member edited an album-level review, every artist-level review they
 * held silently stopped counting, so A GUEST AT THE THREE-REVIEW CAP WOULD BE HANDED ROOM THEY
 * DID NOT HAVE.
 *
 * The surviving implementation wraps the match in `not coalesce(..., false)`, which collapses
 * the third value before the negation and is why it is the one that stays. `tests/guest.test.ts`
 * pins the behaviour against a real database rather than against the argument.
 */


/**
 * The cap as a decision rather than as a comparison, so the log dialog's rendering and
 * `saveLog`'s enforcement cannot disagree about what "at the cap" means.
 *
 * PURE, and it takes the count rather than fetching it, because the caller that enforces this
 * is inside `saveLog`'s transaction and must not spend a second round trip there.
 */
export function guestReviewCapReached(reviewsExcludingThisOne: number): boolean {
  return reviewsExcludingThisOne >= GUEST_REVIEW_CAP;
}

/**
 * The refusal copy, in one place, because it is an OFFER and not an error.
 *
 * It names the number, states what is kept, and does not apologise. The shorter version
 * ("Review limit reached") reads as a quota notice, which is the one thing a guest has no
 * reason to accept.
 */
export const GUEST_REVIEW_CAP_MESSAGE =
  `Guests can write ${GUEST_REVIEW_CAP} reviews. Create an account to keep writing — ` +
  `your reviews, ratings and diary come with you.`;

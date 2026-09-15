import "server-only";

import { randomBytes } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { desertIsland, favorites, lists, logs, users, wantlist } from "@/lib/db/schema";
/**
 * THE QUOTA IS IMPORTED, NOT REPEATED (see the desert-island step in `mergeGuestInto`).
 *
 * lib/desert-island/ is the quota rule engine and owns this number; a second literal `10`
 * here would be exactly the kind of copy this codebase has already paid for twice — a merge
 * that filled eleven slots while the crown action refused the eleventh would present as "the
 * button is broken" on a shelf that is genuinely over quota. This is a deliberate forward
 * reference in the same spirit as lib/auth/index.ts importing this phase's guest module.
 */
import { DESERT_ISLAND_QUOTA } from "@/lib/desert-island";

/**
 * THE TWO CONVERSION PATHS.
 *
 * > A guest is either a new person or somebody who already has an account elsewhere, and
 * > those need different doors.
 *
 * Path A (`claimGuestAccount`) is sign-UP: the guest row BECOMES the member row, in place.
 * Path B (`mergeGuestInto`) is sign-IN: the guest's work moves onto an account that already
 * exists, and the guest row is deleted.
 *
 * Everything in this file is written against the possibility that two tabs are doing it at
 * once, because that is the normal case rather than the exotic one: the conversion prompt
 * appears on every page a guest loads, so the guest who converts is very often the guest with
 * four tabs open.
 */

/**
 * A fresh `users.avatar_seed`.
 *
 * 6 bytes -> 12 hex characters, which satisfies `avatarSeedSchema` (`[a-zA-Z0-9_-]`, 1..32) —
 * that matters because the seed is interpolated into a CSS gradient, so it gets the same
 * allowlist treatment as a username rather than being trusted as opaque text.
 *
 * RANDOM RATHER THAN DERIVED FROM THE USERNAME, which is the interesting half. The gradient
 * space is only 2,880 combinations (eight palettes x 360 angles), so 48 bits is absurd as
 * *art* — but the seed is a KEY, and the reason it exists as a column at all is that a member
 * can reroll their gradient without renaming their account. Deriving it from the name would
 * make a reroll impossible, and usernames here are permanent, so the "rename changes the art"
 * case the fallback protects cannot happen.
 */
export function newAvatarSeed(): string {
  return randomBytes(6).toString("hex");
}

/**
 * PATH A — SIGN-UP CLAIMS THE ROW IN PLACE.
 *
 * `displayName` is the caller's choice and defaults to the username at the call site (see
 * app/actions/auth.ts); `passwordHash` arrives already hashed, because this module must never
 * hold a plaintext password it could then log.
 */
export type ClaimInput = {
  guestId: number;
  username: string;
  email: string;
  passwordHash: string;
  displayName: string | null;
  avatarSeed: string;
};

/**
 * Claims a guest row for a new account. Returns TRUE if this call is the one that won.
 *
 * THE `is_guest = true` PREDICATE IS INSIDE THE UPDATE, NOT IN A SELECT BEFORE IT (I-30), so
 * two concurrent claims cannot both believe they won: the second one matches zero rows and is
 * told so, instead of overwriting the first one's credentials with its own.
 *
 * SAME `users.id`, SO NOTHING MOVES AND NOTHING CAN HALF-FAIL. Every log, tag, wantlist row,
 * list, list item, pinned favourite and Desert Island crown already points at this id, so
 * there is no data migration to get wrong, no transaction to leave half-applied, and no
 * window in which some of the member's work belongs to a row nobody can sign into. THIS IS
 * WHAT MAKES "KEEP YOUR LOGS" A FACT RATHER THAN A PROMISE, and it is the reason sign-up
 * claims rather than copies.
 *
 * `false` MEANS "THIS WAS NOT A CLAIMABLE GUEST", AND NOTHING ELSE. A unique-index violation
 * (the username or the address is taken) THROWS and must not be converted into `false` here:
 * the caller's fallback for `false` is to create a fresh row, so swallowing a 23505 would turn
 * "that username is taken" into a second insert that fails again for a reason nobody logged.
 *
 * `email_verified_at` is deliberately left alone — it is NULL on a guest row and stays NULL,
 * because claiming proves nothing about the address that was just typed in. The verification
 * flow is what proves that, and a reset redemption is the other thing that proves it.
 */
export async function claimGuestAccount(input: ClaimInput): Promise<boolean> {
  const [row] = await db
    .update(users)
    .set({
      username: input.username,
      email: input.email,
      passwordHash: input.passwordHash,
      displayName: input.displayName,
      avatarSeed: input.avatarSeed,
      isGuest: false,
    })
    .where(and(eq(users.id, input.guestId), eq(users.isGuest, true)))
    .returning({ id: users.id });

  return Boolean(row);
}

/**
 * What a merge moved. Reported rather than discarded because the numbers are the only way an
 * operator can tell "the merge did nothing because the guest was empty" from "the merge did
 * nothing because it refused", and because the sign-in action logs them.
 *
 * `favoritesDiscarded` is a count of rows DELETED, not moved — see the table below.
 */
export type MergeSummary = {
  logs: number;
  wantlist: number;
  lists: number;
  desertIsland: number;
  favoritesDiscarded: number;
};

/**
 * Thrown only when the guest row stops being a guest row between the check and the delete at
 * the end of the transaction — i.e. when a concurrent Path A claimed it mid-merge. Rolls the
 * whole merge back.
 *
 * A named class because the sign-in action logs `name` and nothing else, and this is the one
 * merge failure that is a RACE rather than a bug: seeing it in a log means two conversions
 * ran at once, which is information, whereas a driver error means something is wrong.
 */
export class GuestMergeConflictError extends Error {
  constructor() {
    super("The guest account was claimed while its data was being merged.");
    // Minification renames classes; `name` is what reaches the log.
    this.name = "GuestMergeConflictError";
  }
}

/**
 * PATH B — SIGN-IN MERGES THE GUEST ONTO AN EXISTING ACCOUNT. ONE TRANSACTION (I-31).
 *
 * > A half-merged guest would leave logs stranded under a row nobody can sign into, which is
 * > indistinguishable from losing them.
 *
 * That is the whole argument for the transaction, and it is stronger than it looks: the guest
 * row is DELETED at the end, and the FKs are `ON DELETE CASCADE`, so a merge that fails
 * halfway through without rolling back does not leave the data behind — it destroys whatever
 * had not moved yet. There is no repair path, because there is nothing left to repair from.
 *
 * I-36 — EVERY TABLE A GUEST CAN WRITE APPEARS BELOW, OR IS LISTED AS DELIBERATELY DISCARDED.
 * The original forgot `absolute_cinema` (this build's `desert_island`): it is neither merged
 * nor listed, so a guest's crowns were silently cascade-deleted with the row. That is why the
 * list is written out in full rather than left to the reader:
 *
 *   logs             MOVED     — no per-member uniqueness (a replay is a second row)
 *   log_tags         FOLLOWS   — keyed by log_id, so they travel with the log by FK
 *   wantlist         MERGED    — PK collision possible; the TARGET's note and date win
 *   lists            MOVED     — no per-user uniqueness
 *   list_items       FOLLOWS   — keyed by list_id
 *   desert_island    MERGED    — capped at the quota, oldest first
 *   favorites        DISCARDED — keyed by slot; see the step for why
 *   rate_limits      DISCARDED — rows keyed `write:user:<guest id>`. Merging spent budget onto
 *                                the target would hand them the guest's exhausted counters;
 *                                the pruner deletes them within a day either way.
 *   follows, likes, comments      NOT REACHABLE — the three `requireMember` sites
 *   email_verification_tokens,
 *   password_reset_tokens         NOT REACHABLE — a guest is never asked to confirm an address
 *                                 and cannot reset a password
 *
 * FOUR REFUSALS, ALL RETURNING `null`: self-merge, a source that is not a guest, a missing
 * target, a target that is itself a guest. They return rather than throw because a refused
 * merge must never fail the sign-in that triggered it — the member is already in.
 */
export async function mergeGuestInto(guestId: number, targetUserId: number): Promise<MergeSummary | null> {
  // Before the transaction, because it costs no query: merging a row into itself would delete
  // the row at the end and take every log with it through the cascade.
  if (guestId === targetUserId) return null;

  return db.transaction(async (tx) => {
    /*
     * BOTH ROLES ARE READ FROM THE COLUMN, INSIDE THE TRANSACTION (I-18). The session token's
     * `isGuest` is presentation only, and here it would additionally be the wrong copy: by
     * the time this runs the caller has just signed in, so the token is the TARGET's.
     */
    const [source] = await tx
      .select({ isGuest: users.isGuest })
      .from(users)
      .where(eq(users.id, guestId))
      .limit(1);
    if (!source || !source.isGuest) return null;

    const [target] = await tx
      .select({ isGuest: users.isGuest })
      .from(users)
      .where(eq(users.id, targetUserId))
      .limit(1);
    // A guest cannot be the destination of a merge: the destination has to be an account
    // somebody can sign back into, and merging two guests would build a row with two sets of
    // discarded credentials and no way to reach either.
    if (!target || target.isGuest) return null;

    /* ---- logs ------------------------------------------------------------------------- *
     * A straight change of owner. `logs` carries ZERO unique constraints on purpose — a
     * replay is a second row — so there is no collision to resolve and no reason to dedupe:
     * if the member rated the same album as a guest and again as themselves, those are two
     * real, separately dated opinions, and the `DISTINCT ON (user_id)` in every community
     * aggregate already picks the current one.
     *
     * The count comes from RETURNING rather than from `rowCount`, because the two drivers
     * shape that field differently and this module has to behave identically on both.
     */
    const movedLogs = await tx
      .update(logs)
      .set({ userId: targetUserId })
      .where(eq(logs.userId, guestId))
      .returning({ id: logs.id });

    /* ---- wantlist --------------------------------------------------------------------- *
     * PK is (user_id, album_id), so an album on both wantlists is a collision. The TARGET's
     * note and date WIN: `DO NOTHING` keeps the row they already had, because the note they
     * wrote on their own account is the one they will expect to find, and an "added" date
     * that moves backwards makes their queue reorder itself for no visible reason.
     *
     * TWO DATA-MODIFYING CTEs IN ONE STATEMENT, and the safety is a property of Postgres
     * rather than of the ordering: every sub-statement of a `WITH` sees the same snapshot, so
     * the DELETE cannot remove a row before the INSERT's SELECT has read it. Written as two
     * separate statements it would be just as correct here and one more round trip; written
     * as a DELETE first it would be wrong in any engine.
     */
    const wantlistResult = await tx.execute<{ moved: number }>(sql`
      with moved as (
        insert into ${wantlist} (user_id, album_id, note, added_at)
        select ${targetUserId}, ${wantlist.albumId}, ${wantlist.note}, ${wantlist.addedAt}
        from ${wantlist}
        where ${wantlist.userId} = ${guestId}
        on conflict (user_id, album_id) do nothing
        returning album_id
      ),
      cleared as (
        delete from ${wantlist} where ${wantlist.userId} = ${guestId} returning album_id
      )
      select (select count(*) from moved)::int as moved,
             (select count(*) from cleared)::int as cleared
    `);

    /* ---- lists ------------------------------------------------------------------------ *
     * Also a straight change of owner: `lists` has no per-user uniqueness (two lists may
     * share a title, and the slug is neither unique nor stable). `list_items` are keyed by
     * `list_id`, so they travel without being touched.
     */
    const movedLists = await tx
      .update(lists)
      .set({ userId: targetUserId })
      .where(eq(lists.userId, guestId))
      .returning({ id: lists.id });

    /* ---- desert_island ---------------------------------------------------------------- *
     * THE TABLE THE ORIGINAL FORGOT (I-36), and the only step with a rule of its own.
     *
     * The quota is on marks HELD, across all artists, so a merge that ignored it would leave
     * a member holding more crowns than the product allows — and the crown button would then
     * refuse every new one until they gave several back, with no explanation for why they are
     * over. So: count what the target already holds, fill only the free slots, OLDEST FIRST
     * (the marks they have lived with longest are the ones they meant), and discard the rest
     * with the guest row.
     *
     * `NOT EXISTS` RATHER THAN LEANING ON `ON CONFLICT` ALONE: a track crowned on both
     * accounts is not a new mark, and with `LIMIT free` a conflicting row would still consume
     * a slot and insert nothing — so a member with two free slots and one duplicate would
     * receive one crown instead of two. The `ON CONFLICT DO NOTHING` stays anyway, as the
     * guard against a concurrent crown landing between the SELECT and the INSERT.
     *
     * AND THE TARGET ROW IS LOCKED FIRST, for the reason spelled out in `lib/desert-island`:
     * `ON CONFLICT DO NOTHING` catches a concurrent crown on the SAME track and nothing else,
     * while the case that breaks the quota is a concurrent crown on a DIFFERENT track — which
     * under READ COMMITTED lands between this count and the insert below and pushes the target
     * past ten. The lock is on `users`, the same row `crownTrack` takes, so the two paths
     * serialise against each other rather than each being internally consistent and jointly
     * wrong.
     */
    await tx.execute(sql`SELECT 1 FROM users WHERE id = ${targetUserId} FOR UPDATE`);

    const [held] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(desertIsland)
      .where(eq(desertIsland.userId, targetUserId));
    const free = Math.max(0, DESERT_ISLAND_QUOTA - (held?.count ?? 0));

    let mergedCrowns = 0;
    if (free > 0) {
      const crowns = await tx.execute<{ id: number }>(sql`
        insert into ${desertIsland} (user_id, artist_id, album_id, disc_number, track_number, created_at)
        select ${targetUserId}, g.artist_id, g.album_id, g.disc_number, g.track_number, g.created_at
        from ${desertIsland} g
        where g.user_id = ${guestId}
          and not exists (
            select 1 from ${desertIsland} t
            where t.user_id = ${targetUserId}
              and t.album_id = g.album_id
              and t.disc_number = g.disc_number
              and t.track_number = g.track_number
          )
        order by g.created_at asc, g.id asc
        limit ${free}
        on conflict do nothing
        returning id
      `);
      mergedCrowns = crowns.rows.length;
    }

    // The overflow is dropped rather than kept under the guest row, because the guest row is
    // about to stop existing. A design that kept them would need the guest row to survive,
    // which is the "unreachable account" the last step exists to prevent.
    await tx.delete(desertIsland).where(eq(desertIsland.userId, guestId));

    /* ---- favorites -------------------------------------------------------------------- *
     * DELETED, NOT MERGED.
     *
     * > Pinned favourites are keyed by slot, and the target's four are a deliberate
     * > arrangement, so a guest's pins are dropped rather than shuffled into whatever slots
     * > happen to be free.
     *
     * The rejected alternative — fill the empty slots — is worse than it sounds: the PK is
     * (user_id, position), so "empty slot 3" is a fact about the arrangement, and dropping a
     * guest's pin into it silently rewrites a profile shelf the member composed by hand. The
     * count is returned so the UI can say so if it wants to; the data is four rows the member
     * can recreate in four clicks.
     */
    const droppedPins = await tx
      .delete(favorites)
      .where(eq(favorites.userId, guestId))
      .returning({ position: favorites.position });

    /* ---- the guest row ---------------------------------------------------------------- *
     * LAST, AND THE ORDER IS LOAD-BEARING: every table above is `ON DELETE CASCADE` against
     * this row, so deleting it first would take the logs, lists and crowns with it before
     * they moved.
     *
     * > Leaving behind an unreachable account is how a users table fills with debris.
     *
     * `is_guest = true` IS IN THE DELETE for the same reason it is in Path A's UPDATE (I-30):
     * if a concurrent sign-up claimed this row mid-merge, it is now a real member's account
     * and must not be deleted. Zero rows deleted therefore means the race happened, and the
     * throw rolls the whole merge back rather than leaving one member's logs under another
     * member's name.
     */
    const [removed] = await tx
      .delete(users)
      .where(and(eq(users.id, guestId), eq(users.isGuest, true)))
      .returning({ id: users.id });
    if (!removed) throw new GuestMergeConflictError();

    return {
      logs: movedLogs.length,
      wantlist: Number(wantlistResult.rows[0]?.moved ?? 0),
      lists: movedLists.length,
      desertIsland: mergedCrowns,
      favoritesDiscarded: droppedPins.length,
    };
  });
}

/**
 * `mergeGuestInto`, with the target resolved from THE ADDRESS THAT JUST AUTHENTICATED.
 *
 * This exists so the sign-in action never handles a target id. The caller has one piece of
 * evidence — an address that successfully completed a bcrypt compare against a non-guest row
 * — and this turns exactly that into an id. A merge that accepted an id from the caller would
 * be a "move this guest's work onto account N" endpoint, which is a way to graft data onto a
 * stranger's account and, worse, a way to delete a guest row somebody else is using.
 *
 * `lower()` ON BOTH SIDES, in Postgres rather than in JavaScript, matching the functional
 * unique index `users_email_lower_uq`: the predicate then has the index's shape (so it is an
 * index scan) and the index's semantics (JavaScript and Postgres disagree on some non-ASCII
 * folding, so an address stored through one and looked up through the other can miss).
 *
 * No `is_guest` filter here — `mergeGuestInto` refuses a guest target itself, and one rule in
 * one place is worth more than a second copy in front of it.
 */
export async function mergeGuestByEmail(guestId: number, authenticatedEmail: string): Promise<MergeSummary | null> {
  const [target] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${authenticatedEmail})`)
    .limit(1);

  if (!target) return null;
  return mergeGuestInto(guestId, target.id);
}

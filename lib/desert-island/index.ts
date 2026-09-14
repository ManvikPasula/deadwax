import "server-only";

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { desertIsland, logs } from "@/lib/db/schema";
import { MAX_RATING } from "@/lib/ratings";

/**
 * DESERT ISLAND — the quota rule engine.
 *
 * THIS IS A LIB MODULE RATHER THAN AN ACTION BODY ON PURPOSE. `toggleDesertIsland` in
 * app/actions/logs.ts is a shell: it parses, authorizes, resolves the artist from the album row
 * and revalidates. Everything below is the part with a rule worth proving, so it lives here and
 * is tested against a real database (tests/desert-island.test.ts). An action is a shell, and a
 * rule that only exists inside one is a rule nobody can prove — the seven boundary cases this
 * module has to get right cannot be reached through `guard()` without a session, a rate-limit
 * budget and a revalidation pass, which is three reasons a test would not be written.
 *
 * TWO HARD RULES, both enforced SERVER-SIDE AGAINST THE DATABASE and never taken from the
 * request:
 *
 *   1. Entry condition — the member's LATEST rating for that exact track must equal
 *      `MAX_RATING`. Not 9, not unrated.
 *   2. Quota — `DESERT_ISLAND_QUOTA` marks held at once, across all artists.
 *
 * THE ORDER OF THE STEPS IS THE DESIGN, and §5.1 of docs/ARCHITECTURE.md pins it. The rating
 * gate is outside the transaction because it reads a table nothing in the transaction writes;
 * the count and the insert are inside one because they are the classic count-then-insert race
 * (I-29); and the idempotence check precedes the quota check because a naive order refuses the
 * member their own tenth crown.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 *   - No database constraint expresses the five-star precondition, and `getDesertIsland` in
 *     lib/db/queries/users.ts deliberately does not filter on it either — it reports the
 *     current rating through a `LEFT JOIN LATERAL` WITHOUT FILTERING ON IT. A member who later
 *     lowers the rating should keep the mark until they clear it themselves rather than have
 *     the database silently discard their choice.
 *   - `uncrownTrack` never checks the rating at all. See its own comment.
 */

/**
 * `DESERT_ISLAND_QUOTA` — ten, and the ceiling is the entire feature.
 *
 * An honour with no ceiling is a second "like": the mark only means something because an
 * eleventh requires taking one back. Ten is also few enough that a member can hold the list in
 * their head, which is the stated reason the television original's `ABSOLUTE_CINEMA_QUOTA = 10`
 * transferred unchanged even though the argument for changing it was real — a heavy listener
 * has far more rated tracks than a viewer has rated episodes, which argues for FEWER, not more.
 * Ten is kept because "a person can hold ten in their head" is the property being bought, and
 * it does not move with the catalogue.
 *
 * Clearing a mark frees its slot instantly: the limit is on marks HELD, never on marks ever
 * given. Nothing anywhere counts `desert_island` rows over time.
 */
export const DESERT_ISLAND_QUOTA = 10;

/**
 * The addressable identity of a mark. `desert_island_target_uq` is
 * `(user_id, album_id, disc_number, track_number)` — note that `artist_id` is NOT in it.
 */
export type TrackMark = {
  albumId: number;
  discNumber: number;
  trackNumber: number;
};

/**
 * What `crownTrack` needs in addition: `desert_island.artist_id` is NOT NULL, and it is the
 * always-present anchor of the whole tree.
 *
 * IT MUST BE RESOLVED FROM THE ALBUM ROW BY THE CALLER, never read from the request — the same
 * rule `saveLog` follows, for the same reason. This module cannot enforce that (it receives a
 * number either way), so the enforcement lives in `toggleDesertIsland` and this comment exists
 * so a second caller does not invent its own source for the field.
 */
export type CrownTarget = TrackMark & { artistId: number };

/** Why a crown was refused. Both arms are member-visible states, not errors. */
export type CrownRefusal = "not-five-star" | "quota-full";

export type DesertIslandResult =
  | { ok: true; marked: boolean; used: number }
  | { ok: false; reason: CrownRefusal };

/**
 * A drizzle transaction handle, derived from `db.transaction` rather than imported.
 *
 * `PgTransaction` takes four type arguments and one of them is the driver's result HKT, so
 * naming the type explicitly would be a second copy of the driver choice that lib/db/index.ts
 * owns — and that copy would have to be edited if `DATABASE_URL` ever selected a third driver.
 * Deriving it means there is nothing to edit.
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The narrowest handle the count needs, so ONE implementation serves both callers: the display
 * read below and the ENFORCING read inside `crownTrack`'s transaction. The rule "how many
 * crowns does this member hold" is one rule, and the only difference between its two uses is
 * which connection asks.
 */
type Selector = Pick<Tx, "select">;

/**
 * The per-mark predicate, written once and used three times: the idempotence check inside the
 * transaction, `isCrowned`, and `uncrownTrack`'s delete.
 *
 * PLAIN EQUALITIES ARE CORRECT HERE, unlike `exactTargetConditions` in
 * lib/db/queries/logs.ts, which needs a per-column `IS NULL` branch. Every column of
 * `desert_island` is NOT NULL — the table holds tracks only — so there is no three-valued
 * logic to get wrong. Do not copy the null-branching pattern in here "for consistency"; it
 * would be four unreachable branches pretending a column might be null.
 *
 * `artist_id` IS DELIBERATELY ABSENT from the predicate even though the row carries it.
 * `ensureAlbum` rewrites an album's `artist_id` on every sync, and a release genuinely moves
 * between artist rows (a rename, a credit correction, a stub promoted to a real artist). If the
 * predicate included it, such a move would leave the member holding a mark they could neither
 * see as crowned nor clear — a slot burned permanently by a metadata edit.
 */
function markConditions(userId: number, target: TrackMark) {
  return and(
    eq(desertIsland.userId, userId),
    eq(desertIsland.albumId, target.albumId),
    eq(desertIsland.discNumber, target.discNumber),
    eq(desertIsland.trackNumber, target.trackNumber),
  );
}

async function countHeldWith(handle: Selector, userId: number): Promise<number> {
  const [row] = await handle
    .select({ count: sql<number>`count(*)::int` })
    .from(desertIsland)
    .where(eq(desertIsland.userId, userId));
  return row?.count ?? 0;
}

/**
 * How many marks this member holds, on the pool rather than inside a transaction.
 *
 * `countDesertIsland` in lib/db/queries/users.ts answers the same question and is NOT a
 * duplicate of this by accident: that one is the query layer's display read, projected and
 * ordered for the profile strip's remaining-slot frames, and it is documented as being allowed
 * to be one stale. This one is the rule engine's own count, and it exists as a named export
 * because the button needs `used` after an `uncrownTrack` that returns it anyway, and because a
 * test asserting "ten held" should not have to reach through the query layer to see it.
 */
export async function countHeld(userId: number): Promise<number> {
  return countHeldWith(db, userId);
}

/** Does this member hold a mark on this exact track? One index scan on `desert_island_target_uq`. */
export async function isCrowned(userId: number, target: TrackMark): Promise<boolean> {
  const rows = await db
    .select({ id: desertIsland.id })
    .from(desertIsland)
    .where(markConditions(userId, target))
    .limit(1);
  return rows.length > 0;
}

/**
 * Give the mark. The two steps, in the order §5.1 fixes.
 *
 * STEP 1 IS OUTSIDE THE TRANSACTION. It reads `logs`, which nothing in step 2 writes, so
 * holding a transaction open across it would buy nothing and would widen the window in which
 * two crowns of two different tracks contend. A stale read here is also harmless in the only
 * direction that matters: if the member lowers the rating between the gate and the insert they
 * keep a mark they could have kept anyway, because the precondition is deliberately not
 * re-checked once a mark is held.
 */
export async function crownTrack(userId: number, target: CrownTarget): Promise<DesertIslandResult> {
  /* ---- Step 1 — the rating gate ------------------------------------------------ */
  /**
   * `ORDER BY created_at DESC LIMIT 1` IS THE WHOLE POINT OF THIS QUERY.
   *
   * The qualifying question is what they think of the track NOW, not whether they ever gave it
   * five stars and later changed their mind. A replay is a new row rather than a mutation
   * (there are zero unique constraints on `logs`), so a member can easily hold a 10 from 2019
   * and a 6 from last week; `MAX(rating)` or `EXISTS (… rating = 10)` would both admit the
   * crown on the strength of a verdict the member has already moved past.
   *
   * `rating IS NOT NULL` is what makes "latest" mean "latest RATING". Without it a bare listen
   * mark added after the five-star rating — which is exactly what `toggleTrackListened` and
   * `markAlbumListened` write — becomes the newest row and silently withdraws the member's own
   * qualification. That is invariant I-11 wearing a different hat.
   *
   * The equalities are plain rather than null-branched because a track-level log always carries
   * all four columns; `target_type = 'track'` is what guarantees it, and it also lets
   * `logs_target_rating_idx` serve the lookup.
   */
  const latest = await db
    .select({ rating: logs.rating })
    .from(logs)
    .where(
      and(
        eq(logs.userId, userId),
        eq(logs.targetType, "track"),
        eq(logs.albumId, target.albumId),
        eq(logs.discNumber, target.discNumber),
        eq(logs.trackNumber, target.trackNumber),
        isNotNull(logs.rating),
      ),
    )
    .orderBy(desc(logs.createdAt))
    .limit(1);

  // No rated log at all and a rating below the top both land here, and both are the same
  // answer to the member: the entry condition is five stars.
  if (latest[0]?.rating !== MAX_RATING) return { ok: false, reason: "not-five-star" };

  /* ---- Step 2 — count, check, insert, in ONE transaction (I-29) ---------------- */
  /**
   * THE TRANSACTION IS NOT DEFENSIVE PROGRAMMING. Two tabs both sitting at nine held would
   * otherwise each read nine, each insert, and leave the member holding eleven — which is not
   * a cosmetic overcount, it is the ceiling gone, and nothing ever recounts to repair it.
   *
   * `desert_island_target_uq` does NOT close this. A unique index stops a duplicate row for the
   * SAME track; it says nothing at all about two different tracks, which is the case that
   * breaks the quota.
   */
  return db.transaction<DesertIslandResult>(async (tx) => {
    const held = await countHeldWith(tx, userId);

    const already = await tx
      .select({ id: desertIsland.id })
      .from(desertIsland)
      .where(markConditions(userId, target))
      .limit(1);

    /**
     * THE IDEMPOTENCE CHECK PRECEDES THE QUOTA CHECK, and a test exists solely to lock it.
     *
     * At ten held, the naive order — quota first — refuses the member their own tenth crown:
     * they click the button on a track they have already crowned, the count reads ten, and they
     * are told their island is full by the very mark that filled it. `used` is reported as
     * `held` rather than `held + 1` because this path inserts nothing, and the button's
     * arithmetic treats `used` as a global count that ALREADY INCLUDES the current track
     * whenever `marked` is true.
     */
    if (already[0]) return { ok: true, marked: true, used: held };

    if (held >= DESERT_ISLAND_QUOTA) return { ok: false, reason: "quota-full" };

    /**
     * `onConflictDoNothing` covers the one race the transaction cannot: two tabs crowning the
     * SAME track. Serialised by the unique index, the loser's insert would raise 23505, which
     * `guard()` flattens to "Something went wrong. Try again." — a failure message for an
     * operation that in fact succeeded, on a mark the member can see is held the moment the
     * page refreshes. Swallowing the conflict reports success with a `used` that may be one
     * high, and a display count that is one stale is cosmetic and reconciled by the
     * `router.refresh()` every successful action triggers.
     */
    await tx
      .insert(desertIsland)
      .values({
        userId,
        artistId: target.artistId,
        albumId: target.albumId,
        discNumber: target.discNumber,
        trackNumber: target.trackNumber,
      })
      .onConflictDoNothing({
        target: [desertIsland.userId, desertIsland.albumId, desertIsland.discNumber, desertIsland.trackNumber],
      });

    return { ok: true, marked: true, used: held + 1 };
  });
}

/**
 * Take the mark back. IT NEVER CHECKS THE RATING, and that is a product decision rather than an
 * omission.
 *
 * A member who has cooled on a song must be able to clear its mark. Requiring the five stars to
 * still be in place would trap the slot behind a rating they no longer agree with: the mark
 * cannot be given (the gate refuses), cannot be cleared (the same gate refuses), and the only
 * escape is to re-rate the track at five stars in order to be allowed to stop loving it. That
 * is the shape of a bug, not of a rule.
 *
 * UNCROWNING SOMETHING NEVER CROWNED IS A SILENT NO-OP. The delete matches nothing and the
 * count is reported as it stands. The rejected alternative — reading first so the caller can be
 * told "that was not crowned" — turns a double-click, a stale tab and a rolled-back optimistic
 * update into three error messages about a state the member already wanted.
 *
 * NO TRANSACTION, deliberately. The quota is a ceiling, and a delete can only move the count
 * away from it, so there is nothing here for two tabs to race for. Wrapping these two
 * statements for symmetry with `crownTrack` would spend a transaction to protect a number that
 * is only ever displayed.
 */
export async function uncrownTrack(
  userId: number,
  target: TrackMark,
): Promise<{ ok: true; marked: false; used: number }> {
  await db.delete(desertIsland).where(markConditions(userId, target));
  return { ok: true, marked: false, used: await countHeld(userId) };
}

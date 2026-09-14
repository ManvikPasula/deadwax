"use server";

import { revalidatePath } from "next/cache";

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { type ActionResult, fail, guard, ok, safeErrorDetail } from "@/app/actions/result";
// THE CAP IS A DECISION AND A SENTENCE, AND NEITHER IS RE-DERIVED HERE. `>= 3` written inline
// would be a second copy of the threshold, and a hand-written refusal would be a second copy of
// the offer copy — which is the exact drift class that produced two of the source audit's
// findings. The client detects the guest cap by a substring of this message, so there must be
// exactly one string.
import { GUEST_REVIEW_CAP_MESSAGE, guestReviewCapReached } from "@/lib/auth/guest";
import { UnauthorizedError, requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getTrackAt } from "@/lib/db/queries/albums";
import { getArtistDiscography } from "@/lib/db/queries/artists";
import { type LogTarget, countReviewsBy, findExistingLog } from "@/lib/db/queries/logs";
import { type Album, type NewLog, type TargetType, logTags, logs, users } from "@/lib/db/schema";
import { DESERT_ISLAND_QUOTA, crownTrack, uncrownTrack } from "@/lib/desert-island";
import { utcCalendarDate } from "@/lib/format";
import { ensureAlbumById, ensureArtistById } from "@/lib/ingest/albums";
import { MAX_RATING, MIN_RATING } from "@/lib/ratings";
import {
  albumIdSchema,
  artistIdSchema,
  calendarDate,
  calendarDateCeiling,
  discNumberSchema,
  logIdSchema,
  reviewBody,
  tagList,
  targetSchema,
  targetTypeOf,
  trackNumberSchema,
} from "@/lib/security/schemas";

/**
 * THE WRITE PATH FOR `logs`, and `saveLog` is THE SINGLE WRITE.
 *
 * Playing a track, rating an album, reviewing an artist and hearting a record differ only in
 * which columns are filled — which is why there is one `saveLog` rather than six near-identical
 * actions, and why that one has to be careful about the columns it was NOT given.
 *
 * EVERY EXPORT IS `return guard("<label>", async () => { … })`. The label is typed as
 * `ActionLabel`, so a typo is a compile error rather than a silent "not exempt". Two of these
 * actions are in `VERIFICATION_EXEMPT` — `deleteLog` and `unmarkAlbumListened`, both
 * self-scoped undos that nobody else can see the effects of and which must not be held hostage
 * to slow mail. `saveLog` is NOT exempt: the gate is on publishing.
 *
 * WHAT AN ACTION IN THIS FILE IS ALLOWED TO DO: validate, authorize, mutate, revalidate. The
 * quota rule lives in lib/desert-island because it has boundary cases worth proving; the target
 * predicates live in lib/db/queries/logs.ts because three-valued logic is easy to get wrong
 * once and impossible to get wrong twice if there is only one copy.
 */

/**
 * THE FLAT PARSE FAILURE, and it is never `parsed.error`.
 *
 * A Zod error tree names every field, its expected type and its bound. On a payload that only
 * a crafted call can produce, that is a free description of the server's own shape — and on a
 * payload the real dialog produced it is unreadable to a member anyway, because the dialog has
 * already prevented every reachable mistake. One sentence, no field detail.
 */
const INVALID_LOG = "That log does not look right.";
const INVALID_TARGET = "That does not look right.";

/**
 * 1..10, the stored scale. `MIN_RATING`/`MAX_RATING` come from lib/ratings.ts, where they are
 * declared once, so this schema cannot disagree with the star input or the bracket table.
 *
 * DECLARED HERE RATHER THAN IN lib/security/schemas.ts only because that module currently has
 * no rating rule. IF A SECOND ACTION EVER NEEDS ONE, MOVE THIS THERE — a second copy beside a
 * second action is precisely the drift the shared library exists to prevent.
 */
const ratingSchema = z.int().min(MIN_RATING, "Unknown rating.").max(MAX_RATING, "Unknown rating.");

/**
 * `targetSchema` supplies the polymorphic target; everything else is the payload.
 *
 * EVERY MUTABLE FIELD IS `.nullable().optional()` ON PURPOSE, and the two are not the same
 * thing: `undefined` means "leave this column alone" and an explicit `null` means "clear it".
 * Collapsing them — `.nullish()` with a `?? null` default, or a `.default(null)` — reintroduces
 * the only CRITICAL finding in the source audit. See the patch block below.
 *
 * `targetType` IS NOT A FIELD. It is derived by `targetTypeOf()`, because the column is a
 * `varchar(8)` with no check constraint: a caller who could set it could write
 * `target_type = 'album'` on a row carrying a track number, and every aggregate that switches
 * on the column would then count that row twice.
 *
 * `artistId` is accepted but IGNORED on an album or track log — see `resolveTarget`.
 */
const saveLogSchema = targetSchema.extend({
  rating: ratingSchema.nullable().optional(),
  review: reviewBody.nullable().optional(),
  listenedOn: calendarDate.nullable().optional(),
  isReplay: z.boolean().optional(),
  liked: z.boolean().optional(),
  /** A REPLACE, not a merge. Absent leaves the existing tags alone; `[]` clears them. */
  tags: tagList.optional(),
  /**
   * The replay switch. `LogDialog` passes true from "Log again", which is what makes a replay a
   * SECOND ROW rather than a mutation — the encoding the whole `logs` table is built on.
   */
  createNew: z.boolean().optional(),
});

export type SaveLogInput = z.input<typeof saveLogSchema>;

const trackTargetSchema = z.object({
  albumId: albumIdSchema,
  discNumber: discNumberSchema.optional(),
  trackNumber: trackNumberSchema,
});

const toggleTrackListenedSchema = trackTargetSchema.extend({
  listened: z.boolean(),
  /** The member's LOCAL calendar date, from `localCalendarDate()` in lib/format.ts. */
  listenedOn: calendarDate.optional(),
});

const markAlbumSchema = z.object({ albumId: albumIdSchema, listenedOn: calendarDate.optional() });
const unmarkAlbumSchema = z.object({ albumId: albumIdSchema });
const markDiscographySchema = z.object({ artistId: artistIdSchema, listenedOn: calendarDate.optional() });
const deleteLogSchema = z.object({ logId: logIdSchema });
const toggleDesertIslandSchema = trackTargetSchema.extend({ crowned: z.boolean() });

export type ToggleTrackListenedInput = z.input<typeof toggleTrackListenedSchema>;
export type MarkAlbumListenedInput = z.input<typeof markAlbumSchema>;
export type UnmarkAlbumListenedInput = z.input<typeof unmarkAlbumSchema>;
export type MarkDiscographyListenedInput = z.input<typeof markDiscographySchema>;
export type DeleteLogInput = z.input<typeof deleteLogSchema>;
export type ToggleDesertIslandInput = z.input<typeof toggleDesertIslandSchema>;

/* ========================================================================== *
 * THE AUTHORIZATION LADDER, factored so every writer climbs the same rungs
 *
 * `guard()` is rung 1 and `requireUser()` is rung 2; both are at each action's call site
 * because their ORDER relative to each other is the point. Rungs 4, 6 and 7 are below.
 * ========================================================================== */

type ResolvedTarget = {
  targetType: TargetType;
  target: LogTarget;
  /** Null only for an artist-level log. Carried so rung 7 has a release date to look at. */
  album: Album | null;
};

type Resolution = { ok: true; value: ResolvedTarget } | { ok: false; error: string };

/**
 * RUNG 4 — the target must exist locally or be fetchable, and **`artist_id` IS RESOLVED FROM
 * THE ALBUM ROW, NEVER FROM THE REQUEST.**
 *
 * That single line closes a whole class of forgery without a check of its own. `logs.artist_id`
 * is NOT NULL and is the anchor every artist-level aggregate joins on — the discography
 * heatmap, the completion meter, "artists touched", the artist review rollup. A caller who
 * could supply it could publish a five-star review of a Nickelback track against Radiohead's
 * artist row, and every one of those surfaces would render it. There is no separate
 * "does this album belong to this artist" validation because there is nothing to validate: the
 * request never gets a say.
 *
 * `ensureAlbumById`/`ensureArtistById` are React-`cache()`d, so a page that already resolved
 * the album for rendering does not pay for this twice.
 *
 * THE DISC DEFAULT. A track payload with no `discNumber` becomes disc 1, matching
 * `tracks.disc_number`'s own NOT NULL DEFAULT 1 and `trackLocator`'s suppression of the
 * redundant "1-" on a single-disc record. A wrong guess is not silently written: rung 6 looks
 * the exact `(album, disc, track)` row up and refuses if it is not there.
 */
async function resolveTarget(input: {
  artistId?: number;
  albumId?: number;
  discNumber?: number;
  trackNumber?: number;
}): Promise<Resolution> {
  const targetType = targetTypeOf(input);

  if (targetType === "artist") {
    if (input.artistId === undefined) return { ok: false, error: "Unknown artist." };
    const artist = await ensureArtistById(input.artistId);
    if (!artist) return { ok: false, error: "We do not have that artist." };
    return {
      ok: true,
      value: {
        targetType,
        album: null,
        // The explicit nulls matter: `findExistingLog` turns them into `IS NULL` predicates,
        // and an omitted key would make the lookup match an album-level row instead.
        target: { artistId: artist.id, albumId: null, discNumber: null, trackNumber: null },
      },
    };
  }

  // `targetTypeOf` returns "track" on a payload carrying a track number and no album id, which
  // is a shape only a crafted call produces. Refuse it here rather than letting a NOT NULL
  // violation become "Something went wrong".
  if (input.albumId === undefined) return { ok: false, error: "Unknown album." };

  const album = await ensureAlbumById(input.albumId);
  if (!album) return { ok: false, error: "We do not have that album." };

  if (targetType === "album") {
    return {
      ok: true,
      value: {
        targetType,
        album,
        target: { artistId: album.artistId, albumId: album.id, discNumber: null, trackNumber: null },
      },
    };
  }

  const trackNumber = input.trackNumber;
  // Unreachable: `targetTypeOf` only answers "track" when `trackNumber !== undefined`. The
  // branch exists so the type narrows without a non-null assertion, which is the kind of
  // assertion that survives a refactor of `targetTypeOf` and then lies.
  if (trackNumber === undefined) return { ok: false, error: "Unknown track." };

  return {
    ok: true,
    value: {
      targetType,
      album,
      target: {
        artistId: album.artistId,
        albumId: album.id,
        discNumber: input.discNumber ?? 1,
        trackNumber,
      },
    },
  };
}

/**
 * RUNG 6 — TARGET EXISTENCE (I-19).
 *
 * For a track target, the exact `(album_id, disc_number, track_number)` row must exist in
 * `tracks`. Without this, a crafted call publishes a review of a track that does not exist,
 * which renders on the album page, links to a 404, and inflates the author's public track and
 * listening-time totals.
 *
 * Album and artist targets need nothing here: rung 4 resolved them from their own rows, so
 * their existence is already proved by the row it returned.
 */
async function targetExistenceRefusal(resolved: ResolvedTarget): Promise<string | null> {
  if (resolved.targetType !== "track") return null;
  if (resolved.target.albumId == null || resolved.target.discNumber == null || resolved.target.trackNumber == null) {
    return "Unknown track.";
  }

  const track = await getTrackAt(resolved.target.albumId, resolved.target.discNumber, resolved.target.trackNumber);
  return track ? null : "We do not have that track.";
}

/**
 * RUNG 7 — THE RELEASE-DATE GATE. The pre-release-single state, and the one piece of the
 * television version's air-date logic that survives.
 *
 * Everything else about air dates is deleted: a track is either released with its album or it
 * does not exist, so there is no "Not aired" badge, no `opacity-60` unaired styling and no
 * aired-only filter anywhere. But `release_date > today` is a real state — Deezer lists
 * announced records — and a diary entry against one is a member logging something nobody can
 * have heard.
 *
 * THE CEILING IS `calendarDateCeiling()`, NOT `utcCalendarDate()`, and the difference is the
 * timezone fix rather than slack. A member in UTC+13 at 09:00 on release morning is still on
 * yesterday's UTC date, so comparing against UTC today refuses them on a record that came out
 * hours ago in the only calendar they have. It is the same +1 day `calendarDate`'s own upper
 * bound uses, and the two must agree or one of them refuses what the other accepts.
 *
 * The comparison is STRING against STRING. Drizzle returns a `date` column as `YYYY-MM-DD`
 * (I-9), which is lexicographically ordered the same way it is chronologically ordered, so
 * there is no `Date` round trip here to produce an "Invalid Date".
 *
 * A NULL release date does not refuse. Unknown is not future, and the mirror holds plenty of
 * undated rows.
 */
function releaseRefusal(album: Pick<Album, "releaseDate">): string | null {
  if (!album.releaseDate) return null;
  if (album.releaseDate <= calendarDateCeiling()) return null;
  return "That record is not out yet.";
}

/**
 * RUNG 5 — the guest review cap.
 *
 * `is_guest` IS READ FROM THE COLUMN, never from the session token (I-18): the token's copy is
 * presentation only, and a guest who converted in another tab still carries a token saying they
 * are one.
 *
 * `countReviewsBy(userId, target)` EXCLUDES THIS TARGET, and the exclusion is the whole reason
 * the parameter exists — a guest sitting at the cap must still be able to revise the three they
 * wrote instead of being frozen out of their own words.
 *
 * THE MESSAGE MUST CONTAIN "Create an account", and `GUEST_REVIEW_CAP_MESSAGE` is where that
 * sentence lives. `ActionResult` has no machine-readable code field, so `LogDialog` detects the
 * guest cap by that substring and renders the refusal as an OFFER — a sign-up button under the
 * textarea — rather than as a red error. THAT COUPLES THE CLIENT TO THE WORDING, and it is the
 * documented trade: the alternative is a `code` field on every `ActionResult` in the
 * application, which is a change to the frozen action contract for the benefit of one branch.
 * The coupling is survivable only because the string is declared once; a copy of it here is how
 * the substring test starts failing silently.
 */
async function guestReviewRefusal(userId: number, target: LogTarget): Promise<string | null> {
  const rows = await db.select({ isGuest: users.isGuest }).from(users).where(eq(users.id, userId)).limit(1);
  const row = rows[0];
  // Deleted between `requireUser` and here. Not a guest problem, so not a guest message.
  if (!row) throw new UnauthorizedError();
  if (!row.isGuest) return null;

  return guestReviewCapReached(await countReviewsBy(userId, target)) ? GUEST_REVIEW_CAP_MESSAGE : null;
}

/**
 * REVALIDATION DISCIPLINE. Three calls, and the shape of each is deliberate.
 *
 * `"/album/[slug]"` and `"/artist/[slug]"` are THE ROUTE PATTERNS WITH A TYPE ARGUMENT, not
 * interpolated concrete paths: album and artist pages are keyed by `<title>-<id>` slugs, and we
 * do not have the slug here — only the id. Revalidating the segment tree is the honest answer;
 * building a slug from a title we would have to re-read is the wrong one. The artist tree is in
 * the list because a track log moves the discography heatmap and the completion meter, both of
 * which live on the artist page rather than the album page.
 *
 * The member's own tree is a CONCRETE path with `"layout"`, which covers the profile, the diary,
 * the albums tab, the year pages and the wantlist in one call — all of them show log-derived
 * numbers. Interpolating the username is safe for exactly the reason `usernameSchema` is an
 * allowlist rather than a denylist: nothing outside `[a-zA-Z0-9_]` can reach this column, so
 * nothing can reach this argument.
 *
 * NOTHING ELSE IS ADDED. `/` sets `revalidate = 0`, so it is never cached and an entry for it
 * would be decoration; `/log/[id]` renders the viewer's own like state and is dynamic per
 * request. The television original ships a `revalidatePath("/show/${id}")` that matches no
 * rendered route at all, and a dead path is worse than a missing one — it reads as coverage.
 */
function revalidateLogSurfaces(username: string): void {
  revalidatePath("/album/[slug]", "layout");
  revalidatePath("/artist/[slug]", "layout");
  revalidatePath(`/@${username}`, "layout");
}

/* ========================================================================== *
 * saveLog — THE SINGLE WRITE
 * ========================================================================== */

/**
 * Authorization strictly in this order, and the order is the design:
 *
 *  1. `guard("saveLog", …)` consumes a rate-limit token BEFORE ANYTHING ELSE, including before
 *     `requireUser()`, so an unauthenticated flood is metered on the way in rather than after a
 *     database round trip. `saveLog` is NOT verification-exempt — it publishes.
 *  2. `requireUser()` re-reads the account row, so a JWT for a deleted account cannot write
 *     (I-17). This is the single revocation point in the application.
 *  3. Zod, returning one flat sentence.
 *  4. `ensureAlbumById`/`ensureArtistById`, with `artist_id` resolved FROM THE ALBUM ROW.
 *  5. The guest review cap.
 *  6. Target existence (I-19).
 *  7. The release-date gate.
 *
 * Rungs 5, 6 and 7 are each one query or none, and they are in this order because 5 is about
 * the AUTHOR, 6 about the TARGET and 7 about the WORLD — narrowing outward, so the cheapest
 * refusal a member can actually hit comes first.
 */
export async function saveLog(input: SaveLogInput): Promise<ActionResult<{ logId: number }>> {
  return guard("saveLog", async () => {
    const user = await requireUser();

    const parsed = saveLogSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_LOG);
    const data = parsed.data;

    const resolved = await resolveTarget(data);
    if (!resolved.ok) return fail(resolved.error);
    const { targetType, target, album } = resolved.value;

    /**
     * `review` IS NORMALISED ONCE, HERE, and not again inside the transaction.
     *
     * A whitespace-only review becomes SQL NULL, so it stays out of every review list, out of
     * `countReviews`, out of the reviews-written statistic and out of the guest cap. The
     * rejected alternative — trimming at each read — is four copies of one rule, and the
     * symptom of missing one is a review card rendering a blank body with a byline.
     *
     * Note what this does NOT do: it does not turn `undefined` into `null`. `data.review`
     * staying `undefined` is what tells the patch below to leave the column alone.
     */
    const review = data.review?.trim() ? data.review.trim() : null;

    if (review !== null) {
      const refusal = await guestReviewRefusal(user.id, target);
      if (refusal) return fail(refusal);
    }

    const missing = await targetExistenceRefusal(resolved.value);
    if (missing) return fail(missing);

    if (album) {
      const unreleased = releaseRefusal(album);
      if (unreleased) return fail(unreleased);
    }

    /**
     * THE ROW TO PATCH. Newest first, because a replay is a second row and the oldest row is a
     * verdict the member has already moved past.
     *
     * `findExistingLog` owns the predicate, and it is not a convenience: the target conditions
     * use an explicit per-column `IS NULL` branch for an absent disc or track, because SQL
     * `= NULL` is NULL rather than false. Four plain equalities compile, run, and are silently
     * wrong — at album level every lookup misses (so every edit becomes a new row), and at
     * track level an omitted predicate matches the album-level row instead (so rating a track
     * edits the album).
     *
     * `createNew` skips the lookup entirely. That is the replay path.
     */
    const existing = data.createNew ? null : await findExistingLog(user.id, target);

    /**
     * ONE TRANSACTION (I-32), because the tag replacement can fail on its own.
     *
     * The measured defect: a tag that overflowed `varchar(32)` at INSERT — `İ` lower-cases to
     * two code units, so a 17-character tag became 34 (I-8) — left the log edited and every
     * existing tag deleted, while the member was told the save had failed. Two write statements
     * and one reported outcome have to be one unit or the member's copy of what happened is
     * wrong.
     */
    const logId = await db.transaction<number>(async (tx) => {
      let id: number;

      if (existing) {
        /**
         * PATCH SEMANTICS (I-1 / SEC-01). **`undefined` MEANS LEAVE ALONE; AN EXPLICIT `null`
         * STILL CLEARS.**
         *
         * THIS BLOCK IS THE FIX FOR THE SOURCE AUDIT'S ONLY CRITICAL FINDING. Before it, the
         * action built a full row from its input and wrote all of it, so clicking Like — or a
         * single star — on an album you had reviewed destroyed your own review, your diary
         * date, your replay flag and every tag on it, instantly and unrecoverably, because the
         * control that sent the click had no idea the other columns existed.
         *
         * The paired half lives in the client: ANY CONTROL THAT SAVES MUST BE PRIMED FROM THE
         * REAL ROW, NEVER FROM BLANKS. That is why `LogDialog`'s `initial` prop is REQUIRED
         * rather than optional — the omission is a compile error instead of a data loss. Both
         * halves are needed: patch semantics alone still lets a primed-from-blanks dialog send
         * explicit nulls, and priming alone still lets a bare star click blank the row.
         *
         * `updatedAt` is the one field set unconditionally, because the row did change.
         */
        const patch: Partial<NewLog> = { updatedAt: new Date() };
        if (data.rating !== undefined) patch.rating = data.rating;
        if (data.review !== undefined) patch.review = review;
        if (data.listenedOn !== undefined) patch.listenedOn = data.listenedOn;
        // `logs.is_replay` is snake_case in the schema object because of how it was declared.
        // Everything around it is camelCase; this one is not.
        if (data.isReplay !== undefined) patch.is_replay = data.isReplay;
        if (data.liked !== undefined) patch.liked = data.liked;

        await tx.update(logs).set(patch).where(eq(logs.id, existing.id));
        id = existing.id;
      } else {
        /**
         * A new row takes column defaults for anything absent, which is a different rule from
         * the patch above and the right one: there is no previous value to leave alone. The
         * defaults match the schema's own — an unrated listen is `rating IS NULL`, not a zero,
         * because zero stars is unrepresentable on this scale.
         */
        const [inserted] = await tx
          .insert(logs)
          .values({
            userId: user.id,
            // DERIVED, never accepted from the client.
            targetType,
            artistId: target.artistId,
            albumId: target.albumId ?? null,
            discNumber: target.discNumber ?? null,
            trackNumber: target.trackNumber ?? null,
            rating: data.rating ?? null,
            review,
            listenedOn: data.listenedOn ?? null,
            is_replay: data.isReplay ?? false,
            liked: data.liked ?? false,
          })
          .returning({ id: logs.id });

        // `returning` on a successful insert always yields a row; if it did not, continuing
        // would write tags against `NaN` and report success.
        if (!inserted) throw new Error("log insert returned no row");
        id = inserted.id;
      }

      /**
       * TAGS ARE A REPLACE, NOT A MERGE, and the guard is `data.tags` rather than
       * `data.tags?.length`: an empty array is a member clearing their tags and must delete,
       * while an absent key is a control that never asked about tags and must not.
       *
       * `new Set` is taken AFTER normalisation, which is why `tagList` deliberately does not
       * dedupe: the set has to be taken on the lower-cased, trimmed values, and a schema that
       * silently dropped entries would report "at most 12 tags" on thirteen that collapse
       * to nine.
       */
      if (data.tags) {
        await tx.delete(logTags).where(eq(logTags.logId, id));
        const cleaned = [...new Set(data.tags)].filter(Boolean);
        if (cleaned.length > 0) {
          await tx.insert(logTags).values(cleaned.map((tag) => ({ logId: id, tag })));
        }
      }

      return id;
    });

    revalidateLogSurfaces(user.username);
    return ok({ logId });
  });
}

/* ========================================================================== *
 * The checkmark
 * ========================================================================== */

/**
 * The per-track tick.
 *
 * **true:** if ANY row exists for that exact track, DO NOTHING. Idempotent, and it never
 * duplicates — a double-click, a stale optimistic state and a re-sent request all land on the
 * same single mark. A replay is created by `saveLog` with `createNew`, deliberately, because a
 * replay is an event with a date and a verdict rather than a second tick.
 *
 * **false:** delete only the LATEST row, SO A REPLAY HISTORY IS NOT WIPED BY ONE MIS-CLICK.
 * Three replay rows need three clicks. The rejected alternative — deleting every row for the
 * target — is one keystroke shorter and destroys years of dated diary entries on a mis-click,
 * which is the same defect class as the patch-semantics one above wearing different clothes.
 *
 * THE RELEASE GATE APPLIES ONLY TO THE INSERT. A gate on the delete would trap a mark behind a
 * release date that moved forward after a resync, and an undo is never a publish.
 */
export async function toggleTrackListened(
  input: ToggleTrackListenedInput,
): Promise<ActionResult<{ listened: boolean }>> {
  return guard("toggleTrackListened", async () => {
    const user = await requireUser();

    const parsed = toggleTrackListenedSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_TARGET);
    const data = parsed.data;

    const resolved = await resolveTarget(data);
    if (!resolved.ok) return fail(resolved.error);
    const { target, album } = resolved.value;

    const missing = await targetExistenceRefusal(resolved.value);
    if (missing) return fail(missing);

    const existing = await findExistingLog(user.id, target);

    if (data.listened) {
      if (album) {
        const unreleased = releaseRefusal(album);
        if (unreleased) return fail(unreleased);
      }

      if (!existing) {
        await db.insert(logs).values({
          userId: user.id,
          targetType: "track",
          artistId: target.artistId,
          albumId: target.albumId ?? null,
          discNumber: target.discNumber ?? null,
          trackNumber: target.trackNumber ?? null,
          // A BARE MARK: no rating, no review, no flags. `listened_on` is the member's own
          // local date, sent by the client, because a server computing `toISOString()` puts a
          // member in UTC+13 a day behind their own diary.
          listenedOn: data.listenedOn ?? utcCalendarDate(),
        });
      }
    } else if (existing) {
      await db.delete(logs).where(eq(logs.id, existing.id));
    }

    revalidateLogSurfaces(user.username);
    return ok({ listened: data.listened });
  });
}

/**
 * ONE MULTI-ROW INSERT for every track of an album the member has not already marked.
 *
 * `INSERT … SELECT … WHERE NOT EXISTS` rather than read-diff-insert, because the read-then-write
 * form has a window in which a concurrent single tick creates the row this statement is about
 * to create, and the recovery from that is a unique-violation the table has no unique index to
 * raise — so it would be a duplicate mark, silently, and duplicate marks are what
 * `COUNT(DISTINCT …)` exists to paper over everywhere else.
 *
 * `RETURNING id` is what makes the count honest: `markDiscographyListened` aggregates these
 * numbers into its own result, and a statement that cannot say how many rows it wrote cannot be
 * reported on.
 *
 * **`artist_id` comes from the ALBUM ROW, not from `tracks.artist_id`.** The denormalised copy
 * on `tracks` is written at ingest and can lag a resync that moved the album to a different
 * artist row; a log anchored to the stale one vanishes from that artist's completion meter and
 * review rollup.
 *
 * NOT EXPORTED, and that is the point of this function existing separately:
 * `markDiscographyListened` calls it in a loop INSIDE ONE `guard()`.
 */
async function markAlbumTracks(
  userId: number,
  album: { id: number; artistId: number },
  listenedOn: string,
): Promise<number> {
  const inserted = await db.execute<{ id: number }>(sql`
    INSERT INTO logs (user_id, target_type, artist_id, album_id, disc_number, track_number, listened_on)
    SELECT ${userId}::int, 'track', ${album.artistId}::int,
           t.album_id, t.disc_number, t.track_number, ${listenedOn}::date
    FROM tracks t
    WHERE t.album_id = ${album.id}::int
      -- The idempotence half. Without it a second click doubles every mark on the record, and
      -- nothing downstream can tell a duplicate from a replay.
      AND NOT EXISTS (
        SELECT 1 FROM logs l
        WHERE l.user_id = ${userId}::int
          AND l.target_type = 'track'
          AND l.album_id = t.album_id
          AND l.disc_number = t.disc_number
          AND l.track_number = t.track_number
      )
    RETURNING id
  `);

  return inserted.rows.length;
}

/**
 * Tick a whole record.
 *
 * ONLY RELEASED TRACKS. The interface already refuses to let a member tick an unreleased track
 * one at a time, and the bulk path has to agree — a bulk control that reaches things the single
 * control refuses is a way around the rule rather than a shortcut through it. Tracks carry no
 * release date of their own in this schema (a track is released with its album or it does not
 * exist), so "released tracks" resolves to "the tracks of a released album", and the gate is
 * the album's.
 *
 * `ensureAlbumById` is rung 4 and is load-bearing here rather than ceremonial: an album whose
 * tracklist has never been mirrored has no `tracks` rows, so the INSERT would select nothing
 * and the member would be told the click worked while nothing was marked.
 */
export async function markAlbumListened(input: MarkAlbumListenedInput): Promise<ActionResult<{ marked: number }>> {
  return guard("markAlbumListened", async () => {
    const user = await requireUser();

    const parsed = markAlbumSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_TARGET);
    const data = parsed.data;

    const album = await ensureAlbumById(data.albumId);
    if (!album) return fail("We do not have that album.");

    const unreleased = releaseRefusal(album);
    if (unreleased) return fail(unreleased);

    const marked = await markAlbumTracks(user.id, album, data.listenedOn ?? utcCalendarDate());

    revalidateLogSurfaces(user.username);
    return ok({ marked });
  });
}

/**
 * Untick a whole record.
 *
 * **`AND review IS NULL AND rating IS NULL` IS THE ENTIRE SAFETY MECHANISM.** This action
 * deletes rows in bulk on one click, and the only thing standing between it and a member's
 * written work is that filter. A member who rated four tracks and ticked the other eight, then
 * unticks the album, keeps the four ratings. Remove the filter and the same click destroys
 * them, with no confirmation step, no undo and nothing in the interface that said it would.
 *
 * `target_type = 'track'` keeps it to the per-track marks. An album-level log with no rating
 * and no review is a bare album listen — a different control's row — and the album tick is not
 * the album log's undo.
 *
 * NO `ensureAlbum` CALL. Nothing is being published, and making an undo depend on a provider
 * round trip is how an undo fails when the provider is down. Verification-exempt for the same
 * reason: somebody who cannot receive our confirmation mail must still be able to untick
 * something they ticked by accident.
 */
export async function unmarkAlbumListened(
  input: UnmarkAlbumListenedInput,
): Promise<ActionResult<{ removed: number }>> {
  return guard("unmarkAlbumListened", async () => {
    const user = await requireUser();

    const parsed = unmarkAlbumSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_TARGET);

    const removed = await db
      .delete(logs)
      .where(
        and(
          eq(logs.userId, user.id),
          eq(logs.albumId, parsed.data.albumId),
          eq(logs.targetType, "track"),
          isNull(logs.review),
          isNull(logs.rating),
        ),
      )
      .returning({ id: logs.id });

    revalidateLogSurfaces(user.username);
    return ok({ removed: removed.length });
  });
}

/**
 * Tick an artist's whole discography — AND THIS ACTION IS THE FIX FOR A NAMED DEFECT.
 *
 * The television version loops `markSeasonWatched` per season, and EACH NESTED CALL RE-ENTERS
 * `guard()`. Measured on a 20-season show, one click costs:
 *
 *   - 21 rate-limit tokens out of a 120/60s budget, so six clicks lock the member out of every
 *     write in the application for a minute;
 *   - 21 `requireUser()` round trips;
 *   - 21 revalidation passes over the same segment trees;
 *   - and a mid-loop refusal is SILENTLY SKIPPED, because the loop reads `if (result.ok)` and
 *     has no else. The member is told the whole show is marked while season 12 is not.
 *
 * Here the whole loop runs inside ONE `guard()` against `markAlbumTracks`, which is internal and
 * unguarded. One click costs one token, one user read and one revalidation pass, and a partial
 * failure is REPORTED in the result rather than swallowed.
 *
 * SERIAL, NOT `Promise.all`. A discography is routinely forty releases and six hundred tracks,
 * and the pool is `max: 5` (lib/db/index.ts) — forty concurrent multi-row inserts queue on five
 * connections while holding forty promises, which is slower than the loop and exhausts the pool
 * for every other request on the instance.
 *
 * NO `ensureAlbum` PER ALBUM. It marks what is mirrored. Filling forty tracklists from the
 * provider inside one click is exactly the fan-out `DISCOGRAPHY_FILL_CAP = 12` exists to
 * prevent, so an album with no mirrored tracks contributes zero marks rather than a network
 * round trip; the artist page's own Suspense-boundary fill is what makes it mirrored.
 */
export async function markDiscographyListened(
  input: MarkDiscographyListenedInput,
): Promise<ActionResult<{ albums: number; tracks: number; skipped: number; failed: number }>> {
  return guard("markDiscographyListened", async () => {
    const user = await requireUser();

    const parsed = markDiscographySchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_TARGET);
    const data = parsed.data;

    const artist = await ensureArtistById(data.artistId);
    if (!artist) return fail("We do not have that artist.");

    /**
     * albums.is_canonical — the "specials" exclusion. A non-canonical release must never enter
     * a completion denominator, a discography heatmap row, or a recommendation pool. COPY THIS
     * COMMENT next to any new query that filters on it; the television version's
     * `season_number > 0` was pasted into three CTEs precisely because it is easy to omit in a
     * fourth. Here the filter is `getArtistDiscography`'s default, and the consequence of
     * losing it is specific: ticking the discography would mark a deluxe edition's bonus tracks
     * and a live album, so `getCompletion` — which counts only canonical releases — would
     * report a member as having played more tracks than the discography contains.
     *
     * The rejected alternative was a three-column select on `albums` right here, which is one
     * query instead of four. Rejected because the query module owns `albums` reads and the
     * canonicality comment lives with the filter; four queries on a click that writes several
     * hundred rows is not the cost that matters.
     */
    const discography = await getArtistDiscography(artist.id);

    const listenedOn = data.listenedOn ?? utcCalendarDate();
    let albumsMarked = 0;
    let tracksMarked = 0;
    let skipped = 0;
    let failed = 0;

    for (const album of discography) {
      // Per album rather than up front: an unreleased single must not block the ten released
      // records beside it, so this SKIPS rather than refusing the whole call.
      if (releaseRefusal(album)) {
        skipped += 1;
        continue;
      }

      try {
        const marks = await markAlbumTracks(user.id, album, listenedOn);
        if (marks > 0) {
          albumsMarked += 1;
          tracksMarked += marks;
        }
      } catch (error) {
        // THE `if (result.ok)` THE ORIGINAL WROTE INSTEAD OF THIS. Counted, logged through the
        // whitelist (I-35 — never the error object, which carries the failing SQL and its bound
        // parameters), and reported to the caller below.
        failed += 1;
        console.error("[action:failed]", {
          label: "markDiscographyListened",
          albumId: album.id,
          ...safeErrorDetail(error),
        });
      }
    }

    revalidateLogSurfaces(user.username);

    // Everything that could be attempted failed. Reporting `ok` here would be the original's
    // defect with extra steps: a success message over a discography that is not marked.
    if (failed > 0 && albumsMarked === 0) return fail("We could not mark that discography. Try again.");

    return ok({ albums: albumsMarked, tracks: tracksMarked, skipped, failed });
  });
}

/* ========================================================================== *
 * Delete
 * ========================================================================== */

/**
 * TWO DISTINCT MESSAGES, deliberately.
 *
 * "That entry no longer exists." is the two-tabs case — deleted here, clicked there — and a
 * member who meets it has done nothing wrong. "That is not your entry." is somebody addressing
 * a log they do not own. Collapsing them into one refusal would tell the honest member they are
 * being accused of something, which is the more common of the two by a wide margin.
 *
 * The distinction leaks only whether a log id exists, and `/log/[id]` is a public route, so that
 * is not a secret this action is keeping.
 *
 * `log_tags` cascades (`log_tags.log_id` is `ON DELETE CASCADE`), so there is no second
 * statement and therefore no transaction. Likes and comments on the log cascade the same way.
 *
 * Verification-exempt: deleting your own entry is self-scoped, and somebody who cannot read our
 * mail must still be able to take back something they published.
 */
export async function deleteLog(input: DeleteLogInput): Promise<ActionResult> {
  return guard("deleteLog", async () => {
    const user = await requireUser();

    const parsed = deleteLogSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_TARGET);

    const rows = await db
      .select({ id: logs.id, userId: logs.userId })
      .from(logs)
      .where(eq(logs.id, parsed.data.logId))
      .limit(1);

    const row = rows[0];
    if (!row) return fail("That entry no longer exists.");
    // Compared against the SESSION id, never against anything in the payload.
    if (row.userId !== user.id) return fail("That is not your entry.");

    await db.delete(logs).where(eq(logs.id, row.id));

    revalidateLogSurfaces(user.username);
    return ok();
  });
}

/* ========================================================================== *
 * Desert Island — a thin shell over lib/desert-island
 * ========================================================================== */

/**
 * A SHELL, and nothing more: parse, authorize, resolve the anchor from the album row, call the
 * rule engine, translate its two refusals into sentences, revalidate.
 *
 * The quota arithmetic, the latest-rating gate and the transaction all live in
 * lib/desert-island/index.ts, where they are tested against a real database. An action is a
 * shell, and a rule that only exists inside one is a rule nobody can prove.
 *
 * `DESERT_ISLAND_QUOTA` is RETURNED rather than re-declared in the client, so the button's
 * "exhausted" arithmetic and the server's ceiling cannot disagree. (It cannot be re-exported
 * from here: every export of a `"use server"` module must be an async function.)
 *
 * THERE IS NO RELEASE GATE HERE. A crown requires a five-star rating for that exact track,
 * which required a log, which passed rung 7 when it was written — and a record whose date moved
 * forward after a resync must not cost the member a mark they already hold.
 *
 * Rung 6 IS here even though the five-star gate makes it almost redundant: the log the gate
 * reads could only have been written through `saveLog`'s existence check, so a qualifying
 * rating is itself an existence proof — but only of the tracklist as it was THEN.
 * `ensureAlbum` rewrites a tracklist on every sync and editions disagree about numbering, so
 * the check is what stops a crown being given to a slot the mirror no longer has.
 */
export async function toggleDesertIsland(
  input: ToggleDesertIslandInput,
): Promise<ActionResult<{ marked: boolean; used: number; quota: number }>> {
  return guard("toggleDesertIsland", async () => {
    const user = await requireUser();

    const parsed = toggleDesertIslandSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID_TARGET);
    const data = parsed.data;

    const resolved = await resolveTarget(data);
    if (!resolved.ok) return fail(resolved.error);
    const { target } = resolved.value;

    const missing = await targetExistenceRefusal(resolved.value);
    if (missing) return fail(missing);

    // Narrowing for the rule engine's non-null target type. `resolveTarget` guarantees all
    // three on a track target and `targetExistenceRefusal` has just proved the row exists.
    if (target.albumId == null || target.discNumber == null || target.trackNumber == null) {
      return fail("Unknown track.");
    }
    const mark = { albumId: target.albumId, discNumber: target.discNumber, trackNumber: target.trackNumber };

    const result = data.crowned
      ? // `artistId` comes from the album row that `resolveTarget` read, never from the request.
        await crownTrack(user.id, { ...mark, artistId: target.artistId })
      : await uncrownTrack(user.id, mark);

    if (!result.ok) {
      return fail(
        result.reason === "not-five-star"
          ? "Give it five stars first — the Desert Island is only for those."
          : `Your Desert Island is full at ${DESERT_ISLAND_QUOTA}. Clear one to make room.`,
      );
    }

    revalidateLogSurfaces(user.username);
    return ok({ marked: result.marked, used: result.used, quota: DESERT_ISLAND_QUOTA });
  });
}

"use server";

/**
 * Lists — eight writes, one authorization rule, and one deliberate exception to it.
 *
 * THE ONE STRUCTURAL DIFFERENCE FROM THE SOURCE IS THAT `list_items` IS POLYMORPHIC. There a
 * list item can only hold a series; here it carries the same target columns `logs` does, so a
 * list can be a playlist — which is the obvious primary use case for a music site. Three
 * consequences land in this file: the target has to be resolved and verified rather than taken
 * as an id (`resolveTarget`), `targetType` is DERIVED by `targetTypeOf()` and never accepted
 * from a caller, and the duplicate-prevention index is an expression index that
 * `onConflictDoNothing()` must be left UNTARGETED to use.
 *
 * THIS IS A `"use server"` MODULE, SO EVERY EXPORT IS A PUBLIC HTTP ENDPOINT. `loadOwnList`,
 * `resolveTarget`, `appendItem` and `createListRow` are unexported for that reason and not as
 * a style preference: exporting `appendItem` would publish a list write that no `guard()`
 * covers — no rate limit, no verification gate, no ownership check.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getMaxPosition } from "@/lib/db/queries/lists";
import { type List, type TargetType, albums, artists, listItems, lists, tracks } from "@/lib/db/schema";
import {
  type TargetInput,
  listDescription,
  listIdSchema,
  listTitleSchema,
  noteSchema,
  targetSchema,
  targetTypeOf,
} from "@/lib/security/schemas";
import { MAX_DB_INT, listSlug } from "@/lib/slug";

import { type ActionResult, fail, guard, ok } from "./result";

/* ========================================================================== *
 * CONSTANTS AND INPUT SCHEMAS
 * ========================================================================== */

/**
 * The one id bound this module declares for itself.
 *
 * `lib/security/schemas.ts` holds six bounded id schemas and none of them is a `list_items`
 * id, so there is nothing to import. THE BOUND ITSELF IS STILL NOT COPIED: `MAX_DB_INT` comes
 * from `lib/slug.ts`, where it is declared once, because the failure being prevented is I-5 —
 * an id above int4 range reaches Postgres as "value out of range for type integer", a 500
 * where a refusal belongs. If a second module ever needs this, it moves to the shared library
 * rather than being written twice.
 */
const listItemIdSchema = z.int().min(1, "Unknown list item.").max(MAX_DB_INT, "Unknown list item.");

/**
 * The reorder cap, inherited from the source's 500.
 *
 * The number is kept but its cost is not: there it bought up to 500 sequential round trips for
 * one rate-limit token, here it buys one statement (see `reorderList`). 500 is far above any
 * real list rendered with up/down buttons and low enough that the `VALUES` list stays a
 * sensible statement size; the bound exists so a crafted payload cannot make one token build
 * an arbitrarily large statement.
 */
const MAX_REORDER_ITEMS = 500;

const createInput = z.object({
  title: listTitleSchema,
  description: listDescription.optional(),
  isRanked: z.boolean().optional(),
  isPublic: z.boolean().optional(),
});

/**
 * PATCH SEMANTICS (I-1 / SEC-01): `undefined` means "leave this column alone", an explicit
 * `null` clears it. Hence `.nullable().optional()` on the description — the two are different
 * instructions and collapsing them is how the source's rating click erased a member's review.
 */
const updateInput = z.object({
  listId: listIdSchema,
  title: listTitleSchema.optional(),
  description: listDescription.nullable().optional(),
  isRanked: z.boolean().optional(),
  isPublic: z.boolean().optional(),
});

const listOnlyInput = z.object({ listId: listIdSchema });

const addInput = z.object({
  listId: listIdSchema,
  target: targetSchema,
  note: noteSchema.optional(),
});

const removeInput = z.object({ listId: listIdSchema, itemId: listItemIdSchema });

const reorderInput = z.object({
  listId: listIdSchema,
  itemIds: z
    .array(listItemIdSchema)
    .min(1, "Nothing to reorder.")
    .max(MAX_REORDER_ITEMS, "That is too many items to reorder at once."),
});

const quickAddInput = z.object({
  title: listTitleSchema,
  target: targetSchema,
  note: noteSchema.optional(),
});

export type CreateListInput = z.infer<typeof createInput>;
export type UpdateListInput = z.infer<typeof updateInput>;
export type DeleteListInput = z.infer<typeof listOnlyInput>;
export type AddToListInput = z.infer<typeof addInput>;
export type RemoveFromListInput = z.infer<typeof removeInput>;
export type ReorderListInput = z.infer<typeof reorderInput>;
export type CloneListInput = z.infer<typeof listOnlyInput>;
export type QuickAddToListInput = z.infer<typeof quickAddInput>;

/* ========================================================================== *
 * THE ONE AUTHORIZATION RULE
 * ========================================================================== */

type OwnedList = { ok: true; list: List } | { ok: false; error: string };

/**
 * THE ONLY AUTHORIZATION IN THIS FILE, and every mutation except `cloneList` starts with it:
 *
 *     const existing = await db.query.lists.findFirst({ where: eq(lists.id, listId) });
 *     if (!existing) return fail("That list no longer exists.");
 *     if (existing.userId !== user.id) return fail("That is not your list.");
 *
 * OWNERSHIP IS ALWAYS COMPARED AGAINST THE SESSION ID, never against anything the caller sent.
 * There is no role, no collaborator table and no share link; a list has exactly one writer.
 *
 * The source copy-pastes those three lines into every mutation and the brief presents the
 * identity as the virtue. It is a helper here instead, because a helper makes "identical in
 * every mutation" structural rather than a property somebody has to keep re-establishing: you
 * cannot half-apply it, you cannot apply the existence line and forget the ownership line, and
 * the two messages cannot drift apart between actions. It returns a result rather than
 * throwing so that each action's refusal stays a plain `fail()` on the action's own line, which
 * is what makes the ordering of checks readable at the call site.
 *
 * THE TWO DISTINCT MESSAGES CONFIRM THE EXISTENCE OF A PRIVATE LIST ID to a non-owner calling
 * a WRITE action, which is asymmetric with the read path — `canViewList` plus a uniform 404,
 * so a reader learns nothing. ACCEPTED, because list ids are already enumerable from the public
 * listings, and because "that is not your list" is the only message that tells a member with
 * two accounts what actually happened. Note the asymmetry is the other way around in
 * `app/actions/social.ts`, where any member can name any list id: there both cases share one
 * message, because there it really would be an oracle.
 *
 * The whole row is selected, not a projection, because `updateList` needs `title` to decide
 * whether to regenerate the slug and `cloneList`-adjacent callers want `isPublic` for
 * revalidation. One row by primary key; narrowing it would buy nothing measurable.
 */
async function loadOwnList(listId: number, userId: number): Promise<OwnedList> {
  const existing = await db.query.lists.findFirst({ where: eq(lists.id, listId) });
  if (!existing) return { ok: false, error: "That list no longer exists." };
  if (existing.userId !== userId) return { ok: false, error: "That is not your list." };
  return { ok: true, list: existing };
}

/* ========================================================================== *
 * TARGET RESOLUTION — I-19
 * ========================================================================== */

/** The `list_items` target columns, all resolved and all verified against the mirror. */
type ResolvedTarget = {
  targetType: TargetType;
  artistId: number;
  albumId: number | null;
  discNumber: number | null;
  trackNumber: number | null;
};

type ResolvedTargetResult = { ok: true; target: ResolvedTarget } | { ok: false; error: string };

/**
 * Turns a client target into the row `list_items` wants, and refuses anything that does not
 * exist in the mirror.
 *
 * TWO RULES, BOTH INHERITED FROM `saveLog` BECAUSE `list_items` CARRIES THE SAME COLUMNS `logs`
 * DOES:
 *
 *   1. `targetType` IS DERIVED by `targetTypeOf()` and never read from the request. The column
 *      is a `varchar(8)` with no check constraint, so a caller who could set it could write
 *      `target_type = 'album'` on a row carrying a track number, and `getListItems` would then
 *      resolve it into the wrong display shape.
 *   2. `artist_id` IS RESOLVED FROM THE ALBUM OR TRACK ROW and never read from the request.
 *      That closes "file a track under the wrong artist" without needing its own check — and
 *      it matters more here than for a log, because `list_items.artist_id` is NOT NULL and is
 *      what the mosaic borrows an artist picture from.
 *
 * EXISTENCE IS VERIFIED (I-19). Without it a crafted call puts a row for disc 3 track 91 of a
 * 12-track record into a list, where it renders as a nameless row linking to a 404. `album_id`
 * and `artist_id` have foreign keys and would fail at INSERT anyway, but a foreign-key
 * violation surfaces as the flat "Something went wrong" — and `(disc_number, track_number)`
 * have no key at all, so for the track tier this read is the only thing standing there.
 *
 * IT DELIBERATELY DOES NOT CALL `ensureAlbumById`. A list add is always initiated from a
 * surface that has already ingested the target, so a provider round trip here would add
 * latency and an outbound-budget dependency to a write whose row is certain to be local
 * already. A miss is a refusal, not a fetch.
 */
async function resolveTarget(input: TargetInput): Promise<ResolvedTargetResult> {
  const targetType = targetTypeOf(input);

  if (targetType === "artist") {
    if (input.artistId === undefined) return { ok: false, error: "Unknown artist." };

    const row = await db.query.artists.findFirst({
      where: eq(artists.id, input.artistId),
      columns: { id: true },
    });
    if (!row) return { ok: false, error: "That artist is not in the catalogue." };

    return {
      ok: true,
      target: { targetType, artistId: row.id, albumId: null, discNumber: null, trackNumber: null },
    };
  }

  // `targetTypeOf` only reaches the album and track tiers when `albumId` is present, but the
  // input type does not know that, and an assertion here would be a second, weaker copy of the
  // rule that function owns.
  if (input.albumId === undefined) return { ok: false, error: "Unknown album." };
  const albumId = input.albumId;

  if (targetType === "album") {
    const row = await db.query.albums.findFirst({
      where: eq(albums.id, albumId),
      columns: { id: true, artistId: true },
    });
    if (!row) return { ok: false, error: "That album is not in the catalogue." };

    return {
      ok: true,
      target: { targetType, artistId: row.artistId, albumId: row.id, discNumber: null, trackNumber: null },
    };
  }

  if (input.trackNumber === undefined) return { ok: false, error: "Unknown track." };

  /**
   * THE DISC DEFAULTS TO 1, and it has to default rather than refuse. `parseTrackLocator("7")`
   * yields `{ disc: 1, track: 7 }` — a single-disc album never carries a redundant "1-" in its
   * URL — and `tracks.disc_number` itself defaults to 1, so 1 is what "no disc given" means
   * everywhere else in the system. Refusing instead would make every single-disc track add
   * depend on a component remembering to send a number the URL does not contain.
   *
   * Rejected alternative: look the track up by `(album_id, track_number)` alone when no disc
   * arrives. On a double LP that matches two different tracks and picks one arbitrarily.
   */
  const discNumber = input.discNumber ?? 1;

  // `tracks.artist_id` is denormalised (it is the album's artist), so this one read answers
  // both existence and the anchor.
  const row = await db.query.tracks.findFirst({
    where: and(
      eq(tracks.albumId, albumId),
      eq(tracks.discNumber, discNumber),
      eq(tracks.trackNumber, input.trackNumber),
    ),
    columns: { artistId: true },
  });
  if (!row) return { ok: false, error: "That track is not in the catalogue." };

  return {
    ok: true,
    target: { targetType, artistId: row.artistId, albumId, discNumber, trackNumber: input.trackNumber },
  };
}

/* ========================================================================== *
 * UNGUARDED INTERNALS
 *
 * These are the shared bodies `addToList` and `quickAddToList` both need. THE SOURCE HAS
 * `quickAddToList` CALL `addToList` DIRECTLY, so `guard()` runs twice for one user gesture:
 * two rate-limit tokens off a 120/60s budget and two `assertEmailVerified` reads, for one
 * click on "add to a new list". Factoring the body out is the fix, and the same shape is what
 * `markDiscographyListened` uses for the same reason (source defect #5).
 * ========================================================================== */

/**
 * Appends one item and bumps the list's timestamp.
 *
 * POSITION IS `max(position) + 1` COMPUTED IN A SEPARATE STATEMENT, OUTSIDE ANY TRANSACTION,
 * AND THAT IS LEGAL because the unique index is on the target tuple — not on
 * `(list_id, position)`. Two concurrent adds therefore read the same maximum and land on the
 * SAME position, which produces two valid rows that `getListItems` renders in `(position, id)`
 * order. Nothing is wrong and nothing needs locking.
 *
 * Rejected alternative: a uniqueness constraint on `(list_id, position)` plus a transaction per
 * add. It converts a harmless tie into a failed save that the member sees, and it makes
 * `reorderList` need a per-move transaction to avoid transient collisions mid-shuffle.
 *
 * `onConflictDoNothing()` IS UNTARGETED ON PURPOSE. The duplicate-prevention index is an
 * EXPRESSION index — `coalesce(album_id, 0)`, `coalesce(disc_number, 0)`,
 * `coalesce(track_number, 0)` — because a plain index over those columns would not dedupe
 * album-level items at all: their ordinals are NULL and Postgres treats NULLs as distinct, so
 * the same album could be added to one list any number of times. A targeted
 * `onConflictDoNothing({ target: [...] })` would have to restate that expression list exactly,
 * and the untargeted form covers every index on the table, which is the one we want.
 *
 * A RE-ADD THEREFORE DOES NOTHING TO THE ROW — position and note are preserved, which is the
 * behaviour you want when somebody clicks "add" twice on an item they already curated — BUT
 * `lists.updatedAt` IS STILL BUMPED, so the list jumps to the top of every `desc(updatedAt)`
 * listing for an add that changed nothing. Inherited knowingly: the alternative is reading the
 * insert's row count to decide whether to bump, and a list whose ordering silently ignores
 * some of its owner's edits is the more confusing of the two.
 */
async function appendItem(listId: number, target: ResolvedTarget, note: string | null): Promise<void> {
  const position = (await getMaxPosition(listId)) + 1;

  await db
    .insert(listItems)
    .values({ listId, ...target, position, note })
    .onConflictDoNothing();

  await db.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, listId));
}

/**
 * Inserts a list row and gives it its slug.
 *
 * ONE TRANSACTION, because the slug embeds the row's own serial id (`kid-a-42`) and that id
 * does not exist until the insert returns. A row left with the placeholder slug would have no
 * usable URL: `parseListSlug` reads only the trailing integer, so `/list/` parses to null and
 * the member's new list 404s.
 *
 * Rejected alternatives: peeking at the sequence with `nextval` before the insert, which
 * couples this action to a sequence name drizzle chose; and letting the client send the slug,
 * which is letting the client send a URL.
 *
 * `lists.slug` has no uniqueness constraint at any scope and is regenerated from the title on
 * every update, so it is neither unique nor stable — nothing reads it as a key. Do not add the
 * constraint; it would break `updateList` for no benefit.
 */
async function createListRow(
  userId: number,
  values: {
    title: string;
    description: string | null;
    isRanked: boolean;
    isPublic: boolean;
    clonedFromId?: number | null;
  },
): Promise<{ id: number; slug: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(lists)
      .values({ ...values, userId, slug: "" })
      .returning({ id: lists.id });
    if (!row) throw new Error("list insert returned no row");

    const slug = listSlug(values.title, row.id);
    await tx.update(lists).set({ slug }).where(eq(lists.id, row.id));

    return { id: row.id, slug };
  });
}

/**
 * A trimmed-empty text field becomes SQL NULL rather than an empty string, so "has a
 * description" is one test (`IS NOT NULL`) everywhere instead of two. Same normalisation
 * `saveLog` applies to a whitespace-only review, for the same reason: an empty string renders
 * as an empty paragraph and counts as content in every `length > 0` check.
 */
function blankToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value.length > 0 ? value : null;
}

/**
 * The three surfaces a list write can change: the list itself, the owner's profile subtree
 * (which carries their list count and their `/lists` tab), and the public listing.
 *
 * `/list/[slug]` is THE ROUTE PATTERN WITH A TYPE ARGUMENT, not an interpolated path: a list's
 * URL carries a slug regenerated from its title, so the concrete path is not something these
 * actions reliably know — and `revalidatePath("/list/17")` would revalidate a URL that is
 * legal but is not the one anybody navigated to. The profile path IS interpolated, because the
 * username is in the session and `usernameSchema`'s `[a-zA-Z0-9_]` allowlist is what makes
 * putting it in a path argument safe.
 *
 * The public listing is touched only when the list is actually public, so editing a private
 * list does not reach a surface it never appeared on.
 */
function revalidateListSurfaces(username: string, isPublic: boolean): void {
  revalidatePath("/list/[slug]", "layout");
  revalidatePath(`/@${username}`, "layout");
  if (isPublic) revalidatePath("/lists");
}

/* ========================================================================== *
 * THE ACTIONS
 * ========================================================================== */

/**
 * A new list. `requireUser`, not `requireMember` — a guest may curate; guests are refused on
 * exactly three things (follow, like, comment) and all three involve another person.
 *
 * `isPublic` defaults to TRUE, matching the column default. A list is a thing you make to show
 * somebody.
 */
export async function createList(input: CreateListInput): Promise<ActionResult<{ listId: number; slug: string }>> {
  return guard("createList", async () => {
    const user = await requireUser();

    const parsed = createInput.safeParse(input);
    if (!parsed.success) return fail("That list does not look right.");
    const { title, description, isRanked, isPublic } = parsed.data;

    const created = await createListRow(user.id, {
      title,
      description: blankToNull(description),
      isRanked: isRanked ?? false,
      isPublic: isPublic ?? true,
    });

    revalidateListSurfaces(user.username, isPublic ?? true);

    return ok({ listId: created.id, slug: created.slug });
  });
}

/**
 * Rename, re-describe, re-rank or re-publish a list.
 *
 * THIS ACTION HAS NO CALLER IN THE SOURCE — one of three server capabilities there whose UI was
 * never built (source defect #8), which is why `/list/[slug]/edit` exists in this build. An
 * action nobody can reach is an action nobody tests and nobody notices rotting.
 *
 * PATCH SEMANTICS (I-1): only the fields that arrived are written, so a form that posts a
 * title cannot blank a description it never displayed. `updatedAt` is always set, because
 * every branch here is an edit.
 *
 * THE SLUG IS REGENERATED ONLY WHEN THE TITLE ARRIVES, which changes the list's canonical URL.
 * That is safe precisely because nothing reads the slug as a key — `parseListSlug` throws it
 * away and keeps the trailing id — so old links keep resolving.
 */
export async function updateList(input: UpdateListInput): Promise<ActionResult> {
  return guard("updateList", async () => {
    const user = await requireUser();

    const parsed = updateInput.safeParse(input);
    if (!parsed.success) return fail("That list does not look right.");
    const { listId, title, description, isRanked, isPublic } = parsed.data;

    const owned = await loadOwnList(listId, user.id);
    if (!owned.ok) return fail(owned.error);

    const patch: {
      updatedAt: Date;
      title?: string;
      slug?: string;
      description?: string | null;
      isRanked?: boolean;
      isPublic?: boolean;
    } = { updatedAt: new Date() };

    if (title !== undefined) {
      patch.title = title;
      patch.slug = listSlug(title, listId);
    }
    // `description` distinguishes absent from null on purpose: absent leaves the column alone,
    // an explicit null clears it, and a string of spaces becomes null rather than whitespace.
    if (description !== undefined) patch.description = blankToNull(description);
    if (isRanked !== undefined) patch.isRanked = isRanked;
    if (isPublic !== undefined) patch.isPublic = isPublic;

    await db.update(lists).set(patch).where(eq(lists.id, listId));

    // Both states, because flipping the flag changes whether it belongs in the public listing
    // at all: revalidating only the new state leaves a just-privatised list on `/lists`.
    revalidateListSurfaces(user.username, owned.list.isPublic || (isPublic ?? false));

    return ok();
  });
}

/**
 * Delete a list. Verification-exempt: a self-scoped deletion nobody else can see the effect of
 * should not be held hostage to slow mail.
 *
 * `list_items` goes with it through `ON DELETE CASCADE`. LIKES AND COMMENTS ON THE LIST DO NOT:
 * `likes.target_id` and `comments.target_id` are polymorphic and therefore carry no foreign
 * key, so those rows are orphaned by design and collected by `GET /api/cron/prune`. Adding a
 * delete for them here would be a second, partial copy of the prune job's rule — and it would
 * still miss the rows orphaned by a cascade from `users`.
 */
export async function deleteList(input: DeleteListInput): Promise<ActionResult> {
  return guard("deleteList", async () => {
    const user = await requireUser();

    const parsed = listOnlyInput.safeParse(input);
    if (!parsed.success) return fail("That list no longer exists.");
    const { listId } = parsed.data;

    const owned = await loadOwnList(listId, user.id);
    if (!owned.ok) return fail(owned.error);

    await db.delete(lists).where(eq(lists.id, listId));

    revalidateListSurfaces(user.username, owned.list.isPublic);

    return ok();
  });
}

/** Add an artist, an album or a track to one of your own lists. */
export async function addToList(input: AddToListInput): Promise<ActionResult> {
  return guard("addToList", async () => {
    const user = await requireUser();

    const parsed = addInput.safeParse(input);
    if (!parsed.success) return fail("That does not look like something we can add.");
    const { listId, target, note } = parsed.data;

    const owned = await loadOwnList(listId, user.id);
    if (!owned.ok) return fail(owned.error);

    const resolved = await resolveTarget(target);
    if (!resolved.ok) return fail(resolved.error);

    await appendItem(listId, resolved.target, blankToNull(note));

    revalidateListSurfaces(user.username, owned.list.isPublic);

    return ok();
  });
}

/**
 * Remove one item from one of your own lists. Verification-exempt, like every other
 * self-scoped removal.
 *
 * THE DELETE IS SCOPED BY `list_id` AS WELL AS BY THE ITEM ID, and that is the authorization,
 * not a redundancy. `loadOwnList` proved the caller owns THIS list; a delete by item id alone
 * would let the owner of list A pass any item id in the table — including one from a
 * stranger's list — and have it removed, because `list_items` has no user column of its own to
 * compare against. Nothing else in this file notices if that predicate is dropped.
 */
export async function removeFromList(input: RemoveFromListInput): Promise<ActionResult> {
  return guard("removeFromList", async () => {
    const user = await requireUser();

    const parsed = removeInput.safeParse(input);
    if (!parsed.success) return fail("That item is no longer on the list.");
    const { listId, itemId } = parsed.data;

    const owned = await loadOwnList(listId, user.id);
    if (!owned.ok) return fail(owned.error);

    await db.delete(listItems).where(and(eq(listItems.id, itemId), eq(listItems.listId, listId)));

    await db.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, listId));

    revalidateListSurfaces(user.username, owned.list.isPublic);

    return ok();
  });
}

/**
 * Rewrite the positions of a list from an ordered array of item ids.
 *
 * THIS ACTION HAS NO CALLER IN THE SOURCE either (defect #8). The edit surface here drives it
 * with up/down buttons — keyboard-operable, no drag-and-drop dependency — which is why it
 * takes the WHOLE ordered array rather than a single move: one press then sends one action call
 * describing the finished order, and a dropped or reordered pair of calls cannot leave the list
 * in a state neither press asked for.
 *
 * ONE TRANSACTION, AND INSIDE IT ONE STATEMENT RATHER THAN N. The source awaits an `UPDATE` per
 * id, sequentially, with no transaction and a cap of 500 — so one rate-limit token buys up to
 * 500 round trips, and a failure at item 300 leaves a half-reordered list, which on a ranked
 * list reads as the ranking being wrong rather than as a failed save. A single
 * `UPDATE … FROM (VALUES …)` is one round trip whatever the length, and the transaction is
 * what keeps the positions and the timestamp in step.
 *
 * THE `::int` CASTS ARE MANDATORY. Bound parameters in a `VALUES` list arrive with no inferred
 * type, so `ordering.id` comes back as text and `list_items.id = ordering.id` fails with
 * "operator does not exist: integer = text". The SET target is written out literally rather
 * than interpolated from the column object because Postgres requires it unqualified —
 * drizzle would render `"list_items"."position"`, which is a syntax error there.
 *
 * IDS ARE DEDUPED IN JS FIRST (the same habit as I-7). `UPDATE … FROM` with a join that
 * matches one target row twice does not error; it picks one of the candidate rows arbitrarily,
 * which would make the resulting order depend on the plan.
 *
 * Two accepted behaviours: an id that does not belong to this list is ignored, because the
 * `list_id` predicate is also the authorization (see `removeFromList`); and an item omitted
 * from the array keeps its old position, so it can tie with a new one — which
 * `getListItems`' `(position, id)` ordering resolves deterministically.
 */
export async function reorderList(input: ReorderListInput): Promise<ActionResult> {
  return guard("reorderList", async () => {
    const user = await requireUser();

    const parsed = reorderInput.safeParse(input);
    if (!parsed.success) return fail("That order does not look right.");
    const { listId, itemIds } = parsed.data;

    const owned = await loadOwnList(listId, user.id);
    if (!owned.ok) return fail(owned.error);

    const ids = [...new Set(itemIds)];
    if (ids.length === 0) return fail("Nothing to reorder.");

    const rows = sql.join(
      ids.map((id, index) => sql`(${id}::int, ${index + 1}::int)`),
      sql`, `,
    );

    await db.transaction(async (tx) => {
      await tx.execute(sql`
        update ${listItems}
        set "position" = ordering."position"
        from (values ${rows}) as ordering("id", "position")
        where ${listItems.id} = ordering."id" and ${listItems.listId} = ${listId}
      `);
      await tx.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, listId));
    });

    revalidateListSurfaces(user.username, owned.list.isPublic);

    return ok();
  });
}

/**
 * Copy somebody's list into your own account.
 *
 * THE DELIBERATE EXCEPTION TO THE ONE AUTHORIZATION RULE, AND IT INVERTS IT: ownership is not
 * required, PUBLICITY is. A public list belonging to anyone may be cloned, which is the whole
 * feature — cloning is how a list travels.
 *
 *     if (!source.isPublic && source.userId !== user.id) return fail("That list is private.");
 *
 * `source.userId !== user.id` is still in the test, so you can also clone your OWN private
 * list. The clone button is hidden for your own lists in the UI — "cloning your own list would
 * just duplicate it, which nobody means to do" — but the action permits it, because the second
 * half of that condition is what lets a private list be duplicated as a starting point by the
 * only person who can see it.
 *
 * `isPublic: true` IS HARD-CODED REGARDLESS OF THE SOURCE. A clone of your own private list is
 * therefore public, which is the one surprising consequence and is inherited deliberately:
 * cloning is a publishing gesture, and a clone that silently inherited "private" would sit
 * invisible on the cloner's profile with nothing to explain why.
 *
 * `clonedFromId` HAS NO FOREIGN KEY, on purpose, so a clone survives its source being deleted.
 * It is a provenance note, not a relationship.
 */
export async function cloneList(input: CloneListInput): Promise<ActionResult<{ listId: number; slug: string }>> {
  return guard("cloneList", async () => {
    const user = await requireUser();

    const parsed = listOnlyInput.safeParse(input);
    if (!parsed.success) return fail("That list no longer exists.");
    const { listId } = parsed.data;

    const source = await db.query.lists.findFirst({ where: eq(lists.id, listId) });
    if (!source) return fail("That list no longer exists.");
    if (!source.isPublic && source.userId !== user.id) return fail("That list is private.");

    // Read the items BEFORE creating the clone, so a source that has since been emptied does
    // not leave an empty list behind under a title the member did not choose to create.
    // Ordered by `(position, id)` for the same reason `getListItems` is: concurrent adds to the
    // source legitimately share a position, and without the tiebreak the clone's order would
    // differ from the order the cloner was looking at.
    const items = await db
      .select({
        targetType: listItems.targetType,
        artistId: listItems.artistId,
        albumId: listItems.albumId,
        discNumber: listItems.discNumber,
        trackNumber: listItems.trackNumber,
        position: listItems.position,
        note: listItems.note,
      })
      .from(listItems)
      .where(eq(listItems.listId, source.id))
      .orderBy(asc(listItems.position), asc(listItems.id));

    const created = await createListRow(user.id, {
      // The title is copied verbatim — no "(copy)" suffix. Two lists with the same title are
      // legal (nothing about `lists.title` is unique) and the cloner is about to rename it or
      // is not, either of which is their business.
      title: source.title,
      description: source.description,
      isRanked: source.isRanked,
      isPublic: true,
      clonedFromId: source.id,
    });

    if (items.length > 0) {
      // ONE multi-row insert, not one per item. No `onConflictDoNothing` needed: the source's
      // own unique index already guarantees these tuples are distinct from each other, and the
      // list they are going into was created two statements ago and is empty.
      //
      // `IN ()`-shaped hazard, inverted: an empty `VALUES` list is invalid SQL too, which is
      // what the length guard above is for.
      await db.insert(listItems).values(items.map((item) => ({ ...item, listId: created.id })));
    }

    revalidateListSurfaces(user.username, true);

    return ok({ listId: created.id, slug: created.slug });
  });
}

/**
 * Create-or-append by title: the "add to a new list" path from an album, artist or track page.
 *
 * MATCHED CASE-INSENSITIVELY AGAINST THE CALLER'S OWN LISTS ONLY. Somebody typing "Best of
 * 1979" twice means the same list both times; somebody else's "Best of 1979" is not theirs to
 * append to. There is no supporting index for `lower(title)` and none is added: the predicate
 * is `user_id = $1 AND lower(title) = lower($2)`, and `lists_user_updated_idx` already narrows
 * that to one member's own lists — a handful of rows — so the function call is evaluated over
 * a set small enough not to matter. A functional index on `(user_id, lower(title))` is the fix
 * if a member ever holds thousands.
 *
 * `=`, NOT `LIKE`, so `lib/like.ts`'s wildcard escaping does not apply here (I-6 is about
 * `LIKE`/`ILIKE` patterns). The title is a bound parameter either way.
 *
 * IT DOES NOT CALL `addToList`, AND THAT IS THE POINT. The source does, so `guard()` runs
 * twice for one gesture: two rate-limit tokens and two `assertEmailVerified` reads for one
 * click. Both paths below call the same unguarded internals inside this single `guard()`.
 *
 * `created` comes back so the confirmation can say which of the two things happened without
 * the client having to guess from a list of titles it may not have loaded.
 */
export async function quickAddToList(
  input: QuickAddToListInput,
): Promise<ActionResult<{ listId: number; created: boolean }>> {
  return guard("quickAddToList", async () => {
    const user = await requireUser();

    const parsed = quickAddInput.safeParse(input);
    if (!parsed.success) return fail("That list does not look right.");
    const { title, target, note } = parsed.data;

    // The target is resolved BEFORE anything is created, so a bad target cannot leave an empty
    // list behind under a title the member will then have to delete.
    const resolved = await resolveTarget(target);
    if (!resolved.ok) return fail(resolved.error);

    const [match] = await db
      .select({ id: lists.id, isPublic: lists.isPublic })
      .from(lists)
      .where(and(eq(lists.userId, user.id), sql`lower(${lists.title}) = lower(${title})`))
      // Most recently touched first, matching `getListOptions`: the list somebody is curating
      // now is the one they mean if two of theirs somehow share a title.
      .orderBy(desc(lists.updatedAt))
      .limit(1);

    if (match) {
      await appendItem(match.id, resolved.target, blankToNull(note));
      revalidateListSurfaces(user.username, match.isPublic);
      return ok({ listId: match.id, created: false });
    }

    const created = await createListRow(user.id, {
      title,
      description: null,
      isRanked: false,
      isPublic: true,
    });

    await appendItem(created.id, resolved.target, blankToNull(note));

    revalidateListSurfaces(user.username, true);

    return ok({ listId: created.id, created: true });
  });
}

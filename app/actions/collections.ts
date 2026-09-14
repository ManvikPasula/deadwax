"use server";

import { revalidatePath } from "next/cache";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { type ActionResult, fail, guard, ok } from "@/app/actions/result";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { favorites, wantlist } from "@/lib/db/schema";
import { ensureAlbumById } from "@/lib/ingest/albums";
import { albumIdSchema, noteSchema } from "@/lib/security/schemas";

/**
 * THE TWO PERSONAL COLLECTIONS: the wantlist (television's watchlist) and the pinned Top Four.
 *
 * Both are keyed by the SESSION user and nothing else — there is no id in any payload here that
 * names an owner, which is why none of these actions needs an ownership check. That is not an
 * omission; it is the reason the tables are shaped the way they are. An action that took an
 * owner id would need `assertVisible`-style plumbing and would be one forgotten check away from
 * letting somebody rearrange another member's profile.
 *
 * `lists.ts` owns the list actions. These three are here because they write single-purpose
 * tables with no titles, no descriptions and no visibility of their own.
 */

/**
 * The flat parse failure, and it is never `parsed.error` — a Zod error tree names every field,
 * its expected type and its bound, which on a payload only a crafted call can produce is a free
 * description of the server's own shape.
 *
 * The identical sentence appears in app/actions/logs.ts. It is a copy because it cannot be
 * anything else: every export of a `"use server"` module must be an async function, so neither
 * file can export the string, and app/actions/result.ts owns `GENERIC_FAILURE` but deliberately
 * not the per-action copy. Two identical literals is the cheapest form of that constraint.
 */
const INVALID = "That does not look right.";

/**
 * FOUR SLOTS. `favorites.position` is a `smallint` documented as 1..4 in lib/db/schema.ts and
 * there is no check constraint behind it — the closed value set is enforced here, by Zod, which
 * is the schema's stated bargain for having no enums.
 *
 * DECLARED HERE RATHER THAN IN lib/security/schemas.ts only because that module has no slot
 * rule today. If a second caller ever needs one — a profile editor that validates a drag
 * target, say — MOVE IT THERE rather than copying it, because a second copy of "1..4" beside a
 * second caller is how the original ended up with two password schemas that disagreed.
 *
 * Four rather than five or six because the profile renders them as a single row of covers at
 * every breakpoint; a fifth slot wraps on a phone and the row stops reading as a set.
 */
const FAVORITE_SLOTS = 4;
const slotSchema = z.int().min(1, "Unknown slot.").max(FAVORITE_SLOTS, "Unknown slot.");

/**
 * AN EXPLICIT DESIRED STATE, NOT A FLIP, and the three toggles in this application agree about
 * it (`toggleTrackListened` takes `listened`, `toggleDesertIsland` takes `crowned`).
 *
 * A read-then-invert action makes a double-click a silent no-op that reports success: the
 * second request reads the state the first one wrote, flips it back, and the member is told
 * twice that it worked while the row ends up in the state they did not ask for. Sending the
 * state the member asked for makes the request idempotent and makes an optimistic rollback
 * meaningful, because the client already knows what it asked for.
 */
const toggleWantlistSchema = z.object({
  albumId: albumIdSchema,
  wanted: z.boolean(),
  /** Absent leaves an existing note alone; `""` clears it. The same rule as `saveLog`'s patch. */
  note: noteSchema.optional(),
});

const setFavoriteSchema = z.object({ position: slotSchema, albumId: albumIdSchema });
const clearFavoriteSchema = z.object({ position: slotSchema });

export type ToggleWantlistInput = z.input<typeof toggleWantlistSchema>;
export type SetFavoriteInput = z.input<typeof setFavoriteSchema>;
export type ClearFavoriteInput = z.input<typeof clearFavoriteSchema>;

/**
 * The wantlist toggle renders ON THE ALBUM PAGE as a server-rendered filled/empty state, so the
 * album segment tree is in the list; `"/album/[slug]"` is the ROUTE PATTERN WITH A TYPE
 * ARGUMENT because album pages are keyed by a `<title>-<id>` slug we do not have here.
 *
 * `"/@<username>"` with `"layout"` covers the wantlist tab and the profile in one call.
 * Interpolating the username is safe for the reason `usernameSchema` is an allowlist rather
 * than a denylist: nothing outside `[a-zA-Z0-9_]` can reach that column.
 */
function revalidateWantlistSurfaces(username: string): void {
  revalidatePath("/album/[slug]", "layout");
  revalidatePath(`/@${username}`, "layout");
}

/**
 * THE TOP FOUR RENDERS ONLY ON THE PROFILE, so only the member's tree is revalidated. The album
 * page carries no "this is in your Top Four" state, and adding `"/album/[slug]"` here would be
 * a path revalidated for a surface that shows nothing — which is the decorative-coverage defect
 * the television version's dead `revalidatePath("/show/${id}")` is an example of.
 */
function revalidateFavoriteSurfaces(username: string): void {
  revalidatePath(`/@${username}`, "layout");
}

/* ========================================================================== *
 * The wantlist
 * ========================================================================== */

/**
 * PK `(user_id, album_id)`, so the write is an UPSERT rather than a read-then-insert.
 *
 * `isWanted()` in lib/db/queries/users.ts answers "is this on the list" for the read path and is
 * deliberately NOT called here: a read before the write would open a window in which two tabs
 * both see "absent" and both insert, and the recovery is a 23505 that `guard()` flattens into
 * "Something went wrong" on an operation that succeeded. `ON CONFLICT` has no window.
 *
 * `albums.is_canonical` IS NOT APPLIED — the same decision `getWantlist` documents. A wantlist
 * is a member's own queue, not a completion denominator, and somebody who wants the deluxe
 * reissue wants the deluxe reissue. This is one of the few places the specials exclusion is
 * wrong rather than merely unnecessary.
 *
 * NO RELEASE-DATE GATE. Wanting an announced record is the whole point of a wantlist; the gate
 * exists for the diary, where a date is a claim to have heard something.
 */
export async function toggleWantlist(input: ToggleWantlistInput): Promise<ActionResult<{ wanted: boolean }>> {
  // The explicit type argument widens `wanted` from the literal each branch returns to the
  // `boolean` the signature promises; without it the two arms infer `true` and `false` and
  // neither matches the other.
  return guard<{ wanted: boolean }>("toggleWantlist", async () => {
    const user = await requireUser();

    const parsed = toggleWantlistSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID);
    const data = parsed.data;

    if (!data.wanted) {
      // No `ensureAlbum` on the removal path: nothing is published, and making a removal depend
      // on a provider round trip is how a removal fails when the provider is down.
      await db.delete(wantlist).where(and(eq(wantlist.userId, user.id), eq(wantlist.albumId, data.albumId)));
      revalidateWantlistSurfaces(user.username);
      return ok({ wanted: false });
    }

    const album = await ensureAlbumById(data.albumId);
    if (!album) return fail("We do not have that album.");

    // `noteSchema` has already trimmed, so an all-whitespace note arrives as "" — which is a
    // member clearing it, not a member writing nothing. `undefined` still means leave alone.
    const note = data.note === undefined ? undefined : data.note || null;

    const insert = db.insert(wantlist).values({ userId: user.id, albumId: album.id, note: note ?? null });
    if (note === undefined) {
      // Already on the list and no note supplied: keep the note and the original `added_at`.
      // `DO UPDATE` here would blank a note every time somebody pressed an already-pressed
      // button.
      await insert.onConflictDoNothing();
    } else {
      await insert.onConflictDoUpdate({
        target: [wantlist.userId, wantlist.albumId],
        set: { note },
      });
    }

    revalidateWantlistSurfaces(user.username);
    return ok({ wanted: true });
  });
}

/* ========================================================================== *
 * The Top Four
 * ========================================================================== */

/**
 * FAVOURITES ARE KEYED BY SLOT, NOT BY ALBUM, so the database will happily let one album occupy
 * two slots — the PK is `(user_id, position)` and nothing in it mentions the album. Pin
 * *Discovery* to slot 1, then to slot 3, and the profile renders it twice while the member
 * believes they moved it.
 *
 * IT IS PREVENTED BY DELETING ANY ROW HOLDING THAT ALBUM FOR THAT USER **BEFORE** THE SLOT
 * UPSERT. Drop, do not merge.
 *
 * **THESE ARE TWO NON-TRANSACTIONAL STATEMENTS.** A failure between them leaves the album in no
 * slot at all — the delete has committed and the upsert has not — which the member sees as a
 * pin that silently emptied its old slot and did not fill the new one. The recovery is one more
 * click, and it is recorded here rather than fixed because lib/db/schema.ts documents this
 * contract on the `favorites` table itself and the two must agree.
 *
 * **ANY SECOND WRITE PATH MUST REPEAT THE DELETE.** A reorder control, an import, a guest-merge
 * path that copies favourites — each of them re-opens the duplicate on its own, because the
 * rule lives in the calling statement rather than in an index. If a third write path ever
 * appears, the honest fix is a partial unique index on `(user_id, album_id)` and not a third
 * copy of this delete.
 */
export async function setFavorite(input: SetFavoriteInput): Promise<ActionResult> {
  return guard("setFavorite", async () => {
    const user = await requireUser();

    const parsed = setFavoriteSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID);
    const data = parsed.data;

    // The Top Four renders cover art, so the mirror has to be fresh enough to have one.
    const album = await ensureAlbumById(data.albumId);
    if (!album) return fail("We do not have that album.");

    /* ---- STATEMENT 1: drop the album from whatever slot it is in ----------------- */
    await db.delete(favorites).where(and(eq(favorites.userId, user.id), eq(favorites.albumId, album.id)));

    /* ---- STATEMENT 2: fill the requested slot ------------------------------------ */
    // `created_at` is NOT re-stamped on conflict: it records when the slot was first filled,
    // and nothing orders on it — the profile orders by `position`, which is the member's own
    // choice of order.
    await db
      .insert(favorites)
      .values({ userId: user.id, position: data.position, albumId: album.id })
      .onConflictDoUpdate({
        target: [favorites.userId, favorites.position],
        set: { albumId: album.id },
      });

    revalidateFavoriteSurfaces(user.username);
    return ok();
  });
}

/**
 * Empty one slot.
 *
 * THIS ACTION EXISTS BECAUSE ITS ABSENCE WAS A NAMED DEFECT. In the television original
 * `clearFavorite` is written and never called from anywhere, so a member who pinned four
 * records could rearrange them forever and never get back to three — the only way out was to
 * pin something they did not want. IT MUST STAY REACHABLE: the profile's favourites editor
 * renders a clear control per filled slot, and a future refactor that drops that control
 * re-creates the defect while leaving this function looking healthy.
 *
 * No `ensureAlbum`, no existence check, no album id at all. Clearing an already-empty slot
 * deletes nothing and reports success, which is what the member wanted either way.
 */
export async function clearFavorite(input: ClearFavoriteInput): Promise<ActionResult> {
  return guard("clearFavorite", async () => {
    const user = await requireUser();

    const parsed = clearFavoriteSchema.safeParse(input);
    if (!parsed.success) return fail(INVALID);

    await db
      .delete(favorites)
      .where(and(eq(favorites.userId, user.id), eq(favorites.position, parsed.data.position)));

    revalidateFavoriteSurfaces(user.username);
    return ok();
  });
}

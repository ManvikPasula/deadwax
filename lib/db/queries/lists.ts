import "server-only";

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import type { AlbumRef, ArtistRef, MemberSummary } from "@/lib/db/queries/users";
import { type TargetType, albums, artists, likes, listItems, lists, tracks, users } from "@/lib/db/schema";
import { albumSlug, artistSlug, trackLocator } from "@/lib/slug";

/**
 * Reads over `lists` and `list_items`.
 *
 * THE ONE REAL STRUCTURAL CHANGE FROM THE TELEVISION ORIGINAL IS THAT `list_items` IS
 * POLYMORPHIC. There, a list item can only hold a series. Here it carries the same target
 * columns `logs` does, because a list of TRACKS — a playlist — is the obvious primary use case
 * for a music site. Three consequences land in this file:
 *
 *   1. `getListItems` resolves three different display shapes out of one table.
 *   2. The mosaic BORROWS: a track item shows its album's cover, an artist item its picture,
 *      because a track has no artwork of its own.
 *   3. `getListOptions`' membership `EXISTS` compares THE WHOLE TARGET TUPLE rather than one
 *      album id, and therefore needs the per-column null branch.
 *
 * WHAT IS NOT HERE: the privacy check. `canViewList` below is pure, and the caller applies it
 * in BOTH `generateMetadata` AND the page body (I-15). Keeping the rule out of the read is what
 * lets the owner's own edit page reuse the same read.
 */

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export type ListOwner = MemberSummary;

export type ListDetail = {
  id: number;
  title: string;
  slug: string;
  description: string | null;
  isRanked: boolean;
  isPublic: boolean;
  /** Has no foreign key on purpose: a clone must survive its source being deleted. */
  clonedFromId: number | null;
  itemCount: number;
  likeCount: number;
  createdAt: Date;
  updatedAt: Date;
  owner: ListOwner;
};

/** One tile of the four-cover mosaic. */
export type ListPreview = {
  id: number;
  /**
   * The album's cover — or the ARTIST'S PICTURE for an artist item, and the ALBUM'S cover for a
   * track item, because a track has no cover of its own.
   */
  imagePath: string | null;
  /** Release-group mbid for album and track tiles, so `albumCover()` keeps its Cover Art
   *  Archive fallback. Null on an artist tile, which has no such fallback. */
  mbid: string | null;
  /** NOT rendered as alt text. The mosaic is decorative; the list title carries the meaning.
   *  Kept for a stable key and for debugging a wrong tile. */
  title: string;
};

export type ListCardBase = {
  id: number;
  title: string;
  slug: string;
  description: string | null;
  isRanked: boolean;
  isPublic: boolean;
  itemCount: number;
  likeCount: number;
  updatedAt: Date;
  owner: ListOwner;
};

export type ListCard = ListCardBase & { previews: ListPreview[] };

export type ListItemEntry = {
  id: number;
  position: number;
  note: string | null;
  targetType: TargetType;
  artist: ArtistRef;
  /** Null only on an artist item. */
  album: AlbumRef | null;
  /** Null on artist and album items. The ordinals come from `list_items`; the rest is joined. */
  track: {
    discNumber: number;
    trackNumber: number;
    locator: string;
    title: string | null;
    durationMs: number | null;
    previewUrl: string | null;
  } | null;
  /** What the row renders, already resolved through the borrowing rule described above. */
  imagePath: string | null;
  mbid: string | null;
  /** The route this row links to, so no component re-derives a slug. */
  href: string;
};

export type ListOption = {
  id: number;
  title: string;
  isPublic: boolean;
  itemCount: number;
  /** Whether this list already holds the thing being added. An EXISTS over the full tuple. */
  containsTarget: boolean;
};

/** The polymorphic target of a list item, in the same shape `logs` uses. */
export type ListTarget = {
  artistId: number;
  albumId?: number | null;
  discNumber?: number | null;
  trackNumber?: number | null;
};

export type ListSort = "popular" | "recent";

/** For whitelisting `?sort=` so an unknown value falls back rather than reaching SQL. */
export const LIST_SORTS: readonly ListSort[] = ["popular", "recent"];

/** Four tiles fan left-over-right on a card. Anything beyond the fourth is never drawn. */
export const PREVIEW_COUNT = 4;

/* -------------------------------------------------------------------------- */
/* Shared projections and correlated subqueries                               */
/* -------------------------------------------------------------------------- */

const ownerRef = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  avatarSeed: users.avatarSeed,
  isGuest: users.isGuest,
};

const albumRef = {
  id: albums.id,
  mbid: albums.mbid,
  title: albums.title,
  slug: albums.slug,
  coverPath: albums.coverPath,
  releaseDate: albums.releaseDate,
};

const artistRef = {
  id: artists.id,
  name: artists.name,
  slug: artists.slug,
  picturePath: artists.picturePath,
};

/**
 * N+1 pattern 1 — correlated subqueries in the SELECT list rather than a round trip per card.
 *
 * `itemCount` is a count, never a column: an `items_count` on `lists` would have to be kept in
 * step by every add, remove, reorder, clone and cascade delete, and the one that forgets is
 * silent. Same argument as `likes`, which the schema states outright.
 */
const itemCountSql = sql<number>`(
  select count(*)::int from ${listItems} where ${listItems.listId} = ${lists.id}
)`;

const listLikeCountSql = sql<number>`(
  select count(*)::int from ${likes}
  where ${likes.targetType} = 'list' and ${likes.targetId} = ${lists.id}
)`;

/** I-12. A guest appears on no public surface, and there is no database-level guard. */
const notGuest = eq(users.isGuest, false);

/* -------------------------------------------------------------------------- */
/* Privacy                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The whole read-side privacy rule, pure so it can be called twice.
 *
 * I-15 — CALL THIS IN `generateMetadata` AND IN THE PAGE BODY. This was audit finding SEC-02
 * (HIGH): the body 404'd while the `<title>` and `<meta description>` of every private list
 * still rendered, which let an anonymous visitor enumerate list ids and read their titles. Any
 * NEW entry point into a list route — an OG image handler, a feed, an API route — needs the
 * same call.
 *
 * `viewerId` must be the SESSION id, never a client-supplied one.
 *
 * Note the deliberate asymmetry with the WRITE path: the mutations distinguish "That list no
 * longer exists" from "That is not your list", which confirms a private list's existence to a
 * non-owner, whereas this read path 404s uniformly. Accepted, because list ids are already
 * enumerable from the public listings.
 */
export function canViewList(
  list: { isPublic: boolean; owner: { id: number } },
  viewerId: number | null | undefined,
): boolean {
  return list.isPublic || list.owner.id === viewerId;
}

/* -------------------------------------------------------------------------- */
/* One list                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The list itself. NO privacy filter and NO guest filter, on purpose: the owner — guest or not
 * — must be able to read their own private list, and `canViewList` is what decides whether a
 * visitor may see it.
 */
export async function getList(id: number): Promise<ListDetail | null> {
  const rows = await db
    .select({
      id: lists.id,
      title: lists.title,
      slug: lists.slug,
      description: lists.description,
      isRanked: lists.isRanked,
      isPublic: lists.isPublic,
      clonedFromId: lists.clonedFromId,
      itemCount: itemCountSql,
      likeCount: listLikeCountSql,
      createdAt: lists.createdAt,
      updatedAt: lists.updatedAt,
      owner: ownerRef,
    })
    .from(lists)
    .innerJoin(users, eq(users.id, lists.userId))
    .where(eq(lists.id, id))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The items, resolved from one polymorphic table into three display shapes.
 *
 * Ordered by `position`, THEN BY `id`. The second key is not decoration: `addToList` computes
 * `max(position) + 1` in a separate statement outside any transaction, so two concurrent adds
 * legitimately land on the SAME position — which is legal precisely because the unique index is
 * on the target tuple and not on position. Without the `id` tiebreaker those two rows swap
 * places between requests, and on a ranked list that reads as the ranking being wrong.
 *
 * `tracks` is LEFT-joined on all three columns: an album or artist item has null ordinals, and
 * `= NULL` never matches, so the left join yields the null row the shape expects.
 */
export async function getListItems(listId: number): Promise<ListItemEntry[]> {
  const rows = await db
    .select({
      id: listItems.id,
      position: listItems.position,
      note: listItems.note,
      targetType: listItems.targetType,
      discNumber: listItems.discNumber,
      trackNumber: listItems.trackNumber,
      trackTitle: tracks.title,
      trackDurationMs: tracks.durationMs,
      trackPreviewUrl: tracks.previewUrl,
      albumDiscCount: albums.discCount,
      album: albumRef,
      artist: artistRef,
    })
    .from(listItems)
    .innerJoin(artists, eq(artists.id, listItems.artistId))
    .leftJoin(albums, eq(albums.id, listItems.albumId))
    .leftJoin(
      tracks,
      and(
        eq(tracks.albumId, listItems.albumId),
        eq(tracks.discNumber, listItems.discNumber),
        eq(tracks.trackNumber, listItems.trackNumber),
      ),
    )
    .where(eq(listItems.listId, listId))
    .orderBy(asc(listItems.position), asc(listItems.id));

  return rows.map((row) => {
    const album = row.album;
    const trackNumber = row.trackNumber;

    const track =
      album !== null && trackNumber !== null
        ? {
            discNumber: row.discNumber ?? 1,
            trackNumber,
            locator: trackLocator({
              disc: row.discNumber ?? 1,
              track: trackNumber,
              discCount: row.albumDiscCount ?? 1,
            }),
            title: row.trackTitle,
            durationMs: row.trackDurationMs,
            previewUrl: row.trackPreviewUrl,
          }
        : null;

    return {
      id: row.id,
      position: row.position,
      note: row.note,
      // `target_type` is a varchar because the schema has no enums, and it is derived at write
      // time from this very tuple — so this is the one cast, not a validation boundary.
      targetType: row.targetType as TargetType,
      artist: row.artist,
      album,
      track,
      // THE BORROWING RULE. A track has no artwork, so it shows its album's cover; an artist
      // item shows the picture. Falling back to the artist picture for an album item that has
      // no cover was the rejected alternative: it puts a face where a record belongs, so a
      // missing cover reads as the wrong row rather than as a missing cover.
      imagePath: album ? album.coverPath : row.artist.picturePath,
      mbid: album ? album.mbid : null,
      href: album
        ? track
          ? `/album/${albumSlug(album.title, album.id)}/track/${track.locator}`
          : `/album/${albumSlug(album.title, album.id)}`
        : `/artist/${artistSlug(row.artist.name, row.artist.id)}`,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Listings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * /lists. Public lists only, AND their owners must not be guests (I-12) — a guest can create
 * lists, and everything about their own profile tab reads normally, but nothing of theirs
 * reaches a public index. That is the same asymmetry `notGuest` carries in queries/logs.ts.
 *
 * "popular" is the correlated like count in the ORDER BY, tie-broken on recency. No hot
 * ranking, no decay, no denormalised counter.
 */
export async function getPublicLists({
  sort = "recent",
  limit = 36,
}: { sort?: ListSort; limit?: number } = {}): Promise<ListCard[]> {
  const order = sort === "popular" ? [desc(listLikeCountSql), desc(lists.updatedAt)] : [desc(lists.updatedAt)];

  const rows = await db
    .select({
      id: lists.id,
      title: lists.title,
      slug: lists.slug,
      description: lists.description,
      isRanked: lists.isRanked,
      isPublic: lists.isPublic,
      itemCount: itemCountSql,
      likeCount: listLikeCountSql,
      updatedAt: lists.updatedAt,
      owner: ownerRef,
    })
    .from(lists)
    .innerJoin(users, eq(users.id, lists.userId))
    .where(and(eq(lists.isPublic, true), notGuest))
    .orderBy(...order)
    .limit(limit);

  return attachPreviews(rows);
}

/**
 * The profile's lists tab. `isSelf` IS THE ENTIRE PRIVACY SWITCH — one comparison against the
 * session id decides whether private lists are in the result at all, so there is no second
 * place for the rule to disagree with itself.
 *
 * No guest filter: this is one member's own tab, and a guest's own lists must read normally.
 */
export async function getUserLists(
  userId: number,
  viewerId: number | null | undefined,
  limit = 60,
): Promise<ListCard[]> {
  const isSelf = viewerId !== null && viewerId !== undefined && viewerId === userId;

  const rows = await db
    .select({
      id: lists.id,
      title: lists.title,
      slug: lists.slug,
      description: lists.description,
      isRanked: lists.isRanked,
      isPublic: lists.isPublic,
      itemCount: itemCountSql,
      likeCount: listLikeCountSql,
      updatedAt: lists.updatedAt,
      owner: ownerRef,
    })
    .from(lists)
    .innerJoin(users, eq(users.id, lists.userId))
    .where(isSelf ? eq(lists.userId, userId) : and(eq(lists.userId, userId), eq(lists.isPublic, true)))
    .orderBy(desc(lists.updatedAt))
    .limit(limit);

  return attachPreviews(rows);
}

/**
 * N+1 pattern 2 — collect the list ids, ONE `IN` query, bucket into a Map, slice to four IN
 * JAVASCRIPT. Every mosaic on the page is filled by this one statement.
 *
 * THE KNOWN COST, STATED HONESTLY: CORRECT BUT UNBOUNDED. It fetches every item of every list
 * on the page in order to use the first four of each, and performs the two joins on all of
 * them — so rendering 36 cards whose lists hold 200 items each transfers 7,200 rows to build
 * 144 thumbnails.
 *
 * The bounded alternative is also a single statement:
 *
 *   cross join lateral (select … from list_items where list_id = lists.id
 *                       order by position limit 4)
 *
 * which transfers exactly four rows per card. It is not used here because the `IN` form is what
 * the original has and because the transfer only becomes material on a page of very long lists
 * — but it is named so that the fix is one edit rather than an investigation.
 *
 * The empty guard is mandatory: `IN ()` is invalid SQL, and a member with no lists should cost
 * zero queries rather than one.
 */
export async function attachPreviews<T extends { id: number }>(
  input: T[],
): Promise<Array<T & { previews: ListPreview[] }>> {
  const cards = input.map((list) => ({ ...list, previews: [] as ListPreview[] }));
  if (cards.length === 0) return cards;

  const rows = await db
    .select({
      id: listItems.id,
      listId: listItems.listId,
      albumTitle: albums.title,
      coverPath: albums.coverPath,
      albumMbid: albums.mbid,
      artistName: artists.name,
      picturePath: artists.picturePath,
      trackTitle: tracks.title,
    })
    .from(listItems)
    .innerJoin(artists, eq(artists.id, listItems.artistId))
    .leftJoin(albums, eq(albums.id, listItems.albumId))
    .leftJoin(
      tracks,
      and(
        eq(tracks.albumId, listItems.albumId),
        eq(tracks.discNumber, listItems.discNumber),
        eq(tracks.trackNumber, listItems.trackNumber),
      ),
    )
    .where(
      inArray(
        listItems.listId,
        cards.map((card) => card.id),
      ),
    )
    // `position` ascending is what makes "the first four" mean the four the member put first.
    // `id` breaks the tie two concurrent adds can create, for the same reason getListItems does.
    .orderBy(asc(listItems.listId), asc(listItems.position), asc(listItems.id));

  const byList = new Map<number, ListPreview[]>();
  for (const row of rows) {
    const bucket = byList.get(row.listId) ?? [];
    // Sliced here rather than in SQL; see the cost note above.
    if (bucket.length >= PREVIEW_COUNT) continue;
    bucket.push({
      // The borrowing rule again, and `albumTitle` rather than `coverPath` is what decides it:
      // keying on the cover would silently substitute the artist's face for an album whose
      // cover has not been mirrored yet.
      id: row.id,
      imagePath: row.albumTitle === null ? row.picturePath : row.coverPath,
      mbid: row.albumMbid,
      title: row.trackTitle ?? row.albumTitle ?? row.artistName,
    });
    byList.set(row.listId, bucket);
  }

  for (const card of cards) card.previews = byList.get(card.id) ?? [];
  return cards;
}

/* -------------------------------------------------------------------------- */
/* The add-to-list dialog                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The caller's own lists, each already knowing whether it holds this target.
 *
 * MEMBERSHIP IS AN EXISTS OVER THE FULL TARGET TUPLE, not over an album id. In the original
 * `list_items` holds only series, so a single `show_id` comparison is the whole test; here the
 * table is polymorphic, and an album item and one of its tracks differ only in the ordinals.
 *
 * THE PER-COLUMN NULL BRANCH IS MANDATORY (the same trap as `countReviewsBy`). `disc_number =
 * NULL` is NULL, never true, so writing four plain equalities would make the EXISTS report
 * false for every album-level item that is already in the list — the dialog would offer "Add",
 * `onConflictDoNothing` would silently do nothing, and the member would click a button that
 * does not respond.
 *
 * `target_type` is deliberately NOT compared, even though the unique index includes it: the
 * tuple already determines the tier (a track item carries ordinals, an album item carries an
 * album id and null ordinals, an artist item is null throughout), so comparing the type as well
 * would add a second, independent copy of `targetTypeOf`'s rule to keep in step for no gain.
 */
export async function getListOptions(userId: number, target: ListTarget): Promise<ListOption[]> {
  const matchesTarget = and(
    eq(listItems.listId, lists.id),
    eq(listItems.artistId, target.artistId),
    target.albumId == null ? isNull(listItems.albumId) : eq(listItems.albumId, target.albumId),
    target.discNumber == null ? isNull(listItems.discNumber) : eq(listItems.discNumber, target.discNumber),
    target.trackNumber == null ? isNull(listItems.trackNumber) : eq(listItems.trackNumber, target.trackNumber),
  );

  return db
    .select({
      id: lists.id,
      title: lists.title,
      isPublic: lists.isPublic,
      itemCount: itemCountSql,
      // N+1 pattern 1 again: an EXISTS per row inside one statement, not one query per list.
      containsTarget: sql<boolean>`exists (select 1 from ${listItems} where ${matchesTarget})`,
    })
    .from(lists)
    .where(eq(lists.userId, userId))
    // Most recently touched first: the list somebody is curating now is the one they mean.
    .orderBy(desc(lists.updatedAt))
    .limit(100);
}

/* -------------------------------------------------------------------------- */
/* Counters the write path needs                                              */
/* -------------------------------------------------------------------------- */

export async function countListItems(listId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(listItems)
    .where(eq(listItems.listId, listId));
  return row?.count ?? 0;
}

/**
 * `addToList` appends at `getMaxPosition(listId) + 1`, IN A SEPARATE STATEMENT OUTSIDE ANY
 * TRANSACTION.
 *
 * That is legal, and deliberately so: the unique index is on the target tuple, not on
 * `(list_id, position)`, so two concurrent adds landing on the same position produce two valid
 * rows that render in id order (see `getListItems`). Adding a uniqueness constraint on position
 * to "fix" the race would turn a harmless tie into a failed save, and reordering would then
 * need a transaction per move.
 *
 * `coalesce(..., 0)` so an empty list yields 0 and its first item gets position 1 — `max()` over
 * no rows is NULL, and NULL + 1 is NULL, which would write a null position into a NOT NULL
 * column and fail the insert.
 */
export async function getMaxPosition(listId: number): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${listItems.position}), 0)::int` })
    .from(listItems)
    .where(eq(listItems.listId, listId));
  return row?.max ?? 0;
}

import "server-only";

import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  albums,
  artists,
  desertIsland,
  favorites,
  follows,
  logs,
  tracks,
  users,
  wantlist,
} from "@/lib/db/schema";
import { containsPattern } from "@/lib/like";
import { trackLocator } from "@/lib/slug";

/**
 * Reads over `users` and everything keyed by a member: the follow graph, the directory, member
 * search, the wantlist, the Top Four and the Desert Island shelf.
 *
 * Three things in this file are deliberate departures from the television original rather than
 * ports of it, and each is marked at its function:
 *
 *   - the directory weights by DISTINCT ALBUMS and carries a TIEBREAKER (the original counts
 *     raw log rows and has no tiebreaker at all);
 *   - `getMemberCardStats` is ONE BATCHED QUERY, replacing 24 executions of the heaviest
 *     aggregate in the application;
 *   - the wantlist HONOURS A PRIVACY FLAG, which the original does not have.
 *
 * Nothing here writes. The follow/like/wantlist mutations live in app/actions, and the reads
 * those actions need — existence, guest status, current state — are exported from here so the
 * actions stay shells.
 */

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export type MemberSummary = {
  id: number;
  username: string;
  displayName: string | null;
  avatarSeed: string | null;
  isGuest: boolean;
};

/**
 * What a profile page needs.
 *
 * THE PROJECTION OMITS `password_hash` AND `email`, and that omission is the reason it is a
 * projection rather than `users.$inferSelect`. This object is handed to Server Components as
 * props, and props cross the server/client boundary in the RSC payload — so selecting the
 * whole row would put a bcrypt hash and an email address into the page's wire format for
 * anybody who views source.
 *
 * `role`, `plan` and `isGuest` are read HERE, from the database, never from the session token
 * (I-18). The token's copies are presentation only.
 */
export type MemberRecord = MemberSummary & {
  bio: string | null;
  role: string;
  plan: string;
  wantlistPrivate: boolean;
  emailVerifiedAt: Date | null;
  createdAt: Date;
};

/** The directory card: the member plus the one number the ordering is computed from. */
export type ActiveMember = MemberSummary & { albums: number };

export type MemberCardStats = { albums: number; ratings: number };

export type FollowCounts = { followers: number; following: number };

/**
 * The album projection used by every collection read in this file.
 *
 * `mbid` is included on purpose: `albumCover()` falls back to the Cover Art Archive keyed by
 * the RELEASE-GROUP mbid when Deezer has no cover, so a projection that omits it silently
 * loses the fallback and renders an empty frame instead of the art.
 */
export type AlbumRef = {
  id: number;
  mbid: string | null;
  title: string;
  slug: string;
  coverPath: string | null;
  releaseDate: string | null;
};

export type ArtistRef = { id: number; name: string; slug: string; picturePath: string | null };

export type WantlistEntry = {
  note: string | null;
  addedAt: Date;
  album: AlbumRef;
  artist: ArtistRef;
};

export type FavoriteEntry = {
  /** 1..4. The PK is (user_id, position), so the slot IS the member's choice of order. */
  position: number;
  album: AlbumRef;
  artist: ArtistRef;
};

export type DesertIslandEntry = {
  id: number;
  discNumber: number;
  trackNumber: number;
  /** "7" or "2-5" — already suppressing the redundant "1-" on a single-disc record. */
  locator: string;
  /** LEFT-joined from `tracks`; see the note about a re-synced tracklist in `getDesertIsland`. */
  trackTitle: string | null;
  /** The member's CURRENT rating. REPORTED, NEVER FILTERED ON. See `getDesertIsland`. */
  rating: number | null;
  createdAt: Date;
  album: AlbumRef;
  artist: ArtistRef;
};

/** The members directory shows 24. */
export const MEMBER_DIRECTORY_LIMIT = 24;

/* -------------------------------------------------------------------------- */
/* Shared projections                                                         */
/* -------------------------------------------------------------------------- */

const memberSummary = {
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

/** I-12. Same rule and same reason as in queries/logs.ts: no database-level guard exists. */
const notGuest = eq(users.isGuest, false);

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Resolves a profile URL to a member, CASE-INSENSITIVELY.
 *
 * `lower(...)` on BOTH sides, matching the FUNCTIONAL unique index `users_username_lower_uq`.
 * Two consequences, both wanted:
 *
 *  1. The predicate has the same shape as the index expression, so this is an index scan.
 *  2. It is the same implementation of "lower" that the index enforces. Lowercasing in
 *     JavaScript instead would introduce a SECOND implementation, and JavaScript and Postgres
 *     disagree on some non-ASCII characters — 'İ' lowercases to two code units in JavaScript
 *     (the same defect as I-8, one layer up) — so a username stored through one would be
 *     unreachable through the other.
 */
export async function getUserByUsername(username: string): Promise<MemberRecord | null> {
  const rows = await db
    .select({
      ...memberSummary,
      bio: users.bio,
      role: users.role,
      plan: users.plan,
      wantlistPrivate: users.wantlistPrivate,
      emailVerifiedAt: users.emailVerifiedAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`)
    .limit(1);

  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* The follow graph                                                           */
/* -------------------------------------------------------------------------- */

/** The read behind the follow button's initial state. */
export async function isFollowing(followerId: number, followeeId: number): Promise<boolean> {
  const rows = await db
    .select({ followerId: follows.followerId })
    .from(follows)
    .where(and(eq(follows.followerId, followerId), eq(follows.followeeId, followeeId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * The read `toggleFollow` needs before it writes, and it closes both gaps the brief names.
 *
 * The original never checks that the followee EXISTS, so following a deleted member surfaces a
 * foreign-key violation as the generic failure message instead of "That member does not
 * exist"; and it never checks that the followee is NOT A GUEST, so a guest could be followed
 * into somebody's feed despite having no public surface anywhere else. Both checks need the row
 * rather than the id, so both need this read.
 */
export async function getFollowTarget(userId: number): Promise<{ id: number; username: string; isGuest: boolean } | null> {
  const rows = await db
    .select({ id: users.id, username: users.username, isGuest: users.isGuest })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * N+1 pattern 4 — MULTIPLE SCALARS IN ONE ROUND TRIP.
 *
 * Both counts come back from one statement because they are always rendered together, in the
 * profile header, on every profile view. The rejected alternative is two queries (or a
 * `Promise.all` of two), which is two round trips for two integers that are never shown apart.
 *
 * This is a raw `db.execute` rather than the query builder for one boring reason: the statement
 * has no FROM clause, and the builder requires a table to select from. `::int` again, because
 * `count(*)` is a bigint and node-postgres returns bigints as strings.
 */
export async function getFollowCounts(userId: number): Promise<FollowCounts> {
  const result = await db.execute<FollowCounts>(sql`
    select
      (select count(*)::int from ${follows} where ${follows.followeeId} = ${userId}) as followers,
      (select count(*)::int from ${follows} where ${follows.followerId} = ${userId}) as following
  `);
  return result.rows[0] ?? { followers: 0, following: 0 };
}

/**
 * N+1 pattern 3 — viewer state as a `Set`, fetched ONCE per page.
 *
 * Returns the subset of `ids` the viewer already follows, so a directory of 24 cards resolves
 * 24 follow buttons in one query instead of 24. GUARDS BOTH EMPTY CASES: `IN ()` is invalid
 * SQL, and a signed-out visitor has no id to compare against.
 */
export async function viewerFollowSet(
  viewerId: number | null | undefined,
  ids: number[],
): Promise<Set<number>> {
  if (!viewerId || ids.length === 0) return new Set<number>();

  const rows = await db
    .select({ followeeId: follows.followeeId })
    .from(follows)
    .where(and(eq(follows.followerId, viewerId), inArray(follows.followeeId, ids)));

  return new Set(rows.map((row) => row.followeeId));
}

/**
 * The two halves of /@name/network.
 *
 * NO GUEST FILTER, and the absence is reasoned rather than forgotten: a guest cannot follow
 * (`requireMember` refuses) and cannot be followed (`toggleFollow` checks `isGuest`), so
 * neither direction of this graph can contain one. If either of those write-side checks is
 * ever relaxed, these two reads are where the guest becomes publicly visible.
 *
 * Ordered by the edge's own `created_at`, newest first — "who arrived most recently" is the
 * only ordering a follower list has that is not arbitrary.
 */
export async function getFollowers(userId: number, limit = 48): Promise<MemberSummary[]> {
  return db
    .select(memberSummary)
    .from(follows)
    .innerJoin(users, eq(users.id, follows.followerId))
    .where(eq(follows.followeeId, userId))
    .orderBy(desc(follows.createdAt))
    .limit(limit);
}

export async function getFollowing(userId: number, limit = 48): Promise<MemberSummary[]> {
  return db
    .select(memberSummary)
    .from(follows)
    .innerJoin(users, eq(users.id, follows.followeeId))
    .where(eq(follows.followerId, userId))
    .orderBy(desc(follows.createdAt))
    .limit(limit);
}

/* -------------------------------------------------------------------------- */
/* The directory and member search                                            */
/* -------------------------------------------------------------------------- */

/**
 * The expression the directory is ordered by AND the number its cards print. They are the same
 * expression on purpose — see `getMemberCardStats`.
 *
 * WEIGHTED BY DISTINCT ALBUMS, NOT RAW LOG ROWS. The original counts rows, which in television
 * is roughly "episodes watched". Here one 40-minute record played once is eleven rows, so a
 * raw-row ranking measures HOW GRANULARLY SOMEBODY LOGS rather than how much they listen: a
 * member who marks every track outranks one who rates whole albums by an order of magnitude.
 *
 * `count(distinct album_id)` ignores NULLs, so an artist-level log contributes nothing. That is
 * correct rather than incidental — the unit being counted is "records engaged with", and an
 * opinion about an artist is not a record.
 *
 * `albums.is_canonical` is deliberately NOT applied here. A non-canonical release must never
 * enter a completion denominator, a discography heatmap row, or a recommendation pool — and an
 * activity ranking is none of those three. Somebody whose year was live albums and compilations
 * has still been listening, and filtering them out would rank them below somebody who logged
 * nothing.
 */
const distinctAlbumsLogged = sql<number>`count(distinct ${logs.albumId})::int`;

export async function getActiveMembers(
  limit = MEMBER_DIRECTORY_LIMIT,
  excludeUserId?: number | null,
): Promise<ActiveMember[]> {
  return db
    .select({ ...memberSummary, albums: distinctAlbumsLogged })
    .from(users)
    // LEFT, so a member who has logged nothing still appears (at zero) rather than vanishing
    // from the directory entirely.
    .leftJoin(logs, eq(logs.userId, users.id))
    .where(excludeUserId ? and(notGuest, ne(users.id, excludeUserId)) : notGuest)
    .groupBy(users.id)
    // THE TIEBREAKER IS THE POINT OF THIS LINE. The original orders on the count alone, and
    // Postgres is free to return equal-count rows in any order it likes — so the tail of the
    // directory, where everybody has the same small number, reshuffles between requests and
    // reads as a page that randomises itself. `users.id` is stable and arbitrary, which is
    // exactly what a tiebreaker should be.
    .orderBy(desc(distinctAlbumsLogged), asc(users.id))
    .limit(limit);
}

/**
 * ONE BATCHED QUERY for every card on the page. This fixes a named defect.
 *
 * The original renders the directory with `Promise.all(members.map(getProfileStats))` — 24
 * executions of the heaviest query in the application (four CTEs and nine scalar subqueries
 * each) to display two numbers per card. One `GROUP BY user_id` over the same rows answers it
 * once (N+1 patterns 2 and 4 together: one `IN` query, bucketed into a Map).
 *
 * `albums` is THE SAME EXPRESSION `getActiveMembers` orders by, and that is deliberate: a card
 * printing a different album count from the one the ordering was computed on makes the
 * ordering itself look broken, which is a worse bug than either number being imprecise.
 *
 * It is therefore NOT `getProfileStats.albums_started`, which counts distinct albums over
 * TRACK-level logs only and excludes non-canonical releases. Those two numbers answer different
 * questions, and this one's job is to explain the card's position in this list.
 *
 * `ratings` is a raw count of rated log rows, matching `getProfileStats.ratings_given` — so a
 * card and the profile it links to agree. A replay rated twice counts twice in both, which is
 * consistent rather than correct: it is a lifetime activity figure, not a consensus figure, and
 * consensus figures are the ones that carry `DISTINCT ON` (I-10).
 */
export async function getMemberCardStats(ids: number[]): Promise<Map<number, MemberCardStats>> {
  const stats = new Map<number, MemberCardStats>();
  if (ids.length === 0) return stats; // `IN ()` is invalid SQL, and there is nothing to ask.

  const rows = await db
    .select({
      userId: logs.userId,
      albums: distinctAlbumsLogged,
      ratings: sql<number>`count(*) filter (where ${logs.rating} is not null)::int`,
    })
    .from(logs)
    .where(inArray(logs.userId, ids))
    .groupBy(logs.userId);

  for (const row of rows) stats.set(row.userId, { albums: row.albums, ratings: row.ratings });
  return stats;
}

/**
 * Member search.
 *
 * I-13 — THE PARENTHESES ARE THE WHOLE FUNCTION.
 *
 * Drizzle emits the `sql` fragment unparenthesised and SQL binds AND tighter than OR, so
 * without the explicit brackets the predicate reads
 *
 *     (is_guest = false AND username ILIKE $1) OR (display_name ILIKE $1)
 *
 * and because every guest's display name is literally "Guest User", SEARCHING "guest" RETURNED
 * EVERY GUEST ACCOUNT ON THE PLATFORM. That shipped in the original and was caught by a test,
 * not by reading — which is why the brackets are here and why this comment is this long.
 *
 * The pattern goes through `containsPattern`, so a member typing `%` searches for a literal
 * percent sign instead of matching every row (I-6).
 *
 * Ordered by username. An unordered search result reshuffles between identical requests for the
 * same reason the directory's missing tiebreaker did.
 */
export async function searchUsers(query: string, limit = MEMBER_DIRECTORY_LIMIT): Promise<MemberSummary[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const pattern = containsPattern(trimmed);

  return db
    .select(memberSummary)
    .from(users)
    .where(
      and(notGuest, sql`(${users.username} ilike ${pattern} or ${users.displayName} ilike ${pattern})`),
    )
    .orderBy(asc(users.username))
    .limit(limit);
}

/* -------------------------------------------------------------------------- */
/* The wantlist — and the privacy flag the original does not have             */
/* -------------------------------------------------------------------------- */

/**
 * THE ENTIRE PRIVACY RULE, in one pure expression so both entry points can call it.
 *
 * The television original has no privacy flag at all: `/@anyone/watchlist` is fully public to
 * signed-out visitors. `users.wantlist_private` is the fix, and it is one column plus this
 * check.
 *
 * I-15 — CALL THIS IN `generateMetadata` AND IN THE PAGE BODY. Checking one of the two entry
 * points is how the original leaked private list titles: the body 404'd while the `<title>` and
 * `<meta description>` of every private list still rendered, which allowed anonymous id
 * enumeration (SEC-02). Any NEW entry point — an OG image route, a feed, an API handler — needs
 * the same call.
 *
 * `viewerId` must come from the SESSION, never from a route parameter or a form field.
 */
export function canViewWantlist(
  owner: { id: number; wantlistPrivate: boolean },
  viewerId: number | null | undefined,
): boolean {
  return !owner.wantlistPrivate || owner.id === viewerId;
}

/**
 * The queue itself. Ordered by `added_at` descending, served by `wantlist_user_added_idx`.
 *
 * `albums.is_canonical` is NOT applied: a wantlist is a member's own queue, not a completion
 * denominator, and somebody who wants the deluxe reissue wants the deluxe reissue.
 *
 * This read does NOT enforce privacy. `canViewWantlist` does, at both entry points — keeping
 * the rule in one pure function is what makes it possible to call it twice.
 */
export async function getWantlist(userId: number, limit = 200): Promise<WantlistEntry[]> {
  return db
    .select({ note: wantlist.note, addedAt: wantlist.addedAt, album: albumRef, artist: artistRef })
    .from(wantlist)
    .innerJoin(albums, eq(albums.id, wantlist.albumId))
    .innerJoin(artists, eq(artists.id, albums.artistId))
    .where(eq(wantlist.userId, userId))
    .orderBy(desc(wantlist.addedAt))
    .limit(limit);
}

/** The album page's "want this" toggle. Signed out has no wantlist, so no round trip. */
export async function isWanted(userId: number | null | undefined, albumId: number): Promise<boolean> {
  if (!userId) return false;

  const rows = await db
    .select({ albumId: wantlist.albumId })
    .from(wantlist)
    .where(and(eq(wantlist.userId, userId), eq(wantlist.albumId, albumId)))
    .limit(1);

  return rows.length > 0;
}

/* -------------------------------------------------------------------------- */
/* The Top Four, and the Desert Island shelf                                  */
/* -------------------------------------------------------------------------- */

/**
 * The pinned Top Four ALBUMS — albums are the natural profile-pin unit for music, not artists.
 *
 * Ordered by `position`, which is the primary key's second column, so the ordering IS the
 * member's stated choice rather than an artefact of insertion order. Unfilled slots are simply
 * absent from this read; the component draws them as dashed frames FOR THE OWNER ONLY, because
 * another member's empty shelf is not information.
 */
export async function getFavorites(userId: number): Promise<FavoriteEntry[]> {
  return db
    .select({ position: favorites.position, album: albumRef, artist: artistRef })
    .from(favorites)
    .innerJoin(albums, eq(albums.id, favorites.albumId))
    .innerJoin(artists, eq(artists.id, albums.artistId))
    .where(eq(favorites.userId, userId))
    .orderBy(asc(favorites.position));
}

/**
 * The crowned tracks.
 *
 * THE LATERAL REPORTS THE RATING; IT DOES NOT FILTER ON IT.
 *
 * The five-star entry condition is enforced once, at crown time, against the member's LATEST
 * rating. THIS READ IS NOT THE PLACE TO QUIETLY OVERRULE THEM: a member who later lowers the
 * rating keeps the mark until they clear it themselves. Adding `and rating = MAX_RATING` to the
 * lateral — or promoting it to an INNER JOIN, which is the same mistake written differently —
 * would make a crown disappear from the strip that the member never took back, which is the
 * database discarding their choice rather than recording it.
 *
 * WHY A LATERAL RATHER THAN A CORRELATED SCALAR SUBQUERY in the SELECT list: identical
 * one-statement cost, but the lateral form lets the projection grow — the date of that rating,
 * the log id to link to — without adding one subquery per column, and it keeps the
 * `order by created_at desc limit 1` (the "what do they think NOW" rule) written once.
 *
 * `tracks` is LEFT-joined. A crowned track's row should always exist, but `ensureAlbum` rewrites
 * a tracklist on every sync and editions genuinely disagree about track numbering, so an INNER
 * JOIN would make a crown vanish because the mirror moved underneath it. The title falls back to
 * null; the mark survives.
 */
export async function getDesertIsland(userId: number): Promise<DesertIslandEntry[]> {
  const latestRating = db
    .select({ rating: logs.rating })
    .from(logs)
    .where(
      and(
        eq(logs.userId, desertIsland.userId),
        eq(logs.targetType, "track"),
        eq(logs.albumId, desertIsland.albumId),
        eq(logs.discNumber, desertIsland.discNumber),
        eq(logs.trackNumber, desertIsland.trackNumber),
        isNotNull(logs.rating),
      ),
    )
    .orderBy(desc(logs.createdAt))
    .limit(1)
    .as("latest_rating");

  const rows = await db
    .select({
      id: desertIsland.id,
      discNumber: desertIsland.discNumber,
      trackNumber: desertIsland.trackNumber,
      trackTitle: tracks.title,
      rating: latestRating.rating,
      createdAt: desertIsland.createdAt,
      albumDiscCount: albums.discCount,
      album: albumRef,
      artist: artistRef,
    })
    .from(desertIsland)
    .innerJoin(albums, eq(albums.id, desertIsland.albumId))
    .innerJoin(artists, eq(artists.id, desertIsland.artistId))
    .leftJoin(
      tracks,
      and(
        eq(tracks.albumId, desertIsland.albumId),
        eq(tracks.discNumber, desertIsland.discNumber),
        eq(tracks.trackNumber, desertIsland.trackNumber),
      ),
    )
    .leftJoinLateral(latestRating, sql`true`)
    .where(eq(desertIsland.userId, userId))
    .orderBy(desc(desertIsland.createdAt));

  return rows.map((row) => ({
    id: row.id,
    discNumber: row.discNumber,
    trackNumber: row.trackNumber,
    locator: trackLocator({
      disc: row.discNumber,
      track: row.trackNumber,
      discCount: row.albumDiscCount ?? 1,
    }),
    trackTitle: row.trackTitle,
    rating: row.rating,
    createdAt: row.createdAt,
    album: row.album,
    artist: row.artist,
  }));
}

/**
 * How many marks this member holds. Read-only, for rendering the strip's remaining slots and
 * the button's `used` count.
 *
 * The QUOTA ITSELF is not enforced here. Count-then-insert against a quota has to be one
 * transaction (I-29) — two tabs sitting at nine would each read nine and leave the member
 * holding eleven — so the enforcing count lives inside `lib/desert-island`'s transaction. This
 * one is for display, and a display count that is one stale is a cosmetic problem.
 */
export async function countDesertIsland(userId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(desertIsland)
    .where(eq(desertIsland.userId, userId));
  return row?.count ?? 0;
}

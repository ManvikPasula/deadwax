import "server-only";

import { and, asc, between, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  type SocialTargetType,
  type TargetType,
  albums,
  artists,
  comments,
  follows,
  likes,
  logTags,
  logs,
  tracks,
  users,
} from "@/lib/db/schema";
import { trackLocator } from "@/lib/slug";

/**
 * Every read over `logs`, returning ONE display-ready shape.
 *
 * The rule the shape exists to enforce: COMPONENTS NEVER ASSEMBLE THAT THEMSELVES. A feed row,
 * a diary row, a review card and the log detail page all render the same `LogEntry`, so no
 * component decides for itself how to derive a track locator or where a cover comes from, and
 * there is exactly one place to fix when it is wrong.
 *
 * THE BASE QUERY: `logs ⋈ users ⋈ artists`, LEFT JOIN `albums`, LEFT JOIN `tracks` ON ALL
 * THREE COLUMNS (album_id, disc_number, track_number).
 *
 *   Both joins are LEFT because the tiers are encoded by nullability: an artist-level log has
 *   no album_id, and neither an artist- nor an album-level log has disc/track numbers. An
 *   INNER JOIN to `tracks` would silently delete every artist- and album-level row from every
 *   feed in the application — which reads as "the feed is broken", not as "the join is wrong".
 *   The three-column ON is also what makes the join exact: joining on album_id alone would
 *   multiply an album-level log by its whole tracklist.
 *
 * COUNTS ARE NEVER DENORMALISED. `likeCount` and `commentCount` are correlated subqueries in
 * the SELECT list (N+1 pattern 1), so no counter column can drift out of step with the rows it
 * claims to count. There is deliberately no `like_count` column anywhere in the schema.
 *
 * TAGS are attached with ONE extra `WHERE log_id IN (…)` query bucketed into a Map (N+1
 * pattern 2) — one extra query rather than one per row.
 *
 * THERE IS NO `containsSpoilers`. The television original carries the column, a toggle, a
 * `LogEntry` field and a reveal branch; music has no equivalent and all four were deleted
 * rather than ported.
 */

/* -------------------------------------------------------------------------- */
/* The shape                                                                  */
/* -------------------------------------------------------------------------- */

export type LogAuthor = {
  id: number;
  username: string;
  displayName: string | null;
  avatarSeed: string | null;
  /**
   * Carried so a surface that legitimately renders a guest's own rows can label them. Public
   * surfaces never need it, because `notGuest` has already excluded them — see below.
   */
  isGuest: boolean;
};

export type LogEntry = {
  id: number;
  targetType: TargetType;
  /** Stored 1..10. NULL means "listened, not rated"; there is no 0. */
  rating: number | null;
  review: string | null;
  /**
   * A `date` column, so DRIZZLE RETURNS IT AS A STRING while `createdAt` below is a `Date`
   * (I-9). Mixing the two silently produces "Invalid Date", so nothing here hands `listenedOn`
   * to a `Date` method — `lib/format.ts` accepts either and normalises.
   */
  listenedOn: string | null;
  isReplay: boolean;
  /** The AUTHOR'S OWN heart on the thing they played. Not the `likes` table, which is others'. */
  liked: boolean;
  createdAt: Date;
  discNumber: number | null;
  trackNumber: number | null;
  /** From the LEFT JOIN, so null on an artist- or album-level log and on an unmirrored track. */
  trackTitle: string | null;
  /** "7" or "2-5", already suppressing the redundant "1-" on a single-disc record. */
  locator: string | null;
  likeCount: number;
  commentCount: number;
  tags: string[];
  author: LogAuthor;
  album: {
    id: number;
    title: string;
    slug: string;
    coverPath: string | null;
    releaseDate: string | null;
  } | null;
  artist: { id: number; name: string; slug: string; picturePath: string | null };
};

/** The addressable tuple of a loggable thing. `artistId` is the always-present anchor. */
export type LogTarget = {
  artistId: number;
  albumId?: number | null;
  discNumber?: number | null;
  trackNumber?: number | null;
};

/** What `LogDialog` needs to prime its `initial` prop from the real row rather than from blanks. */
export type ExistingLog = {
  id: number;
  rating: number | null;
  review: string | null;
  listenedOn: string | null;
  isReplay: boolean;
  liked: boolean;
  tags: string[];
};

export type CommentEntry = {
  id: number;
  body: string;
  createdAt: Date;
  author: LogAuthor;
};

/** `PAGE_SIZE` for /@name/diary. */
export const DIARY_PAGE_SIZE = 50;
/** `PAGE_SIZE` for /album/[slug]/reviews and /artist/[slug]/reviews. */
export const REVIEW_PAGE_SIZE = 20;
/**
 * The following feed's own default; the home page asks for 24. The feed is the newest rows and
 * that is the end of it — no pagination, no ranking, no per-author cap, no recency decay.
 */
export const FOLLOWING_FEED_LIMIT = 30;

/**
 * I-4. Postgres accepts 'infinity' as a `date`. One stored `infinity` row would sit permanently
 * at the top of this member's diary and throw from any downstream `EXTRACT(YEAR …)` — on their
 * public pages, for every visitor, with no way to undo it from the interface. Writes are
 * validated by `calendarDate` now; this keeps one bad row from being fatal.
 */
const DIARY_DATE_FLOOR = "1900-01-01";
const DIARY_DATE_CEILING = "2200-01-01";

/* -------------------------------------------------------------------------- */
/* The guest filter, and the asymmetry in where it is applied                 */
/* -------------------------------------------------------------------------- */

/**
 * I-12. Every PUBLIC surface filters guests out; a guest's OWN surfaces must read normally.
 *
 * Applied to:       getReviews, countReviews, getGlobalFeed, getRecentReviews.
 * DELIBERATELY NOT: getDiary, getRecentLogs, getMemberReviews, getFollowingFeed, getLog.
 *
 * The asymmetry is the guest design itself. A guest is a real `users` row, which is what makes
 * the diary, the heatmaps, the taste model and every other read work unchanged — and the price
 * of that choice is that every figure a member reads as consensus has to exclude them by hand,
 * because there is no database-level guard. One click of a guest's must not move a public
 * number.
 *
 * The other half is just as load-bearing: adding `notGuest` to `getDiary` or `getLog` would
 * make a guest's own diary render empty, which is the same bug wearing the opposite sign.
 * `getFollowingFeed` needs no filter because nobody can follow a guest.
 */
const notGuest = eq(users.isGuest, false);

/* -------------------------------------------------------------------------- */
/* N+1 pattern 1 — correlated subqueries in the SELECT list                   */
/* -------------------------------------------------------------------------- */

/**
 * One subquery per row inside ONE statement, rather than one round trip per row.
 *
 * `::int` is not decoration: `count(*)` is a bigint, which node-postgres hands back as a
 * STRING, so `likeCount + 1` would concatenate rather than add. The cast is what makes it a
 * number on both drivers.
 */
const likeCountSql = sql<number>`(
  select count(*)::int from ${likes}
  where ${likes.targetType} = 'log' and ${likes.targetId} = ${logs.id}
)`;

const commentCountSql = sql<number>`(
  select count(*)::int from ${comments}
  where ${comments.targetType} = 'log' and ${comments.targetId} = ${logs.id}
)`;

/* -------------------------------------------------------------------------- */
/* The base query                                                             */
/* -------------------------------------------------------------------------- */

const logSelection = {
  id: logs.id,
  targetType: logs.targetType,
  rating: logs.rating,
  review: logs.review,
  listenedOn: logs.listenedOn,
  isReplay: logs.is_replay,
  liked: logs.liked,
  createdAt: logs.createdAt,
  discNumber: logs.discNumber,
  trackNumber: logs.trackNumber,
  trackTitle: tracks.title,
  /**
   * Selected only so `trackLocator` can decide whether to print the disc number at all. On a
   * 12-track single-disc record "1-7" is noise, so a single-disc album shows a bare "7".
   */
  albumDiscCount: albums.discCount,
  likeCount: likeCountSql,
  commentCount: commentCountSql,
  author: {
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    avatarSeed: users.avatarSeed,
    isGuest: users.isGuest,
  },
  album: {
    id: albums.id,
    title: albums.title,
    slug: albums.slug,
    coverPath: albums.coverPath,
    releaseDate: albums.releaseDate,
  },
  artist: {
    id: artists.id,
    name: artists.name,
    slug: artists.slug,
    picturePath: artists.picturePath,
  },
};

function baseLogQuery() {
  return db
    .select(logSelection)
    .from(logs)
    .innerJoin(users, eq(users.id, logs.userId))
    .innerJoin(artists, eq(artists.id, logs.artistId))
    .leftJoin(albums, eq(albums.id, logs.albumId))
    .leftJoin(
      tracks,
      // All three columns. On an artist- or album-level log `logs.album_id`, `disc_number` and
      // `track_number` are NULL, `= NULL` never matches, and a LEFT JOIN therefore yields the
      // null track row we want. That is the same three-valued-logic rule that makes the
      // per-column IS NULL branch mandatory further down — here it happens to work FOR us.
      and(
        eq(tracks.albumId, logs.albumId),
        eq(tracks.discNumber, logs.discNumber),
        eq(tracks.trackNumber, logs.trackNumber),
      ),
    );
}

type LogRow = Awaited<ReturnType<typeof baseLogQuery>>[number];

function toEntry(row: LogRow): LogEntry {
  return {
    id: row.id,
    // `target_type` is a varchar because the schema has no enums, and the value is DERIVED by
    // `targetTypeOf()` and never accepted from a client — which is what makes this a cast
    // rather than a validation boundary, and why it happens in exactly one place.
    targetType: row.targetType as TargetType,
    rating: row.rating,
    review: row.review,
    listenedOn: row.listenedOn,
    isReplay: row.isReplay,
    liked: row.liked,
    createdAt: row.createdAt,
    discNumber: row.discNumber,
    trackNumber: row.trackNumber,
    trackTitle: row.trackTitle,
    locator:
      row.trackNumber === null
        ? null
        : trackLocator({
            disc: row.discNumber ?? 1,
            track: row.trackNumber,
            discCount: row.albumDiscCount ?? 1,
          }),
    likeCount: row.likeCount,
    commentCount: row.commentCount,
    tags: [],
    author: row.author,
    album: row.album,
    artist: row.artist,
  };
}

/**
 * N+1 pattern 2 — collect ids, ONE `IN` query, bucket into a Map.
 *
 * THE EMPTY GUARD IS NOT OPTIONAL. `IN ()` is a syntax error, and while this version of Drizzle
 * happens to emit `false` for an empty array, earlier versions emitted the invalid form — so
 * the guard is what keeps a correctness property out of the ORM's changelog. It also saves the
 * round trip outright, which is the whole point on a page that has no logs on it at all.
 *
 * Mutates the entries it is handed. They are always freshly built by `toEntry` above, so there
 * is nothing shared to corrupt, and the alternative copies every row to set one field.
 */
async function withTags(entries: LogEntry[]): Promise<LogEntry[]> {
  if (entries.length === 0) return entries;

  const rows = await db
    .select({ logId: logTags.logId, tag: logTags.tag })
    .from(logTags)
    .where(
      inArray(
        logTags.logId,
        entries.map((entry) => entry.id),
      ),
    );

  const byLog = new Map<number, string[]>();
  for (const row of rows) {
    const bucket = byLog.get(row.logId);
    if (bucket) bucket.push(row.tag);
    else byLog.set(row.logId, [row.tag]);
  }

  for (const entry of entries) entry.tags = byLog.get(entry.id) ?? [];
  return entries;
}

/* -------------------------------------------------------------------------- */
/* Single log, diary, feeds                                                   */
/* -------------------------------------------------------------------------- */

/** No `notGuest`: /log/[id] must render a guest's own log for the guest who wrote it. */
export async function getLog(id: number): Promise<LogEntry | null> {
  const rows = await baseLogQuery().where(eq(logs.id, id)).limit(1);
  const entries = await withTags(rows.map(toEntry));
  return entries[0] ?? null;
}

/**
 * The diary — the only read scoped by `listened_on` rather than `created_at`, because THE DAY
 * SOMEBODY PLAYED SOMETHING IS THE DAY IT BELONGS TO, even if they logged it a week later. A
 * rating saved with "Add to diary" unchecked has a null date and is therefore absent from this
 * read entirely, rather than being filed under whenever it happened to be typed.
 *
 * Ordered by `listened_on` then `created_at`, so several plays dated the same day keep the
 * order they were entered in. Served by `logs_user_listened_idx`.
 *
 * No `notGuest` — a guest's own diary is the surface the whole feature exists for.
 */
export async function getDiary(
  userId: number,
  { year, limit = DIARY_PAGE_SIZE, offset = 0 }: { year?: number | null; limit?: number; offset?: number } = {},
): Promise<LogEntry[]> {
  const rows = await baseLogQuery()
    .where(and(eq(logs.userId, userId), isNotNull(logs.listenedOn), diaryDateWindow(year)))
    .orderBy(desc(logs.listenedOn), desc(logs.createdAt))
    .limit(limit)
    .offset(offset);
  return withTags(rows.map(toEntry));
}

/**
 * I-14's smaller sibling: this repeats getDiary's three conditions and MUST BE EDITED WITH IT.
 * A "next page" link computed from a total that filters differently from the body is the same
 * class of mismatch as a review heading that disagrees with its own list.
 */
export async function countDiary(userId: number, { year }: { year?: number | null } = {}): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(logs)
    .where(and(eq(logs.userId, userId), isNotNull(logs.listenedOn), diaryDateWindow(year)));
  return row?.count ?? 0;
}

/**
 * Both branches are a BETWEEN rather than `EXTRACT(YEAR …) = year`, for two reasons: an extract
 * is not sargable so it cannot use `logs_user_listened_idx`, and it would THROW on a stored
 * 'infinity' (I-4) instead of quietly excluding it — which is exactly what the yearless
 * branch's floor and ceiling are for. The floor is 1900, not 1930: that is before recorded
 * music rather than before television.
 *
 * `year` MUST ALREADY BE BOUNDED BY THE CALLER (`parseBoundedInt`, 1900..2200). It is
 * interpolated into a date literal, and an unparseable one raises an error from the driver —
 * a 500 where a 404 belongs, which is the same class as I-5.
 */
function diaryDateWindow(year?: number | null) {
  if (year === null || year === undefined) {
    return between(logs.listenedOn, DIARY_DATE_FLOOR, DIARY_DATE_CEILING);
  }
  return between(logs.listenedOn, `${year}-01-01`, `${year}-12-31`);
}

/** Profile "recent activity". No `notGuest` — it is one member's own page. */
export async function getRecentLogs(userId: number, limit = 12): Promise<LogEntry[]> {
  const rows = await baseLogQuery().where(eq(logs.userId, userId)).orderBy(desc(logs.createdAt)).limit(limit);
  return withTags(rows.map(toEntry));
}

/**
 * FAN-OUT ON READ. There is no feed table, no inbox and no write-time fan-out anywhere in the
 * schema — the feed is one indexed query against `logs`, served by `logs_user_created_idx`.
 *
 * Everything a followed member logged is included: all three tiers, with or without a rating,
 * review or diary date, replays included. No filtering by kind, no ranking, no de-duplication,
 * no recency decay, no per-author cap. Follows, likes, comments, list creations and wantlist
 * adds do not appear; the feed is logs only.
 *
 * The followee set is a SQL SUBQUERY rather than ids collected in JavaScript, specifically so a
 * member who follows nobody cannot produce `IN ()` — and so the empty case costs one statement
 * instead of two. No `notGuest`: nobody can follow a guest, so there is nothing to exclude.
 */
export async function getFollowingFeed(userId: number, limit = FOLLOWING_FEED_LIMIT): Promise<LogEntry[]> {
  const followees = db.select({ id: follows.followeeId }).from(follows).where(eq(follows.followerId, userId));

  const rows = await baseLogQuery().where(inArray(logs.userId, followees)).orderBy(desc(logs.createdAt)).limit(limit);
  return withTags(rows.map(toEntry));
}

/**
 * The substitute the home page shows when the following feed is empty. The substitution is
 * silent in the data and visible only in the copy, which flips between "From people you follow"
 * and "Across Deadwax".
 */
export async function getGlobalFeed(limit = 24): Promise<LogEntry[]> {
  const rows = await baseLogQuery().where(notGuest).orderBy(desc(logs.createdAt)).limit(limit);
  return withTags(rows.map(toEntry));
}

/** The signed-out home rail. Reviews only, hence `isNotNull(review)` rather than every log row. */
export async function getRecentReviews(limit = 12): Promise<LogEntry[]> {
  const rows = await baseLogQuery()
    .where(and(isNotNull(logs.review), notGuest))
    .orderBy(desc(logs.createdAt))
    .limit(limit);
  return withTags(rows.map(toEntry));
}

/** One member's reviews, for their profile. No `notGuest`, for the reason at its declaration. */
export async function getMemberReviews(
  userId: number,
  { limit = REVIEW_PAGE_SIZE, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<LogEntry[]> {
  const rows = await baseLogQuery()
    .where(and(eq(logs.userId, userId), isNotNull(logs.review)))
    .orderBy(desc(logs.createdAt))
    .limit(limit)
    .offset(offset);
  return withTags(rows.map(toEntry));
}

/* -------------------------------------------------------------------------- */
/* THE SCOPING LADDER — getReviews and countReviews                           */
/* -------------------------------------------------------------------------- */

export type ReviewScope = "exact" | "any";
export type ReviewSort = "popular" | "recent";

/** For whitelisting `?sort=` in a route, so an unknown value falls back rather than reaching SQL. */
export const REVIEW_SORTS: readonly ReviewSort[] = ["popular", "recent"];

/**
 * Which reviews a page gathers.
 *
 * The tier is read off which fields are present, exactly as `targetTypeOf` reads it:
 * `trackNumber` ⇒ track, else `albumId` ⇒ album, else artist.
 */
export type ReviewTarget = {
  artistId?: number;
  albumId?: number;
  discNumber?: number;
  trackNumber?: number;
  scope?: ReviewScope;
};

/**
 * `scope: "any"` ROLLS UP; `scope: "exact"` does not.
 *
 *   artist + "any"  -> artist-, album- AND track-level reviews of anything by that artist
 *   album  + "any"  -> album-level reviews AND its own tracks' reviews
 *   track           -> that track only. "any" is a no-op at the leaf, because a track has no
 *                      children to roll up.
 *
 * THE ROLLUP IS WORTH MORE HERE THAN IN TELEVISION. Most writing about music is about a
 * specific record rather than about an artist's whole output, so an artist page restricted to
 * artist-level reviews is usually an empty page while all the writing sits one or two tiers
 * below it.
 *
 * TWO PREDICATES THAT LOOK REDUNDANT AND ARE NOT:
 *
 *  1. The explicit `disc_number IS NULL AND track_number IS NULL` on the exact album case. An
 *     omitted predicate is not the same as a null one: without it an album page sweeps in every
 *     track row of the album and reports its tracklist's reviews as its own. Same rule as
 *     I-10's third detail.
 *  2. The `target_type` equality beside them. `target_type` is a varchar with no check
 *     constraint, so the nullability predicates are the real guard — but the type column is
 *     what `logs_target_rating_idx` and `logs_artist_target_idx` lead with, so it is also what
 *     makes the plan an index scan rather than a sequential one.
 */
function reviewConditions(target: ReviewTarget) {
  const scope = target.scope ?? "exact";
  const conditions = [isNotNull(logs.review), notGuest];

  if (target.trackNumber !== undefined && target.albumId !== undefined) {
    conditions.push(
      eq(logs.targetType, "track"),
      eq(logs.albumId, target.albumId),
      eq(logs.discNumber, target.discNumber ?? 1),
      eq(logs.trackNumber, target.trackNumber),
    );
  } else if (target.albumId !== undefined) {
    if (scope === "any") {
      // The album tier plus its tracks. Artist-level logs carry a null album_id so they fall
      // out of this on their own; no `target_type` predicate is wanted here, and adding one
      // would defeat the rollup this scope exists for.
      conditions.push(eq(logs.albumId, target.albumId));
    } else {
      conditions.push(
        eq(logs.targetType, "album"),
        eq(logs.albumId, target.albumId),
        isNull(logs.discNumber),
        isNull(logs.trackNumber),
      );
    }
  } else if (target.artistId !== undefined) {
    if (scope === "any") {
      conditions.push(eq(logs.artistId, target.artistId));
    } else {
      conditions.push(eq(logs.targetType, "artist"), eq(logs.artistId, target.artistId), isNull(logs.albumId));
    }
  } else {
    // AN UNIDENTIFIABLE TARGET RETURNS NOTHING, NOT EVERYTHING.
    //
    // Without this branch a `{}` target — a caller that forgot a field, or a route that parsed
    // its slug into undefined — would leave the ladder holding only "has a review" and "not a
    // guest", and an album page would render every review on the platform under its own
    // heading. `false` is the only safe default for a predicate builder whose whole job is to
    // narrow.
    conditions.push(sql`false`);
  }

  return conditions;
}

/**
 * TWO ORDERS ONLY.
 *
 * "popular" is the same correlated like-count subquery the SELECT list uses, reused IN THE
 * ORDER BY, so the sort runs over every matching review before LIMIT/OFFSET rather than
 * reordering one page of already-chosen rows.
 *
 * There is deliberately NO hot ranking, no time decay, no reputation term, no minimum-like
 * threshold and no denormalised `like_count` column. The tiebreak is recency, so an unliked
 * review still holds a stable position instead of reshuffling between requests.
 */
export async function getReviews(
  target: ReviewTarget,
  {
    sort = "recent",
    limit = REVIEW_PAGE_SIZE,
    offset = 0,
  }: { sort?: ReviewSort; limit?: number; offset?: number } = {},
): Promise<LogEntry[]> {
  const order = sort === "popular" ? [desc(likeCountSql), desc(logs.createdAt)] : [desc(logs.createdAt)];

  const rows = await baseLogQuery()
    .where(and(...reviewConditions(target)))
    .orderBy(...order)
    .limit(limit)
    .offset(offset);
  return withTags(rows.map(toEntry));
}

/**
 * THIS FUNCTION AND `getReviews` MUST BE EDITED TOGETHER (I-14).
 *
 * A "12 reviews" heading over ten visible ones is the kind of mismatch that looks like a bug in
 * the list rather than a bug in a count — so the count has to answer the same question the list
 * answers, including the guest filter, which is why `users` is joined here purely to reach
 * `is_guest`.
 *
 * The conditions ladder is reached through `reviewConditions` so the two functions cannot drift
 * apart on the ladder itself; the television original duplicates all of it by hand and that
 * duplication is what I-14 exists to warn about. What is still duplicated here, and still has
 * to be maintained by hand, is the SHAPE around it: the `users` join. Dropping that join
 * compiles, runs, and overcounts by every guest review on the page.
 */
export async function countReviews(target: ReviewTarget): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(logs)
    .innerJoin(users, eq(users.id, logs.userId))
    .where(and(...reviewConditions(target)));
  return row?.count ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Viewer state, comments, priming                                            */
/* -------------------------------------------------------------------------- */

/**
 * N+1 pattern 3 — viewer state as a `Set`, fetched ONCE per page.
 *
 * Called exactly once by every review-bearing page, and called AFTER the entries are in hand
 * because it needs their ids. That is the one place the home page's `Promise.all` is
 * deliberately broken into a second await: a real data dependency, not an oversight (N+1
 * pattern 5).
 *
 * Guards BOTH empty cases. `IN ()` is invalid SQL, and a signed-out visitor has no id at all —
 * so a null `viewerId` returns an empty set rather than spending a round trip on `user_id =
 * null`, which cannot match anything.
 */
export async function getLikedLogIds(viewerId: number | null | undefined, logIds: number[]): Promise<Set<number>> {
  if (!viewerId || logIds.length === 0) return new Set<number>();

  const rows = await db
    .select({ targetId: likes.targetId })
    .from(likes)
    .where(and(eq(likes.userId, viewerId), eq(likes.targetType, "log"), inArray(likes.targetId, logIds)));

  return new Set(rows.map((row) => row.targetId));
}

/** The single-object form, for a page that renders one log or one list. */
export async function hasLiked(
  viewerId: number | null | undefined,
  targetType: SocialTargetType,
  targetId: number,
): Promise<boolean> {
  if (!viewerId) return false;

  const rows = await db
    .select({ userId: likes.userId })
    .from(likes)
    .where(and(eq(likes.userId, viewerId), eq(likes.targetType, targetType), eq(likes.targetId, targetId)))
    .limit(1);

  return rows.length > 0;
}

/**
 * A comment thread. Flat — depth is exactly 1, there is no `parent_id`.
 *
 * ORDERED ASCENDING, unlike every other read in the application: a thread is read top to
 * bottom, so the oldest comment is the first one. `comments_target_idx` covers exactly this.
 *
 * The parameter is the polymorphic target rather than a bare log id, so /list/[slug] uses this
 * same read with `targetType: "list"`. The name is kept from the original because `log` is the
 * case that had no renderer at all there: nothing in the television version renders a thread on
 * a log, so every review card's comment count was permanently 0.
 *
 * No `notGuest`: a guest cannot post a comment (`requireMember` refuses), so there is nothing
 * to filter — and filtering here would retroactively hide a comment if a member were ever
 * converted the other way.
 */
export async function getLogComments(target: {
  targetType: SocialTargetType;
  targetId: number;
}): Promise<CommentEntry[]> {
  return db
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      author: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarSeed: users.avatarSeed,
        isGuest: users.isGuest,
      },
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .where(and(eq(comments.targetType, target.targetType), eq(comments.targetId, target.targetId)))
    .orderBy(asc(comments.createdAt));
}

/**
 * The per-column predicate for one exact target tuple.
 *
 * THE PER-COLUMN NULL BRANCH IS MANDATORY. SQL `= NULL` is NULL, never true, so `disc_number =
 * $2` with a null parameter matches nothing at all. At album level that turns a lookup into a
 * guaranteed miss, and at track level omitting the predicate entirely would let an album-level
 * row through instead. So the branch is `isNull(column)` where the target has no value and
 * `eq(column, value)` where it does. Rewriting this as four plain equalities compiles, runs,
 * and is silently wrong.
 */
function exactTargetConditions(target: LogTarget) {
  return [
    eq(logs.artistId, target.artistId),
    target.albumId == null ? isNull(logs.albumId) : eq(logs.albumId, target.albumId),
    target.discNumber == null ? isNull(logs.discNumber) : eq(logs.discNumber, target.discNumber),
    target.trackNumber == null ? isNull(logs.trackNumber) : eq(logs.trackNumber, target.trackNumber),
  ];
}

/**
 * The newest existing log for one exact target, so a save control can be PRIMED FROM THE REAL
 * ROW.
 *
 * This is the paired half of I-1: any control that saves must be primed from the real row,
 * never from blanks, or a rating click submits empty values over the member's review, diary
 * date, flags and tags (SEC-01). `LogDialog`'s `initial` prop is required rather than optional
 * precisely so that forgetting this read is a compile error.
 *
 * NEWEST, not oldest: a replay is a second row, so the oldest row is a verdict the member has
 * already moved past.
 */
export async function findExistingLog(userId: number, target: LogTarget): Promise<ExistingLog | null> {
  const rows = await db
    .select({
      id: logs.id,
      rating: logs.rating,
      review: logs.review,
      listenedOn: logs.listenedOn,
      isReplay: logs.is_replay,
      liked: logs.liked,
    })
    .from(logs)
    .where(and(eq(logs.userId, userId), ...exactTargetConditions(target)))
    .orderBy(desc(logs.createdAt))
    .limit(1);

  const existing = rows[0];
  if (!existing) return null;

  const tags = await db.select({ tag: logTags.tag }).from(logTags).where(eq(logTags.logId, existing.id));
  return { ...existing, tags: tags.map((row) => row.tag) };
}

/**
 * How many reviews this member has written, EXCLUDING THE ONE THEY ARE EDITING.
 *
 * The exclusion is the entire reason the parameter exists. A guest sitting at
 * `GUEST_REVIEW_CAP = 3` must still be able to revise the three they wrote, instead of being
 * frozen out of their own words — so the review currently open in the dialog must not count
 * against the cap that would refuse the save.
 *
 * TWO SEPARATE THREE-VALUED-LOGIC TRAPS LIVE IN THESE FIVE LINES:
 *
 *  1. The per-column branch (see `exactTargetConditions`): `= NULL` never matches, so a plain
 *     equality makes the exclusion a silent no-op and the member is refused their own edit.
 *  2. `NOT (…)` over that predicate is NULL, not true, whenever a ROW carries a null in a
 *     column the ignored target has a value for. An artist-level review compared against a
 *     track target gives `NOT NULL` = NULL, and `WHERE NULL` drops the row — so the count would
 *     silently fall SHORT and let a guest past the cap. `coalesce(…, false)` is what makes the
 *     negation total.
 */
export async function countReviewsBy(userId: number, ignore?: LogTarget): Promise<number> {
  const conditions = [eq(logs.userId, userId), isNotNull(logs.review)];

  if (ignore) {
    const matchesIgnored = and(...exactTargetConditions(ignore));
    conditions.push(sql`not coalesce(${matchesIgnored}, false)`);
  }

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(logs)
    .where(and(...conditions));
  return row?.count ?? 0;
}

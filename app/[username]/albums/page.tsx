/**
 * `/@name/albums` — the member's shelf. Four orderings, one grid, no pagination.
 *
 * ============================================================================
 * THERE IS NO `getMemberAlbums` QUERY, AND THIS PAGE IS COMPOSED OUT OF THREE THAT EXIST.
 *
 * Every member-scoped album read in lib/ answers a narrower question than "everything this
 * member has engaged with": `getTopAlbums` is album-level RATINGS only, `getReplayLeaders` is
 * albums played twice or more, and the two progress rails are TRACK-level logs against
 * canonical releases. So the set here is their union, assembled in JavaScript, and the
 * recency ordering comes from a bounded scan of the member's own log rows — which is the only
 * read in the codebase that carries a true `created_at` ordering across all three tiers.
 *
 * THE KNOWN COST, STATED HONESTLY: the recency scan is bounded at `LOG_SCAN` rows, so an album
 * logged once, unrated, and further back than that window is absent from this shelf. The
 * bounded alternative does not exist yet; the right fix is one statement
 * (`SELECT DISTINCT ON (album_id) … ORDER BY album_id, created_at DESC`) in
 * lib/db/queries/albums.ts, and it is named here so that it is one edit rather than an
 * investigation. Nothing below silently pretends the window is the whole library: the count
 * printed under the heading is the size of what was assembled, never a claim about the total.
 * ============================================================================
 *
 * THE FOUR ORDERINGS ALL CARRY A TIE-BREAKER, for the reason `getActiveMembers` records: a
 * comparator with ties lets the tail of the page reshuffle between two renders of identical
 * data, which reads as a page that randomises itself.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { loadProfile } from "@/app/[username]/layout";
import { CoverCard } from "@/components/album/cover-card";
import { CoverGrid } from "@/components/album/cover-grid";
import { SortSelect } from "@/components/discovery/sort-select";
import { Stars } from "@/components/rating/stars";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionHeading } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import { getAlbumsByIds, getTopAlbums } from "@/lib/db/queries/albums";
import { getRecentLogs } from "@/lib/db/queries/logs";
import { plural } from "@/lib/format";
import { formatRating } from "@/lib/ratings";
import { getReplayLeaders } from "@/lib/stats/profile";
import { cardFromAlbumRow } from "@/lib/view";

/** How many of the member's own log rows the recency pass reads. See the docblock's caveat. */
const LOG_SCAN = 400;
/** Album-level ratings considered. `getTopAlbums` is already `DISTINCT ON (album_id)`. */
const RATED_SCAN = 200;
/** Replay leaders considered. Enough to rank a shelf; the panel on the profile shows six. */
const REPLAY_SCAN = 60;
/** Albums rendered. A multiple of 24, so the last row fills at every breakpoint. */
const SHELF_LIMIT = 120;
/** The first row of a grid is eager; everything below the fold stays lazy. */
const EAGER_ROW = 6;

const MEMBER_ALBUM_SORTS = ["recent", "rating", "name", "replays"] as const;
type MemberAlbumSort = (typeof MEMBER_ALBUM_SORTS)[number];

/**
 * NOTHING HERE IS WORDED AS QUALITY OR AS A TOTAL. "Most played" is a count of album-level log
 * rows and says so; "Rating" is the member's own verdict and is neither an average nor a
 * ranking of the catalogue. The same rule `ALBUM_SORT_LABELS` is written out for.
 */
const MEMBER_ALBUM_SORT_LABELS: Readonly<Record<MemberAlbumSort, string>> = {
  recent: "Recently logged",
  rating: "Rating",
  name: "A–Z",
  replays: "Most played",
};

/** The whitelist. A sort key never reaches a comparator as free text. */
function parseMemberAlbumSort(value: string | undefined | null): MemberAlbumSort {
  return (MEMBER_ALBUM_SORTS as readonly string[]).includes(value ?? "")
    ? (value as MemberAlbumSort)
    : "recent";
}

/** One album on the shelf, before the full row is fetched. */
type Shelved = {
  albumId: number;
  title: string;
  /** Position in the recency scan; `UNSEEN` for an album the scan's window did not reach. */
  recency: number;
  /** The member's album-level verdict, stored 1..10. NULL is "not rated", never 0. */
  rating: number | null;
  /** Album-level log rows. 0 for an album below `REPLAY_LEADER_MIN_PLAYS`. */
  plays: number;
};

/** Sorts after everything the scan saw, rather than before it, which `0` would do. */
const UNSEEN = Number.MAX_SAFE_INTEGER;

type PageProps = {
  params: Promise<{ username: string }>;
  searchParams: Promise<{ sort?: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { username } = await params;
  const member = await loadProfile(username);
  const name = member.displayName ?? member.username;

  return {
    title: `${name}'s albums`,
    description: `Records ${name} has rated, played and written about on Deadwax.`,
  };
}

export default async function MemberAlbumsPage({ params, searchParams }: PageProps) {
  const [{ username }, query] = await Promise.all([params, searchParams]);
  const sort = parseMemberAlbumSort(query.sort);

  const [member, viewer] = await Promise.all([loadProfile(username), currentUser()]);
  const isOwner = viewer?.id === member.id;
  const name = member.displayName ?? member.username;

  const [recent, rated, replays] = await Promise.all([
    getRecentLogs(member.id, LOG_SCAN),
    getTopAlbums(member.id, RATED_SCAN),
    getReplayLeaders(member.id, REPLAY_SCAN),
  ]);

  /*
   * THE UNION, BUILT IN ONE PASS PER SOURCE AND KEYED BY `album_id`.
   *
   * Insertion order does not matter — every comparator below is total — but the ORDER OF THE
   * THREE PASSES does: the recency pass runs first so that `recency` is the scan index rather
   * than a value invented by a later pass, and the two enrichment passes only ever fill fields
   * rather than replacing a row, so an album present in all three keeps one entry.
   */
  const shelf = new Map<number, Shelved>();

  recent.forEach((entry, index) => {
    // An artist-level log has no album, and `count(distinct album_id)` ignores nulls
    // everywhere else for the same reason: an opinion about an artist is not a record.
    if (!entry.album) return;
    const existing = shelf.get(entry.album.id);
    if (existing) return; // The first sighting is the most recent one: this list is newest-first.
    shelf.set(entry.album.id, {
      albumId: entry.album.id,
      title: entry.album.title,
      recency: index,
      rating: null,
      plays: 0,
    });
  });

  for (const row of rated) {
    const existing = shelf.get(row.id);
    if (existing) existing.rating = row.viewerRating;
    else
      shelf.set(row.id, {
        albumId: row.id,
        title: row.title,
        recency: UNSEEN,
        rating: row.viewerRating,
        plays: 0,
      });
  }

  for (const row of replays.albums) {
    const existing = shelf.get(row.albumId);
    if (existing) existing.plays = row.plays;
    else
      shelf.set(row.albumId, {
        albumId: row.albumId,
        title: row.title,
        recency: UNSEEN,
        rating: null,
        plays: row.plays,
      });
  }

  /** The tie-breaker every comparator ends on. Title, then the id, which is arbitrary but stable. */
  const byTitle = (a: Shelved, b: Shelved) =>
    a.title.localeCompare(b.title, "en") || a.albumId - b.albumId;

  const ordered = [...shelf.values()].sort((a, b) => {
    switch (sort) {
      case "rating":
        // NULL SORTS LAST, NOT AS ZERO. "Not rated" is a real state and treating it as the
        // bottom of the scale would put unrated records below a one-star verdict.
        if (a.rating === b.rating) return byTitle(a, b);
        if (a.rating === null) return 1;
        if (b.rating === null) return -1;
        return b.rating - a.rating;
      case "name":
        return byTitle(a, b);
      case "replays":
        return b.plays - a.plays || byTitle(a, b);
      case "recent":
      default:
        return a.recency - b.recency || byTitle(a, b);
    }
  });

  const window = ordered.slice(0, SHELF_LIMIT);

  /*
   * THE DEPENDENT READ, AND IT IS WHY THE SORT HAPPENS BEFORE IT. `getAlbumsByIds` preserves
   * the input order, so the ranking computed above survives into the grid — and only the
   * hundred-and-twenty rows that are actually rendered are fetched, rather than every row of
   * every source.
   */
  const rows = await getAlbumsByIds(window.map((entry) => entry.albumId));
  const shelvedById = new Map(window.map((entry) => [entry.albumId, entry]));

  const basePath = `/@${member.username}/albums`;

  return (
    <div className="space-y-6">
      <SectionHeading eyebrow="Shelf" title={`${name}'s albums`} as="h1" />

      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
          {plural(ordered.length, "album")}
        </p>
        {/*
          `params` is empty and `page` is deliberately not in it: this route has no page
          parameter at all, and `SortSelect`'s own docblock explains why carrying one across a
          re-sort lands a member in the middle of a set they have not seen the start of.
        */}
        <SortSelect
          basePath={basePath}
          options={MEMBER_ALBUM_SORTS}
          value={sort}
          labels={MEMBER_ALBUM_SORT_LABELS}
          label={`Sort ${name}'s albums by`}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={isOwner ? "Nothing on the shelf yet" : `${name} has not logged an album yet`}
          description={
            isOwner
              ? "Rate or log a record and it appears here, ordered by whichever of the four views you prefer."
              : "Albums appear here once they have been rated, played or written about."
          }
          action={
            isOwner ? (
              <Button asChild variant="primary">
                <Link href="/albums">Browse albums</Link>
              </Button>
            ) : null
          }
        />
      ) : (
        <CoverGrid>
          {rows.map((row, index) => {
            const shelved = shelvedById.get(row.id);
            const rating = shelved?.rating ?? null;
            return (
              <div key={row.id}>
                <CoverCard
                  album={{
                    ...cardFromAlbumRow(row),
                    /*
                     * `viewerRating` IS DELIBERATELY NOT SET, EVEN THOUGH A RATING IS IN HAND.
                     *
                     * `CoverCard`'s overlay announces "Your rating: …" — and the rating on this
                     * page belongs to the member whose shelf it is, who is usually not the
                     * person reading. Reusing the slot would put a false first-person sentence
                     * in front of every screen-reader user looking at somebody else's profile,
                     * which is exactly the kind of thing a visual check never catches. So the
                     * stars go BELOW the card, attributed by name.
                     *
                     * `replayCount` is reused, because its own sr-only sentence is already
                     * third-person ("Played 4 times") and therefore true either way.
                     */
                    replayCount: shelved?.plays ?? 0,
                  }}
                  eager={index < EAGER_ROW}
                />
                {rating === null ? null : (
                  <div className="mt-1">
                    <Stars
                      value={rating}
                      size="xs"
                      label={`${isOwner ? "You rated" : `${name} rated`} this ${formatRating(rating)} out of 5 stars`}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </CoverGrid>
      )}
    </div>
  );
}

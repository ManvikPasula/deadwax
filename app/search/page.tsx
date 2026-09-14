/**
 * /search — records, artists and members.
 *
 * ---------------------------------------------------------------------------------------
 * THE RATE LIMIT DEGRADES THE FEATURE INSTEAD OF REFUSING IT
 * ---------------------------------------------------------------------------------------
 *
 * `BUDGETS.searchByIp` is 30 per 60s. OVER THE LIMIT, THE REMOTE SEARCH IS REPLACED BY
 * `Promise.resolve([])` AND THE PAGE RENDERS FROM THE LOCAL MIRROR ALONE.
 *
 * That substitution is the whole design of this route: *a scraper gets far less than they asked
 * for, and a person hitting the limit barely notices.* The rejected alternative is the ordinary
 * one — a 429, or an error panel reading "too many requests" — and it is worse in both
 * directions at once. It teaches a scraper exactly where the wall is, and it takes the search
 * box away from somebody who typed three words quickly.
 *
 * AND IT IS DISCLOSED. `mirrorOnly` reaches `SearchResults`, which prints one mono line saying
 * the provider search is throttled — because a member who searches a real record and sees
 * nothing would otherwise conclude the catalogue does not have it and try again with the same
 * words. The limiter FAILS OPEN on its own errors (I-33), so this state is rare by design.
 *
 * ---------------------------------------------------------------------------------------
 * THE FILL IS SEQUENCED BEFORE THE LOCAL READ, AND THAT ORDER IS THE POINT
 * ---------------------------------------------------------------------------------------
 *
 *   1. the remote search (or `[]`)
 *   2. `await cacheAlbumSummaries(...)`
 *   3. the mirror: albums, artists, members
 *
 * Step 2 is NOT an optimisation. `logs.album_id` carries a foreign key, so a cover clicked
 * before its row exists is a first star click that cannot be saved — and a provider summary
 * alone cannot even produce a URL, because the primary key here is a local `serial` and the
 * external id is a secondary column (lib/view.ts explains this at length). Running the local
 * read BEFORE the fill was the first version and it is wrong twice over: the freshly mirrored
 * rows are missing from the results, so every remote card renders inert, and the artists those
 * albums just created are missing from the Artists section.
 *
 * Step 2 also explains why there is NO REMOTE ARTIST SEARCH. `cardFromDeezerArtist` returns
 * null without a local id, so an unmirrored provider artist cannot be rendered at all — and
 * the only bulk writer of artist rows is `cacheAlbumSummaries` itself, through
 * `ensureArtistStub`. So the artists somebody was looking for arrive in step 2 as stubs and are
 * found by step 3. Calling `searchArtists` as well would spend a second provider request to
 * produce cards that would then be dropped.
 *
 * ---------------------------------------------------------------------------------------
 * THE MERGE IS LOCAL-FIRST, AND THE CAP IS 36
 * ---------------------------------------------------------------------------------------
 *
 * `uniqueCards` keeps the FIRST occurrence, and the local card is placed first because it is
 * the one carrying member figures; keeping the provider copy instead would blank the average on
 * exactly the records Deadwax knows most about. 36 is one and a half grids of 24 — enough that
 * a vague query is useful and few enough that the page is not a catalogue dump.
 */

import type { Metadata } from "next";

import { SearchResults } from "@/components/discovery/search-results";
import { searchLocalAlbums } from "@/lib/db/queries/albums";
import { searchLocalArtists } from "@/lib/db/queries/artists";
import { getMemberCardStats, searchUsers, viewerFollowSet } from "@/lib/db/queries/users";
import { currentUser } from "@/lib/auth/session";
import { cacheAlbumSummaries } from "@/lib/ingest/albums";
import { searchAlbums } from "@/lib/providers/deezer";
import type { DeezerAlbumSummary } from "@/lib/providers/deezer/types";
import { BUDGETS, clientAddress, consume } from "@/lib/security/rate-limit";
import { cardFromAlbumRow, cardFromArtistRow, cardFromDeezerSummary, uniqueCards, type AlbumCard } from "@/lib/view";

/**
 * The cap on the merged record list. Applied AFTER the dedupe, so a query whose local and
 * remote halves overlap heavily still fills the grid.
 */
const RESULT_CAP = 36;

/** The provider window. One request; the merge and the cap do the rest. */
const REMOTE_LIMIT = 25;

/** Local windows, both a little over the cap so the dedupe has something to work with. */
const LOCAL_ALBUM_LIMIT = 36;
const LOCAL_ARTIST_LIMIT = 18;

/**
 * The longest query we will pass on.
 *
 * Not a validation rule — `containsPattern` (I-6) already escapes `%` and `_` so a member
 * typing a literal percent sign searches for one — but a 4KB query string has no legitimate
 * use and ends up in a provider URL and a `LIKE` pattern.
 */
const MAX_QUERY = 120;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** First value wins for a repeated `?q`, then trim and cap. */
function readQuery(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? "").trim().slice(0, MAX_QUERY);
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  // `searchParams` IS A PROMISE in Next 16, in `generateMetadata` exactly as in the page.
  const query = readQuery((await searchParams).q);

  return {
    // A bare title: the root's `title.template` makes it "… · Deadwax".
    title: query ? `Search: ${query}` : "Search",
    description: "Search Deadwax for records, the artists who made them, and the members writing about them.",
  };
}

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const query = readQuery((await searchParams).q);
  const viewer = await currentUser();

  /*
   * AN EMPTY QUERY IS A FIRST-CLASS STATE AND IT RETURNS BEFORE ANYTHING ELSE HAPPENS.
   *
   * Nothing has failed and nothing is missing, so the answer is an INVITATION — which
   * `SearchResults` renders for `query === ""`, deliberately different from the "nothing found"
   * report. It is also why this branch is above the limiter: a visitor who opens /search and
   * types nothing must not spend a budget slot, and must not be told the provider is throttled
   * for a search they never ran.
   */
  if (query.length === 0) {
    return (
      <div className="space-y-6">
        <SearchHeader query="" />
        <SearchResults query="" albums={[]} artists={[]} members={[]} viewerId={viewer?.id ?? null} />
      </div>
    );
  }

  /*
   * ONE SLOT PER RENDERED SEARCH, KEYED BY SOURCE RATHER THAN BY ACCOUNT.
   *
   * `clientAddress()` takes the LEFT-MOST x-forwarded-for entry, which is trustworthy only
   * because the hosting platform terminates every request and overwrites that header — off
   * platform this budget is bypassable with one header, and the limiter's own module says so.
   * Keying by member instead would leave a signed-out scraper unlimited, which is the case this
   * budget exists for.
   */
  const limit = await consume(BUDGETS.searchByIp, await clientAddress());
  const mirrorOnly = !limit.ok;

  /*
   * THE SUBSTITUTION. Over the limit this is a resolved empty array and NO REQUEST LEAVES THE
   * PROCESS. `searchAlbums` goes through `deezerFetchOptional`, so a provider that is down or
   * slow also resolves to `[]` rather than throwing — this page has no failure branch because
   * every path through it has a mirror to fall back to.
   */
  const remote: Promise<DeezerAlbumSummary[]> = mirrorOnly
    ? Promise.resolve([])
    : searchAlbums(query, REMOTE_LIMIT);
  const summaries = await remote;

  /*
   * THE LOAD-BEARING WRITE. See the module docblock: `logs.album_id` has a foreign key, so this
   * is what makes the first star click on a search result savable. It is deliberately
   * non-fatal — it logs a warning and returns — so a failed upsert degrades to provider-only
   * cards with no href rather than to a 500.
   */
  await cacheAlbumSummaries(summaries);

  /* Now the mirror, which includes everything step 2 just inserted. */
  const [localAlbums, localArtists, members] = await Promise.all([
    searchLocalAlbums(query, LOCAL_ALBUM_LIMIT),
    searchLocalArtists(query, LOCAL_ARTIST_LIMIT),
    searchUsers(query),
  ]);

  /*
   * A SECOND ROUND, because both of these need the ids from the first. One query each for the
   * whole page (D-3), never one per card: `getMemberCardStats` is the batched read the member
   * directory's defect was about, and `viewerFollowSet` resolves every follow button at once.
   */
  const memberIds = members.map((member) => member.id);
  const [memberStats, followingIds] = await Promise.all([
    getMemberCardStats(memberIds),
    viewerFollowSet(viewer?.id, memberIds),
  ]);

  /*
   * THE MERGE.
   *
   * A local card keys on its serial id and a provider-only card keys on its `deezerId`, so
   * `uniqueCards` cannot collapse the two against each other — which is exactly why the
   * already-mirrored summaries are filtered out HERE, by external id, before they ever reach
   * it. Without this the same record appears twice: once with member figures and once inert.
   *
   * The known limitation, stated rather than hidden: a summary mirrored in step 2 whose title
   * and artist do not match the local `ILIKE` (Deezer matched it on something we do not index)
   * falls through to the provider branch and renders with `href: null` even though its row now
   * exists. That is `CoverCard`'s designed inert state, and it self-corrects on the next search
   * for a string the mirror can match.
   */
  const mirroredIds = new Set(localAlbums.map((row) => row.deezerId));
  const albums: AlbumCard[] = uniqueCards([
    ...localAlbums.map((row) => cardFromAlbumRow(row)),
    ...summaries
      .filter((summary) => !mirroredIds.has(String(summary.id)))
      // `null` local id, explicitly: a provider id cannot stand in for a serial, and the card
      // renders without a link rather than pointing at somebody else's album on a guessed id.
      .map((summary) => cardFromDeezerSummary(summary, null)),
  ]).slice(0, RESULT_CAP);

  return (
    <div className="space-y-6">
      <SearchHeader query={query} />
      <SearchResults
        query={query}
        albums={albums}
        artists={localArtists.map((row) => cardFromArtistRow(row, 500))}
        members={members}
        memberStats={memberStats}
        followingIds={followingIds}
        viewerId={viewer?.id ?? null}
        mirrorOnly={mirrorOnly}
      />
    </div>
  );
}

/**
 * The page's own heading.
 *
 * IT IS NOT A SEARCH BOX. The one input in the search path is `components/nav/search-box.tsx`
 * in the sticky header, which is on screen on every route including this one — a second field
 * here would be a second thing to type into, with two values that can disagree, and the header
 * copy already names the query back through the `<h1>`.
 */
function SearchHeader({ query }: { query: string }) {
  return (
    <header className="letterbox">
      <p className="eyebrow">Search</p>
      <h1 className="mt-2 font-display text-3xl leading-tight text-paper text-balance sm:text-4xl">
        {/* Curly quotes, and the query is escaped JSX children — never interpolated markup. */}
        {query ? <>Results for &ldquo;{query}&rdquo;</> : "Search Deadwax"}
      </h1>
    </header>
  );
}

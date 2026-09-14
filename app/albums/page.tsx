/**
 * /albums — the catalogue grid.
 *
 * ---------------------------------------------------------------------------------------
 * THE ADDRESS IS THE ONLY STATE
 * ---------------------------------------------------------------------------------------
 *
 * `?genre &decade &sort &page`, every one of them parsed here by the EXPORTED parser that
 * belongs to the query it feeds — `parseAlbumSort` (a whitelist that selects a branch of an
 * `orderBy`, so a sort key never reaches SQL as text), `parseDecade` (bounded 1900..2200, and
 * it returns NULL rather than clamping so a silly value cannot render somebody else's page),
 * `parsePage` (the single exception to that rule: a page number clamps to 1, because a silly
 * `?page=` should not break a link).
 *
 * `FilterBar` and `FilterPagination` do the rest, and both are Server Components made of links
 * — the reasoning is written out at length in their own file. Nothing on this page holds state.
 *
 * ---------------------------------------------------------------------------------------
 * THE COLD-START FILL, AND WHY IT IS ALLOWED HERE AND NOT ON `/`
 * ---------------------------------------------------------------------------------------
 *
 * `HomeRails` refuses to write, and names this route as one of the three that do. The reason is
 * specific rather than a preference: `/` carries `revalidate = 0`, so every anonymous visitor
 * would trigger a bulk upsert and PGlite allows exactly one writer. This page is reached
 * because somebody asked for records.
 *
 * So the fill is here, and it is BOUNDED THREE WAYS:
 *
 *   1. PAGE 1 ONLY. Page 7 of a thin result set is not where a catalogue gets seeded.
 *   2. ONLY WHEN THE WINDOW IS SHORT. A full page means the mirror already holds enough; the
 *      fill stops happening on its own the moment it has worked.
 *   3. ONLY WITH NO DECADE FILTER. Deezer's chart is this week's records, so fetching it to
 *      satisfy `?decade=1970` spends a provider call and a write on rows that cannot match the
 *      filter being asked about.
 *
 * Without it a cold instance shows an empty grid with no way out of it from this page, and the
 * empty state below would be the whole of /albums forever.
 *
 * `await` ON `cacheAlbumSummaries` IS LOAD-BEARING, NOT AN OPTIMISATION. `logs.album_id` has a
 * foreign key, so a cover that is clicked before its row exists is a star click that cannot be
 * saved. The upsert is deliberately non-fatal — it logs and returns on failure — so the page
 * renders whatever the mirror has either way.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { CoverCard } from "@/components/album/cover-card";
import { CoverGrid } from "@/components/album/cover-grid";
import { FilterBar, FilterPagination } from "@/components/discovery/filter-bar";
import { ALBUM_SORT_LABELS } from "@/components/discovery/sort-select";
import { Button } from "@/components/ui/button";
import { EmptyState, Eyebrow } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import {
  ALBUM_SORTS,
  BROWSE_PAGE_SIZE,
  browseAlbums,
  getViewerAlbumOverlay,
  parseAlbumSort,
  parseDecade,
  type AlbumRow,
} from "@/lib/db/queries/albums";
import { cacheAlbumSummaries } from "@/lib/ingest/albums";
import { chartAlbums, DEFAULT_GENRES, getGenres } from "@/lib/providers/deezer";
import { parsePage } from "@/lib/slug";
import { cardFromAlbumRow } from "@/lib/view";

/** The chart window the cold-start fill mirrors. Deezer's own page maximum is far larger. */
const CHART_FILL = 25;

/** The first grid row loads eagerly; `lg:grid-cols-6` is the widest row this grid has. */
const EAGER_ROW = 6;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** First value wins for a repeated parameter, and the length cap keeps a silly URL out of SQL. */
function one(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = (raw ?? "").trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 60);
}

/** "Jazz records from the 1970s". One spelling, shared by the heading and the page title. */
function browseTitle(genre: string | null, decade: number | null): string {
  const noun = genre ? `${genre} records` : "Records";
  return decade === null ? noun : `${noun} from the ${decade}s`;
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  // `searchParams` IS A PROMISE in Next 16, in `generateMetadata` exactly as in the page.
  const query = await searchParams;
  const genre = one(query.genre);
  const decade = parseDecade(one(query.decade));

  return {
    // A bare title: the root's `title.template` makes it "… · Deadwax".
    title: browseTitle(genre, decade),
    description:
      "Browse the records Deadwax has mirrored, by genre and by decade, ordered by popularity, release date or title.",
  };
}

export default async function AlbumsPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;

  const genre = one(query.genre);
  const decade = parseDecade(one(query.decade));
  const sort = parseAlbumSort(one(query.sort));
  const page = parsePage(one(query.page));

  /*
   * THE VIEWER ONLY OVERLAYS, IT NEVER FILTERS. Their own star and play count land on the
   * cards; nothing is hidden because they have already rated it. Hiding would quietly turn a
   * catalogue into a recommender, which is what /for-you is — with a model behind it and a
   * stated reason per row.
   */
  const viewer = await currentUser();

  /*
   * THE GENRE VOCABULARY IS THE PAGE'S JOB, because `FilterBar` must not query. These are
   * NAMES, not ids: `browseAlbums` filters with `genres @> '["Jazz"]'::jsonb` against the names
   * resolved at ingest, so the name IS the filter value.
   *
   * `getGenres` is Deezer's fixed list of ~28, cached for a week by the fetch layer, and it
   * returns an empty array rather than throwing when the provider is unreachable. It falls back
   * to `DEFAULT_GENRES` rather than to nothing: four verified chips are a usable filter row and
   * zero chips reads as a broken one.
   */
  const vocabulary = await getGenres();
  const genres = vocabulary.length > 0 ? vocabulary.map((entry) => entry.name) : [...DEFAULT_GENRES];

  let result = await browseAlbums({ genre, decade, sort, page });

  // The bounded cold-start fill. All three conditions are argued for in the module docblock.
  if (page === 1 && decade === null && result.rows.length < BROWSE_PAGE_SIZE) {
    const genreId = genre === null ? 0 : (vocabulary.find((entry) => entry.name === genre)?.id ?? null);
    if (genreId !== null) {
      const summaries = await chartAlbums(genreId, CHART_FILL);
      if (summaries.length > 0) {
        await cacheAlbumSummaries(summaries);
        // Re-read, so the covers that were just mirrored carry real ids and real hrefs.
        result = await browseAlbums({ genre, decade, sort, page });
      }
    }
  }

  const overlay = await getViewerAlbumOverlay(
    viewer?.id,
    result.rows.map((row) => row.id),
  );

  const withViewer = (row: AlbumRow) => {
    const own = overlay.get(row.id);
    return {
      ...cardFromAlbumRow(row),
      viewerRating: own?.rating ?? null,
      /*
       * `plays` is this member's album-level log count, which is what the teal `×N` badge
       * means: nobody is 40% of the way through a 42-minute record, so the replay count is the
       * progress figure a music card has.
       */
      replayCount: own?.plays ?? 0,
    };
  };

  /** Every filter and the sort, and NEVER `page` — changing a filter resets the window. */
  const params = { genre, decade, sort };

  return (
    <div className="space-y-6">
      <header className="letterbox">
        <Eyebrow>Browse</Eyebrow>
        <h1 className="mt-2 font-display text-3xl leading-tight text-paper sm:text-4xl">
          {browseTitle(genre, decade)}
        </h1>
      </header>

      {/*
        `decade` is PASSED, which is what makes the decade row appear at all — `/artists` omits
        the prop entirely, because an artist has no release date to filter on, and `undefined`
        (no axis) and `null` (axis present, nothing selected) are deliberately different states.
      */}
      <FilterBar
        basePath="/albums"
        genres={genres}
        genre={genre}
        decade={decade}
        sorts={ALBUM_SORTS}
        sort={sort}
        sortLabels={ALBUM_SORT_LABELS}
      />

      {result.rows.length === 0 ? (
        /*
         * A DESIGNED EMPTY STATE, AND THE COPY SAYS WHOSE ABSENCE IT IS. With a filter on, it is
         * this filter's; with no filter it is our mirror's. Neither is a claim about music —
         * "there are no jazz records" is a sentence nobody should read off this page.
         */
        <EmptyState
          title={genre || decade !== null ? "Nothing matches that filter yet" : "The catalogue is still filling"}
          description={
            genre || decade !== null
              ? "Deadwax mirrors a record the first time somebody looks at it, so a narrow filter can be empty while the record exists. Searching for it pulls it in."
              : "Nothing has been mirrored into this instance yet. Searching for a record pulls it in, along with its tracklist and its artist."
          }
          action={
            <Button asChild variant="primary">
              <Link href="/search">Search for a record</Link>
            </Button>
          }
        />
      ) : (
        <>
          {/*
            `CoverGrid` owns the column counts AND the `.stagger` animation, so re-declaring
            `grid-cols-3 sm:grid-cols-4 lg:grid-cols-6` here would be a second copy of a number
            that is only correct as long as it agrees with `BROWSE_PAGE_SIZE`.

            NO `memberAverage` IS PASSED, and that is the rule rather than an omission:
            `browseAlbums` returns no member aggregates, the card's average slot is reserved for
            Deadwax's own ratings, and Deezer hands us `fans` and `rank` in the same payload —
            dropping one of those into a star figure is the single most tempting dishonesty
            available in a music app.
          */}
          <CoverGrid>
            {result.rows.map((row, index) => (
              <CoverCard key={row.id} album={withViewer(row)} eager={index < EAGER_ROW} />
            ))}
          </CoverGrid>

          {/*
            No total and no numbered page list. `browseAlbums` fetches `perPage + 1` rows — one
            past the window, which is what makes a full window distinguishable from the end —
            and there is no honest total to print for a provider-backed grid. Page 1 carries no
            `page` parameter, so the canonical first page has exactly one address.
          */}
          <FilterPagination basePath="/albums" params={params} page={result.page} hasMore={result.hasMore} />
        </>
      )}
    </div>
  );
}

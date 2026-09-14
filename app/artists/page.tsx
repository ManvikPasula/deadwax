/**
 * /artists — the artist grid.
 *
 * `?genre &sort &page`, parsed by the exported parsers that belong to the query they feed:
 * `parseArtistSort` is a whitelist that selects a branch of an `orderBy`, and `parsePage`
 * clamps to 1 rather than returning null, because a silly `?page=` should not break a link.
 *
 * ---------------------------------------------------------------------------------------
 * NO DECADE AXIS, AND THE PROP IS OMITTED RATHER THAN PASSED AS NULL
 * ---------------------------------------------------------------------------------------
 *
 * An artist has no release date to filter on. `FilterBar` treats an ABSENT `decade` prop and a
 * `null` one as different states on purpose — absent hides the row, null means "the axis
 * exists and nothing is selected" — so the omission below is the whole of that decision.
 *
 * ---------------------------------------------------------------------------------------
 * THERE IS NO COLD-START FILL HERE, UNLIKE /albums
 * ---------------------------------------------------------------------------------------
 *
 * /albums seeds a thin mirror from `chartAlbums` + `cacheAlbumSummaries`. The same move is
 * deliberately NOT made here, and the reason is that there is no bulk writer for artists:
 * `cacheAlbumSummaries` is the only path that creates artist rows in bulk, and it does so as a
 * side effect of mirroring ALBUMS (through `ensureArtistStub`). The two alternatives both lose:
 *
 *   - `chartArtists()` + `ensureArtist()` per row is 25 provider DETAIL calls for one grid, on
 *     a platform-wide outbound budget shared with every other member.
 *   - `chartAlbums()` + `cacheAlbumSummaries()` from here would mirror albums nobody asked for
 *     in order to populate a page about people, and would put the artist grid's freshness at
 *     the mercy of an album chart.
 *
 * So artists arrive with their records, and the empty state below says exactly that and sends
 * somebody to the surface that fills the mirror. That is the honest version: this page reports
 * what we hold rather than fetching a chart to look busy.
 *
 * ---------------------------------------------------------------------------------------
 * ROUND PORTRAITS, NOT `.sleeve`
 * ---------------------------------------------------------------------------------------
 *
 * `.sleeve` is the RECORD geometry — 1:1 with the card radius, and it carries the hover lift
 * that means "a release lives here". A square artist portrait in a page of square covers reads
 * as one more album. The markup below is deliberately the same as the artist section of
 * components/discovery/search-results.tsx, for the reason that file states: one shape for
 * "person", one for "release", and no third.
 *
 * `CoverGrid` is still the layout, because it is a layout ONLY and takes children for exactly
 * this — the same column counts hold album cards and artist cards without a second copy of the
 * classes, and its `.stagger` applies to whatever is inside it.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { UserRound } from "lucide-react";

import { CoverGrid } from "@/components/album/cover-grid";
import { FilterBar, FilterPagination } from "@/components/discovery/filter-bar";
import { ARTIST_SORT_LABELS } from "@/components/discovery/sort-select";
import { Button } from "@/components/ui/button";
import { EmptyState, Eyebrow } from "@/components/ui/primitives";
import { ARTIST_SORTS, browseArtists, getMirroredAlbumCounts, parseArtistSort } from "@/lib/db/queries/artists";
import { plural } from "@/lib/format";
import { DEFAULT_GENRES, getGenres } from "@/lib/providers/deezer";
import { parsePage } from "@/lib/slug";
import { cardFromArtistRow } from "@/lib/view";
import { cn } from "@/lib/utils";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** First value wins for a repeated parameter, and the length cap keeps a silly URL out of SQL. */
function one(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = (raw ?? "").trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 60);
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  // `searchParams` IS A PROMISE in Next 16, here as much as in the page body.
  const genre = one((await searchParams).genre);

  return {
    // A bare title: the root's `title.template` makes it "… · Deadwax".
    title: genre ? `${genre} artists` : "Artists",
    description: "The artists Deadwax has mirrored, by genre, ordered by following, name or number of releases.",
  };
}

export default async function ArtistsPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;

  const genre = one(query.genre);
  const sort = parseArtistSort(one(query.sort));
  const page = parsePage(one(query.page));

  /*
   * The genre vocabulary is the page's job, because `FilterBar` must not query. NAMES, not ids:
   * `browseArtists` filters with `genres @> '["Jazz"]'::jsonb` against the names resolved at
   * ingest, so the name IS the filter value. `getGenres` is cached for a week by the fetch layer
   * and returns an empty array rather than throwing, so the fallback keeps four verified chips
   * on the page instead of a filter row with nothing in it.
   */
  const vocabulary = await getGenres();
  const genres = vocabulary.length > 0 ? vocabulary.map((entry) => entry.name) : [...DEFAULT_GENRES];

  const result = await browseArtists({ genre, sort, page });

  /*
   * THE CAPTION COUNT COMES FROM THE MIRROR, NOT FROM `artists.album_count`.
   *
   * Both numbers are true and they answer different questions: the column is Deezer's claim
   * about its own catalogue and counts releases we have never mirrored, while this one is the
   * denominator the discography and the completion figure both use. The caption sits on a LINK,
   * and linking to a discography of eleven rows under a label reading fourteen is the small lie
   * that makes a whole page untrustworthy.
   */
  const mirrored = await getMirroredAlbumCounts(result.rows.map((row) => row.id));

  /** The filter and the sort, and NEVER `page` — changing a filter resets the window. */
  const params = { genre };

  return (
    <div className="space-y-6">
      <header className="letterbox">
        <Eyebrow>Browse</Eyebrow>
        <h1 className="mt-2 font-display text-3xl leading-tight text-paper sm:text-4xl">
          {genre ? `${genre} artists` : "Artists"}
        </h1>
      </header>

      {/* No `decade` prop at all — see the docblock. */}
      <FilterBar
        basePath="/artists"
        genres={genres}
        genre={genre}
        sorts={ARTIST_SORTS}
        sort={sort}
        sortLabels={ARTIST_SORT_LABELS}
      />

      {result.rows.length === 0 ? (
        <EmptyState
          title={genre ? "Nobody mirrored under that genre yet" : "No artists mirrored yet"}
          /*
           * The copy names the mechanism, because the mechanism is the way out: an artist row is
           * created as a side effect of mirroring one of their records, so the action that fills
           * this page is opening an album.
           */
          description="Artists arrive with their records. Opening an album from a search result mirrors the release, its tracklist and the people who made it."
          action={
            <Button asChild variant="primary">
              <Link href="/search">Search for a record</Link>
            </Button>
          }
        />
      ) : (
        <>
          <CoverGrid>
            {result.rows.map((row) => {
              const card = cardFromArtistRow(row, 500);
              const releases = mirrored.get(row.id) ?? 0;
              return (
                // ONE WRAPPING LINK PER ARTIST, so the portrait and the caption respond to the
                // same hover and there is one tab stop per person rather than two.
                <Link key={row.id} href={card.href} className="group block text-center">
                  <div
                    className={cn(
                      "relative mx-auto aspect-square w-full overflow-hidden rounded-full bg-surface-2",
                      "ring-1 ring-line transition-[transform,box-shadow] duration-150 ease-out-quick",
                      "group-hover:-translate-y-0.5 group-hover:ring-amber",
                    )}
                  >
                    {card.pictureUrl ? (
                      // Empty alt: the name below is inside the same link and is already this
                      // link's accessible name. Naming the image too announces every artist twice.
                      <img
                        src={card.pictureUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="size-full object-cover object-top"
                      />
                    ) : (
                      // No placeholder photograph, ever. A dimmed outline glyph reads as "we have
                      // no picture" rather than as a person.
                      <span className="flex size-full items-center justify-center text-faint" aria-hidden="true">
                        <UserRound className="size-8" />
                      </span>
                    )}
                  </div>
                  <p className="mt-2 truncate font-sans text-[0.8125rem] leading-snug text-paper transition-colors group-hover:text-amber">
                    {row.name}
                  </p>
                  {/*
                    ZERO IS NOT PRINTED. A mirrored count of nothing means we hold the artist but
                    none of their releases yet, and "0 releases" under a link to a discography is
                    a statement about our cache dressed as a fact about their career.
                  */}
                  {releases > 0 ? (
                    <p className="mt-0.5 truncate font-mono text-[0.6875rem] tabular text-faint">
                      {plural(releases, "release")}
                    </p>
                  ) : null}
                </Link>
              );
            })}
          </CoverGrid>

          {/*
            Same pagination contract as /albums: `perPage + 1` rows, one past the window, no
            `COUNT(*)` and therefore no numbered page list. Page 1 carries no `page` parameter.
          */}
          <FilterPagination basePath="/artists" params={params} page={result.page} hasMore={result.hasMore} />
        </>
      )}
    </div>
  );
}

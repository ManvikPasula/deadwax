/**
 * The browse filter bar — genre, decade, sort — plus the pagination that has to agree with it.
 *
 * NO `"use client"`. **EVERY FILTER IS A LINK WITH A QUERY STRING, NEVER CLIENT STATE.**
 *
 * ---------------------------------------------------------------------------------------
 * WHY THAT IS THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------------------------
 *
 * The rejected alternative is the ordinary one: hold `{genre, decade, sort}` in `useState`,
 * fetch on change, render a spinner. It fails four ways at once, and each failure is visible
 * to a member rather than only to a reviewer:
 *
 *   1. A FILTERED VIEW IS NOT SHAREABLE. "Look at the Jazz records from the seventies" becomes
 *      a link to the unfiltered page plus instructions.
 *   2. IT DOES NOT SURVIVE A RELOAD, and the back button walks through a single URL whose
 *      contents changed under it.
 *   3. `browseAlbums` READS THE QUERY STRING SERVER-SIDE (`parseAlbumSort`, `parseDecade`), so
 *      a client-held filter would have to be pushed into the URL anyway — the state would be a
 *      duplicate of the address, and duplicates drift.
 *   4. NOTHING WORKS BEFORE HYDRATION, on the controls a member reaches for first.
 *
 * So the whole bar is `<Chip asChild><Link/></Chip>`, the page is a Server Component, and the
 * address is the only state there is.
 *
 * ---------------------------------------------------------------------------------------
 * EVERY CHIP DROPS `page`
 * ---------------------------------------------------------------------------------------
 *
 * Changing a filter invalidates the window it was paged into. Keeping `?page=7` while adding
 * `?genre=Jazz` lands on page 7 of a two-page result, which `browseAlbums` answers honestly
 * with an empty grid and a "Previous" link — a filter that appears to return nothing. The
 * omission in `queryHref` is what resets to page 1; there is no other reset.
 *
 * ---------------------------------------------------------------------------------------
 * THE CONSTANTS ARE IMPORTED
 * ---------------------------------------------------------------------------------------
 *
 * `DECADE_MIN`/`DECADE_MAX` (1900..2200) are the VALIDATOR's bounds, shared with the diary and
 * the year page (I-4) — they are not a UI ladder. Rendering all thirty-one of them is thirty
 * empty decades of furniture around the four that have records in them, so the offered ladder
 * is bounded again by `DECADE_FLOOR` below, and clamped to the imported pair rather than
 * re-deciding them.
 */

import Link from "next/link";

import { queryHref, SortSelect, type QueryValue } from "@/components/discovery/sort-select";
import { Chip, Eyebrow, Pagination } from "@/components/ui/primitives";
import { DECADE_MAX, DECADE_MIN } from "@/lib/db/queries/albums";
import { cn } from "@/lib/utils";

/**
 * The oldest decade offered as a chip.
 *
 * 1950 IS A CATALOGUE FACT, NOT A TASTE ONE: Deezer's catalogue thins out fast before the
 * fifties and an empty decade chip is worse than a missing one, because it reads as a broken
 * filter rather than as a gap in the mirror. `DECADE_MIN` (1900) stays the validator's floor,
 * so `?decade=1920` remains a legal, addressable view — see `decadeOptions`, which adds the
 * active decade back into the ladder precisely so that link renders with its own chip on.
 */
export const DECADE_FLOOR = 1950;

/**
 * The decade ladder, newest first, with the active decade guaranteed present.
 *
 * Exported and pure so a test can assert the bounds without rendering. `now` is a parameter
 * for the same reason.
 */
export function decadeOptions(active: number | null, now: Date = new Date()): number[] {
  const currentDecade = Math.floor(now.getFullYear() / 10) * 10;
  const top = Math.min(DECADE_MAX, currentDecade);
  const bottom = Math.max(DECADE_MIN, DECADE_FLOOR);

  const decades: number[] = [];
  for (let decade = top; decade >= bottom; decade -= 10) decades.push(decade);

  /*
   * A LEGAL DECADE OUTSIDE THE LADDER IS STILL SHOWN AS SELECTED. `parseDecade` accepts
   * anything in 1900..2200, so `/albums?decade=1920` is a real page somebody can link to; if
   * its chip were missing the page would render 1920s results with every chip reading "off",
   * which looks like the filter failed rather than like the ladder is short.
   */
  if (active !== null && active >= DECADE_MIN && active <= DECADE_MAX && !decades.includes(active)) {
    decades.push(active);
    decades.sort((left, right) => right - left);
  }

  return decades;
}

/* -------------------------------------------------------------------------- */
/* The bar                                                                    */
/* -------------------------------------------------------------------------- */

export type FilterBarProps<TSort extends string> = {
  /** `/albums`, `/artists`, or an artist's album tab. Every chip links back to it. */
  basePath: string;
  /**
   * The genre vocabulary to offer, as NAMES.
   *
   * Names, not ids: `browseAlbums`/`browseArtists` filter with `genres @> '["Jazz"]'::jsonb`
   * against the names resolved at ingest, so the name IS the filter value. The page owns the
   * list (Deezer's fixed ~28, or the mirror's own distinct set) because this component must
   * not query.
   */
  genres: readonly string[];
  /** The active genre, or null. Not validated here — an unknown name simply matches nothing. */
  genre: string | null;
  /**
   * The active decade, or null for "all decades".
   *
   * OMIT THE PROP ENTIRELY TO HIDE THE ROW. `/artists` has no release date to filter on, so
   * `undefined` (prop absent) and `null` (prop present, nothing selected) are deliberately
   * different states — which is why `decade` is read off `props` rather than destructured with
   * a default that would collapse the two.
   */
  decade?: number | null;
  /** The imported whitelist — `ALBUM_SORTS`, `ARTIST_SORTS`. */
  sorts: readonly TSort[];
  sort: TSort;
  /** `ALBUM_SORT_LABELS` / `ARTIST_SORT_LABELS` from ./sort-select. */
  sortLabels?: Readonly<Record<TSort, string>>;
  /**
   * Query parameters that are not filters but must survive every chip — `type` on
   * `/artist/[slug]/albums`. Never `page`: see the docblock.
   */
  extra?: Record<string, QueryValue>;
  className?: string;
};

export function FilterBar<TSort extends string>(props: FilterBarProps<TSort>) {
  const { basePath, genres, genre, sorts, sort, sortLabels, extra, className } = props;

  // `in`-style test rather than `?? null`: absent means "this surface has no decade axis".
  const showDecades = props.decade !== undefined;
  const decade = props.decade ?? null;

  /*
   * AN ACTIVE GENRE THAT IS NOT IN THE OFFERED VOCABULARY IS STILL RENDERED, for the same
   * reason as the decade above: an album page's genre chip links to `/albums?genre=<whatever
   * MusicBrainz or Deezer called it>`, and if the page's list does not carry that name the
   * member arrives at a filtered grid with nothing showing as filtered.
   */
  const genreOptions = genre && !genres.includes(genre) ? [genre, ...genres] : genres;
  const decades = showDecades ? decadeOptions(decade) : [];

  /** What a chip in one group keeps from the other groups. `page` is never in here. */
  const base: Record<string, QueryValue> = { ...extra, sort };
  const anyFilter = genre !== null || decade !== null;

  return (
    // A `nav` landmark, because this is a set of links to other views of the same data — not a
    // form. The label is what stops it being announced as an unnamed second navigation.
    <nav aria-label="Filter and sort" className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <Eyebrow className="pt-1.5">Genre</Eyebrow>
        <div role="group" aria-label="Filter by genre" className="flex flex-wrap items-center gap-1.5">
          {/*
            "ALL" IS A CHIP, NOT A CLEAR BUTTON. It is the same kind of thing as every other
            option — one addressable view — so it is one more link, and it is active when
            nothing is selected. A cross-shaped clear affordance would be a control with no
            address and no keyboard story beyond a click.
          */}
          <Chip asChild active={genre === null}>
            <Link
              href={queryHref(basePath, { ...base, decade })}
              aria-current={genre === null ? "true" : undefined}
            >
              All
            </Link>
          </Chip>
          {genreOptions.map((name) => {
            const active = name === genre;
            return (
              <Chip key={name} asChild active={active}>
                <Link
                  href={queryHref(basePath, { ...base, decade, genre: name })}
                  aria-current={active ? "true" : undefined}
                >
                  {name}
                </Link>
              </Chip>
            );
          })}
        </div>
      </div>

      {showDecades ? (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <Eyebrow className="pt-1.5">Decade</Eyebrow>
          <div role="group" aria-label="Filter by decade" className="flex flex-wrap items-center gap-1.5">
            <Chip asChild active={decade === null}>
              <Link
                href={queryHref(basePath, { ...base, genre })}
                aria-current={decade === null ? "true" : undefined}
              >
                All
              </Link>
            </Chip>
            {decades.map((value) => {
              const active = value === decade;
              return (
                <Chip key={value} asChild active={active}>
                  <Link
                    href={queryHref(basePath, { ...base, genre, decade: value })}
                    aria-current={active ? "true" : undefined}
                  >
                    {/*
                      `tabular` because these are numbers in a mono chip and a column of
                      decades that shifts by a digit's width reads as misalignment. The
                      apostrophe form ("1970s") is spelled out rather than "70s": the filter
                      spans a century and "20s" is ambiguous in a catalogue that contains both.
                    */}
                    <span className="tabular">{value}s</span>
                    {/* The decade filter is applied to the FIRST-release date, which is not
                        obvious from the chip; the sentence is the only place that says so. */}
                    <span className="sr-only"> — records first released in the {value}s</span>
                  </Link>
                </Chip>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SortSelect
          basePath={basePath}
          // The sort links carry the filters, exactly as the filter links carry the sort.
          params={{ ...extra, genre, decade }}
          options={sorts}
          value={sort}
          labels={sortLabels}
          label="Sort results by"
        />
        {anyFilter ? (
          // One link back to the unfiltered view. It drops the sort as well: "reset" that
          // leaves an ordering behind is a reset that has to be explained.
          <Link
            href={queryHref(basePath, extra)}
            className={cn(
              "rounded-card font-mono text-[0.6875rem] uppercase tracking-wider",
              "text-faint underline decoration-line-bright underline-offset-4 transition-colors hover:text-paper",
            )}
          >
            Reset
          </Link>
        ) : null}
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* Pagination that agrees with the bar                                        */
/* -------------------------------------------------------------------------- */

export type FilterPaginationProps = {
  basePath: string;
  /** Every filter and the sort — the same object the bar was given, minus `page`. */
  params?: Record<string, QueryValue>;
  /** 1-based, already clamped by `parsePage`. */
  page: number;
  /**
   * `BrowseResult.hasMore`. The grid asks for `perPage + 1` rows and learns only whether one
   * more exists, which is why `Pagination` renders no numbered page list — there is no honest
   * total to print for a provider-backed grid.
   */
  hasMore: boolean;
  /** Only for the local-only surfaces that genuinely know (a diary year, a review list). */
  totalPages?: number;
  className?: string;
};

/**
 * `Pagination` with the browse href rule applied, and it lives in this file because it is the
 * SAME rule the chips use — one page-shaped link, every filter preserved, and **page 1 carries
 * no `page` parameter at all** so the canonical first page has exactly one address instead of
 * two that cache, prefetch and get indexed separately.
 */
export function FilterPagination({
  basePath,
  params,
  page,
  hasMore,
  totalPages,
  className,
}: FilterPaginationProps) {
  return (
    <Pagination
      page={page}
      hasNext={hasMore}
      totalPages={totalPages}
      className={className}
      buildHref={(next) => queryHref(basePath, { ...params, page: next <= 1 ? null : next })}
    />
  );
}

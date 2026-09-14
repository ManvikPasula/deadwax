/**
 * The sort control — AND IT IS A ROW OF LINKS, NOT A `<select>`.
 *
 * NO `"use client"`. There is no state here: the selected sort IS the query string.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THE NAME SAYS "SELECT" AND THE MARKUP SAYS "LINK"
 * ---------------------------------------------------------------------------------------
 *
 * A native `<select>` cannot navigate on its own. It needs an `onChange` that pushes a route,
 * which makes this a Client Component, and then the sort order lives in JavaScript rather than
 * in the URL. The rejected alternative was exactly that — `components/ui/field.tsx` ships a
 * styled `Select` and it would have been the shortest code — and every consequence of it is
 * bad here:
 *
 *   - a sorted view is not shareable, because the address does not describe it;
 *   - it does not survive a reload, so the back button walks through pages that re-sort
 *     themselves;
 *   - the browse route reads `?sort` server-side through `parseAlbumSort`, so a client-held
 *     sort would have to be replayed into the URL anyway;
 *   - and nothing works before hydration, on the one control a member reaches for first.
 *
 * So: one `<Link>` per option, `Chip` for the paint, `aria-current` for the meaning. Middle
 * click, copy-link and prefetch all keep working, and the whole surface stays server-rendered.
 *
 * ---------------------------------------------------------------------------------------
 * THE SORT KEYS THEMSELVES ARE IMPORTED, NEVER RE-DECLARED
 * ---------------------------------------------------------------------------------------
 *
 * `ALBUM_SORTS`, `ARTIST_SORTS` and `DISCOGRAPHY_SORTS` live beside the SQL that implements
 * them (lib/db/queries/albums.ts, artists.ts), because each key selects a branch of an
 * `orderBy` and a key with no branch silently falls through to "popular". This file only
 * supplies the LABELS, and it types them as `Record<AlbumSort, string>` and friends so adding
 * a key to a whitelist without wording it is a compile error rather than a chip reading
 * "fans".
 */

import Link from "next/link";
import type * as React from "react";

import { Chip, Eyebrow } from "@/components/ui/primitives";
import type { AlbumSort } from "@/lib/db/queries/albums";
import type { ArtistSort, DiscographySort } from "@/lib/db/queries/artists";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Href building — shared with FilterBar and FilterPagination                 */
/* -------------------------------------------------------------------------- */

export type QueryValue = string | number | null | undefined;

/**
 * `("/albums", { genre: "Jazz", sort: "new", page: null })` -> `/albums?genre=Jazz&sort=new`.
 *
 * IT LIVES HERE RATHER THAN IN `lib/` BECAUSE IT IS A UI RULE, NOT A DATA ONE: every caller is
 * a chip, a sort link or the pagination in `filter-bar.tsx`, and all three must agree
 * character for character or Next treats two spellings of the same view as two routes and
 * prefetches both.
 *
 * NULL, UNDEFINED AND "" ARE ALL OMITTED, which is what makes "no filter" one address instead
 * of three (`/albums`, `/albums?genre=`, `/albums?genre=null`). `URLSearchParams` does the
 * escaping, so a genre like "Rap/Hip Hop" or "R&B" survives the round trip — the one place
 * hand-rolled `?genre=${name}` interpolation would break, and the genre vocabulary has both.
 *
 * Insertion order is preserved, so each call site emits a stable key order.
 */
export function queryHref(basePath: string, params: Record<string, QueryValue> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${basePath}?${query}` : basePath;
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * NOTHING HERE IS WORDED AS QUALITY, and that is the whole reason these maps are written out
 * instead of title-casing the key.
 *
 * `popular` is a 0..100 normalisation of Deezer `rank` and `fans` is a follower count — both
 * are POPULARITY, and a chip reading "Best" or "Top rated" over either would make the browse
 * page claim a rating it does not have. There is deliberately no highest-rated album sort at
 * all (the reason is written out at `parseAlbumSort`), so no label needs to imply one.
 */
export const ALBUM_SORT_LABELS: Readonly<Record<AlbumSort, string>> = {
  popular: "Popular",
  new: "Newest",
  fans: "Most fans",
  title: "A–Z",
};

export const ARTIST_SORT_LABELS: Readonly<Record<ArtistSort, string>> = {
  popular: "Popular",
  name: "A–Z",
  albums: "Most releases",
};

/**
 * `chronological` is FIRST-release order and `newest` is the reverse — they are not the same
 * axis inverted, because `getArtistDiscography` orders chronological on
 * `original_release_date ?? release_date`. "Oldest first" would be the wrong word: a 2017
 * remaster of a 1997 record is chronologically 1997.
 */
export const DISCOGRAPHY_SORT_LABELS: Readonly<Record<DiscographySort, string>> = {
  chronological: "Chronological",
  newest: "Newest",
  rated: "Highest rated",
  popular: "Popular",
  title: "A–Z",
};

/* -------------------------------------------------------------------------- */
/* The control                                                                */
/* -------------------------------------------------------------------------- */

export type SortSelectProps<TSort extends string> = {
  /** The route the options link back to: `/albums`, `/artists`, `/artist/kid-a-4/albums`. */
  basePath: string;
  /**
   * Everything in the current query string that must survive a sort change — the genre, the
   * decade, the artist tab's `type`.
   *
   * DO NOT PASS `page`. Re-sorting invalidates the window it was paged into: page 7 of a
   * popularity sort is a different set of records from page 7 of an alphabetical one, and
   * carrying the number over lands the member in the middle of a result set they have not
   * seen the start of. Omitting it here is what resets to page 1.
   */
  params?: Record<string, QueryValue>;
  /** The whitelist, imported — `ALBUM_SORTS`, `ARTIST_SORTS`, `DISCOGRAPHY_SORTS`. */
  options: readonly TSort[];
  /** The active key. Already whitelisted by the page through `parseAlbumSort` and friends. */
  value: TSort;
  /** `ALBUM_SORT_LABELS` and friends. A key with no label falls back to the key. */
  labels?: Readonly<Record<TSort, string>>;
  /**
   * The group's accessible name — "Sort albums by". Required: a row of five two-word chips
   * with no name is a row of links to nowhere in particular.
   */
  label: string;
  /** The visible mono label. Defaults to "Sort"; pass null to render the group bare. */
  legend?: React.ReactNode;
  className?: string;
};

export function SortSelect<TSort extends string>({
  basePath,
  params,
  options,
  value,
  labels,
  label,
  legend = "Sort",
  className,
}: SortSelectProps<TSort>) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
      {/*
        THE VISIBLE LABEL SITS OUTSIDE THE GROUP and the group carries its own `aria-label` —
        the same split components/artist/discography-heatmap.tsx documents. Putting the
        `<p>` inside makes a screen reader read "Sort" as the group's first child immediately
        after reading the group's name, which is the same word twice.
      */}
      {legend === null ? null : <Eyebrow>{legend}</Eyebrow>}
      <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
        {options.map((option) => {
          const active = option === value;
          return (
            <Chip key={option} asChild active={active}>
              {/*
                `aria-current` is the caller's job — `Chip`'s own docblock says so, because
                `active` is the paint and paint alone does not tell a screen reader which sort
                is on. `"true"` rather than `"page"`: this is not a page, it is an ordering.
              */}
              <Link
                href={queryHref(basePath, { ...params, sort: option })}
                aria-current={active ? "true" : undefined}
              >
                {labels?.[option] ?? option}
              </Link>
            </Chip>
          );
        })}
      </div>
    </div>
  );
}

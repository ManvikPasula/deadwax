/**
 * One rail of records per genre, each under its own heading.
 *
 * AN ASYNC SERVER COMPONENT THAT READS ITS OWN ROWS, which is the one deviation from "components
 * receive data as props" in this file and it is a deliberate one: every rail runs the SAME
 * query parameterised by one string, so hoisting them into the caller means each of the three
 * surfaces that wants genre rails (the signed-out home, the cold-start home, a future genre
 * index) repeats the same `Promise.all` and the same "drop the empty ones" rule. `SiteHeader`
 * makes the same trade for the same reason — a self-contained section that owns its one read.
 *
 * It is READ-ONLY. There is deliberately no `chartAlbums()`/`genreArtists()` provider call and
 * no `cacheAlbumSummaries` write in here: this renders on the app's front door, where
 * `revalidate = 0` means every visitor triggers it, and PGlite allows exactly one writer.
 * Filling the mirror is `lib/ingest`'s job, reached from /albums, /search and /for-you.
 *
 * ---------------------------------------------------------------------------------------
 * THE DEFAULT GENRES ARE DELIBERATELY NOT THE POPULAR ONES
 * ---------------------------------------------------------------------------------------
 *
 * `DEFAULT_GENRES` is imported from lib/providers/deezer, never re-declared, and its own
 * comment there says why the list is Alternative / Jazz / Electro / Metal: Pop and Rap/Hip Hop
 * would fill the page with the same records the chart rail directly above has already shown.
 * A rail that repeats the rail above it is worse than no rail.
 *
 * `DEFAULT_GENRE_IDS` — the other half of that pair — is deliberately NOT imported here. It
 * keys Deezer's own `/genre/<id>/artists` endpoint, and this component reads the local mirror,
 * where a genre is stored as a NAME inside a jsonb array (`genres @> '["Jazz"]'::jsonb`). The
 * name is the filter value; importing the ids to render names would be an unused value and a
 * second, silently-drifting way to say "Jazz".
 *
 * ---------------------------------------------------------------------------------------
 * NOTHING IS DEDUPED ACROSS RAILS
 * ---------------------------------------------------------------------------------------
 *
 * A record tagged both Alternative and Electro appears in both rails. The rejected alternative
 * was a first-rail-wins dedupe: it makes every rail after the first thinner than the one above
 * it, and it hides a genre's best record from that genre because a different heading got there
 * first. The repetition is honest — the record really is both things.
 */

import Link from "next/link";

import { CoverCard } from "@/components/album/cover-card";
import { CoverRail } from "@/components/album/cover-rail";
import { queryHref } from "@/components/discovery/sort-select";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "@/components/ui/primitives";
import { browseAlbums } from "@/lib/db/queries/albums";
import { DEFAULT_GENRES } from "@/lib/providers/deezer";
import { cardFromAlbumRow } from "@/lib/view";
import { cn } from "@/lib/utils";

/** One rail's worth. Twelve is a screen and a half of covers at `w-[152px]`. */
const RAIL_SIZE = 12;

export type GenreRailProps = {
  /**
   * Genre NAMES, in the order they should appear. Defaults to the signed-out set.
   *
   * A signed-in caller passes the member's own leading genres (from `buildTasteProfile`'s
   * affinities) — which is why this is a prop at all rather than a constant read inside.
   */
  genres?: readonly string[];
  /** Albums per rail. */
  limit?: number;
  /** `h2` under a page's own `h1`; `h3` when the caller has already opened a section. */
  as?: "h2" | "h3";
  className?: string;
};

export async function GenreRail({
  genres = DEFAULT_GENRES,
  limit = RAIL_SIZE,
  as = "h2",
  className,
}: GenreRailProps) {
  /*
   * PARALLEL ACROSS GENRES, one indexed `SELECT` each. Four concurrent reads of the same table
   * is what a single page of rails costs; the sequential alternative pays four round trips in
   * series for a section that is entirely above the fold.
   */
  const rails = await Promise.all(
    genres.map(async (genre) => ({
      genre,
      // `sort: "popular"` is Deezer's own `rank`/`fans` ordering — POPULARITY, NOT QUALITY. It
      // is never rendered as stars and the heading never calls it "best": `browseAlbums`
      // returns no member aggregates, so `CoverCard`'s average slot stays empty, which is the
      // rule for every provider-derived figure in the product.
      rows: (await browseAlbums({ genre, sort: "popular", perPage: limit })).rows,
    })),
  );

  /*
   * AN EMPTY GENRE IS DROPPED, NOT SHOWN AS AN EMPTY STATE. A rail with no rows means our
   * mirror holds nothing tagged that way yet — a fact about the cache, not about the genre —
   * and "no jazz records" is a claim nobody should read off this page. Contrast the designed
   * empty states on a member's own surfaces, where the absence IS the member's state.
   */
  const populated = rails.filter((rail) => rail.rows.length > 0);
  if (populated.length === 0) return null;

  return (
    <div className={cn("space-y-10", className)}>
      {populated.map(({ genre, rows }) => (
        <section key={genre}>
          <SectionHeading
            as={as}
            eyebrow="Popular in"
            title={genre}
            action={
              <Button asChild variant="ghost" size="sm">
                {/* The heading's "see all" is the same address the album page's genre chips
                    link to, built by the same helper, so there is one spelling of it. */}
                <Link href={queryHref("/albums", { genre })}>
                  All {genre}
                  <span className="sr-only"> records</span>
                </Link>
              </Button>
            }
          />
          {/*
            THE CARD IS DROPPED IN UNSIZED. `CoverRail` sets `[&>*]:w-[132px] sm:[&>*]:w-[152px]`
            and `[&>*]:shrink-0` on its direct children itself — its docblock says the width
            belongs to the rail so that twelve rails cannot drift into twelve widths — so
            repeating those classes here would be a second copy of a number with one owner.
          */}
          <CoverRail>
            {rows.map((row) => (
              <CoverCard key={row.id} album={cardFromAlbumRow(row)} />
            ))}
          </CoverRail>
        </section>
      ))}
    </div>
  );
}

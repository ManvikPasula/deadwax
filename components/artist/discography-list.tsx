/**
 * The discography, grouped by record type.
 *
 * NO `"use client"`. Rows in, cards out.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THE GROUPING IS TWO GROUPS AND NOT FOUR
 * ---------------------------------------------------------------------------------------
 *
 * Deezer's `record_type` is one of `album | single | ep | compilation`. Grouping by all four
 * produces two real sections and two of one or two rows each, and a heading over a single
 * single is more furniture than information. So: ALBUMS FIRST, then everything else behind one
 * heading. The second heading names all three members ("EPs, singles and other releases")
 * rather than the two the brief lists, because a compilation silently filed under "EPs and
 * singles" is a small wrong label, and the alternative — a third group holding one row — is
 * worse.
 *
 * Albums lead because the discography grid upstairs is a career arc drawn from albums, and the
 * list beneath it should read in the same order of importance.
 *
 * ---------------------------------------------------------------------------------------
 * NON-CANONICAL RELEASES ARE SHOWN, AND VISIBLY MARKED
 * ---------------------------------------------------------------------------------------
 *
 * `is_canonical = false` — a reissue, a deluxe edition, a compilation — never enters a heatmap
 * row, a completion denominator or a recommendation pool. But it is REACHABLE BY DIRECT
 * NAVIGATION: a search result, a shared link, another member's diary entry all land on it. So
 * hiding it here would make the page disagree with the rest of the app.
 *
 * Showing it unmarked is the worse failure of the two: a member counting rows against the
 * "11 releases" in the hero, or against the eleven rows of the grid, finds fourteen and
 * concludes one of the numbers is wrong. The badge is the sentence that reconciles them.
 */

import type * as React from "react";

import { CoverCard } from "@/components/album/cover-card";
import { CoverGrid } from "@/components/album/cover-grid";
import { Badge, EmptyState, SectionHeading } from "@/components/ui/primitives";
import type { DiscographyAlbum } from "@/lib/db/queries/artists";
import { plural } from "@/lib/format";
import { cardFromAlbumRow } from "@/lib/view";
import { cn } from "@/lib/utils";

export type DiscographyListProps = {
  /**
   * `getArtistDiscography(artistId, { viewerId, includeNonCanonical: true })`.
   *
   * ALREADY CHRONOLOGICAL by `original_release_date ?? release_date` ascending, and the grouping
   * below preserves that order inside each group — ordering by the Deezer release date alone
   * puts every remaster at the end of the career, which is the single most common way a music
   * catalogue lies about itself.
   */
  albums: DiscographyAlbum[];
  /** `h2` by default; a page whose only content is this list passes `h1`. */
  as?: "h1" | "h2" | "h3";
  className?: string;
};

const SECONDARY_NOTE =
  "Reissues, deluxe editions and compilations are excluded from the discography grid and from completion figures. They are still loggable.";

export function DiscographyList({ albums, as = "h2", className }: DiscographyListProps) {
  if (albums.length === 0) {
    return (
      <EmptyState
        className={className}
        title="No releases mirrored yet"
        description="Nothing from this artist has been pulled into the catalogue. Opening an album from a search result mirrors it."
      />
    );
  }

  const primary = albums.filter((album) => album.recordType === "album");
  const secondary = albums.filter((album) => album.recordType !== "album");

  return (
    <div className={cn("space-y-10", className)}>
      {primary.length > 0 ? (
        <Group as={as} title="Albums" eyebrow={plural(primary.length, "release")} albums={primary} />
      ) : null}
      {secondary.length > 0 ? (
        <Group
          // Always `h2` or lower: whatever the first group is, the second is subordinate to the
          // page, and two `h1`s on one page is not a heading structure.
          as={as === "h1" ? "h2" : as}
          title="EPs, singles and other releases"
          eyebrow={plural(secondary.length, "release")}
          albums={secondary}
        />
      ) : null}
    </div>
  );
}

function Group({
  as,
  title,
  eyebrow,
  albums,
}: {
  as: "h1" | "h2" | "h3";
  title: string;
  eyebrow: React.ReactNode;
  albums: DiscographyAlbum[];
}) {
  return (
    <section>
      <SectionHeading as={as} title={title} eyebrow={eyebrow} />
      {/*
        `CoverGrid` owns the column counts and the `.stagger` animation, so every card in it
        gets the six hard-coded delay steps and the pin at 180ms. Re-declaring
        `grid-cols-3 sm:grid-cols-4 lg:grid-cols-6` here would be a second copy of a number
        that is only correct as long as it agrees with `BROWSE_PAGE_SIZE`.
      */}
      <CoverGrid>
        {albums.map((album) => (
          /*
            EVERY CARD IS WRAPPED, not only the marked ones. `.stagger > *` targets the direct
            child, so a bare card and a wrapped card in the same grid would animate the wrapper
            in one case and the card in the other — and grid items of two different structures
            baseline differently, which shows up as a row whose captions do not line up.
          */
          <div key={album.id} className="space-y-1.5">
            <CoverCard album={cardFromAlbumRow(album)} />
            {album.isCanonical ? null : (
              <Badge tone="amber" title={SECONDARY_NOTE}>
                Secondary release
                {/* The `title` is unreachable without a pointer, so the sentence is also real
                    text. It is the explanation, not a tooltip garnish. */}
                <span className="sr-only"> — {SECONDARY_NOTE}</span>
              </Badge>
            )}
          </div>
        ))}
      </CoverGrid>
    </section>
  );
}

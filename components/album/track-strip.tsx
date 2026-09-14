/**
 * THE TRACK STRIP — the album page's compact heatmap. One row per disc, one cell per track.
 *
 * NO `"use client"`, and that is the single difference that matters between this file and
 * components/artist/discography-heatmap.tsx. That component is a client component for two
 * reasons: the cell colour is a function of a SWITCHED source, and the hover readout is a
 * function of the source plus whichever cell is under the pointer. NEITHER APPLIES HERE:
 *
 *   - THERE IS NO SOURCE SWITCH ON THIS STRIP. The artist page owns that control, and a second
 *     one on the album page would be a second control with the same name and a narrower scope —
 *     a member who set "Critics" on one page and found "Members" on the other would reasonably
 *     read that as a bug. The strip takes a fixed `source` from the page instead.
 *   - THERE IS NO HOVER READOUT. The strip sits within a few hundred pixels of the full
 *     tracklist, which prints every one of those numbers as text already — locator, title,
 *     duration, the viewer's stars. A readout would restate the row two inches below it. The
 *     per-cell `title` covers the pointer and the per-cell `sr-only` sentence covers everybody
 *     else, which is exactly what the tracklist cannot do: turn the SHAPE of a record into one
 *     glance.
 *
 * So the whole strip is server-rendered: `ratingColor()` is pure, the cells arrive fully
 * computed from `getTrackStrip`, and nothing here queries, sorts or aggregates.
 *
 * ---------------------------------------------------------------------------------------
 * THE CELL VOCABULARY IS THE DISCOGRAPHY HEATMAP'S, DELIBERATELY UNCHANGED
 * ---------------------------------------------------------------------------------------
 *
 * 16px, 20px from `sm`, 4px gaps, a real `<Link>` per cell with an `sr-only` sentence,
 * `hover:scale-125` AS A TRANSFORM so a hovered cell overlaps its neighbours rather than
 * widening the row and reflowing every cell after it, unrated cells at `var(--heat-none)`, and
 * a crowned cell getting an OUTSET `ring-2 ring-desert` that leaves the background colour
 * untouched — because the mark ANNOTATES the rating rather than replacing it, so a crowned
 * track the member has since cooled on still shows the colour of the rating it actually has.
 *
 * The same track rendered here and on the artist page cannot disagree about its own colour,
 * and that is not a coincidence: both read `HeatCell` from lib/db/queries/albums.ts and both
 * call `ratingColor()` on the number the selected source has.
 *
 * ROWS STAY RAGGED. No padding to the widest disc, because padding implies tracks that do not
 * exist — a phantom grey cell at the end of disc 2 is indistinguishable from an unrated real
 * one.
 *
 * DEEZER `popularity` IS NOT A SOURCE HERE EITHER. It measures streams, not quality; it lives
 * in the labelled meter on the track row and nowhere else.
 */

import Link from "next/link";

import { BracketLegend } from "@/components/rating/bracket-legend";
import { Eyebrow } from "@/components/ui/primitives";
import type { DiscStrip, HeatCell } from "@/lib/db/queries/albums";
import { bracketLabel, formatRating, ratingColor, UNRATED_COLOR } from "@/lib/ratings";
import { trackLocator } from "@/lib/slug";
import { cn } from "@/lib/utils";

/**
 * Three sources, not the heatmap's four. `predicted` is absent because a forecast is a
 * discography-scale read — `forecastForViewer` runs over every track an artist has, gated on
 * `MIN_RATED_ALBUMS` — and paying for it to colour twelve cells the member is already looking
 * at the ratings of is the wrong trade. The artist page is where a prediction earns its query.
 */
export type StripSource = "member" | "critic" | "mine";

const SOURCE_NOTES: Record<StripSource, string> = {
  member: "Community average — one vote per member.",
  critic: "MusicBrainz per-recording ratings.",
  mine: "Your own ratings.",
};

/** The one number this source has for this cell, or null. NEVER a substituted neutral. */
function scoreFor(cell: HeatCell, source: StripSource): number | null {
  switch (source) {
    case "member":
      return cell.memberAverage;
    case "critic":
      return cell.criticScore;
    case "mine":
      return cell.viewerRating;
  }
}

export type TrackStripProps = {
  /** Straight from `getTrackStrip(albumId, viewerId)` — already one entry per disc, in order. */
  strips: DiscStrip[];
  /** `/album/<slug>`. Cells link to `${albumHref}/track/${locator}`. */
  albumHref: string;
  /** For the `sr-only` sentence, so a cell says which record it belongs to. */
  albumTitle: string;
  /**
   * `album.discCount`, which drives `trackLocator`'s disc prefix and nothing else. Defaults to
   * the number of discs actually present in the mirror, which is the honest fallback: a strip
   * cannot claim a disc it has no cells for.
   */
  discCount?: number;
  /** Defaults to the community average, which is the only source every visitor can read. */
  source?: StripSource;
  /** The legend is the text equivalent of the ramp. Suppress it only when the page has one. */
  legend?: boolean;
  className?: string;
};

export function TrackStrip({
  strips,
  albumHref,
  albumTitle,
  discCount,
  source = "member",
  legend = true,
  className,
}: TrackStripProps) {
  /*
   * NOTHING, NOT AN EMPTY STATE. An album whose tracklist has not been mirrored has no cells,
   * and a grid of nothing with a caption saying so is a statement about our mirror in the
   * middle of a page that is otherwise about a record. The tracklist beside it already carries
   * that message once.
   */
  if (strips.length === 0) return null;

  const discs = discCount ?? strips.length;
  const multiDisc = discs > 1;

  return (
    <section className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Eyebrow>Shape of the record</Eyebrow>
        <p className="font-mono text-[0.6875rem] tracking-wider text-faint">{SOURCE_NOTES[source]}</p>
      </div>

      {/*
        `overflow-x-auto` KEEPS ITS SCROLLBAR, unlike the cover rails. A 22-track disc is
        genuinely wider than a phone and nothing else in this layout says so; a rail's bar,
        by contrast, sits under every row of covers and reads as an accident.
      */}
      <div className="overflow-x-auto pb-1">
        <div className="min-w-fit space-y-1">
          {strips.map((strip) => (
            <div key={strip.disc} className="flex items-center gap-2">
              {/*
                THE DISC GUTTER EXISTS ONLY ON A MULTI-DISC RECORD. On a 12-track album the disc
                number is noise — the same reason `trackLocator` drops the redundant "1-" — and
                a permanent 2rem label that always reads "D1" is a column of nothing.
              */}
              {multiDisc ? (
                <span className="w-7 shrink-0 font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
                  D{strip.disc}
                </span>
              ) : null}

              <div className="flex items-center gap-1">
                {strip.cells.map((cell) => (
                  <StripCell
                    key={`${cell.disc}:${cell.track}`}
                    cell={cell}
                    source={source}
                    albumHref={albumHref}
                    albumTitle={albumTitle}
                    discCount={discs}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/*
        The legend carries the seven bracket NAMES, and it is the text equivalent for every
        colour in the strip above. A grid of colours with no key is a decoration.
      */}
      {legend ? <BracketLegend /> : null}
    </section>
  );
}

function StripCell({
  cell,
  source,
  albumHref,
  albumTitle,
  discCount,
}: {
  cell: HeatCell;
  source: StripSource;
  albumHref: string;
  albumTitle: string;
  discCount: number;
}) {
  const score = scoreFor(cell, source);
  // The URL form: no padding, because `07` and `7` would be two addresses for one track and
  // `parseTrackLocator` accepts both.
  const locator = trackLocator({ disc: cell.disc, track: cell.track, discCount });
  const reading =
    score === null ? "not rated" : `${formatRating(score)} stars, ${bracketLabel(score)}`;

  return (
    <Link
      href={`${albumHref}/track/${locator}`}
      // A double LP is 22 cells and Next prefetches links as they enter the viewport. The strip
      // is a browsing surface, not a navigation path somebody is about to take.
      prefetch={false}
      // The pointer's version of the sentence below. There is no hover readout on this strip —
      // see the docblock — so `title` is doing that job for a mouse.
      title={`${locator} · ${cell.title} — ${reading}${cell.crowned ? " · Desert Island" : ""}`}
      className={cn(
        // 16px on mobile, 20px from `sm`, 4px gaps: the discography heatmap's exact vocabulary.
        "relative size-4 shrink-0 rounded-sm sm:size-5",
        // A TRANSFORM, so a hovered cell overlaps its neighbours instead of widening the row.
        // `z-10` is the bottom rung of the app's five-value ladder, reused rather than
        // invented: without it the next sibling paints over the quarter that grew rightwards.
        "transition-transform duration-150 ease-out-quick hover:z-10 hover:scale-125 focus-visible:z-10 focus-visible:scale-125",
        cell.crowned
          ? // OUTSET `ring-2 ring-desert` rather than the default inset hairline, so the ring
            // eats into the 4px gap and the mark is visible at 16px. THE BACKGROUND COLOUR IS
            // UNTOUCHED: the mark annotates the rating, it does not replace it.
            "ring-2 ring-desert"
          : "ring-1 ring-inset ring-black/25",
      )}
      style={{ backgroundColor: score === null ? UNRATED_COLOR : ratingColor(score) }}
    >
      {/* THE TEXT EQUIVALENT FOR THE COLOUR. Nothing in this strip is available only as a hue,
          including the crown — a ring is a colour too. */}
      <span className="sr-only">
        {`${albumTitle}, track ${locator}, ${cell.title}: ${reading}`}
        {cell.crowned ? ", Desert Island" : ""}
      </span>
    </Link>
  );
}

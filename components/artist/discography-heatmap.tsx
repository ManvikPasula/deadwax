"use client";

/**
 * THE DISCOGRAPHY HEATMAP — one row per album, one cell per track.
 *
 * This is the signature view of the product and the thing music has that film does not: it
 * draws a CAREER ARC. The sophomore slump is a row of oranges between two rows of greens; the
 * late return to form is a blue cell in the last row of a long catalogue. It is the true
 * analogue of television's "shape of the run", and it is the reason the artist page exists.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THE WHOLE COMPONENT IS A CLIENT COMPONENT, AND WHAT WAS TRIED FIRST
 * ---------------------------------------------------------------------------------------
 *
 * The brief's preference is to keep the cells in the server half and put only the source
 * switch in the browser. That is not achievable here, and the reason is structural rather
 * than lazy: the CELL COLOUR IS A FUNCTION OF THE SELECTED SOURCE, and the hover readout is a
 * function of both the selected source and which cell is under the pointer or the caret. Two
 * splits were considered and rejected:
 *
 *   1. RENDER ALL FOUR GRIDS SERVER-SIDE and let a client wrapper reveal one. Four copies of
 *      up to ~400 anchors is four times the markup and four times the accessibility tree, and
 *      a screen reader would walk every track four times over. Rejected on that alone.
 *   2. PASS THE CELLS AS SERVER-RENDERED `children` and drive the colour from a
 *      `data-source` attribute on a client container, with each cell carrying its four
 *      colours as inline custom properties and the readout assembled by event delegation.
 *      This genuinely works, and it was rejected for two reasons: the switch needs a CSS rule
 *      per source (`[data-source="member"] .cell { background: var(--heat-member) }`) and
 *      app/globals.css is frozen; and delegation replaces the per-cell
 *      `onFocus`/`onBlur`/`onMouseEnter`/`onMouseLeave` pairing that the accessibility
 *      contract below is written in terms of, which is the one thing in this file that must
 *      not become clever.
 *
 * The cost is bounded and worth naming: the payload arrives FULLY COMPUTED from
 * `getDiscographyHeatmap`, so nothing here queries, joins or aggregates. The only work in the
 * browser is `ratingColor()` — a pure bracket lookup and an sRGB lerp — over a few hundred
 * numbers, once per source change.
 *
 * ---------------------------------------------------------------------------------------
 * EVERY CELL IS A REAL `<Link>`, AND THAT IS THE ACCESSIBILITY STORY
 * ---------------------------------------------------------------------------------------
 *
 * The grid is keyboard-navigable because it is a list of links, not because anything here
 * implements a grid keyboard model. Tab walks the tracks in release order; every cell carries
 * an `sr-only` sentence with its locator, its title, its score and `", Desert Island"` when
 * crowned; and `onFocus`/`onBlur` MIRROR `onMouseEnter`/`onMouseLeave` so the readout follows
 * the caret exactly as it follows the pointer.
 *
 * REPLACING THE ANCHORS WITH DIVS DESTROYS ALL OF THAT. A div grid needs a roving tabindex, a
 * hand-written arrow-key model, an `aria-label` per cell and a click handler that reimplements
 * navigation — and it still loses middle-click, copy-link and prefetch. Do not do it.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------------------
 *
 * DEEZER TRACK `popularity` IS NOT A FIFTH COLOUR SOURCE, and it never will be. It measures
 * streams, not quality. Colouring a quality grid by streams is exactly the dishonesty this
 * product refuses: the grid would look identical to one built from ratings while meaning
 * something entirely different, and no label can undo that. It belongs in a separate,
 * explicitly labelled "Popularity" meter in the track row, which is where it is.
 */

import Link from "next/link";
import * as React from "react";

import { BracketLegend } from "@/components/rating/bracket-legend";
import { Button } from "@/components/ui/button";
import { EmptyState, Eyebrow } from "@/components/ui/primitives";
import type { HeatCell } from "@/lib/db/queries/albums";
import type { DiscographyHeatmapRow } from "@/lib/db/queries/artists";
import { plural } from "@/lib/format";
import { bracketLabel, formatRating, ratingColor, UNRATED_COLOR } from "@/lib/ratings";
import { trackLocator } from "@/lib/slug";
import { cn } from "@/lib/utils";

/**
 * `${albumId}:${disc}:${track}` — THE ACROSS-ALBUMS KEY, DUPLICATED HERE ON PURPOSE.
 *
 * The canonical implementation is `albumTrackKey` in lib/db/queries/albums.ts, whose own
 * docblock explains why it is a named helper rather than an inline template string at twenty
 * call sites: a mismatched lookup FAILS SILENTLY, returning undefined and rendering an
 * uncoloured cell rather than an error.
 *
 * It cannot be imported here. That module opens with `import "server-only"`, and this is a
 * client component, so a value import is a build failure (a `import type` would be fine — it
 * is erased — but a function is not a type). The rejected alternatives were: moving the helper
 * to a client-safe module, which means editing a frozen file; and restructuring the prop into
 * arrays parallel to `rows[i].cells[j]`, which trades a named key for positional coupling and
 * fails just as silently while being much harder to read.
 *
 * SO: THE TWO MUST AGREE. Whatever builds the `predictions` map on the server — currently
 * `forecastForViewer` over lib/taste/tracks.ts — keys it with `albumTrackKey`, and this is the
 * same string.
 */
function predictionKey(albumId: number, disc: number, track: number): string {
  return `${albumId}:${disc}:${track}`;
}

/* -------------------------------------------------------------------------- */
/* The four sources — switched, never blended                                 */
/* -------------------------------------------------------------------------- */

export type HeatSource = "member" | "critic" | "mine" | "predicted";

/**
 * FOUR COLOUR SOURCES, EACH RETURNING EXACTLY ONE NUMBER.
 *
 * Switching source rather than blending them is what keeps each number attributable: a green
 * cell is either the community's verdict, or MusicBrainz's, or the viewer's own, or the
 * model's guess — and the switch says which. A blend would produce a colour that is nobody's
 * opinion and cannot be argued with.
 *
 * `unavailable` is rendered as a `title` AND as an `sr-only` sentence inside the disabled
 * button. A `title` alone is unreachable for anyone not using a mouse, and a disabled button
 * is skipped by Tab — but a screen reader's virtual cursor still reads its contents, so the
 * sentence is the only version of this explanation that everybody can get to.
 */
const SOURCES: ReadonlyArray<{ key: HeatSource; label: string; unavailable: string }> = [
  { key: "member", label: "Members", unavailable: "No member ratings for this artist yet" },
  // This component is only ever mounted on an artist page, so the wording is artist-scoped.
  { key: "critic", label: "Critics", unavailable: "No critic scores for this artist yet" },
  { key: "mine", label: "Mine", unavailable: "Rate a track to see your own colours" },
  /*
   * "eight" IS `MIN_RATED_ALBUMS` FROM lib/taste/shared.ts, SPELLED OUT. If that constant
   * moves, this sentence moves with it.
   *
   * The rejected alternative was importing the constant and interpolating it, which would be
   * a real binding rather than a comment — but lib/taste/shared.ts is the whole recommender's
   * pure core, and importing it into a client component drags the entire scoring model into
   * the browser bundle to render one number word. The gate itself is enforced SERVER-SIDE:
   * `forecastForViewer` returns null below the threshold, so `predictions` arriving empty is
   * the authoritative signal and this button cannot be talked into enabling itself.
   */
  { key: "predicted", label: "Predicted", unavailable: "Rate eight albums to unlock predictions" },
];

const SOURCE_NOTES: Record<HeatSource, string> = {
  member: "Community average — one vote per member.",
  critic: "MusicBrainz per-recording ratings.",
  mine: "Your own ratings only.",
  predicted: "Your rating where you have one, the model's estimate where you do not.",
};

/** The one number this source has for this cell, or null. NEVER a substituted neutral. */
function scoreFor(cell: HeatCell, source: HeatSource, predicted: number | null): number | null {
  switch (source) {
    case "member":
      return cell.memberAverage;
    case "critic":
      return cell.criticScore;
    case "mine":
      return cell.viewerRating;
    case "predicted":
      // A real rating is never overwritten by a prediction, so a row reads as one continuous
      // line rather than as a mix of fact and guess the member cannot tell apart.
      return cell.viewerRating ?? predicted;
  }
}

/* -------------------------------------------------------------------------- */
/* Props                                                                      */
/* -------------------------------------------------------------------------- */

export type DiscographyHeatmapProps = {
  /**
   * Straight from `getDiscographyHeatmap(artistId, viewerId)`.
   *
   * ROWS ARE ALREADY NON-CANONICAL-FREE, ALREADY CHRONOLOGICAL BY
   * `original_release_date ?? release_date`, AND CELLS ARE ALREADY ORDERED BY
   * `(disc_number, track_number)`. Nothing here re-sorts or re-filters: the query owns all
   * three properties and undoing `is_canonical` would put a deluxe edition beside the album
   * it duplicates with the same nine cells twice.
   */
  rows: DiscographyHeatmapRow[];
  /**
   * Predicted scores on the stored 0..10 scale, keyed by
   * `albumTrackKey(albumId, disc, track)`.
   *
   * ABSENT OR EMPTY MEANS THE PREDICTION SOURCE IS GATED, and that is the server's decision,
   * not a UI one — `forecastForViewer` returns null below `MIN_RATED_ALBUMS`.
   */
  predictions?: ReadonlyMap<string, number> | null;
  /** For the sr-only sentences, so a cell announces which artist's track it is. */
  artistName: string;
  className?: string;
};

/** Which cell the readout is describing. Indices, so the lookup is O(1) and needs no map. */
type Active = { row: number; cell: number };

export function DiscographyHeatmap({ rows, predictions, artistName, className }: DiscographyHeatmapProps) {
  const available = React.useMemo(() => {
    let member = false;
    let critic = false;
    let mine = false;
    for (const row of rows) {
      for (const cell of row.cells) {
        if (cell.memberAverage !== null) member = true;
        if (cell.criticScore !== null) critic = true;
        if (cell.viewerRating !== null) mine = true;
      }
    }
    return { member, critic, mine, predicted: (predictions?.size ?? 0) > 0 };
  }, [rows, predictions]);

  /*
   * THE COLD-START DEFAULT CANNOT BE `hasMemberData ? member : critic`, WHICH IS WHAT
   * TELEVISION USED.
   *
   * MusicBrainz per-recording ratings are sparse — most releases have none at all — so
   * `critic` is usually unavailable and that fallback lands on an empty grid. The ladder walks
   * every source and settles on `member` only when nothing has any data, which is the state
   * the designed empty state below exists for.
   *
   * `mine` sits before the fallback because a GUEST is excluded from every community
   * aggregate (`u.is_guest = false`), so a guest who has rated tracks has `mine` data and no
   * `member` data. Without this rung their own ratings would be invisible on the one page
   * built to show them.
   */
  const initialSource: HeatSource = available.member
    ? "member"
    : available.critic
      ? "critic"
      : available.mine
        ? "mine"
        : "member";

  const [source, setSource] = React.useState<HeatSource>(initialSource);
  const [active, setActive] = React.useState<Active | null>(null);

  if (rows.length === 0) {
    // An artist whose tracklists have not been mirrored gets a statement about OUR mirror, not
    // a claim about their records. `getDiscographyHeatmap` already drops albums with no tracks
    // for the same reason, so reaching here means the whole discography is unmirrored.
    return (
      <EmptyState className={className} title="Track data has not been mirrored for this artist yet." />
    );
  }

  /*
   * THE EMPTY STATE IS DESIGNED, NOT INHERITED. Every cell falls to `var(--heat-none)` on its
   * own — `ratingColor(null)` returns exactly that — so the grid still draws its shape, its
   * ragged edges and its release order. What it needs is the sentence saying why it is grey,
   * because a uniformly grey grid with no caption reads as broken rather than as unrated.
   */
  const empty = !available[source];

  const activeCell = active ? rows[active.row]?.cells[active.cell] : undefined;
  const activeRow = active ? rows[active.row] : undefined;

  return (
    <section className={cn("space-y-3", className)}>
      {/* ---------------------------------------------------------------- */}
      {/* The source switch                                                */}
      {/* ---------------------------------------------------------------- */}
      {/*
        BUTTONS WITH `aria-pressed`, NOT RADIX TABS — even though components/ui/tabs.tsx names
        this selector as its example use. A `TabsTrigger` sets `aria-controls` pointing at a
        `TabsContent` panel, and the grid deliberately lives OUTSIDE any panel so that
        switching source repaints a few hundred backgrounds instead of unmounting and
        remounting a few hundred links. A trigger whose `aria-controls` has no target is worse
        than no tablist at all.
      */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/*
          The visible label sits OUTSIDE the group and the group carries its own `aria-label`.
          Putting the `<p>` inside would make a screen reader read "Colour by" as the group's
          first child immediately after reading the group's name, which is the same words
          twice.
        */}
        <Eyebrow>Colour by</Eyebrow>
        <div role="group" aria-label="Colour the grid by" className="flex flex-wrap items-center gap-1.5">
          {SOURCES.map((option) => {
            const enabled = available[option.key];
            const selected = source === option.key;
            return (
              <Button
                key={option.key}
                type="button"
                size="sm"
                variant={selected ? "primary" : "secondary"}
                aria-pressed={selected}
                disabled={!enabled}
                // DISABLED RATHER THAN HIDDEN. A hidden option teaches nothing; a disabled one
                // with a reason teaches that the source exists and what would unlock it.
                title={enabled ? SOURCE_NOTES[option.key] : option.unavailable}
                onClick={() => setSource(option.key)}
              >
                {option.label}
                {enabled ? null : <span className="sr-only"> — {option.unavailable}</span>}
              </Button>
            );
          })}
        </div>
        <p className="font-mono text-[0.6875rem] tracking-wider text-faint">{SOURCE_NOTES[source]}</p>
      </div>

      {empty ? (
        <p className="font-mono text-[0.6875rem] uppercase tracking-wider text-faint">
          Nothing rated yet — be the first.
        </p>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* The grid                                                         */}
      {/* ---------------------------------------------------------------- */}
      {/*
        `overflow-x-auto` KEEPS ITS SCROLLBAR, unlike the cover rails, which opt out with
        `[scrollbar-width:none]`. A rail showing a bar under every row of covers reads as an
        accident; a grid whose rows are genuinely wider than the viewport needs the bar,
        because a 22-track double LP has content off-screen and nothing else says so.

        `min-w-fit` on the inner column is what makes the widest row set the scroll width
        rather than the container clipping it.
      */}
      <div className="overflow-x-auto pb-1">
        <div className="min-w-fit space-y-1">
          {rows.map((row, rowIndex) => (
            <HeatRow
              key={row.albumId}
              row={row}
              rowIndex={rowIndex}
              source={source}
              predictions={predictions}
              artistName={artistName}
              onActivate={setActive}
              onDeactivate={setActive}
            />
          ))}
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The hover / focus readout                                        */}
      {/* ---------------------------------------------------------------- */}
      {/*
        FIXED HEIGHT, FOR THE SAME REASON `hover:scale-125` IS A TRANSFORM: neither is allowed
        to reflow anything. A readout that grows from nothing to two lines as the pointer
        enters the grid would push the legend down and pull the grid up under the cursor,
        which moves the cell out from under the pointer that is hovering it.

        `aria-hidden` because every cell already carries the same sentence as `sr-only` text.
        Announcing it twice — once from the focused link, once from a live region — is how an
        annotated grid becomes unusable with a screen reader.
      */}
      <p
        aria-hidden="true"
        className="h-9 overflow-hidden font-mono text-[0.6875rem] leading-relaxed tracking-wider tabular text-muted"
      >
        {activeCell && activeRow ? (
          <Readout
            row={activeRow}
            cell={activeCell}
            score={scoreFor(activeCell, source, predictions?.get(predictionKey(activeRow.albumId, activeCell.disc, activeCell.track)) ?? null)}
            source={source}
          />
        ) : (
          <span className="text-faint">Hover a cell, or tab through the grid, to read a track.</span>
        )}
      </p>

      {/*
        The legend is not decoration: it is the only place the seven bracket NAMES appear, and
        a colour scale with no names is a colour scale nobody can quote. It is also the text
        equivalent for every colour-coded cell in the grid above.
      */}
      <BracketLegend />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* One album — one ragged row                                                 */
/* -------------------------------------------------------------------------- */

function HeatRow({
  row,
  rowIndex,
  source,
  predictions,
  artistName,
  onActivate,
  onDeactivate,
}: {
  row: DiscographyHeatmapRow;
  rowIndex: number;
  source: HeatSource;
  predictions?: ReadonlyMap<string, number> | null;
  artistName: string;
  onActivate: (active: Active) => void;
  onDeactivate: (active: null) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {/*
        THE ROW LABEL IS A FIXED `w-40` (10rem) LEFT-ALIGNED GUTTER, WIDENED FROM THE 2rem A
        TELEVISION GRID NEEDS.

        There, the label was an ordinal — "S3" — and 2rem was generous. AN ALBUM TITLE IS NOT
        AN ORDINAL: it is up to 300 characters of proper noun, and it is the only thing that
        identifies the row. 10rem is the width at which most titles survive and the rest
        truncate gracefully, while still leaving a 20-track row visible on a phone. Left
        aligned, because a ragged right edge beside a ragged grid reads as two ragged things
        rather than as one.
      */}
      <div className="w-40 shrink-0 pr-3">
        <Link
          href={row.href}
          className="block truncate text-[0.8125rem] leading-tight text-paper hover:text-amber"
        >
          {row.title}
        </Link>
        <span className="font-mono text-[0.6875rem] tracking-wider tabular text-faint">
          {/* An undated release is an em dash, never a guessed year. */}
          {row.year ?? "—"}
        </span>
      </div>

      {/*
        ROWS STAY RAGGED. Each album is exactly as wide as its own track count, with NO padding
        to the widest row, BECAUSE PADDING WOULD IMPLY TRACKS THAT DO NOT EXIST — a phantom
        grey cell at the end of an EP is indistinguishable from an unrated real one.

        ROWS ARE RAGGEDER HERE THAN IN TELEVISION, and this is the one place the view is harder
        than its source: a series' seasons run roughly uniform, so its grid is nearly
        rectangular. A 22-track double LP beside a 4-track EP has no equivalent there, and the
        honest drawing of that is a row five times longer than its neighbour.
      */}
      <div className="flex items-center gap-1">
        {row.cells.map((cell, cellIndex) => (
          <HeatCellLink
            key={`${cell.disc}:${cell.track}`}
            row={row}
            cell={cell}
            source={source}
            predicted={predictions?.get(predictionKey(row.albumId, cell.disc, cell.track)) ?? null}
            artistName={artistName}
            onEnter={() => onActivate({ row: rowIndex, cell: cellIndex })}
            onLeave={() => onDeactivate(null)}
          />
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One track — one cell, and a real link                                      */
/* -------------------------------------------------------------------------- */

function HeatCellLink({
  row,
  cell,
  source,
  predicted,
  artistName,
  onEnter,
  onLeave,
}: {
  row: DiscographyHeatmapRow;
  cell: HeatCell;
  source: HeatSource;
  predicted: number | null;
  artistName: string;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const score = scoreFor(cell, source, predicted);
  // `trackLocator` drops the redundant "1-" when the album has one disc, which is why
  // `discCount` travels on the row: on a 12-track record the disc number is noise, and on a
  // double LP it is the difference between two different tracks.
  const locator = trackLocator({ disc: cell.disc, track: cell.track, discCount: row.discCount });

  return (
    <Link
      href={`${row.href}/track/${locator}`}
      // 300 anchors in one grid, and Next prefetches links as they enter the viewport. Left
      // alone, scrolling a long discography would fire a request per track page. The grid is a
      // browsing surface, not a navigation path somebody is about to take.
      prefetch={false}
      // onFocus/onBlur MIRROR onMouseEnter/onMouseLeave. This pairing is the whole reason the
      // readout works for a keyboard, and it is why the cells are anchors: focus is something
      // the platform gives us, not something this file implements.
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      className={cn(
        // 16px on mobile, 20px from `sm`, with 4px gaps. Small enough that a 30-album career
        // fits one screen, large enough to be a hit target at the top of the scale.
        "relative size-4 shrink-0 rounded-sm sm:size-5",
        // `hover:scale-125` IS A TRANSFORM, so a hovered cell OVERLAPS its neighbours rather
        // than widening the row and reflowing every cell after it. `z-10` is the bottom rung
        // of the app's five-value ladder (feed date headers), reused here rather than invented:
        // without it the next sibling paints over the 25% that grew to the right.
        "transition-transform duration-150 ease-out-quick hover:z-10 hover:scale-125 focus-visible:z-10 focus-visible:scale-125",
        cell.crowned
          ? // A CROWNED CELL GETS AN OUTSET `ring-2 ring-desert` INSTEAD OF the default inset
            // hairline, so the ring eats into the 4px gap and the mark is visible at 16px.
            // THE BACKGROUND COLOUR IS UNTOUCHED: the mark ANNOTATES the rating, it does not
            // replace it. A crowned track the member has since cooled on still shows the
            // colour of the rating it actually has.
            "ring-2 ring-desert"
          : "ring-1 ring-inset ring-black/25",
      )}
      style={{ backgroundColor: score === null ? UNRATED_COLOR : ratingColor(score) }}
    >
      {/*
        THE TEXT EQUIVALENT FOR THE COLOUR. Every cell says its locator, its title, its score
        and its bracket name — and `", Desert Island"` when crowned, because the ring is a
        colour too. Nothing in this grid is available only as a hue.
      */}
      <span className="sr-only">
        {`${artistName} — ${row.title}, track ${locator}, ${cell.title}: `}
        {score === null ? "not rated" : `${formatRating(score)} stars, ${bracketLabel(score)}`}
        {cell.crowned ? ", Desert Island" : ""}
      </span>
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/* The readout line                                                           */
/* -------------------------------------------------------------------------- */

function Readout({
  row,
  cell,
  score,
  source,
}: {
  row: DiscographyHeatmapRow;
  cell: HeatCell;
  score: number | null;
  source: HeatSource;
}) {
  const locator = trackLocator({ disc: cell.disc, track: cell.track, discCount: row.discCount });
  return (
    <>
      <span className="text-paper">{locator}</span>
      {" · "}
      <span className="text-paper">{cell.title}</span>
      {" · "}
      <span className="text-muted">{row.title}</span>
      {" · "}
      {score === null ? (
        <span className="text-faint">Not rated</span>
      ) : (
        <>
          <span className="text-amber">{formatRating(score)}</span>
          {" "}
          <span>{bracketLabel(score)}</span>
        </>
      )}
      {/*
        The vote count belongs to the MEMBER source and nowhere else: a critic score has its
        own vote count on the consensus card, `mine` is one person by definition, and a
        prediction has a confidence rather than a sample. Printing "1 rating" under a
        prediction would be a fabricated sample size.
      */}
      {source === "member" && cell.memberCount > 0 ? (
        <>
          {" · "}
          <span className="text-faint">{plural(cell.memberCount, "rating")}</span>
        </>
      ) : null}
      {cell.crowned ? (
        <>
          {" · "}
          <span className="text-desert">Desert Island</span>
        </>
      ) : null}
    </>
  );
}

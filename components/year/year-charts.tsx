/**
 * Year in Review's three charts: the monthly bars, the genre split, and the you-versus-everyone
 * comparison rows.
 *
 * NO `"use client"`, NO SVG, NO CANVAS, NO CHARTING LIBRARY. Plain elements with CSS widths and
 * heights, because the shapes are simple enough that this stays FULLY SERVER-RENDERED: no
 * measuring pass, no layout effect, no hydration cost on a page that is otherwise nine
 * aggregate panels of text. A charting library would ship 40–120 kB to draw twelve rectangles
 * and would need the browser to measure the container before the first bar appeared.
 *
 * What is lost by not using one: axes, ticks, tooltips and animation. None of the four is
 * wanted here — the counts are printed as text beside or beneath every shape (which is also
 * what makes them accessible), and an animated year summary is a year summary that has to be
 * waited for.
 *
 * =========================================================================================
 * THE TWO MINIMUM FLOORS — 4% HERE, 2% IN `Meter` — ARE BOTH DELIBERATE AND BOTH ARE KEPT
 * =========================================================================================
 *
 * They solve the same problem (a non-zero value must be visible) at two different sizes, and
 * unifying them makes one of the two charts lie:
 *
 *   `MIN_BAR_PERCENT = 4`   a monthly bar is ~24px wide inside a 128px-tall track. 2% of 128px
 *                           is 2.5px, which reads as the baseline rather than as a bar, so a
 *                           month with a single play would look like a month with none.
 *   `METER_MIN_PERCENT = 2` a meter is the full width of a panel, where 2% is already a legible
 *                           sliver and 4% would visibly overstate one play against a
 *                           denominator of two hundred.
 *
 * Both numbers were tuned against the real shapes. components/ui/primitives.tsx carries the
 * mirror image of this comment. DO NOT UNIFY THEM.
 *
 * =========================================================================================
 * AVERAGE RATING RENDERS AS STARS, NEVER AS `n/10`
 * =========================================================================================
 *
 * `YearSummary.averageRating` and `YearPlatform.averageRating` are on the STORED 1..10 scale
 * because that is the only scale lib/stats/year.ts speaks. The source product prints "7.4 / 10"
 * on the year page while every other surface in it shows 0.5–5 stars — a named honesty bug, and
 * the reason `ComparisonRow` takes `kind="rating"` and hands the number to `<Stars>`, which
 * divides internally. A member who has been reading stars all year is not shown a different
 * scale for their summary of it.
 */

import type * as React from "react";

import { Stars } from "@/components/rating/stars";
import { Eyebrow, Meter } from "@/components/ui/primitives";
import { formatCount, plural } from "@/lib/format";
import { formatRating } from "@/lib/ratings";
import type { MonthlyPoint, YearGenre } from "@/lib/stats/year";
import { cn } from "@/lib/utils";

/** See the module docblock. This is the monthly-bar floor and it is not `Meter`'s. */
export const MIN_BAR_PERCENT = 4;

/** 0..1, and never NaN — a ratio built from an empty year would otherwise be `0/0`. */
function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/* ========================================================================== *
 * MonthlyBars
 * ========================================================================== */

/**
 * The visible labels are SINGLE LETTERS and the full names are `sr-only`.
 *
 * Twelve three-letter labels do not fit under twelve bars on a phone without rotating them, and
 * rotated text in a summary panel is a design that only works in one language. The letter is
 * `aria-hidden` because "J" twice and "M" twice is not a set of month names — the sentence
 * beside it is.
 */
const MONTHS: ReadonlyArray<{ letter: string; name: string }> = [
  { letter: "J", name: "January" },
  { letter: "F", name: "February" },
  { letter: "M", name: "March" },
  { letter: "A", name: "April" },
  { letter: "M", name: "May" },
  { letter: "J", name: "June" },
  { letter: "J", name: "July" },
  { letter: "A", name: "August" },
  { letter: "S", name: "September" },
  { letter: "O", name: "October" },
  { letter: "N", name: "November" },
  { letter: "D", name: "December" },
];

export type MonthlyBarsProps = {
  /**
   * `YearReview.monthly` — ALWAYS TWELVE POINTS, missing months zero-filled by
   * `zeroFilledMonths`, `month` being 1..12.
   *
   * The zero-fill is load-bearing for this component and the query's own comment says why:
   * without it a January-only year renders one bar occupying the whole width and reads as a
   * busy year rather than a quiet one.
   */
  monthly: MonthlyPoint[];
  className?: string;
};

export function MonthlyBars({ monthly, className }: MonthlyBarsProps) {
  /*
   * THE DENOMINATOR IS THE TALLEST MONTH, NOT THE YEAR'S TOTAL — the same choice §4.2 makes for
   * the rating histogram. A share-of-total chart of twelve months tops out at ~30% in a
   * realistic year, so every bar would be short and the SHAPE of the year, which is the only
   * thing this panel is for, would be squashed into the bottom third of the track.
   */
  const peak = monthly.reduce((max, point) => Math.max(max, point.entries), 0);
  const total = monthly.reduce((sum, point) => sum + point.entries, 0);

  return (
    <div className={cn("w-full", className)}>
      {/* The one summary sentence a screen reader gets before the twelve per-month ones. */}
      <p className="sr-only">
        {total === 0
          ? "No diary entries in this year."
          : `Diary entries by month, ${plural(total, "entry", "entries")} in total.`}
      </p>

      {/* An ordered list, because the months are an order — reversing it would be a different
          chart, not a differently-sorted one. */}
      <ol className="flex items-end gap-1.5">
        {monthly.map((point) => {
          const month = MONTHS[point.month - 1];
          const ratio = peak > 0 ? clampRatio(point.entries / peak) : 0;

          return (
            <li key={point.month} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              {/* THE FIXED `h-32` TRACK. The bar's percentage height resolves against this, so
                  the floor below has something to be a percentage of. */}
              <span className="flex h-32 w-full items-end justify-center">
                <span
                  aria-hidden="true"
                  className={cn(
                    "w-full max-w-5 rounded-t-[2px]",
                    point.entries > 0
                      ? "bg-amber/70"
                      : // A ZERO MONTH IS A 2px STUB IN THE HAIRLINE-BRIGHT GREY, so the
                        // baseline stays unbroken and the month is still legible as a month —
                        // and so that it CANNOT be mistaken for a floored amber bar, which is
                        // what a single play looks like. `line-bright` is the token that clears
                        // 3:1 as a meaningful graphical object.
                        "bg-line-bright",
                  )}
                  style={{
                    /*
                       `max()` IN CSS RATHER THAN `Math.max` IN JS, deliberately: the percentage
                       has to resolve against the rendered height of the track, which is not
                       known here. components/rating/histogram.tsx floors its bars the same way
                       for the same reason.
                    */
                    height: point.entries === 0 ? "2px" : `max(${MIN_BAR_PERCENT}%, ${(ratio * 100).toFixed(2)}%)`,
                  }}
                />
              </span>

              <span aria-hidden="true" className="font-mono text-[0.6875rem] tabular text-faint">
                {month?.letter ?? point.month}
              </span>
              {/* THE TEXT EQUIVALENT. Nothing in this chart is available only as a height. */}
              <span className="sr-only">
                {`${month?.name ?? `Month ${point.month}`}: ${plural(point.entries, "entry", "entries")}`}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ========================================================================== *
 * GenreSplit
 * ========================================================================== */

/**
 * FOUR COLOURS, CYCLED BY INDEX — and rose is not one of them.
 *
 * The tone vocabulary in components/ui/primitives.tsx is a vocabulary rather than a palette:
 * `rose` is destructive or failed everywhere else in the interface, and a genre slice painted
 * in it reads as an error in a chart nobody can click. `line-bright` takes the fourth slot
 * instead — it is the token that exists to be a legible graphical object against these
 * surfaces, and as the coolest of the four it reads as "and the rest" without claiming a
 * meaning.
 *
 * Four rather than eight, because eight distinct hues on one 10px bar is a colour scale nobody
 * can match to a legend, and the legend below is the real readout in any case.
 */
const GENRE_TONES = ["bg-amber", "bg-teal", "bg-desert", "bg-line-bright"] as const;

/**
 * Later slices dim, so a hue coming round a second time still reads apart from its first
 * appearance. Floored at 0.45 — below that an amber sliver on `surface-3` stops being visible
 * at all, which would make the fifth genre disappear rather than merely recede.
 */
function sliceOpacity(index: number): number {
  return Math.max(0.45, 1 - index * 0.07);
}

export type GenreSplitProps = {
  /**
   * `YearReview.genres` — already ordered, already sliced by the query. Nothing here re-sorts:
   * the ordering is the panel's ranking and re-deriving it would be a second opinion.
   */
  genres: YearGenre[];
  className?: string;
};

export function GenreSplit({ genres, className }: GenreSplitProps) {
  /*
   * THE DENOMINATOR IS THE SUM OF THE RETURNED GENRES, NOT THE MEMBER'S WHOLE YEAR.
   *
   * The query returns the member's leading genres, so this sum is smaller than the number of
   * albums they played — some records carry no genre at all, and the tail is cut. Every share
   * below is therefore "of these genres", and the note under the legend SAYS SO, because a
   * stacked bar that fills its full width is otherwise read as a share of everything and
   * "Jazz 41%" becomes a claim about the year rather than about the top four.
   */
  const total = genres.reduce((sum, entry) => sum + entry.albums, 0);

  if (genres.length === 0 || total === 0) {
    // A sentence about our data, not about the member: a record with no genre in the mirror is
    // an ungenred record, and "you listened to no genres" would be nonsense.
    return (
      <p className={cn("font-mono text-[0.6875rem] uppercase tracking-wider text-faint", className)}>
        No genre data for this year.
      </p>
    );
  }

  return (
    <div className={cn("w-full space-y-3", className)}>
      {/*
        THE BAR IS DECORATION AND THE LEGEND IS THE DATA — the same split
        components/rating/histogram.tsx makes. A stacked bar has no honest single label, so it
        is hidden outright and every number below is real text.
      */}
      <div aria-hidden="true" className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-3">
        {genres.map((entry, index) => (
          <span
            key={entry.genre}
            className={cn(
              // `min-w-[3px]` SO A SLIVER STAYS VISIBLE. A genre with one album out of two
              // hundred is 0.5% — under a pixel on a phone — and a segment that rounds away is
              // indistinguishable from a genre the query did not return.
              "min-w-[3px]",
              GENRE_TONES[index % GENRE_TONES.length],
            )}
            style={{ width: `${((entry.albums / total) * 100).toFixed(2)}%`, opacity: sliceOpacity(index) }}
          />
        ))}
      </div>

      <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
        {genres.map((entry, index) => (
          <li key={entry.genre} className="flex items-center gap-2">
            {/* The swatch repeats the segment's colour AND its opacity, so the legend and the
                bar can be matched by eye; it is `aria-hidden` because the text beside it is
                the equivalent. */}
            <span
              aria-hidden="true"
              className={cn("size-2.5 shrink-0 rounded-full", GENRE_TONES[index % GENRE_TONES.length])}
              style={{ opacity: sliceOpacity(index) }}
            />
            <span className="text-[0.8125rem] text-paper">{entry.genre}</span>
            <span className="font-mono text-[0.6875rem] tabular text-faint">
              {plural(entry.albums, "album")}
              {" · "}
              {Math.round((entry.albums / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>

      {/* The denominator, in words. See the comment on `total`. */}
      <p className="text-[0.6875rem] leading-relaxed text-faint">
        {`Shares are of the ${plural(total, "album")} in these genres, not of everything you played this year — records with no genre in the catalogue, and the long tail below these, are not counted.`}
      </p>
    </div>
  );
}

/* ========================================================================== *
 * ComparisonRow
 * ========================================================================== */

export type ComparisonRowProps = {
  /** "Tracks played", "Average rating". The row's own label. */
  label: React.ReactNode;
  /** The member's figure. `null` is a real state — an unrated year has no average. */
  mine: number | null;
  /** The platform's figure for the same year, from `YearPlatform`. */
  platform: number | null;
  /**
   * `count` prints the number; `rating` hands it to `<Stars>`, which takes the STORED 0..10
   * scale and divides internally. NEVER `n/10` — see the module docblock.
   */
  kind?: "count" | "rating";
  /** Defaults to "You" and "Everyone". */
  mineLabel?: string;
  platformLabel?: string;
  className?: string;
};

export function ComparisonRow({
  label,
  mine,
  platform,
  kind = "count",
  mineLabel = "You",
  platformLabel = "Everyone",
  className,
}: ComparisonRowProps) {
  /*
   * ONE SHARED SCALE — `max(mine, platform)` — SO THE TWO BARS ARE DIRECTLY COMPARABLE BY
   * LENGTH. Scaling each bar to its own value is the failure this exists to avoid: both would
   * be full width and the panel would say "you and everybody else played the same amount",
   * whatever the two numbers were.
   *
   * For `kind="rating"` this means two near-equal averages produce two near-full bars, which is
   * correct: the difference between 7.2 and 7.0 IS small, and the stars beside each bar carry
   * the absolute value that the bar deliberately does not.
   */
  const scale = Math.max(mine ?? 0, platform ?? 0);
  const ratio = (value: number | null) => (scale <= 0 || value === null ? 0 : clampRatio(value / scale));

  return (
    <div className={cn("space-y-2", className)}>
      <Eyebrow>{label}</Eyebrow>
      {/* `tone="amber"` for the member and `neutral` for the platform: amber is emphasis in this
          palette, and the member's own figure is the subject of the page. */}
      <Side name={mineLabel} value={mine} kind={kind} ratio={ratio(mine)} tone="amber" />
      <Side name={platformLabel} value={platform} kind={kind} ratio={ratio(platform)} tone="neutral" />
    </div>
  );
}

function Side({
  name,
  value,
  kind,
  ratio,
  tone,
}: {
  name: string;
  value: number | null;
  kind: "count" | "rating";
  ratio: number;
  tone: "amber" | "neutral";
}) {
  return (
    <div className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-3">
      <span className="font-mono text-[0.6875rem] uppercase tracking-wider text-faint">{name}</span>
      {/*
        `ratio` IS 0..1. `meterPercent()` returns 0..100 and `Meter`'s docblock warns that
        passing a percentage straight through pins every bar at 100% — which looks like a
        working feature. The figure is printed beside the bar, so the bar takes no `label` and
        is hidden from assistive technology.
      */}
      <Meter ratio={ratio} tone={tone} />
      <span className="justify-self-end font-mono text-[0.8125rem] tabular text-paper">
        {kind === "rating" ? (
          <span className="flex items-center gap-1.5">
            {/* `<Stars>` keeps its default label, so this announces "3.6 out of 5 stars" — or
                "Not rated" for a null — without a second sentence of our own. */}
            <Stars value={value} size="sm" />
            <span aria-hidden="true" className="text-muted">
              {formatRating(value)}
            </span>
          </span>
        ) : (
          // An em dash for null, never a 0: a missing figure and a measured zero are different
          // claims, and `formatCount(0)` would make the second out of the first.
          (value === null ? "—" : formatCount(value))
        )}
      </span>
    </div>
  );
}

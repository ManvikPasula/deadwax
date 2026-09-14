/**
 * The star display. NO `"use client"` — there is no state and no handler here, so it renders
 * inside Server Components, which matters because a 24-card grid mounts twenty-four of these
 * and a tracklist mounts one per row.
 *
 * TWO STACKED LAYERS, AND THE TOP ONE IS CLIPPED BY A PERCENTAGE WIDTH. Five dim glyphs sit
 * underneath; an absolutely-positioned amber copy sits on top inside an `overflow-hidden` box
 * whose width is `value / 10 * 100%`. That is what makes half stars align exactly and
 * fractional averages render continuously: 3.7 stars is a real 74% clip, not a rounded glyph.
 *
 * The rejected alternative was five per-star glyphs each choosing between full / half / empty
 * characters. It cannot show 3.7 at all — every average lands on one of eleven shapes — and it
 * needs a half-star glyph that lines up with the full one in whatever font the platform
 * resolves `★` from, which is not something we control.
 *
 * IT TAKES THE STORED 0..10 SCALE AND DIVIDES INTERNALLY. That single decision is what lets a
 * member average, a MusicBrainz baseline and one member's own rating all be handed to this
 * component: they already share a scale (see lib/ratings.ts §4.1), so nothing at a call site
 * converts anything.
 */

import { formatStars, intToStars, MAX_RATING } from "@/lib/ratings";
import { cn } from "@/lib/utils";

/**
 * Four sizes. `xs` is the 11px that the cover-card overlay and the feed rows use, and it is
 * the same 11px as `.eyebrow` — see the note on `--color-faint` in globals.css.
 */
const SIZES = {
  xs: "text-[0.6875rem]",
  sm: "text-[0.8125rem]",
  md: "text-base",
  lg: "text-2xl",
} as const;

export type StarSize = keyof typeof SIZES;

/**
 * ONE STRING OF FIVE GLYPHS PER LAYER, not five elements.
 *
 * Both layers render byte-identical markup with identical classes, so their glyph metrics are
 * identical by construction and the clip cannot drift. NO LETTER-SPACING, deliberately: any
 * tracking adds a trailing gap after the fifth star which is inside the measured 100% width,
 * so the 50% clip would land slightly right of the third glyph's midpoint.
 */
const GLYPHS = "\u2605\u2605\u2605\u2605\u2605";

export type StarsProps = {
  /**
   * The STORED 0..10 scale — an integer rating, a weighted community mean, or a critic score
   * already normalised through `mbRatingToStored`. `null` renders the empty track.
   */
  value: number | null | undefined;
  size?: StarSize;
  /**
   * The text equivalent. Defaults to "3.5 out of 5 stars" / "Not rated".
   *
   * `null` SUPPRESSES IT, for the one case where this component sits inside a control that
   * already carries the name — `StarInput`'s slider, whose `aria-valuetext` says the same
   * thing and would otherwise say it twice.
   */
  label?: string | null;
  className?: string;
};

export function Stars({ value, size = "sm", label, className }: StarsProps) {
  const bounded = value === null || value === undefined ? null : Math.min(MAX_RATING, Math.max(0, value));
  const stars = bounded === null ? 0 : intToStars(bounded);
  // Percentage of the whole five-star row, which is why the divisor is MAX_RATING and not 5.
  const percent = bounded === null ? 0 : (bounded / MAX_RATING) * 100;

  return (
    <span className={cn("relative inline-block select-none leading-none", SIZES[size], className)}>
      {/* The track. `line-bright` rather than a dimmed amber: the empty state is a meaningful
          graphical object and needs 3:1 against the surface — see globals.css. */}
      <span aria-hidden="true" className="block text-line-bright">
        {GLYPHS}
      </span>
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 overflow-hidden text-amber"
        style={{ width: `${percent}%` }}
      >
        {/* `whitespace-nowrap` is load-bearing: the parent is narrower than five glyphs, so
            without it the row wraps inside the clip box instead of overflowing it. */}
        <span className="block whitespace-nowrap">{GLYPHS}</span>
      </span>
      {label === null ? null : (
        <span className="sr-only">{label ?? (bounded === null ? "Not rated" : `${formatStars(stars)} out of 5 stars`)}</span>
      )}
    </span>
  );
}

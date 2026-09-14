/**
 * The Deadwax mark and wordmark.
 *
 * WHAT THE NAME MEANS, because the mark is drawing it literally: the deadwax is the blank
 * run-out groove at the end of a record side, where the mastering engineer scratches a
 * private signature into the lacquer. A diary of personal verdicts on records is the same
 * gesture, which is why the mark is a set of concentric grooves that STOP, leaving a blank
 * band with one scratch in it — the empty band is the subject, not the grooves.
 *
 * The geometry is fixed in a 32-unit viewBox and scaled by font size or by a utility class,
 * so the mark and the word always sit on the same baseline rhythm.
 *
 * COLOURS COME FROM THE THEME TOKENS via `var()`, which works because this is inline SVG in
 * the document. app/icon.svg CANNOT do that — a favicon is fetched standalone with no access
 * to the app's stylesheet — so it carries hardcoded copies of the same three hexes. THE TWO
 * FILES MUST BE EDITED TOGETHER; there is no build step tying them.
 */

import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The record: four grooves, then the deadwax, then the label.
 *
 * The groove opacities descend outward-in (0.95 → 0.45) so the disc reads as catching light
 * rather than as four identical rings, and the gap between the innermost groove (r=9) and the
 * label (r=5) is the run-out — deliberately WIDER than the groove spacing, because a
 * proportionally correct run-out disappears at 16px and the mark stops being about anything.
 */
export function LogoMark({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 32 32"
      // Decoration: `Logo` and every caller supply the accessible name in text beside it.
      aria-hidden="true"
      focusable="false"
      className={cn("size-7", className)}
      {...props}
    >
      <circle cx="16" cy="16" r="15.25" fill="var(--color-ink)" stroke="var(--color-line)" strokeWidth="0.5" />
      <g fill="none" stroke="var(--color-amber)" strokeWidth="1">
        <circle cx="16" cy="16" r="13.5" opacity="0.95" />
        <circle cx="16" cy="16" r="12" opacity="0.75" />
        <circle cx="16" cy="16" r="10.5" opacity="0.6" />
        <circle cx="16" cy="16" r="9" opacity="0.45" />
      </g>
      {/* The scratched signature, sitting in the blank band. One stroke, tangential. */}
      <path
        d="M19.6 10.9 L21.6 12.5"
        fill="none"
        stroke="var(--color-amber-bright)"
        strokeWidth="1"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="5" fill="var(--color-amber)" />
      <circle cx="16" cy="16" r="1.3" fill="var(--color-ink)" />
    </svg>
  );
}

/**
 * "Dead" in paper, "wax" in amber.
 *
 * The split is not a flourish: it makes the compound word legible as two words at small
 * sizes, and it puts the accent on the half that names the blank groove. Display serif,
 * because the wordmark is the one place the display face appears outside a headline.
 */
export function Wordmark({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span className={cn("font-display text-xl leading-none tracking-tight", className)} {...props}>
      <span className="text-paper">Dead</span>
      <span className="text-amber">wax</span>
    </span>
  );
}

/**
 * The pair, as the header and the footer render it.
 *
 * The accessible name is a real `sr-only` string rather than the two coloured spans, so a
 * screen reader announces "Deadwax" once instead of "Dead" then "wax", and the mark stays
 * `aria-hidden`.
 */
export function Logo({
  className,
  markClassName,
  wordClassName,
  showWordmark = true,
}: {
  className?: string;
  markClassName?: string;
  wordClassName?: string;
  showWordmark?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark className={markClassName} />
      {showWordmark ? (
        <Wordmark aria-hidden="true" className={wordClassName} />
      ) : null}
      <span className="sr-only">Deadwax</span>
    </span>
  );
}

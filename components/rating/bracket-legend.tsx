/**
 * The seven-bracket legend. Server Component.
 *
 * It renders `bracketLegend()` unchanged, which samples each swatch at the MIDPOINT of its
 * range — so a swatch is not the shade that happens to sit next to the neighbouring bracket,
 * which made an earlier version read as one continuous ramp rather than as seven named bands.
 *
 * THE LABEL IS THE POINT, NOT THE SWATCH. The brackets carry the meaning and the gradient
 * carries the precision (§4.3), so the swatch is `aria-hidden` and the name beside it is the
 * text equivalent of every colour in both heatmaps. That is the whole reason this component
 * exists as a separate file: a heatmap is a grid of colours, and a grid of colours without a
 * key is a decoration.
 *
 * The order is deliberately not a spectrum — dark green ("Awesome") outranks bright green
 * ("Great") and blue sits above both — so the legend is also the only place that order is
 * visible. Best first, which is how `bracketLegend()` returns it.
 *
 * Inline `backgroundColor` is the ONE sanctioned exception to "no arbitrary colour values":
 * the ramp deliberately does not live in CSS, because a fixed set of variables can name seven
 * colours but not seven ranges. See the comment on `--heat-none` in globals.css.
 */

import { bracketLegend, UNRATED_COLOR } from "@/lib/ratings";
import { cn } from "@/lib/utils";

export type BracketLegendProps = {
  /**
   * Defaults to TRUE. Both heatmaps draw unrated cells, and on most of the catalogue that is
   * the commonest colour on the screen — a key that omits it is incomplete exactly where a
   * newcomer needs it most.
   */
  showUnrated?: boolean;
  className?: string;
};

export function BracketLegend({ showUnrated = true, className }: BracketLegendProps) {
  const entries = bracketLegend();

  return (
    <ul className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", className)}>
      {entries.map((entry) => (
        <li key={entry.key} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-[2px] ring-1 ring-inset ring-black/25"
            style={{ backgroundColor: entry.color }}
          />
          <span className="font-mono text-[0.6875rem] uppercase tracking-wider text-faint">{entry.label}</span>
        </li>
      ))}
      {showUnrated ? (
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-[2px] ring-1 ring-inset ring-black/25"
            style={{ backgroundColor: UNRATED_COLOR }}
          />
          <span className="font-mono text-[0.6875rem] uppercase tracking-wider text-faint">Not rated</span>
        </li>
      ) : null}
    </ul>
  );
}

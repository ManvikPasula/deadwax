/**
 * The rating histogram. TEN BARS, ALWAYS.
 *
 * Server Component: it renders `HistogramBucket[]` and nothing else.
 *
 * `ratio` arrives as a share of the TALLEST bucket, not of the total (§4.2), which is what
 * makes an album with twelve ratings silhouette-comparable to one with twelve thousand. The
 * bars are floored at `max(2px, ratio%)` — A 2px FLOOR KEEPS AN UNUSED BUCKET LEGIBLE AS A
 * BUCKET. Without it, a distribution with one empty rung reads as a nine-bucket chart and the
 * gap looks like a rendering fault rather than like "nobody gave this three stars".
 *
 * The floor is written as a CSS `max()` rather than computed in JS on purpose: the percentage
 * has to resolve against the rendered height, which we do not know here.
 *
 * THE BARS ARE AMBER, NOT BRACKET-COLOURED. The seven-bracket ramp belongs to the heatmaps,
 * where hue is carrying the score of one cell; here the x-axis already carries the score and
 * colouring the bars as well would say the same thing twice, in the one place the product
 * cannot afford to look like it has two rating scales.
 */

import { plural } from "@/lib/format";
import { formatStars, type HistogramBucket } from "@/lib/ratings";
import { cn } from "@/lib/utils";

export type HistogramProps = {
  /** Exactly ten buckets, from `histogram()` or `histogramFromCounts()`. */
  buckets: HistogramBucket[];
  /** Overall height of the plot area. The bars fill it; the floor keeps empties visible. */
  height?: "sm" | "md";
  className?: string;
};

const HEIGHTS = { sm: "h-12", md: "h-20" } as const;

export function Histogram({ buckets, height = "md", className }: HistogramProps) {
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);

  return (
    <div className={cn("w-full", className)}>
      {/*
        THE CHART IS DECORATION AND THE LIST BELOW IT IS THE DATA. A ten-bar bitmap has no
        honest single label — "a histogram" tells a screen reader nothing — so the whole plot
        is hidden and the same numbers are published as an sr-only list.
      */}
      <div aria-hidden="true" className={cn("flex items-end gap-1", HEIGHTS[height])}>
        {buckets.map((bucket) => (
          <div key={bucket.value} className="flex h-full flex-1 items-end">
            <div
              className="w-full rounded-t-[2px] bg-amber/70"
              style={{ height: `max(2px, ${bucket.ratio * 100}%)` }}
              title={`${formatStars(bucket.stars)} stars — ${plural(bucket.count, "rating")}`}
            />
          </div>
        ))}
      </div>

      <div aria-hidden="true" className="mt-1.5 flex justify-between font-mono text-[0.6875rem] tabular text-faint">
        <span>0.5</span>
        <span>5.0</span>
      </div>

      <ul className="sr-only">
        <li>{total === 0 ? "No ratings yet." : `${plural(total, "rating")} in total.`}</li>
        {buckets.map((bucket) => (
          <li key={bucket.value}>{`${formatStars(bucket.stars)} stars: ${plural(bucket.count, "rating")}`}</li>
        ))}
      </ul>
    </div>
  );
}

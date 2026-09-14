/**
 * The member's genre split.
 *
 * NO `"use client"`. A chart built from plain elements with CSS widths — no SVG, no canvas, no
 * charting library, no measuring pass, no hydration. That is the house approach to every chart
 * in this application.
 *
 * ---------------------------------------------------------------------------------------
 * THE DENOMINATOR CAVEAT IS THE WHOLE DESIGN OF THIS COMPONENT
 * ---------------------------------------------------------------------------------------
 *
 * `getGenreBreakdown` is `CROSS JOIN LATERAL jsonb_array_elements(a.genres)`, so AN ALBUM WITH
 * THREE GENRES CONTRIBUTES TO THREE BUCKETS. The counts therefore sum ABOVE the album count
 * and are not percentages of anything. The query's own docblock puts it bluntly: "treating
 * this as a partition of the library reports a split adding to 180%."
 *
 * SO THIS IS NOT A STACKED PROPORTIONAL BAR, AND THAT IS THE REJECTED ALTERNATIVE WORTH
 * NAMING. The television original's `GenreSplit` is exactly that — one bar divided into
 * segments over a cycled palette — and it is correct there because a show belongs to its
 * genres in a single row. Porting the shape here would put a figure that sums to 180% inside
 * the one visual form that means "these are shares of a whole", and no caption undoes that: a
 * reader trusts the picture over the sentence under it.
 *
 * WHAT REPLACES IT: one bar per genre, EACH MEASURED AGAINST THE LEADER rather than against a
 * total. That is a ranking with a visible magnitude, which is all the data supports — "Rock is
 * about twice Ambient" is true and readable; "Rock is 31% of what I listen to" is not
 * available from these rows. The caveat is then stated in the UI rather than implied away.
 *
 * `Meter` TAKES A RATIO OF 0..1, NOT 0..100. `meterPercent()` returns 0..100, so it is divided
 * before it reaches the component; passing the percent straight through silently pins every
 * bar at 100%, which looks like a working feature. Its own 2% floor is what keeps a genre with
 * one album from rendering as an empty track — deliberately NOT the 4% floor `MonthlyBars`
 * uses, because these bars are panel-width where 2% is already a legible sliver.
 *
 * NO PER-GENRE COLOUR. The tone vocabulary in components/ui/primitives.tsx is a VOCABULARY and
 * not a palette — teal is replay and completion only, desert is the Desert Island honour only,
 * rose is destructive, amber is emphasis — so cycling four of them across "Ambient, Dub, Jazz,
 * Post-punk" would teach a reader that one of those genres is a replay and another is an error.
 * One amber ramp with the genre named beside every bar carries the same information and
 * borrows no meaning it has not earned.
 */

import { Meter, SectionHeading } from "@/components/ui/primitives";
import type { GenreCount } from "@/lib/stats/profile";
import { formatCount, plural } from "@/lib/format";
import { meterPercent } from "@/lib/ratings";
import { cn } from "@/lib/utils";

export type GenreBreakdownProps = {
  /**
   * `getGenreBreakdown(userId)` — already ordered by count with an alphabetical tie-break "so
   * the panel does not reshuffle between two renders of identical data", and already capped by
   * the query's own `limit`. Nothing here re-sorts or re-truncates.
   */
  genres: GenreCount[];
  /**
   * `ProfileStats.albumsStarted`, used ONLY in the caveat sentence — never as a denominator.
   *
   * It is the honest number to compare against: both it and this query are CANONICAL-ONLY,
   * which is what lets the two figures be named in the same sentence at all. A member whose
   * live albums were counted here but not there would see a split that cannot be reconciled
   * with the rest of the panel.
   */
  albumCount?: number | null;
  className?: string;
};

export function GenreBreakdown({ genres, albumCount, className }: GenreBreakdownProps) {
  /*
   * Nothing at all for an empty split. The genres come from the provider on the albums a member
   * has logged, so an empty result means they have logged nothing — which the diary and the
   * stat tiles on the same page already say, in copy that offers the next move. A third empty
   * box is a page telling a new member three times that they are new.
   */
  if (genres.length === 0) return null;

  /**
   * THE SCALE IS THE LEADER, NOT THE SUM. `genres[0]` is safe because the query orders by
   * count, and `Math.max(1, …)` only guards the arithmetic: a zero count cannot reach here
   * (`COUNT(*)` over a `GROUP BY` is at least one) but a division by it would produce NaN
   * widths rather than an error anybody would notice.
   */
  const leader = Math.max(1, ...genres.map((row) => row.albums));
  /** The sum of the rows SHOWN, which is not the whole library — see the caveat copy below. */
  const shown = genres.reduce((total, row) => total + row.albums, 0);

  return (
    <section className={cn("space-y-4", className)}>
      <SectionHeading eyebrow="Genres" title="What they listen to" />

      <ul className="space-y-3">
        {genres.map((row) => (
          <li key={row.genre}>
            <div className="flex items-baseline justify-between gap-3">
              {/* Sans, not mono: a genre is a name, not an identifier or a number. */}
              <p className="min-w-0 truncate text-[0.8125rem] text-paper">{row.genre}</p>
              <p className="shrink-0 font-mono text-[0.6875rem] tabular text-muted">
                {formatCount(row.albums)}
                {/* The bar is decoration and is hidden below; THIS is the data, so the unit has
                    to be readable rather than implied by the column it sits in. */}
                <span className="sr-only"> {row.albums === 1 ? "album" : "albums"}</span>
              </p>
            </div>
            {/*
              NO `label`, deliberately. `Meter` hides itself from assistive technology when the
              number is already beside it in the layout — which it is, one line up — and naming
              the bar as well would announce every genre twice.
            */}
            <Meter ratio={meterPercent(row.albums, leader) / 100} tone="amber" className="mt-1.5" />
          </li>
        ))}
      </ul>

      {/*
        THE CAVEAT, IN THE UI. Stating it is the whole reason this panel is a ranking rather than
        a pie: a reader who adds the numbers up and gets more than the album count needs the
        explanation here, not in a docblock they will never see.
      */}
      <p className="text-[0.8125rem] leading-relaxed text-faint">
        {/* `plural` needs the irregular form spelled out: its default is `noun + "s"`, which
            would print "entrys". */}
        An album counts in every genre it carries, so these add up to {plural(shown, "entry", "entries")}
        {typeof albumCount === "number" && albumCount > 0 ? ` across ${plural(albumCount, "album")}` : ""}. The bars
        are relative to the leading genre, not shares of a whole.
      </p>
    </section>
  );
}

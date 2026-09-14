/**
 * Dual rating — a verdict on the whole, beside the mean of the parts.
 *
 * Server Component: every number and every sentence is computed by lib/ratings/dual.ts, which
 * is pure and unit-tested. This file lays them out and does no arithmetic of its own.
 *
 * THE RIGHT-HAND FIGURE GETS NO CONTROL. It is labelled "Derived from N tracks" and there is
 * deliberately nothing to press, SO NOBODY LOOKS FOR A CONTROL TO SET IT. A track average is
 * not a settable opinion; it is the shadow the track ratings cast.
 *
 * THE DIVERGENCE IS INTERESTING RATHER THAN AN ERROR. A record of consistently fine songs that
 * fumbles its last three rates lower as a whole than its tracks average, and a patchy record
 * with three transcendent songs often rates higher as a whole than its mean track. So the note
 * describes it and never invites a correction.
 *
 * VIEWER-PRIVATE. This panel is never computed for the community, which is why it carries no
 * vote count and no attribution — there is only one person in it.
 *
 * Exported under both names because the spec calls the component `DualRating` while the value
 * it renders already owns that identifier in lib/ratings/dual.ts, and shadowing a type with a
 * component in the same file is how you get an unreadable error at the call site.
 */

import { Stars } from "@/components/rating/stars";
import { Eyebrow } from "@/components/ui/primitives";
import { formatRating } from "@/lib/ratings";
import { derivedFromLabel, divergenceNote, type DualRating, type DualScope } from "@/lib/ratings/dual";
import { cn } from "@/lib/utils";

export type DualRatingPanelProps = {
  /** From `dualRating(wholeRating, partRatings)`. */
  dual: DualRating;
  /**
   * `album` (the album verdict against its tracks) is the DEFAULT, because an album is the
   * primary work — the television original defaults to the show for the opposite reason. The
   * `artist` scope draws the career statement against the mean of their rated albums.
   */
  scope?: DualScope;
  className?: string;
};

export function DualRatingPanel({ dual, scope = "album", className }: DualRatingPanelProps) {
  // Nothing to compare: a panel holding two em dashes is noise on a page that already says
  // "you have not rated this".
  if (dual.wholeRating === null && dual.partAverage === null) return null;

  const note = divergenceNote(dual, scope);
  const wholeCaption = scope === "album" ? "Your album rating" : "Your artist rating";

  return (
    <section className={cn("card p-4", className)} aria-label="Your verdict against the parts you rated">
      <div className="grid grid-cols-2 gap-4 divide-x divide-line">
        <div className="min-w-0">
          <Eyebrow>{wholeCaption}</Eyebrow>
          <p className="mt-1.5 font-mono text-2xl tabular text-paper">{formatRating(dual.wholeRating)}</p>
          <Stars value={dual.wholeRating} size="sm" className="mt-1" />
        </div>

        {/* No control, no link, no input. See the docblock. */}
        <div className="min-w-0 pl-4">
          <Eyebrow>{derivedFromLabel(dual, scope)}</Eyebrow>
          <p className="mt-1.5 font-mono text-2xl tabular text-muted">{formatRating(dual.partAverage)}</p>
          <Stars value={dual.partAverage} size="sm" className="mt-1" />
        </div>
      </div>

      {note ? (
        <p className="mt-3 border-t border-line pt-3 text-[0.8125rem] leading-relaxed text-muted text-balance">{note}</p>
      ) : null}
    </section>
  );
}

export { DualRatingPanel as DualRating };

/**
 * The consensus card — TWO NUMBERS, NEVER MERGED.
 *
 * Server Component. The whole point of it is attribution, so it is worth restating the rule
 * the whole rating subsystem exists to protect (§4.4):
 *
 *   An album with six member ratings must not borrow the authority of MusicBrainz seventy, so
 *   EACH NUMBER KEEPS ITS ATTRIBUTION AND ITS VOTE COUNT.
 *
 * NOTHING IN THIS COMPONENT MAY AVERAGE THE TWO NUMBERS. There is no Bayesian prior on
 * display, no shrinkage toward the provider mean, no vote-weighted blend, and no "overall
 * score" line. If a future version needs one number it needs a different component, a
 * different name, and an argument for why the blend is honest — because provider consensus
 * enters a computed number in exactly one place in this codebase (the taste model, where
 * MEASURED AGREEMENT weights a prediction) and never in anything a member reads as a
 * community average.
 *
 * MUSICBRAINZ IS ON THE LEFT. That is how "leads with the baseline" is expressed physically:
 * reading order, not a label saying which matters more.
 *
 * THE ONE HONESTY RULE DEADWAX ADDS. When `criticVotes === 0` the provider column is NOT
 * RENDERED AT ALL and the card collapses to one column with a footnote. DO NOT grey out a
 * zero: a greyed "0.0" implies a measured zero — seventy people who all hated it — when the
 * truth is that nobody has rated it there. Neither provider carries a rating for much of the
 * catalogue, so this is the COMMON state, not an exceptional one, and it has to read as
 * ordinary rather than as damage.
 */

import { Stars } from "@/components/rating/stars";
import { Eyebrow } from "@/components/ui/primitives";
import { plural } from "@/lib/format";
import { criticToStars, formatRating, formatStars, LOW_CONFIDENCE_THRESHOLD } from "@/lib/ratings";
import { cn } from "@/lib/utils";

export type ConsensusProps = {
  /** MusicBrainz, ALREADY on the stored 0..10 scale — the bridge ran once, at ingest. */
  criticScore: number | null;
  /** Zero collapses the card. See the docblock. */
  criticVotes: number;
  /** The Deadwax weighted mean, stored 0..10 scale. */
  memberAverage: number | null;
  /** Drives both the low-confidence state and the `null` forcing below. */
  memberCount: number;
  /**
   * Overrides the provider caption. Retained for the TRACK case, where per-recording
   * MusicBrainz ratings are genuinely sparse and the caption is worth qualifying; artists and
   * albums both carry real attributed figures and want the plain name.
   */
  label?: string;
  className?: string;
};

export function Consensus({
  criticScore,
  criticVotes,
  memberAverage,
  memberCount,
  label = "MusicBrainz",
  className,
}: ConsensusProps) {
  /**
   * FORCED TO NULL AT ZERO RATINGS REGARDLESS OF WHAT WAS PASSED. A caller that computed an
   * average over an empty set and got a 0 through — a plain SQL `AVG` and a `?? 0` are both
   * one keystroke away — would publish "0.0 from 0 members", and a displayed 0 on this scale
   * is a verdict (§4.1 has no zero).
   */
  const member = memberCount === 0 ? null : memberAverage;
  const hasCritic = criticVotes > 0 && criticScore !== null;
  const lowConfidence = memberCount < LOW_CONFIDENCE_THRESHOLD;

  return (
    <section className={cn("card p-4", className)} aria-label="Rating consensus">
      <div className={cn("grid gap-4", hasCritic && "grid-cols-2 divide-x divide-line")}>
        {/* LEFT: the baseline, and only when it is a measured one. */}
        {hasCritic ? (
          <Column
            caption={label}
            /* criticToStars rather than formatRating: both land on the same scale, and using
               the critic-specific transform keeps the one-conversion-site rule visible at the
               call site rather than only in lib. */
            figure={formatStars(criticToStars(criticScore))}
            score={criticScore}
            footnote={plural(criticVotes, "vote")}
          />
        ) : null}

        {/* RIGHT: Deadwax itself. Dimmed while the sample is thin — the vote count under it is
            the text equivalent of the dimming, so the state is never carried by opacity alone. */}
        <Column
          caption="Deadwax members"
          figure={formatRating(member)}
          score={member}
          footnote={memberCount === 0 ? "No ratings yet" : plural(memberCount, "rating")}
          className={cn(!hasCritic && "col-span-full", lowConfidence && "opacity-60")}
        />
      </div>

      <p className="mt-3 border-t border-line pt-3 text-[0.6875rem] leading-relaxed text-faint">
        {!hasCritic
          ? "No critic baseline for this release"
          : lowConfidence
            ? /* VERBATIM. The sentence names which number to read and why, which is the whole
                 job of the low-confidence state. */
              "Too few member ratings — showing the MusicBrainz baseline as the reference."
            : "Two independent figures. Deadwax never averages them together."}
      </p>
    </section>
  );
}

function Column({
  caption,
  figure,
  score,
  footnote,
  className,
}: {
  caption: string;
  figure: string;
  score: number | null;
  footnote: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 px-1 first:pl-0 last:pr-0", className)}>
      <Eyebrow>{caption}</Eyebrow>
      <p className="mt-1.5 font-mono text-2xl tabular text-paper">{figure}</p>
      {/* The label names the source, so the two rows can never be read as one pooled score. */}
      <Stars value={score} size="sm" className="mt-1" label={`${caption}: ${figure === "—" ? "not rated" : `${figure} out of 5 stars`}`} />
      <p className="mt-1.5 font-mono text-[0.6875rem] tabular text-faint">{footnote}</p>
    </div>
  );
}

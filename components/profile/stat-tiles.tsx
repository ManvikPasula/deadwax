/**
 * The nine lifetime numbers, as nine `StatTile`s.
 *
 * NO `"use client"`. Nine tiles of props.
 *
 * ---------------------------------------------------------------------------------------
 * AVERAGE RATING IS STARS. NEVER `n / 10`.
 *
 * This is the one honesty bug the brief tells us not to copy: the source's year page renders
 * "Average rating" on the RAW STORED 1–10 SCALE with the unit "/ 10", while every other
 * surface in both applications shows 0.5–5 stars. The same member's taste then reads as 7.4 in
 * one panel and 3.7 everywhere else, and there is no label that undoes that. `formatRating`
 * does the conversion (`intToStars`, then one decimal only when it needs one) and `Stars`
 * draws the glyphs from the same stored number — so the figure and the row of stars cannot
 * disagree, because neither converts anything at this call site.
 *
 * A NULL AVERAGE RENDERS AN EM DASH AND NO STARS. `averageRating` in lib/ratings.ts returns
 * null rather than 0 for an empty set for exactly this reason: a displayed zero is a MEASURED
 * VERDICT — "this member rates everything nothing" — where null is the absence of one. An
 * empty five-star track would be read as the former.
 * ---------------------------------------------------------------------------------------
 *
 * LISTENING TIME GOES THROUGH `formatListeningTime`, AND THE UNIT CONVERSION IS THE TRAP.
 * `ProfileStats.minutesPlayed` is MINUTES (the query is `SUM(duration_ms) / 60000`, floored),
 * and `formatListeningTime` takes MILLISECONDS. Handing it the minutes produces "0 minutes" for
 * a member with a thousand hours behind them, which looks like a working feature. Hence the
 * `* 60_000` below, written once.
 *
 * NO MEDIAN FALLBACK ANYWHERE NEAR THIS NUMBER. The television original sums
 * `COALESCE(runtime, show.episode_run_time, 0)` and needs a median-over-mirrored-episodes
 * workaround because TMDB's runtime field is empty for most shows; every Deezer track carries a
 * reliable duration, so listening time is a plain sum computed at ingest. The brief says
 * explicitly not to port the workaround.
 *
 * THE ASYMMETRY BETWEEN THE TWO GROUPS IS DELIBERATE AND IS WORTH NOT "FIXING":
 *
 *   tracks / minutes / albums   DISTINCT-track-based, CANONICAL RELEASES ONLY
 *   ratings / reviews / diary   RAW LOG COUNTS across all three target levels
 *
 * The first group answers "how much music has this member actually heard", which a deluxe
 * edition's bonus tracks would inflate and a replay would double. The second answers "how much
 * have they written down", and a review of a live album is a review. The hints below are
 * written so the two groups cannot be read as one.
 */

import { Stars } from "@/components/rating/stars";
import { StatTile } from "@/components/ui/primitives";
import type { ProfileStats } from "@/lib/stats/profile";
import { formatCount, formatListeningTime, plural } from "@/lib/format";
import { formatRating, meterPercent } from "@/lib/ratings";
import { cn } from "@/lib/utils";

export type StatTilesProps = {
  /** `getProfileStats(userId)` — nine numbers in one round trip, React-`cache()`d per request. */
  stats: ProfileStats;
  className?: string;
};

export function StatTiles({ stats, className }: StatTilesProps) {
  const {
    tracksPlayed,
    minutesPlayed,
    albumsStarted,
    albumsCompleted,
    artistsTouched,
    ratingsGiven,
    averageRating,
    reviewsWritten,
    diaryEntries,
  } = stats;

  return (
    /*
      NINE TILES, THREE COLUMNS, THREE FULL ROWS — and the divisibility is the reason for the
      breakpoints rather than the other way round, the same argument `GRID_PAGE_SIZE = 24`
      makes beside its own column classes. Two columns on a phone leaves one tile alone on the
      last row, which is the least bad of the three options at that width: a single column makes
      the panel nine screens tall.
    */
    <section className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3", className)}>
      <StatTile label="Tracks played" value={formatCount(tracksPlayed)} hint="Distinct tracks, so a replay counts once" />

      <StatTile
        label="Listening time"
        // MINUTES TO MILLISECONDS. See the docblock — this is the one unit conversion on the panel.
        value={formatListeningTime(minutesPlayed * 60_000)}
        hint="Summed track durations"
      />

      <StatTile label="Albums started" value={formatCount(albumsStarted)} hint="At least one track logged" />

      <StatTile
        label="Albums completed"
        value={formatCount(albumsCompleted)}
        // TEAL IS COMPLETION AND REPLAY, AND NOTHING ELSE. This is one of the two places on a
        // profile that earns it.
        tone="teal"
        /*
          THE SHARE IS OF `albumsStarted`, NOT OF ANYTHING ELSE, and it is rendered as text
          rather than as a `Meter` — the tile has no bar slot, and adding one here would be a
          third chart floor to keep in step with `Meter`'s 2% and `MonthlyBars`' 4%.

          An album with `track_count = 0` can never be "complete", which is why this share can
          sit well below 100% for somebody who has genuinely finished every record they own.
        */
        hint={
          albumsStarted > 0
            ? `${meterPercent(albumsCompleted, albumsStarted)}% of the albums started`
            : "Every track of a canonical release"
        }
      />

      <StatTile label="Artists" value={formatCount(artistsTouched)} hint="Anyone logged at any level" />

      <StatTile label="Ratings given" value={formatCount(ratingsGiven)} hint="Artists, albums and tracks" />

      <StatTile
        label="Average rating"
        // STARS, NOT `n / 10`. The figure and the glyphs are drawn from the same stored number.
        value={
          averageRating === null ? (
            // An em dash, not a zero: see the docblock. `formatRating(null)` returns exactly this.
            formatRating(null)
          ) : (
            <span className="inline-flex items-baseline gap-2">
              {formatRating(averageRating)}
              {/* `Stars` supplies its own `sr-only` sentence, so the colour and the glyphs are
                  never the only channel — and `label` is spelled out rather than left to the
                  default so it says whose average this is. */}
              <Stars
                value={averageRating}
                size="sm"
                label={`${formatRating(averageRating)} out of 5 stars on average`}
              />
            </span>
          )
        }
        tone="amber"
        hint={averageRating === null ? "No ratings yet" : `Across ${plural(ratingsGiven, "rating")}`}
      />

      <StatTile label="Reviews written" value={formatCount(reviewsWritten)} />

      <StatTile label="Diary entries" value={formatCount(diaryEntries)} hint="Logs carrying a listen date" />
    </section>
  );
}

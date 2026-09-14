/**
 * Dual rating — a verdict on the whole, beside the mean of the parts. PURE.
 *
 * The most valuable single transplant from the television original, and in music it applies
 * TWICE rather than once:
 *
 *   scope "album"  — the album verdict beside the mean of its rated tracks   (the default)
 *   scope "artist" — the artist verdict beside the mean of their rated albums (the career
 *                    statement, which has no clean television equivalent)
 *
 * The rationale transplants almost word for word, and it is worth keeping because it is what
 * stops somebody "fixing" the divergence:
 *
 *   An album rating is a judgement of the whole thing: how much they enjoyed it as a record,
 *   including its sequencing and how it closes. A track average is the mean of the tracks
 *   they actually rated. It answers a different question. They diverge for real reasons, and
 *   THE DIVERGENCE IS INTERESTING RATHER THAN AN ERROR: a record of consistently fine songs
 *   that fumbles its last three rates lower as a whole than its tracks average, and a patchy
 *   record with three transcendent songs often rates higher as a whole than its mean track.
 *
 * NOTE THE ASYMMETRY WITH TELEVISION, which is why the default scope flipped. A season is a
 * time slice of a continuing work, so the original defaults to scope="show". An ALBUM IS THE
 * PRIMARY WORK, so here the album is the default and the artist level is the optional extra.
 */

import { MAX_RATING, MIN_RATING } from "@/lib/ratings";

export type DualScope = "album" | "artist";

export type DualRating = {
  /** Their verdict on the whole work, stored 1..10. */
  wholeRating: number | null;
  /** Unweighted mean of the parts they rated, on the stored scale. */
  partAverage: number | null;
  partsRated: number;
  /** wholeRating - partAverage, signed, IN STORED UNITS. */
  divergence: number | null;
};

/**
 * Takes an ITERABLE, not an array, so callers can hand it `Map.values()` directly — which is
 * what the album page has, since viewer state arrives as a Map keyed by track locator.
 *
 * Out-of-range part ratings are SKIPPED rather than clamped, because a clamped bad value
 * still skews the mean while pretending to be data.
 */
export function dualRating(
  wholeRating: number | null | undefined,
  partRatings: Iterable<number | null | undefined>,
): DualRating {
  let sum = 0;
  let count = 0;
  for (const rating of partRatings) {
    if (rating === null || rating === undefined) continue;
    if (!Number.isFinite(rating) || rating < MIN_RATING || rating > MAX_RATING) continue;
    sum += rating;
    count += 1;
  }

  const whole = wholeRating ?? null;
  const partAverage = count === 0 ? null : sum / count;

  return {
    wholeRating: whole,
    partAverage,
    partsRated: count,
    divergence: whole !== null && partAverage !== null ? whole - partAverage : null,
  };
}

/**
 * The gate for saying anything at all.
 *
 * DIVERGENCE_MIN IS IN STORED UNITS. 1.5 stored units is THREE QUARTERS OF A STAR — this
 * comment exists purely to prevent it being read as one and a half stars, which is the
 * mistake the original's inline comment also guards against.
 *
 * PARTS_MIN is raised from the original's 3 to 4, because 3 of 12 tracks is a much lower bar
 * than 3 of 62 episodes: on a short album three rated parts is a quarter of the record and
 * the mean is still mostly noise.
 */
const DIVERGENCE_MIN = 1.5;
const PARTS_MIN = 4;

export function divergenceNote(dual: DualRating, scope: DualScope = "album"): string | null {
  if (dual.partsRated < PARTS_MIN) return null;
  if (dual.divergence === null || Math.abs(dual.divergence) < DIVERGENCE_MIN) return null;

  if (dual.divergence > 0) {
    // Verbatim reusable from the original — it says nothing about the domain.
    return "You rate the whole more highly than its parts.";
  }
  return scope === "album" ? "Strong tracks, weaker as an album." : "Strong albums, weaker as a body of work.";
}

/** "Derived from N tracks" — and the panel gives it NO CONTROL, so nobody looks for one. */
export function derivedFromLabel(dual: DualRating, scope: DualScope = "album"): string {
  const noun = scope === "album" ? "track" : "album";
  return `Derived from ${dual.partsRated} ${noun}${dual.partsRated === 1 ? "" : "s"}`;
}

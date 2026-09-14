/**
 * The rating scale, the histogram, and the colour system. PURE — no I/O, no React.
 *
 * This is the unit-tested layer, and it is tested heavily because everything downstream
 * depends on the scale being settled: the consensus card, both heatmaps, the recommender's
 * every constant, and the Desert Island entry condition all read numbers produced here.
 */

/* -------------------------------------------------------------------------- */
/* The scale                                                                  */
/* -------------------------------------------------------------------------- */

export const MIN_RATING = 1;
export const MAX_RATING = 10;

/**
 * Below this many member ratings the interface LEADS WITH the provider baseline and says so.
 * Transfers from the television original unchanged — the argument ("six ratings must not
 * borrow the authority of seventy") is about sample size, not about the domain.
 */
export const LOW_CONFIDENCE_THRESHOLD = 5;

/**
 * Branded scale types.
 *
 * Three different numbers flow through this codebase and the television original types all
 * three as `number`: stored units (1..10 integers, and float means on that scale), stars
 * (0.5..5), and provider scores. The brief notes the consequence plainly — "passing 4.5 where
 * 9 is expected renders a 2.25-star bar with no error" — and suggests branded types for a
 * rebuild.
 *
 * They are applied at the transform boundaries only, so the churn stays contained: functions
 * that produce a scale brand it, functions that consume one require it, and ordinary
 * arithmetic in between is left alone.
 */
export type Stored = number & { readonly __scale: "stored" };
export type Stars = number & { readonly __scale: "stars" };

export const asStored = (value: number): Stored => value as Stored;
export const asStars = (value: number): Stars => value as Stars;

/**
 * WHY INTEGERS: so histogram bucketing and equality comparisons never touch floating point.
 * A stored 7 is exactly 3.5 stars, `counts[rating - 1]` is an exact array index, and
 * `shown === halfValue` in the star input is a safe strict equality.
 *
 * THERE IS NO 0. Zero stars is unrepresentable; "no rating" is SQL NULL. starsToInt(0) and
 * starsToInt(-4) both return 1. ANY UI OFFERING "0 STARS" IS A BUG — clearing sends null.
 */
export function starsToInt(stars: number): Stored {
  return asStored(Math.min(MAX_RATING, Math.max(MIN_RATING, Math.round(stars * 2))));
}

export function intToStars(value: number): Stars {
  return asStars(value / 2);
}

/**
 * A critic score is ALREADY on the stored 0..10 scale when it reaches here — the MusicBrainz
 * 0..5 conversion happens once, in lib/providers/musicbrainz/mappers.ts, and never again.
 * This function is therefore identical in shape to intToStars and that is the point: the two
 * numbers can be handed to the same <Stars> component precisely because they share a scale.
 */
export function criticToStars(score: number): Stars {
  return asStars(Math.round((score / 2) * 10) / 10);
}

export function formatStars(stars: number): string {
  return Number.isInteger(stars) ? String(stars) : stars.toFixed(1);
}

export function formatRating(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : formatStars(intToStars(value));
}

/**
 * The community average, as a genuine weighted mean rather than SQL AVG.
 *
 * Returns NULL, NOT ZERO, for an empty set. A displayed 0 would be a measured verdict; null
 * renders as an em dash and the caller's "has ratings" branch stays honest.
 */
export function averageRating(buckets: Array<{ value: number; count: number }>): number | null {
  let weighted = 0;
  let total = 0;
  for (const bucket of buckets) {
    weighted += bucket.value * bucket.count;
    total += bucket.count;
  }
  return total === 0 ? null : weighted / total;
}

/* -------------------------------------------------------------------------- */
/* Histograms — always ten buckets                                            */
/* -------------------------------------------------------------------------- */

export type HistogramBucket = {
  /** Stored 1..10. */
  value: Stored;
  /** 0.5..5, for the label. */
  stars: Stars;
  count: number;
  /** Share of the TALLEST bucket, 0..1 — not share of the total. */
  ratio: number;
};

function buildHistogram(counts: number[]): HistogramBucket[] {
  // The `, 0` seed is load-bearing: Math.max(...[]) is -Infinity, which would make every
  // ratio NaN and render the chart as nothing at all.
  const peak = Math.max(...counts, 0);
  return counts.map((count, index) => {
    const value = asStored(index + 1);
    return { value, stars: intToStars(value), count, ratio: peak === 0 ? 0 : count / peak };
  });
}

/**
 * ALWAYS EXACTLY TEN BUCKETS, even for zero ratings, so the chart keeps a stable shape when a
 * record has only a handful — and so the silhouette of an album with twelve ratings stays
 * comparable to one with twelve thousand. Out-of-range values are dropped silently rather
 * than clamped into a neighbouring bucket.
 */
export function histogram(ratings: Array<number | null | undefined>): HistogramBucket[] {
  const counts = new Array<number>(10).fill(0);
  for (const rating of ratings) {
    if (rating === null || rating === undefined) continue;
    if (!Number.isInteger(rating) || rating < MIN_RATING || rating > MAX_RATING) continue;
    counts[rating - 1] += 1;
  }
  return buildHistogram(counts);
}

/** The same output from pre-grouped SQL rows. Assigns rather than increments. */
export function histogramFromCounts(rows: Array<{ rating: number | null; count: number }>): HistogramBucket[] {
  const counts = new Array<number>(10).fill(0);
  for (const row of rows) {
    const rating = row.rating;
    if (rating === null || !Number.isInteger(rating) || rating < MIN_RATING || rating > MAX_RATING) continue;
    counts[rating - 1] = row.count;
  }
  return buildHistogram(counts);
}

/* -------------------------------------------------------------------------- */
/* The seven-bracket colour scale — HUE, NOT LIGHTNESS                        */
/* -------------------------------------------------------------------------- */

/**
 * The single largest block of rationale in the subsystem, and it is worth preserving in full
 * because it is the reason the scale looks the way it does:
 *
 *   HUE, NOT LIGHTNESS. The first version of this was a single amber ramp, which meant a 6.2
 *   and an 8.4 were two barely different shades of the same colour and a heatmap of a long
 *   run read as one flat wash.
 *
 *   Note that the order is NOT A SIMPLE SPECTRUM: dark green ("Awesome") outranks bright
 *   green ("Great"), and blue sits above both. That is deliberate.
 *
 * The television original copies these bounds and hexes from seriesgraph so that a viewer who
 * has seen one of those grids already knows blue is the peak and purple is the floor. THAT
 * RECOGNISABILITY ARGUMENT DOES NOT TRANSFER TO MUSIC — nobody arrives here having read a
 * seriesgraph grid. They are kept anyway, for a different and better reason: the two
 * properties the regression tests enforce are that ADJACENT BRACKETS DIFFER IN HUE and that
 * SHADE VARIES WITHIN a bracket, and a palette that already satisfies both is worth more than
 * a novel one that might not.
 *
 * Only the top band is renamed, because it names a feature.
 */
export type BracketKey = "none" | "garbage" | "bad" | "average" | "good" | "great" | "awesome" | "desertIsland";

export type Bracket = {
  key: Exclude<BracketKey, "none">;
  label: string;
  /** Inclusive minimum on the stored 0..10 scale. */
  min: number;
  from: string;
  to: string;
};

export const BRACKETS: Bracket[] = [
  { key: "garbage", label: "Garbage", min: 0, from: "#5b3f8f", to: "#8a67cf" },
  { key: "bad", label: "Bad", min: 4, from: "#c22f22", to: "#ef4a35" },
  { key: "average", label: "Average", min: 5.5, from: "#d9791a", to: "#fba52a" },
  { key: "good", label: "Good", min: 6.5, from: "#dfbb1b", to: "#ffe155" },
  { key: "great", label: "Great", min: 7.5, from: "#249a45", to: "#48d76c" },
  { key: "awesome", label: "Awesome", min: 8.5, from: "#0f5c30", to: "#1c8a49" },
  /**
   * THE TOP BRACKET NAMES THE FEATURE, and the binding is deliberate: `--color-desert` in
   * globals.css is `#57a3ff`, which is exactly this band's `to` colour. Two literals in two
   * files with only a comment holding them together — change one and the Desert Island badge
   * silently stops matching the heatmap's peak.
   */
  { key: "desertIsland", label: "Desert Island", min: 9.25, from: "#2570e0", to: "#57a3ff" },
];

/**
 * Unrated is a CSS VARIABLE REFERENCE, NOT A HEX. Anything that parses the return value of
 * `ratingColor` must therefore never be handed a null score — and `ratingBracket(NaN)` is
 * "none", not "garbage", so a missing number cannot masquerade as a terrible one.
 */
export const UNRATED_COLOR = "var(--heat-none)";

function bracketFor(score: number): Bracket | null {
  if (!Number.isFinite(score)) return null;
  // Walks DOWNWARDS: the highest satisfied `min` wins.
  for (let index = BRACKETS.length - 1; index >= 0; index -= 1) {
    const bracket = BRACKETS[index];
    if (bracket && score >= bracket.min) return bracket;
  }
  return BRACKETS[0] ?? null;
}

export function ratingBracket(score: number | null | undefined): BracketKey {
  if (score === null || score === undefined) return "none";
  const bracket = bracketFor(score);
  return bracket ? bracket.key : "none";
}

export function bracketLabel(score: number | null | undefined): string {
  if (score === null || score === undefined) return "Not rated";
  return bracketFor(score)?.label ?? "Not rated";
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
}

/** A straight sRGB lerp. Not perceptually uniform, and it does not need to be. */
export function mix(from: string, to: string, position: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const t = clamp(position, 0, 1);
  return rgbToHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

/**
 * THE BRACKETS CARRY THE MEANING; THE GRADIENT CARRIES THE PRECISION.
 *
 * A 7.6 and an 8.4 are visibly distinguishable while both stay unmistakably "Great". The top
 * bracket's ceiling is 10 and the bottom's floor is 0, so both ends get the full gradient
 * rather than being stuck at one end of theirs.
 */
export function ratingColor(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return UNRATED_COLOR;
  const bracket = bracketFor(score);
  if (!bracket) return UNRATED_COLOR;
  const index = BRACKETS.indexOf(bracket);
  const ceiling = BRACKETS[index + 1]?.min ?? 10;
  const span = ceiling - bracket.min;
  const position = span <= 0 ? 1 : (Math.min(score, 10) - bracket.min) / span;
  return mix(bracket.from, bracket.to, clamp(position, 0, 1));
}

/**
 * Best first, and each swatch sampled at the MIDPOINT of its range — so a swatch is not the
 * shade that happens to sit right next to the neighbouring bracket, which made the legend
 * read as a continuous ramp rather than as seven named bands.
 */
export function bracketLegend(): Array<{ key: string; label: string; color: string }> {
  return [...BRACKETS].reverse().map((bracket) => {
    const index = BRACKETS.indexOf(bracket);
    const ceiling = BRACKETS[index + 1]?.min ?? 10;
    return {
      key: bracket.key,
      label: bracket.label,
      color: ratingColor((bracket.min + ceiling) / 2),
    };
  });
}

/** `progressPercent`'s replacement for the replay pillar: a bounded 0..100 for any meter. */
export function meterPercent(value: number, total: number): number {
  if (total <= 0) return 0;
  // Clamped so a mirror that lags behind the provider cannot report 104%.
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

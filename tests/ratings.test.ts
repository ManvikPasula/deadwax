import { describe, expect, it } from "vitest";

import {
  BRACKETS,
  LOW_CONFIDENCE_THRESHOLD,
  MAX_RATING,
  MIN_RATING,
  UNRATED_COLOR,
  averageRating,
  bracketLabel,
  bracketLegend,
  criticToStars,
  formatRating,
  formatStars,
  histogram,
  histogramFromCounts,
  intToStars,
  meterPercent,
  mix,
  ratingBracket,
  ratingColor,
  starsToInt,
} from "@/lib/ratings";
import { derivedFromLabel, divergenceNote, dualRating } from "@/lib/ratings/dual";
import { mapRating, mbRatingToStored } from "@/lib/providers/musicbrainz/mappers";

/**
 * Property tests, not snapshots. Every assertion here is a bound, a direction, or a monotonic
 * relationship, and several test names quote the exact production defect they lock out.
 */

function redChannel(hex: string): number {
  return Number.parseInt(hex.slice(1, 3), 16);
}

describe("the stored scale", () => {
  it("stores integers 1..10 and displays 0.5..5 stars", () => {
    expect(starsToInt(3.5)).toBe(7);
    expect(intToStars(7)).toBe(3.5);
    expect(intToStars(10)).toBe(5);
    expect(intToStars(1)).toBe(0.5);
  });

  it("has no zero: zero and negative stars both clamp to the minimum, because 'no rating' is NULL", () => {
    expect(starsToInt(0)).toBe(MIN_RATING);
    expect(starsToInt(-4)).toBe(MIN_RATING);
    expect(starsToInt(99)).toBe(MAX_RATING);
  });

  it("formats a null rating as an em dash rather than as a zero", () => {
    expect(formatRating(null)).toBe("—");
    expect(formatRating(undefined)).toBe("—");
    expect(formatRating(7)).toBe("3.5");
    expect(formatRating(10)).toBe("5");
  });

  it("formats whole stars without a decimal and halves with one", () => {
    expect(formatStars(4)).toBe("4");
    expect(formatStars(4.5)).toBe("4.5");
  });

  it("returns null, not zero, for an average over no ratings", () => {
    // A displayed 0 would be a measured verdict. Null renders as an em dash and the caller's
    // "has ratings" branch stays honest.
    expect(averageRating([])).toBeNull();
    expect(averageRating([{ value: 8, count: 0 }])).toBeNull();
  });

  it("computes a genuine weighted mean rather than a mean of bucket values", () => {
    // Two members at 10 and one at 4 is 8, not 7.
    expect(
      averageRating([
        { value: 10, count: 2 },
        { value: 4, count: 1 },
      ]),
    ).toBeCloseTo(8, 10);
  });
});

describe("the MusicBrainz scale bridge — the sharpest hazard in the port", () => {
  /**
   * MusicBrainz rates 0..5 while every member figure is on the stored 0..10 scale. The brief
   * calls this "the single sharpest hazard in the port" because passing 4.5 where 9 is
   * expected renders a 2.25-star bar with no error anywhere. These tests are the pin.
   */
  it("doubles a MusicBrainz value onto the stored scale", () => {
    expect(mbRatingToStored(4.5)).toBe(9);
    expect(mbRatingToStored(5)).toBe(10);
    expect(mbRatingToStored(2.5)).toBe(5);
    expect(mbRatingToStored(0)).toBe(0);
  });

  it("renders a critic score and a member average of the same stored number identically", () => {
    // This is the property that lets both be handed to the same <Stars> component. If it ever
    // fails, one of the two is being converted twice or not at all.
    const stored = mbRatingToStored(4.5);
    expect(criticToStars(stored)).toBe(intToStars(9));
  });

  it("reports NO SCORE rather than a measured zero when there are no votes", () => {
    // Storing 0 would paint an unrated release as the worst record ever made, put it at the
    // bottom of every sort, and colour its heatmap cell in the Garbage bracket.
    expect(mapRating({ value: 0, "votes-count": 0 })).toEqual({ score: null, votes: 0 });
    expect(mapRating(null)).toEqual({ score: null, votes: 0 });
    expect(mapRating({ value: 4.5, "votes-count": 72 })).toEqual({ score: 9, votes: 72 });
  });
});

describe("histograms", () => {
  it("always returns exactly ten buckets, even for no ratings", () => {
    // So the chart keeps a stable shape and the silhouette of an album with twelve ratings
    // stays comparable to one with twelve thousand.
    expect(histogram([]).length).toBe(10);
    expect(histogramFromCounts([]).length).toBe(10);
  });

  it("does not produce NaN ratios on an empty set (the Math.max(...counts, 0) seed)", () => {
    // Math.max(...[]) is -Infinity, which would make every ratio NaN and render the chart as
    // nothing at all.
    for (const bucket of histogram([])) expect(bucket.ratio).toBe(0);
  });

  it("expresses ratio as a share of the TALLEST bucket, not of the total", () => {
    const buckets = histogram([10, 10, 10, 8]);
    expect(buckets[9]?.count).toBe(3);
    expect(buckets[9]?.ratio).toBe(1);
    expect(buckets[7]?.ratio).toBeCloseTo(1 / 3, 10);
  });

  it("drops out-of-range values silently rather than clamping them into a neighbour", () => {
    const buckets = histogram([0, 11, -1, 5.5, null, undefined, 7]);
    const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    expect(total).toBe(1);
    expect(buckets[6]?.count).toBe(1);
  });

  it("assigns rather than increments when SQL has already grouped", () => {
    const buckets = histogramFromCounts([
      { rating: 9, count: 4 },
      { rating: 3, count: 1 },
    ]);
    expect(buckets[8]?.count).toBe(4);
    expect(buckets[2]?.count).toBe(1);
  });

  it("bucket counts sum to the rating count — the cross-check that bucketing loses nobody", () => {
    const ratings = [1, 3, 3, 7, 7, 7, 10];
    const sum = histogram(ratings).reduce((total, bucket) => total + bucket.count, 0);
    expect(sum).toBe(ratings.length);
  });
});

describe("the colour scale — hue, not lightness", () => {
  /**
   * THE ORIGINAL DEFECT, quoted from the brief: "The first version of this was a single amber
   * ramp, which meant a 6.2 and an 8.4 episode were two barely different shades of the same
   * colour and a heatmap of a long run read as one flat wash."
   *
   * Both tests below exist to stop that being reintroduced by somebody "simplifying" the
   * palette into a single ramp — which would still pass a naive "the colours differ" test.
   */
  it("changes HUE across a bracket boundary, not merely brightness", () => {
    const below = ratingColor(7.4); // Average/Good territory — warm
    const above = ratingColor(7.6); // Great — green
    expect(below).not.toBe(above);
    // The decisive assertion: the red channel FALLS as the score rises across this boundary.
    // A brightness ramp would raise every channel together.
    expect(redChannel(above)).toBeLessThan(redChannel(below));
  });

  it("varies shade WITHIN a bracket while the label stays the same", () => {
    // The brackets carry the meaning; the gradient carries the precision.
    expect(ratingColor(7.6)).not.toBe(ratingColor(8.4));
    expect(bracketLabel(7.6)).toBe("Great");
    expect(bracketLabel(8.4)).toBe("Great");
  });

  it("names the top bracket Desert Island, and binds it to the badge colour", () => {
    const top = BRACKETS[BRACKETS.length - 1]!;
    expect(top.key).toBe("desertIsland");
    expect(top.label).toBe("Desert Island");
    expect(top.min).toBe(9.25);
    // Two literals in two files with only a comment holding them together: this hex must equal
    // --color-desert in app/globals.css, or the honour silently stops matching the peak.
    expect(top.to).toBe("#57a3ff");
  });

  it("treats a missing score as unrated, not as terrible", () => {
    // ratingBracket(NaN) must not be "garbage": a missing number masquerading as a bad one is
    // how an unmirrored track gets painted as the worst on the record.
    expect(ratingBracket(null)).toBe("none");
    expect(ratingBracket(undefined)).toBe("none");
    expect(ratingBracket(Number.NaN)).toBe("none");
    expect(ratingColor(null)).toBe(UNRATED_COLOR);
    expect(ratingColor(Number.NaN)).toBe(UNRATED_COLOR);
  });

  it("returns a CSS variable reference for unrated, not a hex", () => {
    // Anything parsing the return value must therefore never be handed a null score.
    expect(UNRATED_COLOR.startsWith("var(")).toBe(true);
  });

  it("walks downwards so the highest satisfied minimum wins", () => {
    expect(ratingBracket(9.25)).toBe("desertIsland");
    expect(ratingBracket(9.24)).toBe("awesome");
    expect(ratingBracket(0)).toBe("garbage");
    expect(ratingBracket(10)).toBe("desertIsland");
  });

  it("gives both ends of the scale the full gradient", () => {
    // The top bracket's ceiling is 10 and the bottom's floor is 0, so neither end is stuck at
    // one end of its own gradient.
    expect(ratingColor(0)).toBe(BRACKETS[0]!.from);
    expect(ratingColor(10)).toBe(BRACKETS[BRACKETS.length - 1]!.to);
  });

  it("samples legend swatches at the MIDPOINT of each range, best first", () => {
    const legend = bracketLegend();
    expect(legend.length).toBe(BRACKETS.length);
    expect(legend[0]?.key).toBe("desertIsland");
    // A swatch sampled at the boundary would be the shade sitting next to the neighbouring
    // bracket, which made the legend read as a continuous ramp rather than seven named bands.
    expect(legend[legend.length - 1]?.color).not.toBe(BRACKETS[0]!.from);
  });

  it("mixes in sRGB and clamps the position", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", 2)).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", -1)).toBe("#000000");
  });

  it("is monotonically ordered by minimum, with the deliberate non-spectrum ordering intact", () => {
    for (let index = 1; index < BRACKETS.length; index += 1) {
      expect(BRACKETS[index]!.min).toBeGreaterThan(BRACKETS[index - 1]!.min);
    }
    // Dark green ("Awesome") outranks bright green ("Great"), and blue sits above both. That
    // is deliberate, and a "tidy the palette into a spectrum" change would break it.
    const keys = BRACKETS.map((bracket) => bracket.key);
    expect(keys.indexOf("awesome")).toBeGreaterThan(keys.indexOf("great"));
    expect(keys.indexOf("desertIsland")).toBeGreaterThan(keys.indexOf("awesome"));
  });
});

describe("dual rating — a verdict on the whole beside the mean of the parts", () => {
  it("accepts an Iterable so callers can hand it Map.values() directly", () => {
    const map = new Map([
      ["1:1", 9],
      ["1:2", 7],
    ]);
    expect(dualRating(8, map.values()).partsRated).toBe(2);
  });

  it("skips out-of-range parts rather than clamping them into the mean", () => {
    // A clamped bad value still skews the mean while pretending to be data.
    const dual = dualRating(8, [9, 7, 0, 11, null, undefined]);
    expect(dual.partsRated).toBe(2);
    expect(dual.partAverage).toBe(8);
  });

  it("reports divergence signed, in stored units", () => {
    const dual = dualRating(9, [6, 6, 6, 6]);
    expect(dual.divergence).toBe(3);
    const other = dualRating(6, [9, 9, 9, 9]);
    expect(other.divergence).toBe(-3);
  });

  it("says nothing at all when either gate fails", () => {
    // Both gates must pass: four rated parts AND at least 1.5 stored units of divergence.
    expect(divergenceNote(dualRating(9, [6, 6, 6]))).toBeNull(); // only three parts
    expect(divergenceNote(dualRating(8, [7.5 as number, 7, 7, 7]))).toBeNull(); // under 1.5
  });

  it("uses a 1.5 STORED UNIT gate, which is three quarters of a star and not one and a half", () => {
    // This test exists purely to pin the unit. Reading 1.5 as stars would make the note fire
    // roughly never.
    expect(divergenceNote(dualRating(9, [7.5 as number, 7.5 as number, 7.5 as number, 7.5 as number]))).toBe(
      "You rate the whole more highly than its parts.",
    );
  });

  it("uses album wording for an album scope and body-of-work wording for an artist scope", () => {
    const low = dualRating(6, [9, 9, 9, 9]);
    expect(divergenceNote(low, "album")).toBe("Strong tracks, weaker as an album.");
    expect(divergenceNote(low, "artist")).toBe("Strong albums, weaker as a body of work.");
  });

  it("labels the derived figure with its part count and the right noun", () => {
    expect(derivedFromLabel(dualRating(8, [7, 7]), "album")).toBe("Derived from 2 tracks");
    expect(derivedFromLabel(dualRating(8, [7]), "album")).toBe("Derived from 1 track");
    expect(derivedFromLabel(dualRating(8, [7, 7]), "artist")).toBe("Derived from 2 albums");
  });

  it("has no divergence when either side is missing", () => {
    expect(dualRating(null, [7, 8]).divergence).toBeNull();
    expect(dualRating(8, []).divergence).toBeNull();
  });
});

describe("meters", () => {
  it("cannot report over 100% when the mirror lags behind the provider", () => {
    expect(meterPercent(63, 62)).toBe(100);
    expect(meterPercent(-1, 62)).toBe(0);
    expect(meterPercent(5, 0)).toBe(0);
  });
});

describe("constants that other subsystems depend on", () => {
  it("keeps the low-confidence threshold at five member ratings", () => {
    // Below this the interface LEADS WITH the provider baseline and says so.
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(5);
  });
});

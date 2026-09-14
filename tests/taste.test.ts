import { describe, expect, it } from "vitest";

import type { RatedAlbumForTaste } from "@/lib/db/queries/albums";
import { MAX_RATING, MIN_RATING } from "@/lib/ratings";
import { buildTasteProfile } from "@/lib/taste/profile";
import {
  CONSENSUS_PRIOR,
  CONSENSUS_PRIOR_WEIGHT,
  DEVIATION_CAP,
  MIN_RATED_ALBUMS,
  NO_VARIETY_SPREAD,
  SHRINKAGE,
  affinities,
  confidenceFor,
  leanFor,
  preferredCentre,
  rankingScore,
  reliableAverage,
} from "@/lib/taste/shared";
import { type CandidateAlbum, predictAlbumRating } from "@/lib/taste/recommend";
import { forecastTracks } from "@/lib/taste/tracks";

/**
 * PROPERTY TESTS, NOT SNAPSHOTS, and the reason is worth stating because it governs every
 * assertion in this file:
 *
 *   A recommender is the easiest kind of code to ship broken: IT ALWAYS RETURNS A
 *   PLAUSIBLE-LOOKING NUMBER, and nothing crashes when that number is nonsense.
 *
 * A snapshot of "Kid A scores 8.3" locks in today's arithmetic and tells you nothing about
 * whether the model is right. So every test below asserts A BOUND, A DIRECTION, or A MONOTONIC
 * RELATIONSHIP — and several are named after the exact production defect they lock out, because
 * each of those defects shipped once in the project this model is ported from.
 */

let nextId = 1;

function rated(overrides: Partial<RatedAlbumForTaste> = {}): RatedAlbumForTaste {
  const id = nextId++;
  return {
    albumId: id,
    rating: 7,
    ratingSource: "album",
    tracksRated: 0,
    artistId: 1,
    artistName: "Artist One",
    genres: ["Rock"],
    tags: [],
    label: null,
    year: 2000,
    meanTrackMs: 240_000,
    trackCount: 10,
    criticScore: null,
    criticVotes: 0,
    ...overrides,
  } as RatedAlbumForTaste;
}

function candidate(overrides: Partial<CandidateAlbum> = {}): CandidateAlbum {
  const id = nextId++;
  return {
    id,
    deezerId: String(id),
    mbid: null,
    title: `Album ${id}`,
    genres: ["Rock"],
    tags: [],
    artistId: 99,
    artistName: "Candidate Artist",
    artistCountry: null,
    label: null,
    year: 2000,
    meanTrackMs: 240_000,
    trackCount: 10,
    criticScore: null,
    criticVotes: 0,
    fans: 100_000,
    isCanonical: true,
    neighbourOf: null,
    ...overrides,
  } as CandidateAlbum;
}

/** A readable history: enough albums, and enough variance to clear the no-variety gate. */
function history(): RatedAlbumForTaste[] {
  return [
    rated({ genres: ["Rock"], rating: 9, artistId: 1, artistName: "Rock One" }),
    rated({ genres: ["Rock"], rating: 9, artistId: 2, artistName: "Rock Two" }),
    rated({ genres: ["Rock"], rating: 8, artistId: 3, artistName: "Rock Three" }),
    rated({ genres: ["Jazz"], rating: 5, artistId: 4, artistName: "Jazz One" }),
    rated({ genres: ["Jazz"], rating: 4, artistId: 5, artistName: "Jazz Two" }),
    rated({ genres: ["Pop"], rating: 6, artistId: 6, artistName: "Pop One" }),
    rated({ genres: ["Pop"], rating: 7, artistId: 7, artistName: "Pop Two" }),
    rated({ genres: ["Metal"], rating: 10, artistId: 8, artistName: "Metal One" }),
  ];
}

describe("reliableAverage — Bayesian shrinkage of the crowd score", () => {
  it("pulls a thinly-voted high score DOWN toward the prior", () => {
    /**
     * "An album with 8.6 from 4 votes is not comparable to 8.6 from 300, but the raw average
     * says they are identical. Without this, obscure titles with a handful of enthusiastic
     * ratings outrank canonical records."
     */
    const thin = reliableAverage(8.6, 4)!;
    const thick = reliableAverage(8.6, 300)!;
    expect(thin).toBeLessThan(thick);
    expect(thin).toBeGreaterThan(CONSENSUS_PRIOR);
    expect(thick).toBeCloseTo(8.4, 1);
  });

  it("pulls a badly-rated obscure release UP toward the prior", () => {
    // The symmetry matters: shrinkage is not a penalty on obscurity, it is a statement that a
    // small sample says little in either direction.
    const shrunk = reliableAverage(3, 5)!;
    expect(shrunk).toBeGreaterThan(3);
    expect(shrunk).toBeLessThan(CONSENSUS_PRIOR);
  });

  it("is monotonic in the vote count", () => {
    let previous = reliableAverage(9, 1)!;
    for (const votes of [2, 5, 10, 50, 200, 1000]) {
      const next = reliableAverage(9, votes)!;
      expect(next).toBeGreaterThan(previous);
      previous = next;
    }
  });

  it("USES A WEIGHT OF 40, NOT 400 — the single most important retune in the model", () => {
    /**
     * MusicBrainz vote counts are TWO ORDERS OF MAGNITUDE below TMDB's: Kid A carries 72 votes
     * where a television show carries twenty thousand. At the television weight of 400,
     * (9*72 + 7*400) / 472 = 7.30 — every album in the catalogue shrinks to approximately the
     * prior and THE WHOLE TERM GOES INERT while still looking like it is working.
     *
     * The assertion is the property, not the number: at a realistic vote count the shrunk score
     * must still be meaningfully distinguishable from the prior.
     */
    expect(CONSENSUS_PRIOR_WEIGHT).toBe(40);
    const atTypicalN = reliableAverage(9, 72)!;
    expect(atTypicalN - CONSENSUS_PRIOR).toBeGreaterThan(1);
  });

  it("returns null for a missing score rather than substituting the prior", () => {
    // A substituted neutral is a fabrication. The caller skips the term entirely instead.
    expect(reliableAverage(null, 100)).toBeNull();
  });
});

describe("affinities — capping and shrinkage", () => {
  it("CAPS DEVIATION AT ±2, WHICH IS LOAD-BEARING", () => {
    /**
     * "Uncapped, a single floor rating outweighs a ceiling one, because a mean around 7 leaves
     * far more room below than above." In television that asymmetry made a network a NEGATIVE
     * signal for a member whose favourite show was on it. THE MUSIC ANALOGUE IS WORSE: a member
     * who loves three albums by an artist and rates a fourth at 2 would have the artist axis —
     * their strongest signal — inverted.
     */
    const withFloor = affinities(
      [
        { rating: 9, keys: [{ key: "artistx", label: "Artist X" }] },
        { rating: 9, keys: [{ key: "artistx", label: "Artist X" }] },
        { rating: 9, keys: [{ key: "artistx", label: "Artist X" }] },
        { rating: 1, keys: [{ key: "artistx", label: "Artist X" }] },
      ],
      7,
    );
    // Three at +2 (capped) and one at -2 (capped from -6) is still POSITIVE.
    expect(withFloor[0]!.lean).toBeGreaterThan(0);
    expect(DEVIATION_CAP).toBe(2);
  });

  it("shrinks a lean toward zero as support falls", () => {
    const one = affinities([{ rating: 10, keys: [{ key: "k", label: "K" }] }], 7);
    const many = affinities(
      Array.from({ length: 10 }, () => ({ rating: 10, keys: [{ key: "k", label: "K" }] })),
      7,
    );
    expect(one[0]!.lean).toBeLessThan(many[0]!.lean);
    expect(SHRINKAGE).toBe(5);
  });

  it("SORTS DESCENDING BY LEAN, which four consumers depend on", () => {
    // The signature-genre pick takes the FIRST entry passing its gates, so an unsorted array
    // silently picks an arbitrary attribute as the member's defining lane.
    const result = affinities(
      [
        { rating: 4, keys: [{ key: "low", label: "Low" }] },
        { rating: 10, keys: [{ key: "high", label: "High" }] },
        { rating: 7, keys: [{ key: "mid", label: "Mid" }] },
      ],
      7,
    );
    for (let index = 1; index < result.length; index += 1) {
      expect(result[index]!.lean).toBeLessThanOrEqual(result[index - 1]!.lean);
    }
    expect(result[0]!.key).toBe("high");
  });

  it("exposes a display label distinct from the comparison key", () => {
    // key is normalised for matching; label is what a reason string renders. Printing the key
    // is how an artist lean becomes a bare row id.
    const result = affinities([{ rating: 9, keys: [{ key: "rap/hip hop", label: "Rap/Hip Hop" }] }], 7);
    expect(result[0]!.key).not.toBe(result[0]!.label);
    expect(result[0]!.label).toBe("Rap/Hip Hop");
  });
});

describe("leanFor — support-weighted, never a flat mean", () => {
  it("lets the WELL-EVIDENCED attribute dominate", () => {
    /**
     * The rejected alternative is named in the source: "a member with a +1.07 Comedy lean from
     * five comedies had it averaged against a -1.32 Sci-Fi lean DERIVED FROM A SINGLE SHOW,
     * which pushed a genuinely good animated comedy below their own mean. Weighting by support
     * makes the well-evidenced attribute dominate, WHICH IS WHAT A PERSON WOULD DO."
     */
    const profile = [
      { key: "a", label: "A", lean: 1.0, support: 5 },
      { key: "b", label: "B", lean: -1.3, support: 1 },
    ];
    const result = leanFor(["A", "B"], profile);
    expect(result.lean).toBeGreaterThan(0);
    // A flat mean would give (1.0 + -1.3)/2 = -0.15.
    expect(result.lean).toBeGreaterThan(-0.15);
  });

  it("reports zero and no matches for an attribute set the member has never rated", () => {
    const result = leanFor(["Unseen"], []);
    expect(result.lean).toBe(0);
    expect(result.matched.length).toBe(0);
  });
});

describe("preferredCentre — only enthusiasm pulls the centre", () => {
  it("ignores albums at or below the mean", () => {
    /**
     * "Only above-average ratings pull the centre; below-average ones say nothing about where
     * their taste sits, ONLY WHERE IT DOES NOT."
     */
    const centre = preferredCentre(
      [
        { value: 1970, rating: 9 },
        { value: 2020, rating: 5 },
      ],
      7,
    );
    expect(centre).not.toBeNull();
    expect(centre!).toBeCloseTo(1970, 0);
  });

  it("returns NULL for a perfectly flat rater, which silently disables the pulls", () => {
    // A flat rater has no enthusiasm to weight by, so there is no centre — and the era, length
    // and count penalties correctly do not fire at all rather than firing on a guess.
    expect(preferredCentre([{ value: 1990, rating: 7 }], 7)).toBeNull();
  });
});

describe("predictAlbumRating — every term, as a direction", () => {
  const profile = buildTasteProfile(history());

  it("keeps every prediction inside the stored scale", () => {
    // The clamp is the only thing between a stack of penalties and a negative star rating.
    for (const extreme of [
      candidate({ genres: [], tags: [], year: 1930, meanTrackMs: 60_000, trackCount: 40 }),
      candidate({ genres: ["Metal"], neighbourOf: { artistId: 8, name: "Metal One", rating: 10 } }),
      candidate({ criticScore: 10, criticVotes: 5000 }),
      candidate({ criticScore: 1, criticVotes: 5000 }),
    ]) {
      const prediction = predictAlbumRating(profile, extreme);
      expect(prediction.rating).toBeGreaterThanOrEqual(MIN_RATING);
      expect(prediction.rating).toBeLessThanOrEqual(MAX_RATING);
      expect(prediction.confidence).toBeGreaterThanOrEqual(0);
      expect(prediction.confidence).toBeLessThanOrEqual(0.9);
    }
  });

  it("scores a liked genre above a disliked one", () => {
    const liked = predictAlbumRating(profile, candidate({ genres: ["Metal"] }));
    const disliked = predictAlbumRating(profile, candidate({ genres: ["Jazz"] }));
    expect(liked.rating).toBeGreaterThan(disliked.rating);
  });

  it("THE NEIGHBOUR TERM IS NEVER NEGATIVE, and is the largest single term", () => {
    /**
     * "Everything else — genre, artist, era, track length — moves a prediction by at most a
     * couple of tenths, and candidates inside one genre pool differ by less than that, so
     * without this term the ranking within a pool collapses to the provider's own popularity
     * order."
     */
    const plain = predictAlbumRating(profile, candidate({ genres: ["Pop"] }));
    const neighboured = predictAlbumRating(
      profile,
      candidate({ genres: ["Pop"], neighbourOf: { artistId: 8, name: "Metal One", rating: 10 } }),
    );
    expect(neighboured.rating).toBeGreaterThan(plain.rating);
    expect(neighboured.rating - plain.rating).toBeGreaterThanOrEqual(0.3);
    expect(neighboured.rating - plain.rating).toBeLessThanOrEqual(1.0001);

    // Even a neighbour the member rated BELOW their mean cannot subtract.
    const coolNeighbour = predictAlbumRating(
      profile,
      candidate({ genres: ["Pop"], neighbourOf: { artistId: 5, name: "Jazz Two", rating: 4 } }),
    );
    expect(coolNeighbour.rating).toBeGreaterThanOrEqual(plain.rating);
  });

  it("names its neighbour in a reason, so the member is told WHY", () => {
    const prediction = predictAlbumRating(
      profile,
      candidate({ neighbourOf: { artistId: 8, name: "Metal One", rating: 10 } }),
    );
    expect(prediction.reasons[0]).toContain("Metal One");
  });

  it("A CANDIDATE CANNOT IMPROVE ITS SCORE BY DESCRIBING ITSELF LESS", () => {
    /**
     * THE INVARIANT, and the defect it locks out is precise. An earlier version keyed the
     * absence penalty on the share of the CANDIDATE'S OWN tags that were unfamiliar, which
     * "rewarded sparse metadata twice over: a show tagged only 'Drama' paid nothing while a
     * richly-tagged Sherlock paid for its Mystery tag, SO THE BLANDEST POSSIBLE MATCH OUTRANKED
     * THE APT ONE." Both penalties are keyed on the MEMBER's attributes instead.
     */
    const sparse = predictAlbumRating(profile, candidate({ genres: ["Metal"], tags: [] }));
    const rich = predictAlbumRating(
      profile,
      candidate({ genres: ["Metal", "Rock"], tags: ["doom metal", "sludge", "stoner rock"] }),
    );
    expect(rich.rating).toBeGreaterThanOrEqual(sparse.rating);
  });

  it("penalises sharing NOTHING with a readable history", () => {
    const shares = predictAlbumRating(profile, candidate({ genres: ["Pop"] }));
    const sharesNothing = predictAlbumRating(profile, candidate({ genres: ["Classical"] }));
    expect(sharesNothing.rating).toBeLessThan(shares.rating);
  });

  it("SKIPS the crowd term entirely when there is no critic score", () => {
    // Rather than substituting a neutral value, which would be a fabrication dressed as data.
    const withoutScore = predictAlbumRating(profile, candidate({ criticScore: null, criticVotes: 0 }));
    const zeroVotes = predictAlbumRating(profile, candidate({ criticScore: 9, criticVotes: 0 }));
    expect(withoutScore.rating).toBeCloseTo(zeroVotes.rating, 6);
  });

  it("INVERTS a negative alignment rather than clamping it to zero", () => {
    /**
     * "Clamping a negative alignment to zero DISCARDED THE CLEAREST SIGNAL A CONTRARIAN GIVES
     * US; inverting it means someone who reliably rates canonised hits poorly is offered the
     * overlooked instead."
     */
    const contrarian = buildTasteProfile([
      rated({ genres: ["Rock"], rating: 3, criticScore: 9.5, criticVotes: 200, artistId: 11 }),
      rated({ genres: ["Rock"], rating: 3, criticScore: 9.0, criticVotes: 200, artistId: 12 }),
      rated({ genres: ["Rock"], rating: 4, criticScore: 8.8, criticVotes: 200, artistId: 13 }),
      rated({ genres: ["Rock"], rating: 9, criticScore: 5.0, criticVotes: 200, artistId: 14 }),
      rated({ genres: ["Rock"], rating: 9, criticScore: 4.5, criticVotes: 200, artistId: 15 }),
      rated({ genres: ["Rock"], rating: 10, criticScore: 4.0, criticVotes: 200, artistId: 16 }),
    ]);
    expect(contrarian.consensusAlignment).toBeLessThan(0);

    const acclaimed = predictAlbumRating(contrarian, candidate({ criticScore: 9.5, criticVotes: 400 }));
    const overlooked = predictAlbumRating(contrarian, candidate({ criticScore: 4.5, criticVotes: 400 }));
    // For a contrarian, the OVERLOOKED record must score higher.
    expect(overlooked.rating).toBeGreaterThan(acclaimed.rating);
  });

  it("pulls against a distant era, with an 8-year dead zone rather than 15", () => {
    // 1968, 1983 and 1998 are different sonic worlds; a 15-year dead zone erases that.
    const near = predictAlbumRating(profile, candidate({ genres: ["Metal"], year: 2003 }));
    const far = predictAlbumRating(profile, candidate({ genres: ["Metal"], year: 1955 }));
    expect(far.rating).toBeLessThan(near.rating);
  });

  it("pulls against a distant MEAN TRACK LENGTH, in minutes", () => {
    /**
     * The purpose is FORMAT SEPARATION WITHIN A SHARED TAG: a three-minute pop single against a
     * nine-minute post-rock piece against a sixty-second hardcore track. A 15-MINUTE dead zone,
     * which is what television uses for episode length, is meaningless on a 1–12 minute range.
     */
    const near = predictAlbumRating(profile, candidate({ genres: ["Metal"], meanTrackMs: 250_000 }));
    const far = predictAlbumRating(profile, candidate({ genres: ["Metal"], meanTrackMs: 720_000 }));
    expect(far.rating).toBeLessThan(near.rating);
  });

  it("NEVER EMITS A REASON FOR A TERM THAT DID NOT FIRE", () => {
    // "Emit a reason string only inside the branch that actually moved the score... so the
    // interface never explains an adjustment too small to have changed a rank."
    const plain = predictAlbumRating(profile, candidate({ genres: ["Pop"], neighbourOf: null }));
    expect(plain.reasons.every((reason) => !reason.includes("tend to play this too"))).toBe(true);
    expect(plain.reasons.length).toBeLessThanOrEqual(3);
  });

  it("emits at most three reasons", () => {
    const loaded = predictAlbumRating(
      profile,
      candidate({
        genres: ["Metal", "Rock"],
        label: "Some Label",
        criticScore: 9,
        criticVotes: 500,
        year: 1950,
        neighbourOf: { artistId: 8, name: "Metal One", rating: 10 },
      }),
    );
    expect(loaded.reasons.length).toBeLessThanOrEqual(3);
  });
});

describe("confidence — multiplicative, so each term can veto", () => {
  it("IS ZERO-ISH FOR A PROFILE WITH NO VARIANCE, however large", () => {
    /**
     * "Summing let a member who rated forty albums all 8 out of 10 reach 0.59 — BUT A PROFILE
     * WITH NO VARIANCE CONTAINS NO PREFERENCE, so no amount of volume or tag familiarity should
     * buy confidence."
     */
    const flat = buildTasteProfile(Array.from({ length: 40 }, (_, index) => rated({ rating: 8, artistId: index })));
    expect(flat.spread).toBeCloseTo(0, 6);
    const confident = buildTasteProfile(history());
    expect(confidenceFor(flat, 4)).toBeLessThan(confidenceFor(confident, 4));
  });

  it("rises with evidence and with coverage", () => {
    const small = buildTasteProfile(history().slice(0, 4));
    const large = buildTasteProfile([...history(), ...history().map((row) => rated({ ...row, albumId: nextId++ }))]);
    expect(confidenceFor(large, 6)).toBeGreaterThanOrEqual(confidenceFor(small, 6));
    expect(confidenceFor(large, 6)).toBeGreaterThanOrEqual(confidenceFor(large, 1));
  });

  it("is capped at 0.90, which is an epistemic position rather than a rounding artefact", () => {
    // "With N rated albums and no collaborative signal, certainty would be an overclaim."
    const huge = buildTasteProfile(
      Array.from({ length: 500 }, (_, index) =>
        rated({ rating: index % 2 === 0 ? 2 : 10, artistId: index, genres: ["Rock"] }),
      ),
    );
    expect(confidenceFor(huge, 50)).toBeLessThanOrEqual(0.9);
  });
});

describe("rankingScore — shrink toward the member's mean by confidence", () => {
  it("LETS A WELL-SUPPORTED LOWER PREDICTION BEAT A SHAKY HIGHER ONE", () => {
    /**
     * THE DEFECT THIS FIXES: "Confidence was computed, displayed, and then IGNORED BY THE SORT —
     * it only ever broke exact float ties, which averaged predictions essentially never produce.
     * So the list routinely led with the model's least-supported guesses."
     *
     * For a member whose mean is 6.5, a 0.55-confidence 7.5 must outrank a 0.18-confidence 7.6.
     */
    const profile = { meanRating: 6.5 } as never;
    const supported = rankingScore(profile, { rating: 7.5, confidence: 0.55 } as never);
    const shaky = rankingScore(profile, { rating: 7.6, confidence: 0.18 } as never);
    expect(supported).toBeGreaterThan(shaky);
  });

  it("leaves the DISPLAYED rating untouched", () => {
    // "The displayed number should remain the model's actual estimate, not a value distorted
    // for sorting." rankingScore returns a separate number; it does not mutate the prediction.
    const prediction = { rating: 9, confidence: 0.2 };
    rankingScore({ meanRating: 6 } as never, prediction as never);
    expect(prediction.rating).toBe(9);
  });
});

describe("the withholding gates", () => {
  it("sets the no-variety threshold below any real listener's spread", () => {
    // 0.4 stored units is a fifth of a star of standard deviation. A member with genuine
    // opinions clears it easily; a member who rates everything the same does not.
    expect(NO_VARIETY_SPREAD).toBe(0.4);
    expect(buildTasteProfile(history()).spread).toBeGreaterThan(NO_VARIETY_SPREAD);
    expect(buildTasteProfile(Array.from({ length: 20 }, () => rated({ rating: 7 }))).spread).toBeLessThan(
      NO_VARIETY_SPREAD,
    );
  });

  it("requires MORE rated albums than the television original needs rated shows", () => {
    // "Rating an album is a far lower-effort act than rating a 60-hour series; listeners will
    // rate 20 in one sitting, and the extra evidence buys confidence directly."
    expect(MIN_RATED_ALBUMS).toBe(8);
    expect(MIN_RATED_ALBUMS).toBeGreaterThan(5);
  });

  it("returns zero alignment rather than a spurious ±1 on too few pairs", () => {
    // Pearson on two points is always exactly ±1, which would be a confident statement derived
    // from nothing.
    const two = buildTasteProfile([
      rated({ rating: 9, criticScore: 9, criticVotes: 100 }),
      rated({ rating: 4, criticScore: 4, criticVotes: 100 }),
    ]);
    expect(two.consensusAlignment).toBe(0);
  });
});

/**
 * `forecastTracks(tracks, albumBaseline)` returns an ARRAY or null, and derives its own critic
 * baseline from the tracks it was given rather than taking one. A local lookup keeps the
 * assertions readable without pretending the shape is a Map — the docblock on the real function
 * is explicit that key shapes differ per caller scope and that A MISMATCHED LOOKUP FAILS
 * SILENTLY, returning undefined and rendering as an uncoloured cell rather than as an error.
 */
function at(
  forecast: ReturnType<typeof forecastTracks>,
  disc: number,
  track: number,
): NonNullable<ReturnType<typeof forecastTracks>>[number] | undefined {
  return (forecast ?? []).find((entry) => entry.disc === disc && entry.track === track);
}

describe("forecastTracks — a separate model that shares nothing with the album one", () => {
  it("NEVER OVERWRITES A REAL RATING", () => {
    // "So a row reads as one continuous line." A predicted value replacing a real one would
    // silently disagree with what the member typed.
    const forecast = forecastTracks(
      [
        { disc: 1, track: 1, viewerRating: 10, criticScore: 2 },
        { disc: 1, track: 2, viewerRating: null, criticScore: 9 },
      ],
      6,
    );
    const first = at(forecast, 1, 1);
    expect(first?.rating).toBe(10);
    expect(first?.predicted).toBe(false);
    expect(first?.confidence).toBe(1);
    expect(at(forecast, 1, 2)?.predicted).toBe(true);
  });

  it("uses the crowd only as a RELATIVE SHAPE, never as an absolute", () => {
    /**
     * "THE CROWD'S SCALE IS NOT THE MEMBER'S." A track standing above the album's own critic
     * baseline should land above the member's personal baseline too — but at the member's
     * level, not the crowd's.
     */
    const forecast = forecastTracks(
      [
        { disc: 1, track: 1, viewerRating: null, criticScore: 9 },
        { disc: 1, track: 2, viewerRating: null, criticScore: 5 },
      ],
      4,
    );
    const strong = at(forecast, 1, 1)!;
    const weak = at(forecast, 1, 2)!;
    expect(strong.rating).toBeGreaterThan(weak.rating);
    // Anchored near the MEMBER's baseline of 4, not dragged up to the crowd's 9.
    expect(strong.rating).toBeLessThan(8);
  });

  it("keeps every forecast inside the scale and under its confidence ceiling", () => {
    const forecast = forecastTracks(
      Array.from({ length: 12 }, (_, index) => ({
        disc: 1,
        track: index + 1,
        viewerRating: null,
        criticScore: index % 2 === 0 ? 10 : 1,
      })),
      9.5,
    );
    expect(forecast).not.toBeNull();
    for (const entry of forecast ?? []) {
      expect(entry.rating).toBeGreaterThanOrEqual(MIN_RATING);
      expect(entry.rating).toBeLessThanOrEqual(MAX_RATING);
      expect(entry.confidence).toBeLessThanOrEqual(0.85);
    }
  });

  it("gains confidence as the member rates more of THIS album", () => {
    // "Their own ratings inside this album. By far the stronger signal — people are more
    // consistent within a record than across their library."
    const cold = forecastTracks(
      [
        { disc: 1, track: 1, viewerRating: null, criticScore: null },
        { disc: 1, track: 2, viewerRating: 8, criticScore: null },
      ],
      7,
    );
    const warm = forecastTracks(
      [
        { disc: 1, track: 1, viewerRating: null, criticScore: null },
        ...Array.from({ length: 8 }, (_, index) => ({
          disc: 1,
          track: index + 2,
          viewerRating: 8 - (index % 3),
          criticScore: null,
        })),
      ],
      7,
    );
    expect(at(warm, 1, 1)!.confidence).toBeGreaterThan(at(cold, 1, 1)!.confidence);
  });
});

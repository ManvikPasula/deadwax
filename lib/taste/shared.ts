/**
 * The taste model's shared arithmetic. PURE — no I/O, no React, no database.
 *
 * ALL ARITHMETIC IN THIS SUBSYSTEM IS IN STORED UNITS: 1 UNIT = HALF A STAR. Every constant
 * below — the ±2 deviation cap, the 0.8 absence penalty, the 0.25 country penalty, the 0.4
 * spread gate, the 0.3..1.0 neighbour term, the 0.3/0.4/0.5 reason thresholds, the prior of 7 —
 * lives on that one scale. The source brief's warning is taken literally: **rescale all of
 * them together or the model becomes inert or unhinged.** A single constant re-read as stars
 * is a factor-of-two error that produces plausible numbers and no exception.
 *
 * WHY THIS FILE IS SEPARATE FROM `profile.ts` AND `recommend.ts`: four consumers need these
 * functions (the profile builder, the album scorer, the retrieval seeds and the /for-you
 * footer), and a recommender is the easiest kind of code to ship broken — *it always returns a
 * plausible-looking number, and nothing crashes when that number is nonsense.* Keeping the
 * arithmetic here, with no imports that touch a network or a database, is what lets every one
 * of these be tested as a bound, a direction or a monotonic relationship rather than a
 * snapshot.
 *
 * THE STATED CEILING OF THE WHOLE MODEL, recorded once so that nobody spends tuning effort
 * re-deriving it: Deezer's 28 coarse genres cannot separate a doom metal record from a power
 * metal one, and MusicBrainz tags are present for popular releases and absent for the long
 * tail — so the model is sharpest exactly where it is least needed. Fixing that needs an
 * audio-feature or co-listen embedding, NOT another coefficient. Do not re-derive this.
 */

import { MAX_RATING, MIN_RATING } from "@/lib/ratings";

/* ========================================================================== *
 * CONSTANTS — every one with its rejected alternative
 * ========================================================================== */

/**
 * THE SINGLE MOST IMPORTANT RETUNE IN THE PORT, and the one most likely to be "corrected"
 * back by somebody reading the television original.
 *
 * The prior is the middle of the same stored 0..10 scale, so 7 stands unchanged. The WEIGHT is
 * 40, not the original's 400, because MusicBrainz vote counts are TWO ORDERS OF MAGNITUDE
 * BELOW TMDB'S — Kid A carries 72 votes where a TMDB show carries 20,000.
 *
 * Worked, so the two candidates are side by side:
 *
 *   weight 400 : (9 * 72 + 7 * 400) / (72 + 400) = 3448 / 472 = 7.30
 *   weight  40 : (9 * 72 + 7 *  40) / (72 +  40) =  928 / 112 = 8.29
 *
 * At 400 every album in the catalogue shrinks to approximately the prior and the crowd term
 * goes INERT — it contributes a near-constant offset to every candidate and therefore reorders
 * nothing. At 40 the shrink still bites where it is supposed to: a 4-vote 9.0 gives
 * (36 + 280) / 44 = 7.18, well below the 72-vote 9.0's 8.29, which is the entire purpose of
 * the term.
 */
export const CONSENSUS_PRIOR = 7;
export const CONSENSUS_PRIOR_WEIGHT = 40;

/**
 * Support shrinkage on an attribute lean. Raised from the original's 3.
 *
 * MusicBrainz tag vocabularies are noisy — 60+ tags observed on one album, many with
 * `count: 1`. Tags are already pre-filtered to `count >= 2` at the mapper, and this is the
 * second half of the same defence: at 5, one rating shrinks a lean by 1/6, two by 2/7, five by
 * 1/2 and ten by 2/3. At 3 a single noisy tag kept two thirds of its apparent lean.
 */
export const SHRINKAGE = 5;

/**
 * THE ±2 DEVIATION CAP IS LOAD-BEARING, and it matters MORE in music than in television.
 *
 * Uncapped, a single floor rating outweighs a ceiling one, because a mean around 7 leaves far
 * more room below (6 units) than above (3 units). In the television original that asymmetry
 * made AMC a NEGATIVE signal for a Breaking Bad fan who had also rated The Walking Dead at the
 * bottom, and then docked Better Call Saul — its direct spin-off — for sharing the network.
 *
 * The music analogue is worse, because the artist axis is the member's STRONGEST signal rather
 * than a weak third one: a member who loves three Kanye albums and rates Donda 2 a 2 would
 * have the whole artist axis inverted by one row.
 */
export const DEVIATION_CAP = 2;

/**
 * Coverage saturates at six recognised attributes TOTAL, mixing all three axes in one
 * denominator. Raised from the original's 4.
 *
 * Deezer album genres are coarse (1–3 per album from a 28-entry vocabulary) but MusicBrainz
 * tags are fine, so the two together routinely reach 8+ on a well-known record. 6 saturates on
 * a well-described album without saturating on everything, which 4 did.
 *
 * Without coverage at all, an album carrying the single tag "Rock" takes a member's full Rock
 * lean and is scored as though it were purely and definitively that.
 */
export const COVERAGE_DENOMINATOR = 6;

/**
 * The RECOMMENDATION floor. Raised from the original's 5.
 *
 * Rating an album is a far lower-effort act than rating a 60-hour series — listeners rate 20
 * in a sitting — so the extra evidence is cheap to ask for and buys confidence directly.
 */
export const MIN_RATED_ALBUMS = 8;

/**
 * The PROFILE READABILITY floor — a different question from the recommendation floor, and
 * documented as such rather than being an accident.
 *
 * The television original used 3 for the home genre rails and the ad-affinity bonus while
 * /for-you used 5, so a member with 4 ratings saw personalised rails and personalised ads
 * while being told they had "not enough to go on". Here the two questions are named: 5 is
 * "can we read anything at all from this profile", 8 is "can we rank a catalogue with it".
 */
export const PROFILE_READABLE_MIN = 5;

/**
 * The evidence denominator for the two absence penalties: `min(1, sampleSize / 8)`.
 *
 * IT EQUALS `MIN_RATED_ALBUMS` BY COINCIDENCE OF PURPOSE, NOT BY DEPENDENCE, and the
 * consequence is worth knowing before anybody changes either: because the recommendation floor
 * rose from 5 to 8 while this denominator stayed at 8, `evidence` is ALWAYS EXACTLY 1 inside
 * /for-you. The term only varies for callers below the recommendation floor — the ad-affinity
 * and genre-rail paths, which read a profile from 5 ratings upward. Lowering
 * `MIN_RATED_ALBUMS` would bring the ramp back; raising this would flatten the penalties for
 * everybody.
 */
export const EVIDENCE_SATURATION = 8;

/**
 * The no-variety gate. Unchanged from the original — sample SD in stored units, so 0.4 is a
 * fifth of a star.
 *
 * Checked BEFORE ANY PROVIDER CALL: ten indistinguishable predictions dressed as a ranked list
 * is worse than saying there is nothing to say yet, and it is also worse than spending
 * thirty outbound requests to produce them.
 */
export const NO_VARIETY_SPREAD = 0.4;

/**
 * THREE AXES, NOT TWO. Artist REPLACES network rather than joining it.
 *
 * A show is not made repeatedly by one named person; an artist makes albums. "The artist as a
 * repeated author" is a product pillar music has and television does not, so it earns a
 * first-class axis. Labels are taken as a weak THIRD axis because Deezer returns `label` as
 * free text with wild variation ("Daft Life Ltd./ADA France" observed) — it survives only
 * normalisation at ingest, so it is weighted where a partly-unreliable signal belongs.
 */
export const GENRE_WEIGHT = 0.55;
export const ARTIST_WEIGHT = 0.3;
export const LABEL_WEIGHT = 0.15;

/** Confidence is capped here as an epistemic position, not as a numerical safeguard. */
export const CONFIDENCE_CEILING = 0.9;

/**
 * The notability floor, replacing the original's `MIN_NOTABILITY_VOTES = 150`.
 *
 * **NOT A QUALITY BAR — A NOTABILITY ONE.** Below it, a crowd average is noise. MusicBrainz
 * vote counts are far too sparse to play this role (most albums have none at all), so the
 * floor moves to Deezer album `fans`, which is dense and is a cumulative favourite count
 * rather than a streaming counter. `fans` IS POPULARITY AND IS NEVER RENDERED AS A RATING; it
 * is used here, for retrieval and for tie-breaking, and nowhere else.
 */
export const MIN_NOTABILITY_FANS = 5000;

/**
 * 8, AND SEQUENTIAL. The original syncs 18 in parallel.
 *
 * 18 parallel `ensureAlbum` calls would violate the outbound budget outright — each one is a
 * Deezer detail call plus a tracklist call plus an optional MusicBrainz lookup, and
 * MusicBrainz answers roughly one request per second. Serialised, and lower, because the
 * cached `artist_similar` table removes most of the reason the original needed a wide sync.
 */
export const DETAIL_SYNC_LIMIT = 8;

/* ========================================================================== *
 * Small numeric helpers
 * ========================================================================== */

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Clamps a prediction onto the stored 1..10 scale.
 *
 * A non-finite prediction is a BUG, not a data state — every term in the formula is guarded
 * against null and the only divisions are guarded against zero. It floors rather than throwing
 * so that the one broken row sorts to the bottom of a list instead of taking down a page that
 * had nine good rows on it.
 */
export function clampRating(value: number): number {
  if (!Number.isFinite(value)) return MIN_RATING;
  return clamp(value, MIN_RATING, MAX_RATING);
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * SAMPLE standard deviation, n−1 denominator, and 0 for fewer than two values.
 *
 * The n−1 denominator is not pedantry here: this number is the *discrimination* term in
 * confidence and the *no-variety* gate, both of which ask "has this member said anything
 * distinguishing", and the population formula reports a spread that is systematically too
 * small on the handful of ratings those gates exist to judge.
 */
export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  let total = 0;
  for (const value of values) total += (value - average) ** 2;
  return Math.sqrt(total / (values.length - 1));
}

/**
 * Pearson correlation, returning **0** rather than ±1 for fewer than three pairs or for zero
 * variance on either side.
 *
 * That guard is the whole reason this is not inlined. Two pairs are perfectly correlated by
 * construction, and a member who happened to rate three albums 8 has zero variance — both
 * cases produce a spurious ±1 that then SIGNS the crowd term, which is how a member with no
 * measurable relationship to the consensus gets offered the catalogue in reverse.
 */
export function pearson(pairs: Array<readonly [number, number]>): number {
  if (pairs.length < 3) return 0;

  const count = pairs.length;
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of pairs) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / count;
  const meanY = sumY / count;

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  if (varianceX === 0 || varianceY === 0) return 0;

  const r = covariance / Math.sqrt(varianceX * varianceY);
  return Number.isFinite(r) ? clamp(r, -1, 1) : 0;
}

/* ========================================================================== *
 * reliableAverage — Bayesian shrinkage of the crowd score
 * ========================================================================== */

/**
 * An album with 8.6 from 4 votes is not comparable to 8.6 from 300, but the raw average says
 * they are identical. Without this, obscure titles with a handful of enthusiastic ratings
 * outrank canonical records.
 *
 * Worked values, pinned by test:
 *
 *   (8.6,   4) -> 7.15   a handful of enthusiasts, pulled DOWN hard
 *   (8.6, 300) -> 8.41   a real consensus, barely moved
 *   (3,     5) -> 6.56   a badly-rated obscure release is pulled UP toward the prior
 *   (9,    72) -> 8.29   Kid A, the album that set the weight
 *
 * RETURNS NULL FOR A NULL AVERAGE, never the prior. `albums.critic_score` is NULL when no
 * MusicBrainz rating exists and is never 0, and substituting the prior for an absent score
 * would silently give every unrated album a measured-looking 7 — a fabrication that then
 * competes with real scores in the same term.
 *
 * APPLIED IN EXACTLY THREE PLACES — `crowdBaseline`, `consensusAlignment` and the crowd term
 * in `predictAlbumRating` — AND ALWAYS THIS SAME TRANSFORM, so that the correlation
 * coefficient and the quantity it multiplies come from the same distribution. Correlating raw
 * averages and then weighting shrunk ones is the version of this that looks right and is not.
 */
export function reliableAverage(average: number | null | undefined, votes: number | null | undefined): number | null {
  if (average === null || average === undefined || !Number.isFinite(average)) return null;
  const count = Math.max(0, Number.isFinite(votes ?? 0) ? (votes ?? 0) : 0);
  return (average * count + CONSENSUS_PRIOR * CONSENSUS_PRIOR_WEIGHT) / (count + CONSENSUS_PRIOR_WEIGHT);
}

/* ========================================================================== *
 * Attribute affinities — leans with deviation capping and support shrinkage
 * ========================================================================== */

/**
 * An attribute as the model sees it: a normalised matching key and the display form.
 *
 * THE TWO ARE SEPARATE BECAUSE MATCHING AND SPEAKING ARE DIFFERENT JOBS. Deezer returns the
 * genre "Rock" while MusicBrainz returns the tag "rock", and a case-sensitive match treats
 * them as two attributes with half the support each. But the reason string has to say
 * "Rock", not "rock", so the first-seen display form is carried alongside.
 */
export type AttributeRef = { key: string; label: string };

/** Normalisation for matching only. Never render this. */
export function attributeKey(value: string): string {
  return value.trim().toLowerCase();
}

/** Builds an `AttributeRef` from a raw provider string, or null when there is nothing left. */
export function attributeRef(value: string | null | undefined): AttributeRef | null {
  if (!value) return null;
  const label = value.trim();
  if (label.length === 0) return null;
  return { key: attributeKey(label), label };
}

export type Affinity = {
  /** Normalised. Compare on this. */
  key: string;
  /** First-seen display form. Render this. */
  label: string;
  /** Mean capped deviation from the member's own mean, shrunk by support. Stored units. */
  lean: number;
  /** How many rated albums carried this attribute. */
  support: number;
};

/** One rated album as `affinities()` needs it: its rating and its keys on ONE axis. */
export type AffinityRow = { rating: number; keys: AttributeRef[] };

/**
 * Leans with deviation capping and support shrinkage.
 *
 *   for each rated album, for each key:  push(clamp(rating - meanRating, -2, +2))
 *   raw     = mean(deviations)
 *   lean    = raw * (n / (n + SHRINKAGE))
 *   support = n
 *   sort DESCENDING BY LEAN
 *
 * **THE DESCENDING-LEAN SORT IS DEPENDED ON BY FOUR CONSUMERS AND IS NOT OBVIOUSLY SO**: the
 * signature-genre pick in the absence penalty takes the *first* entry passing its gates, the
 * genre reason string reads `matched[0]`, the retrieval seeds assume the strong end leads, and
 * the profile's "disliked genres" panel slices the ASCENDING end (which is only the weak end
 * because of this sort — the television original sliced the descending end and displayed the
 * three least *disliked* genres under a "disliked" heading).
 *
 * TIES ARE BROKEN EXPLICITLY, on support then key. `Array.prototype.sort` is stable, but the
 * input order here is Map insertion order and therefore depends on which album was read first
 * — so without an explicit tiebreak the signature genre could change between two renders over
 * identical data, and the evaluation harness's output would not reproduce.
 *
 * CALLERS MUST DEDUPE KEYS WITHIN ONE ALBUM. `profile.ts` does it by building each row's keys
 * through a Map; without that, an album whose genres and tags both say "rock" pushes two
 * deviations and reports support 2 from one record.
 */
export function affinities(rows: AffinityRow[], meanRating: number): Affinity[] {
  const buckets = new Map<string, { label: string; deviations: number[] }>();

  for (const row of rows) {
    const deviation = clamp(row.rating - meanRating, -DEVIATION_CAP, DEVIATION_CAP);
    for (const ref of row.keys) {
      const bucket = buckets.get(ref.key);
      if (bucket) bucket.deviations.push(deviation);
      else buckets.set(ref.key, { label: ref.label, deviations: [deviation] });
    }
  }

  const result: Affinity[] = [];
  for (const [key, bucket] of buckets) {
    const support = bucket.deviations.length;
    result.push({
      key,
      label: bucket.label,
      lean: mean(bucket.deviations) * (support / (support + SHRINKAGE)),
      support,
    });
  }

  result.sort((left, right) => right.lean - left.lean || right.support - left.support || left.key.localeCompare(right.key));
  return result;
}

/**
 * Combines affinity lists from different axes into one lookup table, re-sorted descending.
 *
 * Used for the genre axis, which scores Deezer's coarse genres and MusicBrainz's fine tags
 * together. The combine rule is the SAME support-weighting `leanFor` uses, so a key that
 * appears in both lists lands where its combined evidence puts it rather than where the first
 * list happened to put it.
 *
 * REJECTED ALTERNATIVE, and it is why `profile.ts` keeps the two lists disjoint: merging after
 * the fact double-counts an album that carries both the Deezer genre "Rock" and the
 * MusicBrainz tag "rock", reporting support 2 from one record and giving that key twice the
 * weight it earned in `leanFor`. `buildTasteProfile` therefore drops a tag whose key already
 * appears in that album's coarse genres, so the two lists never overlap per album and this
 * merge is exact.
 */
export function mergeAffinities(...lists: Affinity[][]): Affinity[] {
  const buckets = new Map<string, { label: string; weighted: number; support: number }>();

  for (const list of lists) {
    for (const entry of list) {
      const bucket = buckets.get(entry.key);
      if (bucket) {
        bucket.weighted += entry.lean * entry.support;
        bucket.support += entry.support;
      } else {
        buckets.set(entry.key, { label: entry.label, weighted: entry.lean * entry.support, support: entry.support });
      }
    }
  }

  const result: Affinity[] = [];
  for (const [key, bucket] of buckets) {
    result.push({
      key,
      label: bucket.label,
      lean: bucket.support === 0 ? 0 : bucket.weighted / bucket.support,
      support: bucket.support,
    });
  }

  result.sort((left, right) => right.lean - left.lean || right.support - left.support || left.key.localeCompare(right.key));
  return result;
}

export type LeanResult = {
  /** Support-weighted mean lean across the matched entries. 0 when nothing matched. */
  lean: number;
  /** The matched entries, IN THE TABLE'S DESCENDING-LEAN ORDER. `matched[0]` is the strongest. */
  matched: Affinity[];
};

/**
 * SUPPORT-WEIGHTED, NOT A FLAT AVERAGE — and the rejected alternative is named because it
 * shipped:
 *
 *   lean = Σ(entry.lean × entry.support) / Σ entry.support
 *
 * A flat mean averaged a +1.07 lean derived from five records against a −1.32 lean derived
 * from a single record, which pushed a genuinely good candidate below the member's own mean.
 * Weighting by support makes the well-evidenced attribute dominate, which is what a person
 * would do.
 *
 * IT WALKS THE TABLE, NOT THE VALUES. That is O(table) rather than O(values) — the tables here
 * are tens to low hundreds of entries, so the cost is irrelevant — and it buys two properties
 * that the other direction has to remember to implement: `matched` comes out in the table's
 * descending-lean order, and a candidate that names the same attribute twice ("Rock" from
 * Deezer, "rock" from MusicBrainz) matches it once.
 */
export function leanFor(values: Array<string | null | undefined>, table: Affinity[]): LeanResult {
  const wanted = new Set<string>();
  for (const value of values) {
    const ref = attributeRef(value);
    if (ref) wanted.add(ref.key);
  }
  if (wanted.size === 0 || table.length === 0) return { lean: 0, matched: [] };

  const matched: Affinity[] = [];
  let weighted = 0;
  let support = 0;
  for (const entry of table) {
    if (!wanted.has(entry.key)) continue;
    matched.push(entry);
    weighted += entry.lean * entry.support;
    support += entry.support;
  }

  return { lean: support === 0 ? 0 : weighted / support, matched };
}

/* ========================================================================== *
 * preferredCentre — only enthusiasm pulls the centre
 * ========================================================================== */

/**
 * The weighted centre of a numeric attribute (release year, mean track minutes, track count)
 * over the albums the member rated ABOVE their own mean.
 *
 *   w = Math.max(0, rating - meanRating);   // albums at or below the mean contribute nothing
 *
 * Only above-average ratings pull the centre; below-average ones say nothing about where their
 * taste sits, only where it does not. A record they hated in 1974 does not mean they dislike
 * 1974 — it means they disliked that record.
 *
 * RETURNS NULL WHEN NO ALBUM BEAT THE MEAN, which is the honest answer and has a real
 * consequence: a perfectly flat rater gets `null` for all three centres, and the era, track
 * length and track count penalties SILENTLY DISABLE THEMSELVES. That is correct — a centre
 * invented for them would be a measurement of nothing — and it is the reason the no-variety
 * gate exists as a separate, explicit refusal rather than as a quiet degradation.
 */
export function preferredCentre(rows: Array<{ rating: number; value: number | null }>, meanRating: number): number | null {
  let weighted = 0;
  let weight = 0;
  for (const row of rows) {
    if (row.value === null || !Number.isFinite(row.value)) continue;
    const w = Math.max(0, row.rating - meanRating);
    if (w === 0) continue;
    weighted += row.value * w;
    weight += w;
  }
  return weight === 0 ? null : weighted / weight;
}

/* ========================================================================== *
 * The profile shape, and confidence
 * ========================================================================== */

/**
 * Everything the scorer is allowed to know about a member.
 *
 * NOTE ON THE FIELD COUNT: `docs/ARCHITECTURE.md` §6.3 is headed "twelve fields" while its own
 * table enumerates fourteen (the original's eleven, plus `tags`, `labels` and
 * `trackCountCentre`, with `artists` replacing `networks`). The table wins, because every
 * field in it is named and consumed; the heading is a stale count.
 */
export type TasteProfile = {
  sampleSize: number;
  /**
   * COARSE DEEZER GENRES ONLY, and this is the Deadwax-specific fix rather than an oversight.
   * Both absence penalties are computed against this set, never against the fine MusicBrainz
   * tag set: once `seenTags` holds hundreds of entries the "shares nothing at all" penalty
   * NEVER FIRES, because every candidate shares something with a history that broad. Computed
   * against the 28-entry Deezer vocabulary it stays alive.
   */
  seenGenres: Set<string>;
  seenCountries: Set<string>;
  /** Arithmetic mean of the effective ratings, stored units. */
  meanRating: number;
  /** Sample SD, stored units. */
  spread: number;
  /**
   * Mean of `reliableAverage(...)` over the rated albums that HAVE a crowd score, or null when
   * none do.
   *
   * **EXPLICITLY NOT THE MEMBER'S OWN MEAN.** Comparing a candidate's provider score to the
   * member's own mean conflates two different distributions and turns the consensus term into
   * a blanket popularity bonus — which is the same dishonesty as relabelling popularity as
   * quality, arrived at by arithmetic instead of by a label.
   */
  crowdBaseline: number | null;
  /** Coarse Deezer genres. Descending by lean. */
  genres: Affinity[];
  /** Fine MusicBrainz tags, disjoint from `genres` per album. Descending by lean. */
  tags: Affinity[];
  /** Keyed on `String(artistId)`, labelled with the artist name. Descending by lean. */
  artists: Affinity[];
  /** Normalised labels. Descending by lean. */
  labels: Affinity[];
  /** Weighted centre of release years, or null for a flat rater. */
  eraCentre: number | null;
  /** Weighted centre of MEAN TRACK LENGTH IN MINUTES, or null. Minutes, not milliseconds. */
  trackLengthCentre: number | null;
  /** Weighted centre of track counts, or null. */
  trackCountCentre: number | null;
  /** Pearson r of (own rating, shrunk crowd score). 0 when unmeasurable. */
  consensusAlignment: number;
};

/**
 * MULTIPLICATIVE, FLOORED PER TERM, CAPPED AT 0.90.
 *
 * The rejected alternative is the one that shipped in the original: summing let a member who
 * rated forty albums all 8 out of 10 reach 0.59 — but A PROFILE WITH NO VARIANCE CONTAINS NO
 * PREFERENCE, so no amount of volume or tag familiarity should buy confidence.
 *
 * EACH TERM CAN VETO, and the three are three different questions:
 *   evidence        do we know the member?              (how many albums they rated)
 *   discrimination  has the member said anything?       (whether their ratings differ)
 *   coverage        do we know the candidate?           (how many of its attributes we know)
 *
 * The floors (0.15 / 0.1 / 0.25) keep a good signal on two axes from being annihilated by a
 * weak third; the ×1.25 lifts the product back into a usable range after three sub-1 factors;
 * the 0.90 ceiling is an epistemic position and the /for-you footer prints it in words.
 *
 * THE CANDIDATE IS NOT AN ARGUMENT. The original's signature is
 * `confidenceFor(profile, candidate, matchCount)` and the candidate is read by nothing inside
 * it — a parameter that contributes nothing is a claim the code does not honour, so it is
 * gone. What the candidate actually contributes is `attributeMatches`, which the caller has
 * already computed for the coverage term in step 1.
 */
export function confidenceFor(
  profile: Pick<TasteProfile, "sampleSize" | "spread">,
  attributeMatches: number,
): number {
  // log10(41) as the divisor is what makes this saturate at exactly 40 rated albums.
  const evidence = Math.min(1, Math.log10(1 + Math.max(0, profile.sampleSize)) / Math.log10(41));
  // /2 because a 1-star SD is 2 stored units, and a member whose ratings vary by a whole star
  // has told us as much as this term can read.
  const discrimination = clamp(profile.spread / 2, 0, 1);
  const coverage = clamp(attributeMatches / COVERAGE_DENOMINATOR, 0, 1);

  const combined = Math.max(0.15, evidence) * Math.max(0.1, discrimination) * Math.max(0.25, coverage);
  return Math.round(clamp(combined * 1.25, 0, CONFIDENCE_CEILING) * 100) / 100;
}

export type ConfidenceBand = { key: "low" | "moderate" | "good"; label: string; tone: "rose" | "neutral" | "teal" };

/** The three display bands. Thresholds live here so the copy and the colour cannot disagree. */
export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence < 0.35) return { key: "low", label: "Low confidence", tone: "rose" };
  if (confidence < 0.6) return { key: "moderate", label: "Moderate confidence", tone: "neutral" };
  return { key: "good", label: "Good confidence", tone: "teal" };
}

/**
 * The 0.90 ceiling, in the member's words. Printed verbatim in the /for-you footer.
 *
 * It lives beside the constant rather than in the page so that raising the cap without
 * rewriting the sentence is impossible.
 */
export function confidenceCeilingNote(ratedAlbums: number): string {
  return (
    `Confidence is capped at ${Math.round(CONFIDENCE_CEILING * 100)}% — with ${ratedAlbums} rated ` +
    `album${ratedAlbums === 1 ? "" : "s"} and no collaborative signal, certainty would be an overclaim.`
  );
}

/* ========================================================================== *
 * Ranking
 * ========================================================================== */

/** What `predictAlbumRating` returns, and what `rankingScore` consumes. */
export type AlbumPrediction = {
  /** THE MODEL'S ACTUAL ESTIMATE, stored 1..10. This is what gets displayed. */
  rating: number;
  confidence: number;
  /** At most three, pushed in a fixed order. The UI renders up to two. */
  reasons: string[];
};

/**
 * Shrink the prediction toward the member's own mean in proportion to confidence.
 *
 * For a member whose mean is 6.5, a 0.55-confidence prediction of 7.5 scores 7.05 while a
 * 0.18-confidence prediction of 7.6 scores 6.70 — THE WELL-SUPPORTED LOWER PREDICTION WINS.
 *
 * The defect this fixes, quoted because the symptom is so unremarkable that it survived a long
 * time: in the television original confidence was computed, displayed, and then ignored by the
 * sort — it only ever broke exact float ties, which averaged predictions essentially never
 * produce. So the list routinely led with the model's LEAST-supported guesses.
 *
 * **THE DISPLAYED NUMBER STAYS `prediction.rating`.** This value is for ordering only and is
 * never rendered: a member shown 7.05 where the model estimated 7.5 is being shown a number
 * distorted for sorting, which is a different and worse dishonesty than the one being fixed.
 */
export function rankingScore(profile: Pick<TasteProfile, "meanRating">, prediction: AlbumPrediction): number {
  return profile.meanRating + prediction.confidence * (prediction.rating - profile.meanRating);
}

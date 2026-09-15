import "server-only";

/**
 * Track-level taste. **A COMPLETELY SEPARATE MODEL — IT REUSES NONE OF `recommend.ts`.**
 *
 * That separation is the design, not an accident of implementation. The album recommender
 * answers "would this member like a record they have never heard", across a whole catalogue,
 * from attribute affinities. This answers "how would this member rate track 7 of a record they
 * are already looking at", and for that question the album's own internal shape is a far
 * stronger signal than any genre lean — people are more consistent within a record than across
 * their library. Importing the attribute machinery here would add nine terms that all resolve
 * to the same value for every track on the album, which is arithmetic that cannot change an
 * answer.
 *
 * TWO SIGNALS, IN PRIORITY ORDER:
 *
 *   1. **Their own ratings inside this album.** By far the stronger one.
 *   2. **How this track compares to the rest of the album, per the crowd.** A closer that
 *      stands well above the record's own baseline is likely to land above their personal
 *      baseline too.
 *
 * **THE CROWD CONTRIBUTES ONLY A RELATIVE SHAPE — NEVER AN ABSOLUTE VALUE.** *The crowd's scale
 * is not the member's.* A member whose ratings cluster at 6 does not want a 9 predicted for
 * them because MusicBrainz says 9; they want the track that is a point above the others on
 * this record to read a point above the others on this record.
 *
 * ALL ARITHMETIC IS IN STORED UNITS: 1 UNIT = HALF A STAR.
 */

import { clampRating, MIN_RATED_ALBUMS } from "@/lib/taste/shared";
import { countRatedAlbums } from "@/lib/taste/profile";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `ownWeight` saturates at SIX rated tracks, not the original's eight.
 *
 * An album has 10–14 parts, not 62. Eight rated episodes out of a 62-episode series is a small
 * sample of the run; eight rated tracks out of twelve is most of the record, so a saturation
 * point of 8 would mean the anchor never fully trusts a member who has rated half an album —
 * which is the most common state this function is ever called in.
 */
const OWN_WEIGHT_SATURATION = 6;

/**
 * The crowd's share of the deviation: 0.55 cold, falling to 0.30 when the member's own ratings
 * on this record have saturated. It never reaches zero, because the crowd's *shape* remains
 * informative about the tracks the member has not rated even when their own taste is well
 * measured.
 */
const CRITIC_WEIGHT_COLD = 0.55;
const CRITIC_WEIGHT_DECAY = 0.25;

/** Confidence floor for a prediction with nothing but the anchor behind it, and its ramp. */
const CONFIDENCE_BASE = 0.2;
const CONFIDENCE_OWN_RAMP = 0.5;
/** What a usable crowd comparison adds. */
const CONFIDENCE_CRITIC_BONUS = 0.15;
/**
 * The ceiling for a PREDICTED track. Lower than the album model's 0.90 for a plain reason: this
 * model has two signals and one of them is often absent, so there is less to be confident with.
 */
const CONFIDENCE_CEILING_PREDICTED = 0.85;

/**
 * A crowd baseline needs at least two rated tracks to be a baseline at all.
 *
 * With one, the baseline equals the only track's own score, the deviation is exactly zero, and
 * the prediction is unchanged — but confidence would still be bumped by
 * `CONFIDENCE_CRITIC_BONUS` for a comparison that compared the track to itself. Buying
 * confidence with a tautology is the kind of thing that makes a whole model untrustworthy.
 */
const CRITIC_BASELINE_MIN = 2;

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type TrackForecastInput = {
  disc: number;
  track: number;
  /**
   * MusicBrainz per-recording rating, ALREADY on the stored 0..10 scale.
   *
   * ALWAYS NULL TODAY, and that is a missing writer rather than missing data upstream.
   * `mapTrack` does not set it, the tracks upsert deliberately omits it ("MusicBrainz owns
   * them"), and `enrichAlbumFromMusicBrainz` only touches `albums` and `artists` — so nothing
   * in the repository ever writes `tracks.critic_score`. Filling it needs MusicBrainz
   * `recording` lookups matched to mirrored tracks by ISRC, which is one more request per album
   * against the flakiest dependency in the stack, so it is deliberately not built.
   *
   * The consequence, stated so nobody debugs a signal that is structurally absent: the critic
   * term below contributes nothing, every track's forecast falls back to the viewer or album
   * baseline, and the shape is one flat value per album modulated only by the member's own
   * ratings. The code path stays because the column and the scale are right — the day a writer
   * exists, the model starts using it with no further change.
   */
  criticScore: number | null;
  /** The viewer's own rating for this track, stored 1..10, or null. */
  viewerRating: number | null;
};

export type TrackForecast = {
  disc: number;
  track: number;
  /** Stored 1..10. When `predicted` is false this IS the member's own rating, untouched. */
  rating: number;
  /**
   * FALSE FOR A REAL RATING. Every surface that renders these must branch on it: a predicted
   * cell that looks identical to a rated one is the model claiming to know something it
   * guessed.
   */
  predicted: boolean;
  /** 1 for a real rating; at most 0.85 for a prediction. */
  confidence: number;
};

/* -------------------------------------------------------------------------- */
/* forecastTracks — PURE                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Forecasts every track on one album.
 *
 * `albumBaseline` is THE ALBUM'S OWN BASELINE and the caller owns what that means — the
 * viewer's album-level rating if they gave one, otherwise the community average for the record.
 * This module does not guess between them, because the choice is a product decision about whose
 * opinion anchors a row, not an arithmetic one.
 *
 * RETURNS NULL WHEN THERE IS NO ANCHOR AT ALL — no rated tracks on this record and no album
 * baseline. Every prediction would then be built on nothing, and *an unlabelled fabrication is
 * worse than an absent feature.* Null means "do not offer the predicted colour source", which
 * the album page renders as a DISABLED button with a reason rather than as a missing one.
 *
 * **REAL RATINGS ARE NEVER OVERWRITTEN**, so a row reads as one continuous line: a member who
 * has rated four of twelve tracks sees their own four numbers in place, with eight forecasts
 * between them, instead of a row that contradicts what they typed.
 *
 * RETURNS COORDINATES, NOT A KEYED MAP, on purpose. The album strip keys cells with
 * `trackKey(disc, track)` while the discography heatmap keys them with
 * `albumTrackKey(albumId, disc, track)`, the two shapes are not interchangeable, and A
 * MISMATCHED LOOKUP FAILS SILENTLY — it returns undefined, which renders as an uncoloured cell
 * rather than as an error. So the caller builds the key with the helper for its own scope.
 */
export function forecastTracks(
  tracks: TrackForecastInput[],
  albumBaseline: number | null,
): TrackForecast[] | null {
  const ownRatings: number[] = [];
  const criticScores: number[] = [];
  for (const track of tracks) {
    if (track.viewerRating !== null) ownRatings.push(track.viewerRating);
    if (track.criticScore !== null && Number.isFinite(track.criticScore)) criticScores.push(track.criticScore);
  }

  const viewerBaseline =
    ownRatings.length === 0 ? null : ownRatings.reduce((total, value) => total + value, 0) / ownRatings.length;

  const anchor = viewerBaseline ?? albumBaseline;
  if (anchor === null || !Number.isFinite(anchor)) return null;

  // Saturates at six rated tracks. `ownWeight` is the only thing that moves the crowd's share,
  // which is why it is computed from the member's ratings on THIS record and not from their
  // library size: somebody with 400 ratings and none on this album is cold here.
  const ownWeight = Math.min(1, ownRatings.length / OWN_WEIGHT_SATURATION);
  const criticWeight = CRITIC_WEIGHT_COLD - ownWeight * CRITIC_WEIGHT_DECAY;

  const criticBaseline =
    criticScores.length < CRITIC_BASELINE_MIN
      ? null
      : criticScores.reduce((total, value) => total + value, 0) / criticScores.length;

  return tracks.map((track) => {
    // A REAL RATING IS RETURNED AS ITSELF, with confidence 1 and `predicted: false`. No clamp,
    // no blend, no crowd adjustment — it is not an estimate.
    if (track.viewerRating !== null) {
      return { disc: track.disc, track: track.track, rating: track.viewerRating, predicted: false, confidence: 1 };
    }

    let rating = anchor;
    let confidence = CONFIDENCE_BASE + ownWeight * CONFIDENCE_OWN_RAMP;

    if (track.criticScore !== null && criticBaseline !== null) {
      // RELATIVE, NEVER ABSOLUTE. `track.criticScore` on its own would replace the member's
      // scale with MusicBrainz's; the deviation from this record's own crowd baseline carries
      // only the shape — which track stands out — and leaves the level where the member put it.
      rating += (track.criticScore - criticBaseline) * criticWeight;
      confidence += CONFIDENCE_CRITIC_BONUS;
    }

    return {
      disc: track.disc,
      track: track.track,
      rating: clampRating(rating),
      predicted: true,
      confidence: Math.min(CONFIDENCE_CEILING_PREDICTED, confidence),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* forecastForViewer — the gate, enforced SERVER-SIDE                         */
/* -------------------------------------------------------------------------- */

/**
 * `forecastTracks` behind the recommendation floor.
 *
 * **THE GATE IS HERE, NOT IN THE UI.** The album page disables the "predicted" colour-source
 * button when this returns null, but the numbers must not exist on the server either: a
 * disabled button with the data already in the payload is one edit away from shipping
 * predictions to a member with two ratings, and those predictions would be the album baseline
 * repeated twelve times wearing a per-track label.
 *
 * The floor is `MIN_RATED_ALBUMS` (8) — the same number /for-you uses, because it is the same
 * question: *is there enough here to put a number on something the member has not heard.* It is
 * counted with `countRatedAlbums`, which is one COUNT rather than the full two-CTE aggregate,
 * because this path needs the number and not the rows.
 *
 * A NULL `userId` returns null immediately, with no query: a signed-out visitor has no ratings
 * to predict from, and there is nothing to ask the database.
 */
export async function forecastForViewer(
  userId: number | null | undefined,
  tracks: TrackForecastInput[],
  albumBaseline: number | null,
): Promise<TrackForecast[] | null> {
  if (userId === null || userId === undefined) return null;
  if (tracks.length === 0) return null;

  const rated = await countRatedAlbums(userId);
  if (rated < MIN_RATED_ALBUMS) return null;

  return forecastTracks(tracks, albumBaseline);
}

/**
 * The copy for the disabled state, so the number in the sentence and the number in the gate
 * cannot drift apart.
 */
export function forecastGateNote(): string {
  return `Rate ${MIN_RATED_ALBUMS} albums to unlock predictions`;
}

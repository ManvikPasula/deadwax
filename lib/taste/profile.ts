import "server-only";

/**
 * `buildTasteProfile` — the member, reduced to the fourteen numbers the scorer is allowed to
 * see.
 *
 * The function itself is PURE. The one database read in this file is the loader
 * `getTasteProfile`, which exists so that the three consumers of a profile — /for-you, the
 * home genre rails and the house-ad affinity bonus — all go through one place and therefore
 * all apply the same readability floor. The original has the rails and the ads reading a
 * profile at 3 ratings while /for-you demanded 5, so a member with 4 saw personalised rails
 * and personalised ads while being told they had "not enough to go on".
 *
 * WHAT FEEDS THE MODEL: coarse Deezer genres, fine MusicBrainz tags, the artist, the
 * normalised label, the first-release year, mean track length, track count, the crowd score
 * and its vote count, and the artist's country.
 *
 * WHAT IS DELIBERATELY UNUSED DESPITE BEING MIRRORED: credits and contributors, `isrc`, `upc`,
 * per-track popularity, review text, the `liked` flag, listen dates, `explicit`. The source
 * brief's inference is taken: ONE REAL SIMILARITY EDGE BEATS ANOTHER SPARSE CATEGORICAL
 * BUCKET, which is why the effort went into the cached `artist_similar` graph rather than into
 * a producer-affinity axis.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { getRatedAlbumsForTaste, type RatedAlbumForTaste } from "@/lib/db/queries/albums";
import {
  type Affinity,
  type AffinityRow,
  type AttributeRef,
  type TasteProfile,
  affinities,
  attributeKey,
  attributeRef,
  mean,
  pearson,
  preferredCentre,
  reliableAverage,
  standardDeviation,
  PROFILE_READABLE_MIN,
} from "@/lib/taste/shared";

/* -------------------------------------------------------------------------- */
/* buildTasteProfile                                                          */
/* -------------------------------------------------------------------------- */

/** Milliseconds to minutes. `trackLengthCentre` is in MINUTES; the column is in milliseconds. */
const MS_PER_MINUTE = 60_000;

/**
 * `albums.mean_track_ms` and `albums.track_count` both default to 0, and a 0 IS ABSENT DATA
 * RATHER THAN A MEASUREMENT: it is what a summary-cached row carries before its tracklist has
 * ever been fetched. Feeding 0 into a centre would drag the whole centre toward a zero-length,
 * zero-track record that does not exist, and feeding it into the penalty terms would dock
 * every un-detail-synced candidate the full amount — which would then make the detail sync
 * look like it improved the model when all it did was stop it lying.
 */
function measuredOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Per-album attribute keys for the two genre axes, WITH THE TAG SIDE MADE DISJOINT FROM THE
 * COARSE SIDE.
 *
 * A record routinely carries the Deezer genre "Rock" and the MusicBrainz tag "rock" at once.
 * Left alone, that album contributes one deviation to the coarse list and one to the fine
 * list, and `mergeAffinities` then reports support 2 from a single record — giving the key
 * twice the weight it earned. Dropping the duplicate from the fine side keeps the two lists
 * disjoint per album, which is what makes the merge in the genre axis exact.
 *
 * Duplicates WITHIN one side are collapsed by the Map, which matters because MusicBrainz
 * really does return "Electronic" and "electronic" on the same release.
 */
function genreKeysOf(album: RatedAlbumForTaste): { coarse: AttributeRef[]; fine: AttributeRef[] } {
  const coarse = new Map<string, AttributeRef>();
  for (const genre of album.genres) {
    const ref = attributeRef(genre);
    if (ref && !coarse.has(ref.key)) coarse.set(ref.key, ref);
  }

  const fine = new Map<string, AttributeRef>();
  for (const tag of album.tags) {
    const ref = attributeRef(tag);
    if (!ref || coarse.has(ref.key) || fine.has(ref.key)) continue;
    fine.set(ref.key, ref);
  }

  return { coarse: [...coarse.values()], fine: [...fine.values()] };
}

/**
 * The fourteen fields, from one member's own rated albums.
 *
 * AN EMPTY OR NEAR-EMPTY HISTORY PRODUCES A USELESS PROFILE ON PURPOSE: `meanRating` is 0 and
 * `spread` is 0, so every prediction built on it would anchor at 0 and the no-variety gate
 * (`spread < 0.4`) refuses before a single provider call is made. The three cold-start gates
 * are the enforcement; this function does not invent a midpoint to paper over them, because a
 * midpoint would be a measurement of nothing that looks exactly like a measurement.
 */
export function buildTasteProfile(rated: RatedAlbumForTaste[]): TasteProfile {
  const ratings = rated.map((album) => album.rating);
  const meanRating = mean(ratings);

  const seenGenres = new Set<string>();
  const seenCountries = new Set<string>();

  const coarseRows: AffinityRow[] = [];
  const fineRows: AffinityRow[] = [];
  const artistRows: AffinityRow[] = [];
  const labelRows: AffinityRow[] = [];

  const eraRows: Array<{ rating: number; value: number | null }> = [];
  const lengthRows: Array<{ rating: number; value: number | null }> = [];
  const countRows: Array<{ rating: number; value: number | null }> = [];

  const crowdScores: number[] = [];
  const alignmentPairs: Array<readonly [number, number]> = [];

  for (const album of rated) {
    const { coarse, fine } = genreKeysOf(album);

    // seenGenres IS COARSE-ONLY. Both absence penalties read it, and against the fine tag set
    // the "shares nothing at all" penalty would never fire once the history holds hundreds of
    // tags. See the field's docblock in shared.ts.
    for (const ref of coarse) seenGenres.add(ref.key);
    if (album.country) seenCountries.add(attributeKey(album.country));

    coarseRows.push({ rating: album.rating, keys: coarse });
    fineRows.push({ rating: album.rating, keys: fine });

    // The artist axis is keyed on the ID, not the name: two artists share a name far more often
    // in music than two networks do in television ("Nirvana" alone has several), and an id is
    // also what the retrieval stage needs to expand through `artist_similar`.
    artistRows.push({
      rating: album.rating,
      keys: [{ key: String(album.artistId), label: album.artistName }],
    });

    const label = attributeRef(album.label);
    labelRows.push({ rating: album.rating, keys: label ? [label] : [] });

    eraRows.push({ rating: album.rating, value: album.year });
    const meanTrackMs = measuredOrNull(album.meanTrackMs);
    lengthRows.push({ rating: album.rating, value: meanTrackMs === null ? null : meanTrackMs / MS_PER_MINUTE });
    countRows.push({ rating: album.rating, value: measuredOrNull(album.trackCount) });

    // THE SAME TRANSFORM as the crowd term in the scorer and as the alignment pairs below —
    // all three read `reliableAverage`, never a raw average, so the coefficient and the
    // quantity it multiplies come from one distribution.
    const reliable = reliableAverage(album.criticScore, album.criticVotes);
    if (reliable !== null) {
      crowdScores.push(reliable);
      alignmentPairs.push([album.rating, reliable]);
    }
  }

  return {
    sampleSize: rated.length,
    seenGenres,
    seenCountries,
    meanRating,
    spread: standardDeviation(ratings),
    // NULL, not the prior, when no rated album carries a crowd score: a member whose entire
    // history is unrated-by-MusicBrainz obscurities has no measurable relationship to the
    // consensus, and the crowd term skips itself rather than comparing a candidate to 7.
    crowdBaseline: crowdScores.length === 0 ? null : mean(crowdScores),
    genres: affinities(coarseRows, meanRating),
    tags: affinities(fineRows, meanRating),
    artists: affinities(artistRows, meanRating),
    labels: affinities(labelRows, meanRating),
    eraCentre: preferredCentre(eraRows, meanRating),
    trackLengthCentre: preferredCentre(lengthRows, meanRating),
    trackCountCentre: preferredCentre(countRows, meanRating),
    consensusAlignment: pearson(alignmentPairs),
  };
}

/* -------------------------------------------------------------------------- */
/* The loader                                                                 */
/* -------------------------------------------------------------------------- */

export type LoadedTasteProfile = {
  profile: TasteProfile;
  /** The raw rows, because retrieval needs the member's top-rated albums and their artists. */
  rated: RatedAlbumForTaste[];
};

/**
 * Reads one member's history and builds their profile, or returns null below the READABILITY
 * floor of 5.
 *
 * NULL IS NOT AN ERROR AND MUST NOT BE RENDERED AS ONE. It means "this member has not said
 * enough for anything derived from their taste to be honest", and every caller's correct
 * response is to omit its feature: the rails fall back to the default genres, the ad affinity
 * bonus is simply absent, and /for-you shows the too-few-ratings gate (which applies its own,
 * higher floor of 8 — see `MIN_RATED_ALBUMS`).
 *
 * NOT WRAPPED IN REACT `cache()`. `getRatedAlbumsForTaste` goes through `db.execute`, which is
 * not React-cached, so a page that reads a profile twice runs the two-CTE aggregate twice —
 * exactly the defect that made the television profile page run `getProfileStats` twice per
 * view. The wrapper is not applied here because the three consumers sit on three different
 * routes and never co-occur; IF A SINGLE PAGE EVER READS A PROFILE TWICE, WRAP IT THEN, and
 * note that `cache()` dedupes per request only and is not a cross-request cache.
 */
export async function getTasteProfile(userId: number): Promise<LoadedTasteProfile | null> {
  const rated = await getRatedAlbumsForTaste(userId);
  if (rated.length < PROFILE_READABLE_MIN) return null;
  return { profile: buildTasteProfile(rated), rated };
}

/**
 * How many albums this member has an effective rating for, in one cheap count.
 *
 * IT MUST AGREE WITH `getRatedAlbumsForTaste`'s POPULATION, and it does: that query's two CTEs
 * both require `rating IS NOT NULL` and a non-null `album_id`, and its `FULL OUTER JOIN`
 * unions the album-level and track-level sides — so "distinct album_id with any non-null
 * rating" is the same set. An artist-level log carries `album_id IS NULL` and is excluded by
 * both. This exists because the prediction gate on the album page needs the number and not the
 * rows, and running the full aggregate to count it is a waste of a page's budget.
 *
 * NO GUEST FILTER, deliberately, exactly as `getRatedAlbumsForTaste` has none: this reads one
 * member's own rows to gate one member's own feature, and no figure derived from it is ever
 * shown as consensus. A guest's predictions have to work — guest mode exists so that the
 * diary, the heatmaps and the taste model behave unchanged for somebody without credentials.
 */
export async function countRatedAlbums(userId: number): Promise<number> {
  const result = await db.execute<{ rated: number }>(sql`
    SELECT COUNT(DISTINCT l.album_id)::int AS rated
    FROM logs l
    WHERE l.user_id = ${userId}
      AND l.album_id IS NOT NULL
      AND l.rating IS NOT NULL
  `);
  return Number(result.rows[0]?.rated ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Two readings of the genre affinities, for surfaces that are not /for-you    */
/* -------------------------------------------------------------------------- */

/**
 * The genres a member leans toward, strongest first — for the home rails and the ad-affinity
 * bonus.
 *
 * COARSE GENRES ONLY, AND THAT IS A HARD REQUIREMENT rather than a preference: a rail has to
 * become a `/chart/{genreId}/albums` call and an affinity bonus has to compare against an ad's
 * genre column, and only Deezer's 28-entry vocabulary has ids. A MusicBrainz tag like
 * "post-punk revival" has nothing to resolve against.
 *
 * `lean × √support` IS THE SAME SEED RULE THE RECOMMENDER USES, on purpose: a member whose
 * rails say one thing and whose /for-you says another reads as two different models disagreeing
 * about them. A mild preference over six records is a better seed than a strong one over two.
 */
export function preferredGenres(profile: TasteProfile, limit = 3): Affinity[] {
  return profile.genres
    .filter((entry) => entry.lean > 0 && entry.support >= 2)
    .slice()
    .sort((left, right) => right.lean * Math.sqrt(right.support) - left.lean * Math.sqrt(left.support))
    .slice(0, limit);
}

/**
 * The genres a member rates BELOW their own mean, worst first.
 *
 * **SLICED FROM THE ASCENDING END**, and a test asserts the sign. The television original
 * sliced the descending end of a descending-lean array and therefore displayed the three
 * LEAST disliked genres under a "disliked" heading — a bug that is invisible unless you happen
 * to know the member's actual opinion, because the output is always a plausible list of genres.
 */
export function dislikedGenres(profile: TasteProfile, limit = 3): Affinity[] {
  return profile.genres
    .filter((entry) => entry.lean < 0)
    .slice()
    .reverse()
    .slice(0, limit);
}

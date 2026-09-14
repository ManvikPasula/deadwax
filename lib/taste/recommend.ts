import "server-only";

/**
 * `predictAlbumRating` — the nine-step formula — and `getRecommendations`, the seven-source
 * retrieval stage that feeds it.
 *
 * ALL ARITHMETIC IS IN STORED UNITS: 1 UNIT = HALF A STAR. Every constant in this file and in
 * `shared.ts` sits on that one scale, and they were rescaled together. A single one re-read as
 * stars is a factor-of-two error that produces plausible numbers and throws nothing.
 *
 * ---------------------------------------------------------------------------------------
 * TWO THINGS TO READ BEFORE CHANGING A COEFFICIENT
 * ---------------------------------------------------------------------------------------
 *
 * 1. **RETRIEVAL DOMINATES RANKING.** The measured verdict from the television original:
 *    43 distinct titles filled 100 slots across ten very different members before the
 *    retrieval rewrite; 77 distinct across 80 slots after. No amount of ranking work fixes a
 *    pool that only contains the same forty records. If the output looks wrong, count the
 *    distinct titles first — `npm run taste-eval` prints exactly that number.
 *
 * 2. **THE STATED CEILING, recorded so nobody spends tuning effort re-deriving it.** Deezer's
 *    28 coarse genres cannot separate a doom metal record from a power metal one, and
 *    MusicBrainz tags are present for popular releases and absent for the long tail — so THE
 *    MODEL IS SHARPEST EXACTLY WHERE IT IS LEAST NEEDED. Fixing that needs an audio-feature or
 *    co-listen embedding, NOT another coefficient. Do not re-derive this.
 *
 * ---------------------------------------------------------------------------------------
 * NEVER INVENT A REASON
 * ---------------------------------------------------------------------------------------
 *
 * Every reason string is pushed INSIDE the branch that actually moved the score, and each has
 * its own threshold, so the interface never explains an adjustment too small to have changed a
 * rank. The thresholds are named constants below rather than inline numbers precisely so that
 * a reason cannot drift away from the term it describes.
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { albumIdentity } from "@/lib/canonical";
import { db } from "@/lib/db";
import { getAlbumsByIds, getRatedAlbumsForTaste, type AlbumRow } from "@/lib/db/queries/albums";
import { albums, artistSimilar, artists } from "@/lib/db/schema";
import { releaseYear } from "@/lib/format";
import { cacheAlbumSummaries, ensureAlbum, ensureArtist } from "@/lib/ingest/albums";
import { chartAlbums, chartArtists, genreArtists, getArtistAlbums, getGenres } from "@/lib/providers/deezer";
import type { DeezerAlbumSummary } from "@/lib/providers/deezer/types";
import { buildTasteProfile } from "@/lib/taste/profile";
import {
  type Affinity,
  type AlbumPrediction,
  type TasteProfile,
  ARTIST_WEIGHT,
  COVERAGE_DENOMINATOR,
  DETAIL_SYNC_LIMIT,
  EVIDENCE_SATURATION,
  GENRE_WEIGHT,
  LABEL_WEIGHT,
  MIN_NOTABILITY_FANS,
  MIN_RATED_ALBUMS,
  NO_VARIETY_SPREAD,
  PROFILE_READABLE_MIN,
  attributeKey,
  clamp,
  clampRating,
  confidenceFor,
  leanFor,
  mergeAffinities,
  rankingScore,
  reliableAverage,
} from "@/lib/taste/shared";

/* ========================================================================== *
 * The candidate shape
 * ========================================================================== */

/**
 * WHY AN ALBUM ARRIVED IN THE POOL, when it arrived through the neighbour graph.
 *
 * This is provenance, and it is built during retrieval rather than reconstructed later:
 * *once the pools are flattened into one list of ids, the fact that an album arrived via Aphex
 * Twin rather than via the chart is lost, and that fact is the strongest signal available.*
 */
export type NeighbourSeed = {
  /** The member's own artist — the one whose neighbours were expanded. */
  artistId: number;
  name: string;
  /** The member's effective rating for the album that made this artist a seed. Stored units. */
  rating: number;
};

/**
 * Everything the scorer reads about one album. A deliberately narrow projection: it is the
 * model's input contract, and a field appearing here means some step actually consumes it.
 *
 * `genres` IS COARSE DEEZER ONLY and `tags` IS FINE MUSICBRAINZ ONLY. Keeping them separate at
 * this boundary is what makes the coarse-only absence penalties possible; merging them into
 * one array at the query would silently delete that retune.
 */
export type CandidateAlbum = {
  id: number;
  deezerId: string;
  mbid: string | null;
  title: string;
  genres: string[];
  tags: string[];
  artistId: number;
  artistName: string;
  /** `artists.country` — ISO alpha-2, from MusicBrainz only, so usually null. */
  artistCountry: string | null;
  label: string | null;
  /** From `original_release_date ?? release_date`, so a remaster does not read as recent. */
  year: number | null;
  meanTrackMs: number;
  trackCount: number;
  /** ALREADY on the stored 0..10 scale. NULL means no rating; never 0. */
  criticScore: number | null;
  criticVotes: number;
  /** POPULARITY, not quality. The notability floor and the tiebreak, and nothing else. */
  fans: number;
  isCanonical: boolean;
  neighbourOf: NeighbourSeed | null;
};

/* ========================================================================== *
 * Reason thresholds — each term's own, so a reason cannot outrun its effect
 * ========================================================================== */

const REASON_GENRE_LEAN = 0.3;
const REASON_ARTIST_LEAN = 0.4;
const REASON_LABEL_LEAN = 0.5;
/** Stored units the crowd term must actually move the prediction before it says so. */
const REASON_CONSENSUS_SHIFT = 0.15;
/** Stored units the era pull must actually cost before it is worth mentioning. */
const REASON_ERA_COST = 0.2;
/** Stored units an absence penalty must cost before it is worth mentioning. */
const REASON_ABSENCE_COST = 0.2;

/** The signature genre's gates. Both must hold, and the first-match relies on the lean sort. */
const SIGNATURE_LEAN = 0.4;
const SIGNATURE_SUPPORT = 2;

/* ========================================================================== *
 * The merged genre axis, memoised per profile
 * ========================================================================== */

/**
 * The genre axis scores Deezer's coarse genres and MusicBrainz's fine tags TOGETHER, so the
 * two affinity lists have to be merged into one lookup table.
 *
 * Memoised on the profile OBJECT, because `getRecommendations` scores a hundred and fifty
 * candidates against one profile and the merge walks every entry in both lists — on a
 * well-travelled member that is a few hundred entries, so recomputing per candidate turns a
 * trivial cost into a measurable one for no benefit.
 *
 * A `WeakMap` rather than a module-level variable: a rebuilt profile is a new object and gets a
 * new axis, and nothing is retained between requests.
 */
const genreAxisCache = new WeakMap<TasteProfile, Affinity[]>();

function genreAxisFor(profile: TasteProfile): Affinity[] {
  const cached = genreAxisCache.get(profile);
  if (cached) return cached;
  const merged = mergeAffinities(profile.genres, profile.tags);
  genreAxisCache.set(profile, merged);
  return merged;
}

/* ========================================================================== *
 * predictAlbumRating — the nine steps. PURE.
 * ========================================================================== */

/**
 * One album, scored against one profile.
 *
 * PURE: no I/O, no clock, no randomness. Given the same profile and candidate it returns the
 * same three values, which is what makes the property tests and `npm run taste-eval`
 * reproducible.
 */
export function predictAlbumRating(profile: TasteProfile, candidate: CandidateAlbum): AlbumPrediction {
  /**
   * Pushed in a FIXED ORDER — neighbour, genre, artist, label, shares-nothing, not-signature,
   * consensus, era — and truncated to three. The order is the execution order of the steps
   * below, which is not a coincidence: it is what keeps "the reason came from the branch that
   * moved the score" true by construction rather than by review.
   *
   * The UI renders UP TO TWO. The television original renders only `reasons[0]`, so whenever a
   * neighbour reason exists it is the only reason a member ever sees — which wastes every
   * attribute reason the formula bothered to compute.
   */
  const reasons: string[] = [];

  /* ---- STEP 1 — base deviation, THREE AXES, NOT TWO ------------------------------------ */
  //
  // Artist REPLACES network. "The artist as a repeated author" is a pillar music has and
  // television does not, and it is the member's strongest signal after the neighbour term.
  // Labels are third and weakest because Deezer returns them as free text.
  const genre = leanFor([...candidate.genres, ...candidate.tags], genreAxisFor(profile));
  const artist = leanFor([String(candidate.artistId)], profile.artists);
  const label = leanFor([candidate.label], profile.labels);

  // ONE DENOMINATOR ACROSS ALL THREE AXES. Without coverage, an album carrying the single tag
  // "Rock" takes the member's full Rock lean and is scored as though it were purely and
  // definitively that.
  const attributeMatches = genre.matched.length + artist.matched.length + label.matched.length;
  const coverage = clamp(attributeMatches / COVERAGE_DENOMINATOR, 0, 1);

  const deviation = genre.lean * GENRE_WEIGHT + artist.lean * ARTIST_WEIGHT + label.lean * LABEL_WEIGHT;
  let rating = profile.meanRating + deviation * coverage;

  /* ---- STEP 2 — the neighbour term, the largest single term ---------------------------- */
  //
  // Everything else — genre, artist, era, track length — moves a prediction by at most a couple
  // of tenths, and candidates inside one genre pool differ by less than that. Without this term
  // the ranking within a pool collapses to the provider's own popularity order.
  //
  // RANGE [0.3, 1.0], NEVER NEGATIVE. Enthusiasm is clamped at 0 on the low side because an
  // album by a neighbour of something the member rated BELOW their mean is still a neighbour;
  // the graph edge is information, the member's disappointment with one record is not evidence
  // against the edge.
  if (candidate.neighbourOf) {
    const enthusiasm = clamp(candidate.neighbourOf.rating - profile.meanRating, 0, 2);
    rating += 0.3 + enthusiasm * 0.35;
    reasons.push(`Listeners of ${candidate.neighbourOf.name} tend to play this too`);
  }

  /* ---- STEP 3 — reason text, no score effect ------------------------------------------- */
  //
  // The KEY NAMED IN EACH DIRECTION comes from opposite ends of `matched`, which is in the
  // table's descending-lean order: the strongest match for the positive sentence, the weakest
  // for the negative one. Reading `matched[0]` for both would name a genre the member LIKES
  // inside a sentence saying they rate it below their average — the same sign error that made
  // the original's "disliked genres" panel list the three least disliked.
  const strongestGenre = genre.matched[0];
  const weakestGenre = genre.matched.at(-1);
  if (genre.lean > REASON_GENRE_LEAN && strongestGenre) {
    reasons.push(`You rate ${strongestGenre.label} above your average`);
  } else if (genre.lean < -REASON_GENRE_LEAN && weakestGenre) {
    reasons.push(`You tend to rate ${weakestGenre.label} below your average`);
  }

  const matchedArtist = artist.matched[0];
  if (artist.lean > REASON_ARTIST_LEAN && matchedArtist) {
    reasons.push(`${matchedArtist.label} has worked for you before`);
  }

  const matchedLabel = label.matched[0];
  if (label.lean > REASON_LABEL_LEAN && matchedLabel) {
    reasons.push(`You have liked other ${matchedLabel.label} releases`);
  }

  /* ---- STEP 4 — two absence penalties ------------------------------------------------- */
  //
  // BOTH ARE KEYED ON THE MEMBER'S ATTRIBUTES, not on the share of the CANDIDATE's own tags
  // that are unfamiliar. The earlier television version did the latter and rewarded sparse
  // metadata twice over: a show tagged only "Drama" paid nothing while a richly-tagged Sherlock
  // paid for its Mystery tag, so THE BLANDEST POSSIBLE MATCH OUTRANKED THE APT ONE.
  //
  // THE INVARIANT: A CANDIDATE CANNOT IMPROVE ITS SCORE BY DESCRIBING ITSELF LESS.
  //
  // AND BOTH ARE COMPUTED AGAINST THE COARSE DEEZER GENRE PROJECTION ONLY — never the fine
  // MusicBrainz tag set. That is the Deadwax-specific fix: once a member's history holds
  // hundreds of tags, penalty (a) NEVER FIRES, because every candidate shares something with a
  // history that broad. Against the 28-entry Deezer vocabulary it stays alive.
  const evidence = Math.min(1, profile.sampleSize / EVIDENCE_SATURATION);
  const coarseKeys = new Set(candidate.genres.map((genre_) => attributeKey(genre_)).filter((key) => key.length > 0));
  const historyIsReadable = profile.sampleSize >= PROFILE_READABLE_MIN && profile.seenGenres.size > 0;

  if (historyIsReadable) {
    let sharesCoarseGenre = false;
    for (const key of coarseKeys) {
      if (profile.seenGenres.has(key)) {
        sharesCoarseGenre = true;
        break;
      }
    }

    if (!sharesCoarseGenre) {
      const penalty = 0.8 * evidence;
      rating -= penalty;
      if (penalty >= REASON_ABSENCE_COST) reasons.push("Nothing here overlaps the genres you have rated");
    }

    // The signature genre is THE FIRST ENTRY PASSING BOTH GATES, which depends on the
    // descending-lean sort in `affinities()`. Support >= 2 because a one-record lean is exactly
    // the noise the shrinkage exists to damp, and a signature derived from one album would dock
    // the whole catalogue for not being that album.
    const signature = profile.genres.find(
      (entry) => entry.lean > SIGNATURE_LEAN && entry.support >= SIGNATURE_SUPPORT,
    );
    if (signature && !coarseKeys.has(signature.key)) {
      const penalty = Math.min(0.6, signature.lean * 0.4) * evidence;
      rating -= penalty;
      if (penalty >= REASON_ABSENCE_COST) reasons.push(`Not ${signature.label}, your most reliable lane`);
    }
  }

  /* ---- STEP 5 — unfamiliar country ---------------------------------------------------- */
  //
  // FLAT, NO EVIDENCE SCALING, and gated on a readable history. HALVED from the television
  // original's 0.5: music is far less language-gated than television, so an unfamiliar country
  // is a much weaker signal of "you will not get on with this".
  //
  // NO REASON STRING IS EMITTED. "This record is from a country you have not rated" is not a
  // reason anybody wants read back to them, and the term is too small to have moved a rank on
  // its own.
  if (
    profile.sampleSize >= PROFILE_READABLE_MIN &&
    profile.seenCountries.size > 0 &&
    candidate.artistCountry &&
    !profile.seenCountries.has(attributeKey(candidate.artistCountry))
  ) {
    rating -= 0.25;
  }

  /* ---- STEP 6 — the crowd term, SIGNED BY MEASURED ALIGNMENT --------------------------- */
  //
  // SKIPPED ENTIRELY when the candidate has no crowd score, rather than substituting a neutral
  // value: A SUBSTITUTED NEUTRAL IS A FABRICATION, and most albums have no MusicBrainz rating
  // at all, so the fabricated value would be the common case rather than the edge case.
  // Skipped too when the member's own history carries no crowd scores, because then
  // `crowdBaseline` is null and there is nothing to be above or below.
  //
  // NEGATIVE ALIGNMENT IS INVERTED, NOT CLAMPED TO ZERO: clamping discards the clearest signal
  // a contrarian gives us, and inverting means somebody who reliably rates canonised classics
  // poorly is offered the overlooked instead. The lower coefficient for disagreement (0.3
  // against 0.5) is deliberate — DISAGREEMENT IS A NOISIER SIGNAL THAN AGREEMENT.
  const reliable = reliableAverage(candidate.criticScore, candidate.criticVotes);
  if (reliable !== null && profile.crowdBaseline !== null) {
    const crowdDeviation = reliable - profile.crowdBaseline;
    const alignment = profile.consensusAlignment;
    const weight = alignment >= 0 ? alignment * 0.5 : alignment * 0.3;
    const contribution = crowdDeviation * weight;
    rating += contribution;

    if (Math.abs(contribution) >= REASON_CONSENSUS_SHIFT) {
      if (contribution > 0) {
        reasons.push(
          alignment >= 0
            ? "Well regarded, and you usually agree with the consensus"
            : "Overlooked by the consensus, which you usually rate against",
        );
      } else {
        reasons.push(
          alignment >= 0
            ? "Rated below the records you usually agree with"
            : "Canonised, and you usually rate the canon down",
        );
      }
    }
  }

  /* ---- STEP 7 — era pull -------------------------------------------------------------- */
  //
  // AN 8-YEAR DEAD ZONE, capping at a 23-year gap. The television original uses 15 years over
  // 40, which erases the distinction that matters most in music: 1968, 1983 and 1998 are
  // different sonic worlds, and a 15-year dead zone puts all three inside "no penalty".
  if (profile.eraCentre !== null && candidate.year !== null) {
    const gap = Math.abs(candidate.year - profile.eraCentre);
    if (gap > 8) {
      const penalty = Math.min(0.6, (gap - 8) / 25);
      rating -= penalty;
      if (penalty >= REASON_ERA_COST) {
        reasons.push(`About ${Math.round(gap)} years from the era you rate highest`);
      }
    }
  }

  /* ---- STEP 8 — mean-track-length pull ------------------------------------------------ */
  //
  // IN MINUTES, on a 1.5-MINUTE dead zone. The original's 15-minute dead zone over median
  // episode length is meaningless on a 1–12 minute range: every record would sit inside it.
  //
  // The purpose is FORMAT SEPARATION WITHIN A SHARED TAG — a three-minute pop single, a
  // nine-minute post-rock piece and a sixty-second hardcore track all carry the same genre
  // vocabulary, and mean track length separates them more reliably than any of those tags do.
  // The general lesson from the original is worth keeping: *a signal that exists and is ignored
  // is worse than one that does not exist, because it reads as covered.*
  //
  // `meanTrackMs <= 0` IS ABSENT DATA, NOT A ZERO-MINUTE RECORD — it is what a summary-cached
  // row carries before its tracklist has been fetched. Scoring it would dock every
  // un-detail-synced candidate the full 0.45 and make the detail sync look like an improvement
  // when all it did was stop the model lying.
  if (profile.trackLengthCentre !== null && candidate.meanTrackMs > 0) {
    const minutes = candidate.meanTrackMs / 60_000;
    const gap = Math.abs(minutes - profile.trackLengthCentre);
    if (gap > 1.5) rating -= Math.min(0.45, (gap - 1.5) / 6);
  }

  /* ---- STEP 9 — track-count pull (NEW; no television equivalent) ---------------------- */
  //
  // EP against double LP. A television-less signal: seasons are roughly uniform in length,
  // records are not, and a member who rates 40-minute LPs does not necessarily want a
  // 22-track double album. Same absent-data guard as step 8.
  if (profile.trackCountCentre !== null && candidate.trackCount > 0) {
    const gap = Math.abs(candidate.trackCount - profile.trackCountCentre);
    if (gap > 6) rating -= Math.min(0.3, (gap - 6) / 20);
  }

  return {
    rating: clampRating(rating),
    confidence: confidenceFor(profile, attributeMatches),
    reasons: reasons.slice(0, 3),
  };
}

/* ========================================================================== *
 * Retrieval — the tuning constants, with the outbound budget worked out
 * ========================================================================== */

/**
 * THE WORST-CASE OUTBOUND TALLY FOR ONE COLD `/for-you` RENDER, because these numbers are only
 * defensible together:
 *
 *   getGenres                     1   (cached a week at the HTTP layer, so ~0 in practice)
 *   byGenre            2 x 2  =   4   two seeds, pages 1 and 2
 *   byGenreArtists     2 x 5  =  10   one /genre/{id}/artists + 2 x (ensureArtist + albums)
 *   bySimilarArtist    3 x 3  =   9   local artist ids already known, so albums only
 *   byLabel                   =   0   local SQL; Deezer has no label endpoint
 *   chartAlbums               =   1
 *   chartArtists       1 + 6  =   7   three artists x (ensureArtist + albums)
 *   localHighRated            =   0   local SQL
 *   detail sync        8 x 2  =  16   album detail + tracklist, SEQUENTIAL
 *                                --
 *                                48   against deezer:global 400/60s
 *
 * MusicBrainz is the tighter budget: up to 7 artist enrichments plus 8 album enrichments is
 * ~15 against `musicbrainz:global` 45/60s, so THREE SIMULTANEOUS COLD RENDERS EXHAUST IT. That
 * is an accepted degradation rather than an oversight — MusicBrainz enrichment failing means
 * tags, first-release dates and critic scores are absent for those rows, and absent is the
 * designed fallback everywhere they are read. A warm instance pays almost none of this: the
 * HTTP cache covers discovery for 6 hours, `ensureArtist` returns the mirror without a call,
 * and `ensureAlbum` has a 30-day TTL because a released tracklist is immutable.
 */
const GENRE_SEEDS = 2;
const GENRE_PAGES = 2;
const GENRE_ARTISTS_PER_SEED = 2;
const ARTIST_SEEDS = 3;
const NEIGHBOURS_PER_SEED = 3;
const LABEL_SEEDS = 3;
const CHART_ARTISTS = 3;
/** Deezer accepts an arbitrary `limit`, which is why the original's 20-into-24 stitching is gone. */
const SOURCE_PAGE = 25;
/** Local sources are cheap, so they are allowed to be wider than a provider page. */
const LOCAL_POOL = 40;
/** Mirrored albums need this many distinct member ratings before they count as a signal. */
const LOCAL_RATING_FLOOR = 3;
/** A shortlist wider than the final list, SO RE-SCORING AFTER THE DETAIL SYNC HAS ROOM TO REORDER. */
const SHORTLIST_MULTIPLIER = 3;

/* ========================================================================== *
 * The result shape — three gates, three arms, three copies
 * ========================================================================== */

export type Recommendation = {
  album: AlbumRow;
  /** THE MODEL'S ACTUAL ESTIMATE, stored 1..10. Render this, not the ranking score. */
  rating: number;
  confidence: number;
  /** At most three. The UI renders up to two. */
  reasons: string[];
  neighbourOf: NeighbourSeed | null;
};

/**
 * THREE DISTINCT ARMS RATHER THAN ONE `{ ok: false; message }`, and the shape is the point: the
 * page cannot render one apology for all three refusals, because there is no single field to
 * render. Each withholding reason gets its own copy.
 *
 * *Ten indistinguishable predictions dressed as a ranked list is worse than saying there is
 * nothing to say yet.*
 */
export type RecommendationResult =
  | { status: "ok"; items: Recommendation[]; profile: TasteProfile; ratedAlbums: number }
  | { status: "too-few"; ratedAlbums: number; needed: number; title: string; detail: string }
  | { status: "no-variety"; ratedAlbums: number; title: string; detail: string }
  | { status: "cold-pool"; ratedAlbums: number; title: string; detail: string };

/* ========================================================================== *
 * Exclusions
 * ========================================================================== */

type Exclusions = { ids: Set<number>; identities: Set<string> };

/**
 * Everything the member has already logged or wantlisted — AND EVERY ALBUM SHARING AN
 * `albumIdentity` WITH ONE OF THEM.
 *
 * The id set alone is not enough, and this is stricter than the television original for a
 * structural reason rather than a cosmetic one: in television duplicates are occasional
 * regional variants, while in music the same record exists as original / remaster / deluxe /
 * 2CD / Japanese pressing WITH DIFFERENT TITLES AND DIFFERENT YEARS. Excluding by id only,
 * *the list fills with remasters of records the listener already rated.*
 *
 * `albumIdentity` prefers the MusicBrainz release-group mbid and falls back to normalised
 * artist plus suffix-stripped title. It deliberately does not include the year, because the
 * year is exactly what a reissue changes.
 */
async function loadExclusions(userId: number): Promise<Exclusions> {
  const result = await db.execute<{
    id: number;
    mbid: string | null;
    title: string;
    artist_name: string;
  }>(sql`
    WITH owned AS (
      SELECT DISTINCT l.album_id AS album_id
      FROM logs l
      WHERE l.user_id = ${userId} AND l.album_id IS NOT NULL
      UNION
      SELECT w.album_id AS album_id
      FROM wantlist w
      WHERE w.user_id = ${userId}
    )
    SELECT a.id, a.mbid, a.title, ar.name AS artist_name
    FROM owned o
    JOIN albums a ON a.id = o.album_id
    JOIN artists ar ON ar.id = a.artist_id
  `);

  const ids = new Set<number>();
  const identities = new Set<string>();
  for (const row of result.rows) {
    ids.add(row.id);
    identities.add(albumIdentity({ mbid: row.mbid, title: row.title, artistName: row.artist_name }));
  }
  return { ids, identities };
}

/* ========================================================================== *
 * Seeds
 * ========================================================================== */

/**
 * Genre seeds: `weight = lean × √support`, filtered to `lean > 0 && support >= 2`, top 2.
 *
 * *A mild preference over six records is a better seed than a strong one over two* — the square
 * root is what expresses that without letting volume swamp direction entirely.
 *
 * THE FALLBACK IS NOT A SAFETY NET, IT IS THE FIX FOR A WHOLE CLASS OF MEMBER: a genre present
 * in everything a member rates has a lean of EXACTLY ZERO, because a lean is a deviation from
 * their own mean. So a metal-only listener's defining lane produces no query at all, and
 * without this they were served the chart. When the filtered list is empty, sort by SUPPORT
 * alone.
 *
 * COARSE GENRES ONLY, AND ONLY THOSE THAT RESOLVE TO A DEEZER GENRE ID. Resolution happens
 * BEFORE the top-2 cut rather than after: filtering afterwards can leave zero seeds when both
 * winners happen to be unresolvable, and a member with a readable profile getting the generic
 * chart is the exact failure this function exists to prevent.
 */
function genreSeeds(profile: TasteProfile, vocabulary: Map<string, number>): Array<{ genreId: number; name: string }> {
  const resolvable = profile.genres.filter((entry) => vocabulary.has(entry.key));

  const leaning = resolvable
    .filter((entry) => entry.lean > 0 && entry.support >= 2)
    .slice()
    .sort((left, right) => right.lean * Math.sqrt(right.support) - left.lean * Math.sqrt(left.support));

  const chosen =
    leaning.length > 0
      ? leaning
      : resolvable.slice().sort((left, right) => right.support - left.support || right.lean - left.lean);

  return chosen.slice(0, GENRE_SEEDS).flatMap((entry) => {
    const genreId = vocabulary.get(entry.key);
    return genreId === undefined ? [] : [{ genreId, name: entry.label }];
  });
}

/**
 * Artist seeds: the artists behind the member's TOP 3 RATED ALBUMS.
 *
 * Top-rated rather than top-affinity, because the neighbour term's enthusiasm factor reads the
 * seed album's own rating, so the seed has to BE an album the member rated rather than an
 * aggregate over several. Ties broken on album id so the seed set is stable between renders
 * and the evaluation harness reproduces.
 */
function artistSeeds(
  rated: Array<{ albumId: number; artistId: number; artistName: string; rating: number }>,
): NeighbourSeed[] {
  const ordered = rated.slice().sort((left, right) => right.rating - left.rating || left.albumId - right.albumId);

  const seeds: NeighbourSeed[] = [];
  const seen = new Set<number>();
  for (const album of ordered) {
    if (seen.has(album.artistId)) continue;
    seen.add(album.artistId);
    seeds.push({ artistId: album.artistId, name: album.artistName, rating: album.rating });
    if (seeds.length >= ARTIST_SEEDS) break;
  }
  return seeds;
}

/** Labels the member rates above their own mean. Weakest axis, so the widest filter. */
function labelSeeds(profile: TasteProfile): Affinity[] {
  return profile.labels.filter((entry) => entry.lean > 0 && entry.support >= 2).slice(0, LABEL_SEEDS);
}

/* ========================================================================== *
 * The pool
 * ========================================================================== */

/**
 * One retrieved album, before hydration.
 *
 * `summary` is null for the two LOCAL sources — those rows are already mirrored, so there is
 * nothing to cache. `knownArtistId` is NOT an optimisation: `GET /artist/{id}/albums` returns
 * summaries with NO `artist` OBJECT AT ALL (verified — the keys are id, title, link, cover*,
 * md5_image, genre_id, fans, release_date, record_type, tracklist, explicit_lyrics, type), so
 * without it `cacheAlbumSummaries` cannot attribute the row and drops it silently. That exact
 * mistake cost the original 38 dropped rows per discography fill.
 */
type PoolEntry = {
  deezerId: string;
  summary: DeezerAlbumSummary | null;
  knownArtistId: number | null;
  neighbourOf: NeighbourSeed | null;
};

function entriesFrom(
  summaries: DeezerAlbumSummary[],
  knownArtistId: number | null,
  neighbourOf: NeighbourSeed | null,
): PoolEntry[] {
  return summaries.flatMap((summary) => {
    if (!summary?.id) return [];
    return [{ deezerId: String(summary.id), summary, knownArtistId, neighbourOf }];
  });
}

/** Deezer genre NAME (normalised) -> genre id. `genreVocabulary` is the other direction. */
async function genreIdVocabulary(): Promise<Map<string, number>> {
  const vocabulary = new Map<string, number>();
  for (const genre of await getGenres()) {
    if (!genre?.name || typeof genre.id !== "number") continue;
    vocabulary.set(attributeKey(genre.name), genre.id);
  }
  return vocabulary;
}

/** SOURCE 1 — the member's genre lanes, two pages each. */
async function byGenre(seeds: Array<{ genreId: number }>): Promise<PoolEntry[]> {
  const pages = await Promise.all(
    seeds.flatMap((seed) =>
      Array.from({ length: GENRE_PAGES }, (_, page) => chartAlbums(seed.genreId, SOURCE_PAGE, page * SOURCE_PAGE)),
    ),
  );
  return pages.flatMap((summaries) => entriesFrom(summaries, null, null));
}

/**
 * SOURCE 2 — artists inside the member's genre lanes, then those artists' albums.
 *
 * THE INTERSECTION SUBSTITUTE. TMDB joins `with_genres` with a comma meaning AND, so the
 * original could ask for "Sci-Fi AND Mystery" directly and *requiring two of a member's genres
 * at once is what separated a hard-SF viewer from a psychological-thriller one.* DEEZER HAS NO
 * SUCH JOIN, so the two-genre intersection becomes post-filtering against the mirrored `genres`
 * jsonb — which is why this source exists instead: an artist who is representative of a lane
 * brings a whole catalogue with them, which is a different and deeper pool than one more page
 * of the same chart.
 */
async function byGenreArtists(seeds: Array<{ genreId: number }>): Promise<PoolEntry[]> {
  const entries: PoolEntry[] = [];

  for (const seed of seeds) {
    const found = await genreArtists(seed.genreId, SOURCE_PAGE);
    for (const candidate of found.slice(0, GENRE_ARTISTS_PER_SEED)) {
      if (!candidate?.id) continue;
      // `ensureArtist` returns the mirror WITHOUT a provider call when the row is fresh, so on a
      // warm instance this is free. It is needed at all because the album summaries below carry
      // no artist object and `cacheAlbumSummaries` needs a local artist id to attribute them.
      const artist = await ensureArtist(String(candidate.id));
      if (!artist) continue;
      const summaries = await getArtistAlbums(artist.deezerId, SOURCE_PAGE);
      entries.push(...entriesFrom(summaries, artist.id, null));
    }
  }

  return entries;
}

/**
 * SOURCE 3 — the NEIGHBOUR GRAPH, and the reason ranking works at all.
 *
 * Read from the `artist_similar` TABLE, not from a live provider call: /for-you fans out over
 * the member's top artists, and re-fetching the neighbour set on every render would dominate
 * the outbound budget. The table is filled by `ensureArtistSimilar` during ingest.
 *
 * ORDERED BY `position`, which is the provider's own relatedness order. Re-sorting by fans was
 * the rejected alternative: it turns a similarity list into a popularity list, and then every
 * artist's neighbours become the same five household names.
 *
 * THE PROVENANCE IS ATTACHED HERE, NOT RECONSTRUCTED LATER. Once the pools are flattened the
 * fact that an album arrived via this seed rather than via the chart is gone, and that fact is
 * the strongest signal available.
 */
async function bySimilarArtist(seeds: NeighbourSeed[]): Promise<PoolEntry[]> {
  if (seeds.length === 0) return []; // `IN ()` is invalid SQL
  const seedIds = seeds.map((seed) => seed.artistId);
  const byId = new Map(seeds.map((seed) => [seed.artistId, seed]));

  const neighbours = await db
    .select({
      seedId: artistSimilar.artistId,
      similarId: artistSimilar.similarId,
      deezerId: artists.deezerId,
    })
    .from(artistSimilar)
    .innerJoin(artists, eq(artists.id, artistSimilar.similarId))
    .where(inArray(artistSimilar.artistId, seedIds))
    .orderBy(asc(artistSimilar.artistId), asc(artistSimilar.position));

  const perSeed = new Map<number, number>();
  const entries: PoolEntry[] = [];
  for (const neighbour of neighbours) {
    const taken = perSeed.get(neighbour.seedId) ?? 0;
    if (taken >= NEIGHBOURS_PER_SEED) continue;
    perSeed.set(neighbour.seedId, taken + 1);

    const seed = byId.get(neighbour.seedId);
    if (!seed) continue;
    const summaries = await getArtistAlbums(neighbour.deezerId, SOURCE_PAGE);
    entries.push(...entriesFrom(summaries, neighbour.similarId, seed));
  }

  return entries;
}

/**
 * SOURCE 4 — mirrored albums on a label the member leans toward. LOCAL SQL, NO PROVIDER CALL.
 *
 * Deezer has no label endpoint, which is the concrete reason this axis is weighted lowest of
 * the three: it can only ever retrieve what somebody else has already caused to be mirrored.
 */
async function byLabel(seeds: Affinity[]): Promise<PoolEntry[]> {
  if (seeds.length === 0) return []; // `IN ()` is invalid SQL
  const keys = seeds.map((seed) => seed.key);

  const rows = await db
    .select({ deezerId: albums.deezerId })
    .from(albums)
    .where(
      and(
        sql`lower(${albums.label}) IN (${sql.join(
          keys.map((key) => sql`${key}`),
          sql`, `,
        )})`,
        // albums.is_canonical — the "specials" exclusion. A non-canonical release must never
        // enter a completion denominator, a discography heatmap row, or a recommendation pool.
        // COPY THIS COMMENT next to any new query that filters on it; the television version's
        // "season_number > 0" was pasted into three CTEs precisely because it is easy to omit
        // in a fourth.
        eq(albums.isCanonical, true),
        sql`jsonb_array_length(${albums.genres}) > 0`,
        sql`${albums.fans} >= ${MIN_NOTABILITY_FANS}`,
      ),
    )
    .orderBy(desc(albums.fans), desc(albums.id))
    .limit(LOCAL_POOL);

  return rows.map((row) => ({ deezerId: row.deezerId, summary: null, knownArtistId: null, neighbourOf: null }));
}

/** SOURCE 5 — the global chart. genreId 0 is "All". */
async function chartPool(): Promise<PoolEntry[]> {
  return entriesFrom(await chartAlbums(0, SOURCE_PAGE), null, null);
}

/** SOURCE 6 — charting artists, then their albums. Same `ensureArtist` reason as source 2. */
async function chartArtistPool(): Promise<PoolEntry[]> {
  const found = await chartArtists(0, SOURCE_PAGE);
  const entries: PoolEntry[] = [];
  for (const candidate of found.slice(0, CHART_ARTISTS)) {
    if (!candidate?.id) continue;
    const artist = await ensureArtist(String(candidate.id));
    if (!artist) continue;
    entries.push(...entriesFrom(await getArtistAlbums(artist.deezerId, SOURCE_PAGE), artist.id, null));
  }
  return entries;
}

/**
 * SOURCE 7 — **A SOURCE THE TELEVISION VERSION COULD NOT HAVE.**
 *
 * Mirrored albums carrying at least `LOCAL_RATING_FLOOR` distinct member ratings that this
 * member has not logged. It is THE MEMBER COMMUNITY AS A RETRIEVAL SOURCE, and unlike every
 * other source here IT IMPROVES AS THE INSTANCE GROWS: on a fresh deployment it returns
 * nothing, and on a busy one it is the only source that knows what the people using this
 * particular site actually listen to. The recommender stays content-based — no member's
 * ratings predict another's here — but what the community has bothered to rate is a better
 * pool than what Deezer is promoting this week.
 *
 * THE `DISTINCT ON (user_id, album_id)` IS NOT OPTIONAL (I-10). A replay is a new row, so a
 * plain COUNT would let one enthusiastic member clear a floor of three on their own. And
 * `(rating IS NOT NULL) DESC` in the same ORDER BY is what stops a later unrated replay mark
 * withdrawing that member's rating (I-11) — which matters more in music than in television,
 * because relistening is the norm rather than the exception.
 *
 * `u.is_guest = false` because this IS a community aggregate and there is no database-level
 * guard (I-12).
 */
async function localHighRated(userId: number): Promise<PoolEntry[]> {
  const result = await db.execute<{ deezer_id: string }>(sql`
    WITH scoped AS (
      SELECT DISTINCT ON (l.user_id, l.album_id) l.user_id, l.album_id, l.rating
      FROM logs l
      JOIN users u ON u.id = l.user_id
      WHERE l.album_id IS NOT NULL
        AND l.target_type = 'album'
        AND u.is_guest = false
      ORDER BY l.user_id, l.album_id, (l.rating IS NOT NULL) DESC, l.created_at DESC
    )
    SELECT a.deezer_id
    FROM scoped s
    JOIN albums a ON a.id = s.album_id
    WHERE s.rating IS NOT NULL
      -- albums.is_canonical: the "specials" exclusion. A non-canonical release must never
      -- enter a completion denominator, a discography heatmap row, or a recommendation pool.
      AND a.is_canonical = true
      AND jsonb_array_length(a.genres) > 0
      AND a.fans >= ${MIN_NOTABILITY_FANS}
      AND NOT EXISTS (
        SELECT 1 FROM logs mine WHERE mine.user_id = ${userId} AND mine.album_id = a.id
      )
    GROUP BY a.id, a.deezer_id
    HAVING COUNT(*) >= ${LOCAL_RATING_FLOOR}
    ORDER BY AVG(s.rating) DESC, COUNT(*) DESC, a.id DESC
    LIMIT ${LOCAL_POOL}
  `);

  return result.rows.map((row) => ({
    deezerId: String(row.deezer_id),
    summary: null,
    knownArtistId: null,
    neighbourOf: null,
  }));
}

/* ========================================================================== *
 * Hydration
 * ========================================================================== */

/**
 * The model's input projection, deliberately narrower than `AlbumRow`.
 *
 * It exists separately for one reason `AlbumRow` cannot serve: the country axis needs
 * `artists.country`, which `albumRowColumns` does not project because no card renders it. It is
 * also narrower on purpose — cover paths, slugs, popularity and durations are for the render
 * payload, which is fetched once at the end through `getAlbumsByIds` for exactly the rows being
 * returned rather than for the whole pool.
 */
async function hydrate(deezerIds: string[]): Promise<Map<string, Omit<CandidateAlbum, "neighbourOf">>> {
  const hydrated = new Map<string, Omit<CandidateAlbum, "neighbourOf">>();
  if (deezerIds.length === 0) return hydrated; // `IN ()` is invalid SQL

  const rows = await db
    .select({
      id: albums.id,
      deezerId: albums.deezerId,
      mbid: albums.mbid,
      title: albums.title,
      genres: albums.genres,
      tags: albums.tags,
      artistId: albums.artistId,
      artistName: artists.name,
      artistCountry: artists.country,
      label: albums.label,
      releaseDate: albums.releaseDate,
      originalReleaseDate: albums.originalReleaseDate,
      meanTrackMs: albums.meanTrackMs,
      trackCount: albums.trackCount,
      criticScore: albums.criticScore,
      criticVotes: albums.criticVotes,
      fans: albums.fans,
      isCanonical: albums.isCanonical,
    })
    .from(albums)
    .innerJoin(artists, eq(artists.id, albums.artistId))
    .where(inArray(albums.deezerId, [...new Set(deezerIds)]));

  for (const row of rows) {
    // `releaseDate` and `originalReleaseDate` are STRINGS — Drizzle maps `date` to a string and
    // `timestamptz` to a Date, and mixing them silently produces "Invalid Date" (I-9).
    const year = releaseYear(row.originalReleaseDate ?? row.releaseDate);
    hydrated.set(row.deezerId, {
      id: row.id,
      deezerId: row.deezerId,
      mbid: row.mbid,
      title: row.title,
      genres: row.genres ?? [],
      tags: row.tags ?? [],
      artistId: row.artistId,
      artistName: row.artistName,
      artistCountry: row.artistCountry,
      label: row.label,
      year: year === null ? null : Number(year),
      meanTrackMs: row.meanTrackMs,
      trackCount: row.trackCount,
      criticScore: row.criticScore,
      criticVotes: row.criticVotes,
      fans: row.fans,
      isCanonical: row.isCanonical,
    });
  }

  return hydrated;
}

/**
 * THE THREE HARD FILTERS, applied before anything is scored.
 *
 *  1. `genres.length > 0` — *ranking something the model knows nothing about is worse than
 *     omitting it.* Measured in the original: 53 of 100 recommendations were attribute-less
 *     before this filter, and every one of them was a number with nothing behind it.
 *  2. `fans >= MIN_NOTABILITY_FANS` — **NOT A QUALITY BAR, A NOTABILITY ONE.** Below it a crowd
 *     average is noise. `fans` is popularity and is never rendered as a rating.
 *  3. `is_canonical = true` — the "specials" exclusion. A non-canonical release must never
 *     enter a completion denominator, a discography heatmap row, or a recommendation pool.
 */
function passesHardFilters(candidate: Omit<CandidateAlbum, "neighbourOf">): boolean {
  return candidate.genres.length > 0 && candidate.fans >= MIN_NOTABILITY_FANS && candidate.isCanonical;
}

/* ========================================================================== *
 * getRecommendations
 * ========================================================================== */

type Scored = { candidate: CandidateAlbum; prediction: AlbumPrediction; score: number };

function scoreAll(profile: TasteProfile, candidates: CandidateAlbum[]): Scored[] {
  return candidates.map((candidate) => {
    const prediction = predictAlbumRating(profile, candidate);
    return { candidate, prediction, score: rankingScore(profile, prediction) };
  });
}

/** Ranked by `rankingScore`, tie-broken by `fans DESC` and then id so the order is total. */
function rank(scored: Scored[]): Scored[] {
  return scored
    .slice()
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.candidate.fans - left.candidate.fans ||
        left.candidate.id - right.candidate.id,
    );
}

/**
 * Dedupe by `albumIdentity`, keeping the FIRST occurrence — which, because this runs after the
 * rank, is the highest-scoring edition of the record.
 */
function dedupeByIdentity(scored: Scored[]): Scored[] {
  const seen = new Set<string>();
  const kept: Scored[] = [];
  for (const entry of scored) {
    const identity = albumIdentity(entry.candidate);
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push(entry);
  }
  return kept;
}

/**
 * The member's ranked albums, or one of three refusals.
 *
 * THE ORDER OF THE FIRST FOUR STEPS IS LOAD-BEARING. The no-variety gate is checked BEFORE ANY
 * PROVIDER CALL, because a member whose ratings are all 8 cannot be helped by a better pool —
 * every candidate would land within a few hundredths of every other — and spending forty
 * outbound requests to produce ten indistinguishable predictions is worse than saying there is
 * nothing to say yet.
 */
export async function getRecommendations(userId: number, limit = 12): Promise<RecommendationResult> {
  const rated = await getRatedAlbumsForTaste(userId);

  /* ---- GATE 1 — too few ratings ------------------------------------------------------- */
  if (rated.length < MIN_RATED_ALBUMS) {
    return {
      status: "too-few",
      ratedAlbums: rated.length,
      needed: MIN_RATED_ALBUMS,
      title: "Not enough to go on yet",
      // Naming the track path matters: a member who only rates tracks would otherwise read this
      // as "album ratings only" and conclude the feature is not for them.
      detail: "An album rating counts, and so does rating individual tracks.",
    };
  }

  const profile = buildTasteProfile(rated);

  /* ---- GATE 2 — no variety. BEFORE ANY PROVIDER CALL. --------------------------------- */
  if (profile.spread < NO_VARIETY_SPREAD) {
    return {
      status: "no-variety",
      ratedAlbums: rated.length,
      title: "Your ratings are too alike",
      // "The gaps are the signal" is kept WORD FOR WORD from the television original. It says
      // nothing about the domain and it is the best single sentence in that codebase.
      detail:
        "Rating the things you disliked helps more than rating the things you loved. The gaps are the signal.",
    };
  }

  /* ---- Seeds and exclusions ----------------------------------------------------------- */
  const [exclusions, vocabulary] = await Promise.all([loadExclusions(userId), genreIdVocabulary()]);
  const genres = genreSeeds(profile, vocabulary);
  const neighbours = artistSeeds(rated);
  const labels = labelSeeds(profile);

  /* ---- SEVEN SOURCES IN ONE Promise.all ----------------------------------------------- */
  //
  // Parallel ACROSS sources and sequential WITHIN the two that fan out over artists, which is
  // the compromise the outbound budget allows: seven concurrent requests is fine, seven
  // concurrent fan-outs of four requests each is not.
  const pools = await Promise.all([
    byGenre(genres),
    byGenreArtists(genres),
    bySimilarArtist(neighbours),
    byLabel(labels),
    chartPool(),
    chartArtistPool(),
    localHighRated(userId),
  ]);

  /* ---- Flatten, keeping the best provenance per album --------------------------------- */
  //
  // ON COLLISION THE HIGHEST-RATED SOURCE WINS: an album reached both through the chart and
  // through a neighbour of a 9-rated record keeps the neighbour, and one reached through two
  // neighbours keeps the better-loved seed. A null provenance always loses to a real one.
  const pool = new Map<string, PoolEntry>();
  for (const entries of pools) {
    for (const entry of entries) {
      const existing = pool.get(entry.deezerId);
      if (!existing) {
        pool.set(entry.deezerId, entry);
        continue;
      }
      const incoming = entry.neighbourOf?.rating ?? -Infinity;
      const held = existing.neighbourOf?.rating ?? -Infinity;
      if (incoming > held) {
        pool.set(entry.deezerId, { ...entry, summary: entry.summary ?? existing.summary });
      } else if (existing.summary === null && entry.summary !== null) {
        // Keep the provenance we hold, but take the summary so the row can still be mirrored.
        pool.set(entry.deezerId, { ...existing, summary: entry.summary, knownArtistId: entry.knownArtistId });
      }
    }
  }

  if (pool.size === 0) return coldPool(rated.length);

  /* ---- Mirror the summaries ----------------------------------------------------------- */
  //
  // BATCHED BY `knownArtistId`, because that argument is the FALLBACK for summaries that carry
  // no artist object of their own, and one batch cannot carry two different fallbacks.
  //
  // SEQUENTIAL, not `Promise.all`: each batch resolves artist stubs and then runs a bulk upsert,
  // and PGlite allows exactly one writer. This is a write-behind for a surface that has not
  // rendered yet, so the latency is paid once on a cold pool and never on a warm one.
  const batches = new Map<number | null, DeezerAlbumSummary[]>();
  for (const entry of pool.values()) {
    if (!entry.summary) continue;
    const batch = batches.get(entry.knownArtistId);
    if (batch) batch.push(entry.summary);
    else batches.set(entry.knownArtistId, [entry.summary]);
  }
  for (const [knownArtistId, summaries] of batches) {
    await cacheAlbumSummaries(summaries, knownArtistId ?? undefined);
  }

  /* ---- Hydrate, filter, exclude ------------------------------------------------------- */
  const hydrated = await hydrate([...pool.keys()]);

  const candidates: CandidateAlbum[] = [];
  for (const [deezerId, entry] of pool) {
    const row = hydrated.get(deezerId);
    if (!row) continue; // the summary cache write failed, or the row was never mirrored
    if (!passesHardFilters(row)) continue;
    if (exclusions.ids.has(row.id)) continue;
    // Identity exclusion, not just id exclusion — or the list fills with remasters of records
    // the listener already rated.
    if (exclusions.identities.has(albumIdentity(row))) continue;
    candidates.push({ ...row, neighbourOf: entry.neighbourOf });
  }

  if (candidates.length === 0) return coldPool(rated.length);

  /* ---- Score, rank, dedupe, shortlist ------------------------------------------------- */
  const shortlistSize = Math.max(limit * SHORTLIST_MULTIPLIER, DETAIL_SYNC_LIMIT * 2);
  let shortlist = dedupeByIdentity(rank(scoreAll(profile, candidates))).slice(0, shortlistSize);

  /* ---- Detail-sync the top few, SEQUENTIALLY, and re-score ---------------------------- */
  //
  // A summary carries no label, no mean track length, no track count and no critic score — so
  // THREE OF THE MODEL'S SIGNALS ARE STRUCTURALLY INERT for an un-synced candidate, and the
  // re-score is what makes the top of the list reflect the whole formula rather than the genre
  // axis alone.
  //
  // EIGHT, AND SEQUENTIAL. The original syncs 18 in parallel; here each sync is a Deezer detail
  // call plus a tracklist call plus an optional MusicBrainz lookup against a ~1 req/s provider,
  // so 18 in parallel would violate the outbound budget outright. Lower as well as serialised,
  // because the cached `artist_similar` table removes most of the reason the original needed a
  // wide sync at all.
  const toSync = shortlist.slice(0, DETAIL_SYNC_LIMIT);
  for (const entry of toSync) {
    await ensureAlbum(entry.candidate.deezerId); // sequential ON PURPOSE
  }

  if (toSync.length > 0) {
    const refreshed = await hydrate(toSync.map((entry) => entry.candidate.deezerId));
    const rescored = shortlist.map((entry) => {
      const row = refreshed.get(entry.candidate.deezerId);
      if (!row) return entry;
      // A detail sync can reveal that a record is NOT canonical after all — MusicBrainz owns
      // `is_canonical` and a summary only had the title regex to go on — so the hard filters are
      // re-applied rather than trusted from the first pass.
      if (!passesHardFilters(row)) return null;
      const candidate: CandidateAlbum = { ...row, neighbourOf: entry.candidate.neighbourOf };
      const prediction = predictAlbumRating(profile, candidate);
      return { candidate, prediction, score: rankingScore(profile, prediction) };
    });
    shortlist = dedupeByIdentity(rank(rescored.filter((entry): entry is Scored => entry !== null)));
  }

  const top = shortlist.slice(0, limit);
  if (top.length === 0) return coldPool(rated.length);

  /* ---- The render payload, for exactly the rows being returned ------------------------ */
  //
  // `getAlbumsByIds` RETURNS ROWS IN THE ORDER THE IDS WERE GIVEN, which is what preserves the
  // ranking — the database's natural order would silently discard it.
  const rows = await getAlbumsByIds(top.map((entry) => entry.candidate.id));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const items: Recommendation[] = top.flatMap((entry) => {
    const album = byId.get(entry.candidate.id);
    if (!album) return []; // deleted between two statements: shorten the list, do not crash
    return [
      {
        album,
        // THE MODEL'S ACTUAL ESTIMATE, not `entry.score`. The ranking score is shrunk toward the
        // member's mean by confidence and exists only to order the list; showing it would be a
        // number distorted for sorting, which is a worse dishonesty than the one it fixes.
        rating: entry.prediction.rating,
        confidence: entry.prediction.confidence,
        reasons: entry.prediction.reasons,
        neighbourOf: entry.candidate.neighbourOf,
      },
    ];
  });

  if (items.length === 0) return coldPool(rated.length);
  return { status: "ok", items, profile, ratedAlbums: rated.length };
}

/** GATE 3 — the pool came back empty. Its own copy, because it is its own situation. */
function coldPool(ratedAlbums: number): RecommendationResult {
  return {
    status: "cold-pool",
    ratedAlbums,
    title: "Nothing new to suggest",
    detail:
      "Everything the catalogue can reach from your ratings is already in your diary or your wantlist. " +
      "Rate something outside your usual lane and this fills up again.",
  };
}

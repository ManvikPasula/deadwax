/**
 * MusicBrainz -> database columns. PURE.
 *
 * This file contains THE SINGLE MOST DANGEROUS FUNCTION IN THE PORT, and it is three lines
 * long. See `mbRatingToStored`.
 */

import { NON_CANONICAL_SECONDARY_TYPES } from "@/lib/canonical";

import type { MbArtist, MbGenre, MbRating, MbReleaseGroup, MbTag } from "./index";

/**
 * THE ONE SCALE BRIDGE IN THE ENTIRE CODEBASE.
 *
 * MusicBrainz rates on 0..5. Member ratings are stored as 1..10 integers, and every community
 * average, histogram bucket, colour bracket and `<Stars>` render speaks that stored 0..10
 * scale. The television original got the equivalent conversion for free, because TMDB's
 * `vote_average` is already 0..10 — the brief is explicit that this is "accidental and
 * fragile" and that its music equivalent is "the single sharpest hazard in the port", because
 * passing 4.5 where 9 is expected renders a 2.25-star bar with no error anywhere.
 *
 * It is closed by structure, not by care:
 *   1. The two scales meet HERE and nowhere else.
 *   2. `albums.critic_score` and `artists.critic_score` are documented at their declaration as
 *      "already on the stored 0..10 scale".
 *   3. A test pins mbRatingToStored(4.5) === 9, and another asserts a member average and a
 *      critic score of the same stored number render the same width.
 *
 * If you ever add a second provider with a rating, convert it here too. Do not convert at a
 * call site.
 */
export function mbRatingToStored(value: number): number {
  return Math.round(value * 2 * 10) / 10;
}

/**
 * A rating becomes a column pair, and ZERO VOTES BECOMES NULL — never 0.
 *
 * A release with no votes reports NO SCORE rather than a measured zero. Storing 0 would paint
 * it as the worst record ever made, put it at the bottom of every sort, and colour its heatmap
 * cell in the "Garbage" bracket. This is the same rule the television original applies to
 * unaired episodes, and for the same reason.
 */
export function mapRating(rating: MbRating | null | undefined): { score: number | null; votes: number } {
  const votes = Math.max(0, Math.round(rating?.["votes-count"] ?? 0));
  const raw = rating?.value;
  if (!votes || raw === null || raw === undefined || !Number.isFinite(raw)) {
    return { score: null, votes: 0 };
  }
  return { score: mbRatingToStored(raw), votes };
}

/**
 * Tags and genres are NOT interchangeable, and probing made the difference stark.
 *
 * `genres` is curated and count-weighted: Radiohead returns
 *   alternative rock(42), art rock(29), art pop(3), ambient pop(1), britpop(1)
 * `tags` is unmoderated free text: Kid A carries SIXTY, including "apathetic", "owned",
 * "male vocalist", the bare year "2000", and
 *   "discogs/the most popular album released every year from 1950 to 2020".
 *
 * So `genres` leads and `tags` only supplements, both filtered to `count >= 2`. Without the
 * count filter the recommender's attribute space explodes: the brief predicts that a
 * candidate then matches 8+ keys, coverage saturates for everything, and the
 * "shares nothing at all" penalty stops firing entirely.
 */
const TAG_STOPLIST = new Set([
  "owned",
  "wishlist",
  "seen live",
  "favourites",
  "favorites",
  "male vocalist",
  "female vocalist",
  "male vocalists",
  "female vocalists",
  "albums i own",
  "vinyl",
  "cd",
  "spotify",
  "british",
  "american",
  "english",
]);

const MIN_TAG_COUNT = 2;
const MAX_ATTRIBUTES = 25;

function isUsefulTag(name: string): boolean {
  const lower = name.toLowerCase().trim();
  if (!lower || lower.length < 2 || lower.length > 40) return false;
  if (TAG_STOPLIST.has(lower)) return false;
  if (/^\d{2,4}s?$/.test(lower)) return false; // bare years and decades: "2000", "80s"
  if (lower.includes("/")) return false; // "discogs/..." list names
  return true;
}

export function mbTagsToAttributes(
  genres: MbGenre[] | null | undefined,
  tags: MbTag[] | null | undefined,
): string[] {
  const weighted = new Map<string, number>();

  // Genres first and at double weight, so that when the slice bites it is the curated
  // vocabulary that survives.
  for (const genre of genres ?? []) {
    const count = genre.count ?? 0;
    if (count < MIN_TAG_COUNT || !isUsefulTag(genre.name)) continue;
    const key = genre.name.toLowerCase().trim();
    weighted.set(key, Math.max(weighted.get(key) ?? 0, count * 2));
  }

  for (const tag of tags ?? []) {
    const count = tag.count ?? 0;
    if (count < MIN_TAG_COUNT || !isUsefulTag(tag.name)) continue;
    const key = tag.name.toLowerCase().trim();
    weighted.set(key, Math.max(weighted.get(key) ?? 0, count));
  }

  return [...weighted.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ATTRIBUTES)
    .map(([name]) => name);
}

/**
 * The release-group first-release date.
 *
 * ALWAYS PREFER THIS over the provider's per-release date, or every remaster reads as a recent
 * album — which then poisons the recommender's era term, the "new releases" rail and every
 * chronological discography row. Probing confirmed MusicBrainz already does the collapsing:
 * the release group for OK Computer reports 1997-05-21 even when reached via the 2017 OKNOTOK
 * reissue title.
 *
 * Accepts YYYY and YYYY-MM, like the Deezer mapper, and normalises to the start of the period.
 */
export function firstReleaseDate(group: Pick<MbReleaseGroup, "first-release-date">): string | null {
  const raw = group["first-release-date"]?.trim();
  if (!raw) return null;
  if (/^\d{4}$/.test(raw)) return `${raw}-01-01`;
  if (/^\d{4}-\d{2}$/.test(raw)) return `${raw}-01`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  return year >= 1860 && year <= 2200 ? raw : null;
}

export function secondaryTypes(group: Pick<MbReleaseGroup, "secondary-types">): string[] {
  return (group["secondary-types"] ?? []).filter(Boolean);
}

/** True when any secondary type disqualifies the release from a discography grid. */
export function hasNonCanonicalType(group: Pick<MbReleaseGroup, "secondary-types">): boolean {
  return secondaryTypes(group).some((type) => NON_CANONICAL_SECONDARY_TYPES.has(type.toLowerCase()));
}

export type AlbumEnrichment = {
  mbid: string;
  criticScore: number | null;
  criticVotes: number;
  tags: string[];
  originalReleaseDate: string | null;
  secondaryTypes: string[];
  primaryType: string | null;
  /**
   * The ARTIST's MBID, harvested from the release group's `artist-credit`.
   *
   * Free — the lookup already passes `inc=artists` — and it is the only cheap way to get one.
   * Without it, artist enrichment can never run: it needs an MBID to look up, resolving one by
   * search would cost a request per artist against the flakiest provider in the stack, and so
   * `artists.critic_score` would stay permanently null even though probing proved MusicBrainz
   * rates artists too (Radiohead: 4.5 from 80 votes).
   */
  artistMbid: string | null;
};

export function mapAlbumEnrichment(group: MbReleaseGroup): AlbumEnrichment {
  const rating = mapRating(group.rating);
  return {
    mbid: group.id,
    artistMbid: group["artist-credit"]?.[0]?.artist?.id ?? null,
    criticScore: rating.score,
    criticVotes: rating.votes,
    tags: mbTagsToAttributes(group.genres, group.tags),
    originalReleaseDate: firstReleaseDate(group),
    secondaryTypes: secondaryTypes(group),
    primaryType: group["primary-type"] ?? null,
  };
}

export type ArtistEnrichment = {
  mbid: string;
  country: string | null;
  beganOn: string | null;
  endedOn: string | null;
  criticScore: number | null;
  criticVotes: number;
  tags: string[];
};

export function mapArtistEnrichment(artist: MbArtist): ArtistEnrichment {
  const rating = mapRating(artist.rating);
  const span = artist["life-span"] ?? {};
  const partial = (value: string | null | undefined): string | null => {
    if (!value) return null;
    if (/^\d{4}$/.test(value)) return `${value}-01-01`;
    if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  };
  return {
    mbid: artist.id,
    // Two digits only. MusicBrainz sometimes reports a multi-country area with no `country`,
    // in which case this is null and the recommender's country term simply does not fire —
    // which is correct: an absent attribute must not become a penalty.
    country: artist.country && /^[A-Z]{2}$/.test(artist.country) ? artist.country : null,
    beganOn: partial(span.begin),
    endedOn: partial(span.end),
    criticScore: rating.score,
    criticVotes: rating.votes,
    tags: mbTagsToAttributes(artist.genres, artist.tags),
  };
}

/**
 * The "specials" exclusion, and album identity. Pure — no I/O, unit tested.
 *
 * Television's non-canonical items are season 0, detectable with `season_number > 0`. Music
 * has no numeric sentinel, and this is HARDER than the television case rather than easier:
 * the noise is spread across a provider field (`record_type`), a MusicBrainz field
 * (`secondary-types`) and, when neither is available, the title itself.
 *
 * Two jobs live here, and they are different jobs:
 *
 *   isCanonicalRelease()  — may this release enter a completion denominator, a discography
 *                           heatmap row, or a recommendation pool?
 *   albumIdentity()       — are these two rows THE SAME RECORD in different clothes?
 *
 * The second is the one the brief warns gets underestimated. In television, duplicates are
 * occasional regional variants. In music the same album exists as original / remaster /
 * deluxe / 2CD / Japanese pressing / vinyl reissue, WITH DIFFERENT TITLES AND DIFFERENT
 * YEARS — so title+year would dedupe almost nothing.
 */

/**
 * MusicBrainz secondary types that make a release non-canonical.
 *
 * Lower-cased for comparison. "Compilation" appears here and in the Deezer record_type check
 * because the two providers disagree often enough that trusting either alone lets greatest-hits
 * packages into a discography grid.
 */
export const NON_CANONICAL_SECONDARY_TYPES = new Set([
  "compilation",
  "live",
  "remix",
  "soundtrack",
  "dj-mix",
  "mixtape/street",
  "demo",
  "interview",
  "audiobook",
  "audio drama",
  "spokenword",
  "field recording",
]);

/** Deezer record_type values that are canonical studio releases. */
export const CANONICAL_RECORD_TYPES = new Set(["album"]);

/**
 * The last resort, applied only when MusicBrainz has not been reached.
 *
 * Deliberately conservative: it matches suffix-shaped noise, not any occurrence of the words.
 * "Live at Wembley" is excluded; the band Live is not, and neither is an album legitimately
 * titled "Deluxe" on its own. Every entry here is anchored to a bracket, a dash-tail, or the
 * start of a trailing qualifier.
 */
export const TITLE_NOISE =
  /(?:\(|\[|\s[-–—]\s)\s*(?:deluxe|super\s*deluxe|expanded|remaster(?:ed)?|anniversary|bonus|special\s+edition|collector'?s?\s+edition|legacy\s+edition|reissue|mono|stereo|instrumental(?:s)?|karaoke|acoustic\s+version|live\s+(?:at|from|in)|demos?|b[-\s]?sides|rarities|the\s+complete)\b|\b(?:\d{4}\s+remaster(?:ed)?|remaster(?:ed)?\s+\d{4})\b|^\s*(?:live\s+(?:at|from|in)\b)/i;

export type CanonicalInput = {
  /** Deezer record_type: album | single | ep | compilation */
  recordType?: string | null;
  /** MusicBrainz secondary-types. Empty array is meaningful: it means "checked, and clean". */
  secondaryTypes?: string[] | null;
  /** MusicBrainz primary-type: Album | Single | EP | Broadcast | Other */
  primaryType?: string | null;
  title: string;
  /** True when MusicBrainz has actually been consulted for this row. */
  musicbrainzKnown?: boolean;
};

/**
 * A non-canonical release must never enter a completion denominator, a discography heatmap
 * row, or a recommendation pool.
 *
 * COPY THIS COMMENT next to any new query that filters on `albums.is_canonical`. The
 * television original pasted its `season_number > 0` comment into three CTEs precisely
 * because it is easy to omit in a fourth — and the failure mode is silent: nine specials mark
 * an unfinished show finished, and here a deluxe edition's bonus tracks substitute for real
 * ones and mark a discography complete.
 */
export function isCanonicalRelease(input: CanonicalInput): boolean {
  const recordType = (input.recordType ?? "album").toLowerCase();
  if (!CANONICAL_RECORD_TYPES.has(recordType)) return false;

  const primary = (input.primaryType ?? "album").toLowerCase();
  if (primary !== "album") return false;

  const secondary = (input.secondaryTypes ?? []).map((type) => type.toLowerCase());
  if (secondary.some((type) => NON_CANONICAL_SECONDARY_TYPES.has(type))) return false;

  // When MusicBrainz HAS been consulted and reported no secondary types, trust it over the
  // title regex — MusicBrainz's editors have already made this judgement, and a regex second
  // -guessing them is how "Sgt. Pepper's Lonely Hearts Club Band" gets thrown out for
  // containing the word "Club".
  if (input.musicbrainzKnown && secondary.length === 0) return true;

  return !TITLE_NOISE.test(input.title);
}

/**
 * Strips trailing qualifiers so two editions of one record compare equal.
 *
 * "Abbey Road (Super Deluxe)"          -> "Abbey Road"
 * "OK Computer - 2017 Remaster"        -> "OK Computer"
 * "Discovery [Bonus Track Version]"    -> "Discovery"
 */
export function stripSuffixes(title: string): string {
  return title
    .replace(/\s*[([{][^)\]}]*[)\]}]\s*$/g, "")
    .replace(/\s+[-–—]\s+.*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalise(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/**
 * A stable identity for "the same record".
 *
 * Prefers the MusicBrainz RELEASE-GROUP mbid, which is authoritative — MusicBrainz already
 * collapses editions into one group, which probing confirmed: searching for
 * "OK Computer OKNOTOK" returns the release group "OK Computer" with first-release-date
 * 1997-05-21, not a 2017 record.
 *
 * Falls back to normalised artist + suffix-stripped title. Deliberately NOT including the
 * year, because the year is exactly what a reissue changes.
 */
export function albumIdentity(album: {
  mbid?: string | null;
  artistName?: string | null;
  artistId?: number | string | null;
  title: string;
}): string {
  if (album.mbid) return `mb:${album.mbid}`;
  const artist = album.artistName ? normalise(album.artistName) : `artist${album.artistId ?? ""}`;
  return `t:${artist}::${normalise(stripSuffixes(album.title))}`;
}

/**
 * "Active" for TTL purposes: a release inside the last 18 months.
 *
 * This is the `in_production` analogue and it is the ONLY thing that decides between the
 * 1-day and 14-day artist refresh windows. 18 months rather than 12 because an artist's
 * release cadence is lumpier than a television season's.
 */
export function isActiveArtist(latestReleaseDate: string | Date | null | undefined, now = new Date()): boolean {
  if (!latestReleaseDate) return false;
  const date = typeof latestReleaseDate === "string" ? new Date(latestReleaseDate) : latestReleaseDate;
  if (Number.isNaN(date.getTime())) return false;
  const months18 = 18 * 30 * 24 * 60 * 60 * 1000;
  return now.getTime() - date.getTime() < months18;
}

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
 * The noise vocabulary, applied only when MusicBrainz has not been reached.
 *
 * TWO PROPERTIES, and the second was learned the hard way.
 *
 * First: a word from this list only disqualifies a release when it appears INSIDE A TRAILING
 * QUALIFIER — a bracketed group or a dash-tail — not anywhere in the title. That is what keeps
 * "Live Through This" and "Demolition Plot J-7" canonical while rejecting
 * "Nevermind (30th Anniversary Super Deluxe)".
 *
 * Second, and more important: **"REMASTERED" AND A BARE "ANNIVERSARY EDITION" ARE NOT NOISE.**
 * The first version of this list rejected them, which is defensible in the abstract and wrong
 * in practice. Resolving a curated list of forty canonical records against the live catalogue
 * showed why: the only edition Deezer stocks of Nevermind, Abbey Road, London Calling,
 * Trans-Europe Express and Daydream Nation is the remaster. A remaster of a studio album IS
 * the studio album — it is the same work, the same tracklist and the same running order — so
 * rejecting it does not exclude a duplicate, it excludes THE ALBUM, and the artist's
 * discography grid loses a row it should have.
 *
 * What genuinely belongs here is a release that is A DIFFERENT KIND OF THING from the studio
 * album: a live recording, a compilation, a karaoke or instrumental version, a demos
 * collection — or a BOX that pads the tracklist far past the record (a "Super Deluxe" or
 * "Complete" edition), because those really do corrupt a completion denominator and really do
 * make a 65-cell row next to a 10-cell one.
 *
 * Duplicate EDITIONS are not this function's job. They are handled at dedup time by
 * albumIdentity(), which is the right place: canonicality asks "is this a studio album?",
 * deduplication asks "have we already got this one?".
 */
const NOISE_WORDS =
  // A BARE `live` is enough HERE but not in WHOLE_TITLE_NOISE, and the asymmetry is the point:
  // this regex only ever runs against an extracted bracketed qualifier or dash-tail, where
  // "(Live)" or "[Live 1972]" is unambiguous. Requiring a preposition — as the whole-title
  // rule must, so that "Live Through This" survives — let "Homogenic (Live)" through.
  /\b(?:live|super\s*deluxe|mega\s*deluxe|box\s*set|the\s+complete|complete\s+(?:recordings|collection|works)|anthology|greatest\s+hits|best\s+of|karaoke|instrumentals?|tribute|originally\s+performed|made\s+famous\s+by|ukulele|demos|b[-\s]?sides|rarities|outtakes|unplugged|in\s+concert|remix(?:es|ed))\b/i;

/**
 * Titles that are non-canonical AS WHOLE TITLES, with no bracket or dash-tail to look inside.
 *
 * The qualifier-extraction approach cannot see these: "Greatest Hits", "MTV Unplugged in New
 * York" and "The Complete Recordings" carry no trailing qualifier at all, so a
 * contents-of-the-qualifier test finds nothing and lets them through. They are a different
 * class and need a different check.
 *
 * Deliberately short. Every entry here is a phrase that cannot plausibly be the title of a
 * studio album, which is a much higher bar than "contains a suspicious word".
 */
const WHOLE_TITLE_NOISE =
  /^\s*live\s+(?:at|from|in|on)\b|\bgreatest\s+hits\b|\bbest\s+of\b|^\s*the\s+(?:complete|very\s+best)\b|\banthology\b|\bunplugged\b|\bin\s+concert\b|\bkaraoke\b|\bthe\s+singles\s+collection\b/i;

/**
 * NOTE the absence of a year-remaster rule here. An earlier version rejected
 * "OK Computer - 2017 Remaster" and "Trans-Europe Express (2009 Remaster)" on exactly that
 * pattern, which turned out to exclude the only edition of those records the catalogue
 * carries. See the NOISE_WORDS docblock.
 */

/**
 * Extracts trailing qualifiers: every bracketed group, plus anything after a spaced dash.
 *
 * Splitting the extraction from the matching is what fixed a real miss. The first version was
 * a single regex anchored so the noise word had to follow the bracket immediately, which let
 * "Nevermind (30th Anniversary Super Deluxe)" through — because the bracket opens on "30th",
 * not on "Anniversary". Real-world qualifiers routinely lead with an ordinal or a year, so
 * position is the wrong thing to anchor on; the CONTENTS of the qualifier are what matter.
 */
function qualifiers(title: string): string[] {
  const found: string[] = [];
  for (const match of title.matchAll(/[([{]([^)\]}]*)[)\]}]/g)) {
    if (match[1]) found.push(match[1]);
  }
  const dashTail = /\s+[-–—]\s+(.+)$/.exec(title);
  if (dashTail?.[1]) found.push(dashTail[1]);
  return found;
}

/** True when a title looks like a non-canonical release. Exported for its test. */
export function hasTitleNoise(title: string): boolean {
  if (WHOLE_TITLE_NOISE.test(title)) return true;
  return qualifiers(title).some((part) => NOISE_WORDS.test(part));
}

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

  return !hasTitleNoise(input.title);
}

/**
 * Strips trailing qualifiers so two editions of one record compare equal.
 *
 * "Abbey Road (Super Deluxe)"          -> "Abbey Road"
 * "OK Computer - 2017 Remaster"        -> "OK Computer"
 * "Discovery [Bonus Track Version]"    -> "Discovery"
 */
/**
 * A trailing edition marker with NO bracket and NO dash around it.
 *
 * The bracketed and dash-separated forms cover most of the catalogue, and they covered none of
 * `DAMN. COLLECTORS EDITION.` — which sat beside `DAMN.` as a second canonical row on the live
 * artist page after every other duplicate had been collapsed. Deezer titles this way often
 * enough to matter, and a bare trailing phrase is invisible to both other rules.
 *
 * THE VOCABULARY IS CLOSED, and it has to be: stripping arbitrary trailing words would merge
 * `Untitled` with `Untitled 3` and two different records would become one. Every word here
 * names a REPACKAGING of an existing record rather than a different record.
 *
 * The leading separator is required, so a record genuinely titled "Deluxe" or "Ultimate" keeps
 * its whole name — there is nothing before the marker to keep, and the regex cannot match.
 *
 * The separator is WHITESPACE ONLY, not whitespace-or-punctuation: `[\s.,]+` ate the full stop
 * in `DAMN. COLLECTORS EDITION.` and returned `DAMN`, which is a different title from `DAMN.`.
 * Identity would not have cared (`normalise` drops punctuation anyway), but this function is
 * public and its contract is to remove a suffix, not to edit the title it leaves behind.
 */
const BARE_EDITION_SUFFIX =
  /\s+(?:the\s+)?(?:\d+(?:st|nd|rd|th)\s+)?(?:anniversary\s+)?(?:super\s+|mega\s+)?(?:deluxe|collector'?s?|special|expanded|limited|anniversary|remastered|remaster|reissue|platinum|ultimate)(?:\s+(?:edition|version|reissue|remaster))?\.?$/i;

export function stripSuffixes(title: string): string {
  return title
    .replace(/\s*[([{][^)\]}]*[)\]}]\s*$/g, "")
    .replace(/\s+[-–—]\s+.*$/g, "")
    // Applied AFTER the bracket and dash rules, so "Abbey Road (Super Deluxe)" is already
    // reduced and this pass has nothing left to do — and "DAMN. COLLECTORS EDITION." is
    // reduced by this pass alone.
    .replace(BARE_EDITION_SUFFIX, "")
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
  return titleIdentity(album);
}

/** The title-only form, always computable. Split out so `albumIdentities` can emit both. */
function titleIdentity(album: {
  artistName?: string | null;
  artistId?: number | string | null;
  title: string;
}): string {
  const artist = album.artistName ? normalise(album.artistName) : `artist${album.artistId ?? ""}`;
  return `t:${artist}::${normalise(stripSuffixes(album.title))}`;
}

/**
 * EVERY identity a row can be recognised by, not just its preferred one.
 *
 * `albumIdentity` returns ONE key, and preferring the mbid is right for a Map — it is the
 * strongest claim available. But it makes the function useless for the job the recommender
 * needs, which is *matching* two rows, because the preferred key is not a property of the
 * record, it is a property of HOW MUCH WE HAPPEN TO KNOW about the row:
 *
 *   album 55  good kid, m.A.A.d city, mbid NULL      -> t:kendricklamar::goodkidmaadcity
 *   album 176 good kid, m.A.A.d city, mbid 499c19c8  -> mb:499c19c8-...
 *
 * Same record, two schemes, never equal. Measured consequence before this existed: six members
 * had rated album 55 and not 176, and /for-you offered 176 to all six — with a predicted star
 * figure and a reason — because the exclusion set held one form and the candidate hydrated as
 * the other. ARCHITECTURE.md section 6.7 promises the opposite ("excludes every album sharing
 * an albumIdentity with anything already logged, or the list fills with remasters of records
 * the listener already rated").
 *
 * So a *set* membership test wants BOTH forms on both sides. The title form is always emitted,
 * even when an mbid exists, which is what lets a known row match an unknown one in either
 * direction. Two genuinely different records colliding on the title form is possible in
 * principle and is the accepted cost: `stripSuffixes` plus the artist name makes it rare, and
 * the failure mode is a missing recommendation rather than a duplicate one.
 */
export function albumIdentities(album: {
  mbid?: string | null;
  artistName?: string | null;
  artistId?: number | string | null;
  title: string;
}): string[] {
  const title = titleIdentity(album);
  return album.mbid ? [`mb:${album.mbid}`, title] : [title];
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

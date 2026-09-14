/**
 * URL grammar. Pure — no I/O, no React, unit tested.
 *
 *   /artist/radiohead-7
 *   /album/kid-a-42
 *   /album/kid-a-42/track/3           single-disc: a bare number
 *   /album/the-wall-91/track/2-5      multi-disc: disc-track
 *
 * The readable prefix is decoration; THE TRAILING ID IS THE KEY. That is what lets a retitled
 * album keep its old URLs working, and it is why there is no collision handling and no unique
 * constraint on `slug`: two albums called "Greatest Hits" both store `greatest-hits` and are
 * distinguished purely by the id suffix. There is no canonical redirect either — any slug text
 * in front of the right id renders the page.
 */

/** The largest value a Postgres `integer` column can hold. DECLARED ONCE, here.
 *  (The television original declares it in two files, which is a defect, not a feature.) */
export const MAX_DB_INT = 2_147_483_647;

/** Disc and track bounds. MIN IS 0, NOT 1 — a pregap or hidden track is legitimately 0. */
export const DISC_MIN = 0;
export const DISC_MAX = 50;
export const TRACK_MIN = 0;
export const TRACK_MAX = 500;

/**
 * NFKD normalise, strip combining marks, lowercase, DELETE apostrophes outright (so
 * "It's Only Rock 'n Roll" becomes `its-only-rock-n-roll`, not `it-s-only-rock-n-roll`),
 * collapse every other non-alphanumeric run to a single hyphen, trim edge hyphens, cap at 80,
 * then trim AGAIN because the slice can land mid-hyphen.
 *
 * Falls back to the literal `fallback`, so slugify("日本語") is "album" rather than "".
 */
export function slugify(input: string, fallback = "album"): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

/**
 * Extracts the trailing integer id from a slug.
 *
 * THE ORDER OF THE GUARDS MATTERS. The digit-length check comes BEFORE `Number()` so a
 * 30-digit segment cannot round to something that looks valid. Both bounds exist because of
 * real production 500s in the original: `/show/breaking-bad-9999999999` raised
 * "value out of range for type integer" — A 500 WHERE A 404 BELONGS.
 *
 * Returns null rather than clamping, so the caller can `notFound()`.
 *
 * One deliberate quirk, pinned by test: parseIdSlug("album--4") is 4, not -4, because the
 * separator is itself a hyphen, so a minus sign can never enter.
 */
export function parseIdSlug(slug: string | undefined | null): number | null {
  if (!slug) return null;
  const match = /-(\d+)$/.exec(slug);
  const digits = match ? match[1] : /^\d+$/.test(slug) ? slug : null;
  if (digits === null || digits === undefined) return null;
  if (digits.length > 10) return null; // BEFORE Number()
  const id = Number(digits);
  return Number.isSafeInteger(id) && id > 0 && id <= MAX_DB_INT ? id : null;
}

/**
 * A bounded integer from untrusted text.
 *
 * Requires `^\d{1,10}$`, which rejects "1e30", "0x10", " 5 ", "-1" and "". Returns NULL
 * RATHER THAN CLAMPING so the caller can decide to 404 — silently clamping an out-of-range id
 * to a valid one renders somebody else's page.
 */
export function parseBoundedInt(
  value: string | undefined | null,
  { min, max }: { min: number; max: number },
): number | null {
  if (!value || !/^\d{1,10}$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed >= min && parsed <= max ? parsed : null;
}

/**
 * The single exception to "return null, do not clamp": page numbers clamp to 1, because a
 * silly `?page=` should not break a link.
 *
 * `?page=1e30` used to reach SQL `OFFSET` as the string "5e+31" in the original.
 */
export function parsePage(value: string | undefined | null, max = 500): number {
  if (!value || !/^\d{1,10}$/.test(value)) return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 1;
  return Math.min(parsed, max);
}

export type TrackLocator = { disc: number; track: number };

/**
 * Parses a track URL segment.
 *
 * The television original's `episodeCode` ("S03E07") has no music counterpart and, notably,
 * NO TEST. This is its replacement and it is tested in both directions.
 *
 *   "7"    -> { disc: 1, track: 7 }
 *   "2-5"  -> { disc: 2, track: 5 }
 *   "0"    -> { disc: 1, track: 0 }     a pregap/hidden track is legitimately 0
 *
 * Rejects: "", "-5", "2-", "2-5-1", "1e3", "01a", " 3", and anything outside DISC/TRACK bounds.
 */
export function parseTrackLocator(segment: string | undefined | null): TrackLocator | null {
  if (!segment) return null;

  if (/^\d{1,10}$/.test(segment)) {
    const track = parseBoundedInt(segment, { min: TRACK_MIN, max: TRACK_MAX });
    return track === null ? null : { disc: 1, track };
  }

  const match = /^(\d{1,10})-(\d{1,10})$/.exec(segment);
  if (!match) return null;
  const disc = parseBoundedInt(match[1], { min: DISC_MIN, max: DISC_MAX });
  const track = parseBoundedInt(match[2], { min: TRACK_MIN, max: TRACK_MAX });
  if (disc === null || track === null) return null;
  return { disc, track };
}

/**
 * The mirror of `parseTrackLocator`, used for both URLs and display.
 *
 * A single-disc album never shows a redundant "1-", because on a 12-track record the disc
 * number is noise. Zero-padded to two digits for display so a tracklist's numbers align in a
 * tabular-nums column.
 */
export function trackLocator({
  disc,
  track,
  discCount = 1,
  pad = false,
}: {
  disc: number;
  track: number;
  discCount?: number;
  pad?: boolean;
}): string {
  const shown = pad ? String(track).padStart(2, "0") : String(track);
  return discCount > 1 ? `${disc}-${shown}` : shown;
}

/** `kid-a-42` from ("Kid A", 42). Recomputed on every detail sync, so a retitle changes it. */
export function albumSlug(title: string, id: number): string {
  return `${slugify(title, "album")}-${id}`;
}

export function artistSlug(name: string, id: number): string {
  return `${slugify(name, "artist")}-${id}`;
}

export function listSlug(title: string, id: number): string {
  return `${slugify(title, "list")}-${id}`;
}

/**
 * Lists are addressed by the trailing id only — `parseListSlug` is literally `parseIdSlug`,
 * which is why `/list/17` is a valid URL and why the clone button can push a bare-id URL with
 * no slug at all.
 */
export const parseListSlug = parseIdSlug;
export const parseAlbumSlug = parseIdSlug;
export const parseArtistSlug = parseIdSlug;

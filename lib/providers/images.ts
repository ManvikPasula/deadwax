/**
 * Cover and artist imagery. CLIENT-SAFE — the only module under lib/providers/ without
 * `import "server-only"`.
 *
 * It is safe because there is no credential anywhere in this stack to leak. Deezer needs no
 * key, so unlike the television original (whose images module is exempted specifically
 * because "only the public CDN base is used, never the API token") there is not even a token
 * in the building.
 *
 * Deezer returns ABSOLUTE URLs from a pre-rendered size ladder, so there is no base to
 * configure and no path concatenation — which removes the original's trap where overriding
 * NEXT_PUBLIC_TMDB_IMAGE_BASE was not enough because next.config.ts and the CSP also had to
 * move.
 */

/** The four widths Deezer actually renders. */
export const COVER_SIZES = [56, 250, 500, 1000] as const;
export type CoverSize = (typeof COVER_SIZES)[number];

/**
 * Deezer CDN URLs end in `<w>x<h>-000000-80-0-0.jpg`, so a different width can be requested
 * from a stored URL without another API call. Falls back to the URL unchanged if the shape is
 * not recognised — a wrong-sized image beats no image.
 */
export function coverAt(url: string | null | undefined, size: CoverSize): string | null {
  if (!url) return null;
  if (!/cdn-images\.dzcdn\.net|e-cdns-images\.dzcdn\.net/.test(url)) return url;
  return url.replace(/\/\d+x\d+-/, `/${size}x${size}-`);
}

/**
 * The Cover Art Archive fallback, keyed by RELEASE-GROUP mbid.
 *
 * IT 302-REDIRECTS. A verified request for `front-500` landed on
 * `dn710905.ca.archive.org`, so BOTH `coverartarchive.org` AND `*.archive.org` must appear in
 * next.config.ts remotePatterns and in the CSP img-src. The node is not stable, hence the
 * wildcard.
 */
export function coverArtArchive(mbid: string | null | undefined, size: 250 | 500 | 1200 = 500): string | null {
  if (!mbid) return null;
  return `https://coverartarchive.org/release-group/${encodeURIComponent(mbid)}/front-${size}`;
}

/** Cover first, Cover Art Archive second, null third. Never a placeholder image. */
export function albumCover(
  album: { coverPath?: string | null; mbid?: string | null },
  size: CoverSize = 500,
): string | null {
  return coverAt(album.coverPath, size) ?? coverArtArchive(album.mbid, size === 1000 ? 1200 : 500);
}

export function artistPicture(artist: { picturePath?: string | null }, size: CoverSize = 500): string | null {
  return coverAt(artist.picturePath, size);
}

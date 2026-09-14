import "server-only";

import { releaseYear } from "@/lib/format";
import { previewSource } from "@/lib/listen";
import { pickImage } from "@/lib/providers/deezer/mappers";
import type { DeezerAlbumSummary, DeezerArtistDetail, DeezerArtistRef } from "@/lib/providers/deezer/types";
import { albumCover, artistPicture, type CoverSize } from "@/lib/providers/images";
import { albumSlug, artistSlug, trackLocator } from "@/lib/slug";

/**
 * The card adapters — the one place a display shape is assembled, so components never do it.
 *
 * WHY THIS FILE EXISTS. Four different sources produce the same card: a mirrored row, a
 * provider summary, an aggregate-joined row, and a track. Without one adapter each surface
 * builds its own `href`, picks its own cover width and decides for itself whether the year
 * comes from the release date or the first-release date — and they diverge, so the same album
 * reads as 1997 on the artist page and 2017 in a rail. Every field below is computed exactly
 * once.
 *
 * `import "server-only"` because the adapters read provider modules and are only ever called
 * while assembling a page. A CLIENT COMPONENT CAN STILL USE THE TYPES: `import type { AlbumCard }`
 * is erased at compile time and never reaches the bundle. Only the functions are server-bound.
 *
 * ---------------------------------------------------------------------------------------
 * THE ONE HAZARD THE TELEVISION ORIGINAL DID NOT HAVE
 * ---------------------------------------------------------------------------------------
 *
 * There, the primary key WAS the provider id, so a provider summary could always produce a
 * working URL. Here the primary key is a local `serial` (Decision 2) and the external id is a
 * secondary column, so A PROVIDER SUMMARY ALONE CANNOT PRODUCE A LOCAL URL. That is why
 * `cardFromDeezerSummary` takes the resolved local id and why `href` is nullable: the discovery
 * surfaces `await cacheAlbumSummaries(...)` and then pass the id, and the null href is the
 * visible consequence of not doing so rather than a link to somebody else's album.
 *
 * The slug is still COMPUTED ON THE FLY from the title in both adapters, not read from
 * `albums.slug`, for two reasons: a row backfilled by `cacheAlbumSummaries` can carry a slug
 * from an older title (only a detail sync refreshes it), and the URL grammar ignores everything
 * before the trailing id anyway, so one code path is better than two that agree by luck.
 */

/* -------------------------------------------------------------------------- */
/* Card shapes                                                                */
/* -------------------------------------------------------------------------- */

export type AlbumCard = {
  /** The local serial id. NULL only for a provider result that has not been mirrored yet. */
  id: number | null;
  deezerId: string;
  title: string;
  /** `kid-a-42`. Empty when there is no local id to append. */
  slug: string;
  /** `/album/kid-a-42`, or NULL when the row is not mirrored yet. See the docblock. */
  href: string | null;
  coverUrl: string | null;
  artistName: string;
  artistHref: string | null;
  /** Four digits, or null. From `original_release_date ?? release_date`. */
  year: string | null;
  /** Deadwax's own community average on the stored 0..10 scale. NULL is not zero. */
  memberAverage: number | null;
  memberCount: number;
  /** The viewer's own rating, for the star overlay. */
  viewerRating: number | null;
  /** The "x4" replay badge. 0 renders nothing. */
  replayCount: number;
  /** album | single | ep | compilation. */
  recordType: string;
  isCanonical: boolean;
};

export type ArtistCard = {
  id: number;
  name: string;
  slug: string;
  href: string;
  pictureUrl: string | null;
  albumCount: number;
  /** Community average across that artist's albums, when a surface has computed one. */
  memberAverage: number | null;
};

export type TrackCard = {
  id: number | null;
  albumId: number;
  title: string;
  /** `7` on a single-disc album, `2-5` on a double. The URL segment and the display label. */
  locator: string;
  href: string | null;
  coverUrl: string | null;
  artistName: string;
  artistHref: string | null;
  albumTitle: string;
  albumHref: string | null;
  durationMs: number;
  /** Already validated: a foreign or malformed preview URL arrives here as null. */
  previewUrl: string | null;
  memberAverage: number | null;
  memberCount: number;
  viewerRating: number | null;
  crowned: boolean;
  disc: number;
  track: number;
};

/* -------------------------------------------------------------------------- */
/* Input shapes — structural, so the query modules are not a dependency        */
/* -------------------------------------------------------------------------- */

/**
 * Structurally satisfied by `AlbumRow` from lib/db/queries/albums.ts and by anything that
 * carries the same fields. Declared structurally rather than imported so that this module does
 * not depend on a query module, which would make every card render pull the database client in.
 *
 * The four optional figures are read off the row when a caller has widened it
 * (`getMostRatedAlbums`, `getArtistDiscography`) and default to the honest empty values
 * otherwise — NULL for an average, never 0.
 */
export type AlbumCardSource = {
  id: number;
  deezerId: string;
  title: string;
  coverPath?: string | null;
  mbid?: string | null;
  releaseDate?: string | null;
  originalReleaseDate?: string | null;
  recordType?: string | null;
  isCanonical?: boolean;
  artistId?: number | null;
  artistName?: string | null;
  memberAverage?: number | null;
  memberCount?: number | null;
  viewerRating?: number | null;
  replayCount?: number | null;
};

export type ArtistCardSource = {
  id: number;
  name: string;
  picturePath?: string | null;
  albumCount?: number | null;
  memberAverage?: number | null;
};

export type TrackCardSource = {
  id?: number | null;
  albumId: number;
  discNumber: number;
  trackNumber: number;
  title: string;
  durationMs?: number | null;
  previewUrl?: string | null;
  /** The featured credit, when Deezer reports one that differs from the album artist. */
  artistName?: string | null;
  albumTitle: string;
  albumCoverPath?: string | null;
  albumMbid?: string | null;
  discCount?: number | null;
  albumArtistId?: number | null;
  albumArtistName?: string | null;
  memberAverage?: number | null;
  memberCount?: number | null;
  viewerRating?: number | null;
  crowned?: boolean;
};

/* -------------------------------------------------------------------------- */
/* Adapters                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * THE YEAR COMES FROM `original_release_date ?? release_date`, and the choice is deliberate.
 *
 * `albums.release_date` is annotated in the schema as "what displays", and on an album page it
 * is: the detail line should report the edition in front of you. But a CARD CAPTION is an
 * identity hint sitting next to a heatmap row that is ordered by first-release date, so using
 * the reissue's date here would make the same record read as 1997 in the grid and 2017 on the
 * card beside it. One number, chosen once, in this function.
 */
function cardYear(source: { originalReleaseDate?: string | null; releaseDate?: string | null }): string | null {
  return releaseYear(source.originalReleaseDate ?? source.releaseDate ?? null);
}

function artistHrefFor(id: number | null | undefined, name: string | null | undefined): string | null {
  if (!id || !name) return null;
  return `/artist/${artistSlug(name, id)}`;
}

/** A mirrored album row to a card. `size` pairs the card's rendered width with one CDN width. */
export function cardFromAlbumRow(row: AlbumCardSource, size: CoverSize = 500): AlbumCard {
  const slug = albumSlug(row.title, row.id);
  return {
    id: row.id,
    deezerId: row.deezerId,
    title: row.title,
    slug,
    href: `/album/${slug}`,
    coverUrl: albumCover({ coverPath: row.coverPath, mbid: row.mbid }, size),
    artistName: row.artistName ?? "Unknown artist",
    artistHref: artistHrefFor(row.artistId, row.artistName),
    year: cardYear(row),
    memberAverage: row.memberAverage ?? null,
    memberCount: row.memberCount ?? 0,
    viewerRating: row.viewerRating ?? null,
    replayCount: row.replayCount ?? 0,
    recordType: row.recordType ?? "album",
    // Defaults to TRUE when absent, matching the column default. A card is a display object
    // and this field is only ever used to add a qualifier badge, so the safe default is the one
    // that adds nothing.
    isCanonical: row.isCanonical ?? true,
  };
}

export function cardFromArtistRow(row: ArtistCardSource, size: CoverSize = 500): ArtistCard {
  const slug = artistSlug(row.name, row.id);
  return {
    id: row.id,
    name: row.name,
    slug,
    href: `/artist/${slug}`,
    pictureUrl: artistPicture({ picturePath: row.picturePath }, size),
    albumCount: row.albumCount ?? 0,
    memberAverage: row.memberAverage ?? null,
  };
}

export function cardFromTrackRow(row: TrackCardSource, size: CoverSize = 250): TrackCard {
  const albumHref = `/album/${albumSlug(row.albumTitle, row.albumId)}`;
  const locator = trackLocator({
    disc: row.discNumber,
    track: row.trackNumber,
    discCount: row.discCount ?? 1,
  });
  return {
    id: row.id ?? null,
    albumId: row.albumId,
    title: row.title,
    // The raw ordinals travel alongside the formatted locator, not instead of it. Callers that
    // need to identify the track — the Desert Island toggle, the log dialog, a heatmap cell's
    // key — must not have to parse the display string back into numbers, because
    // `trackLocator` deliberately omits the disc prefix on a single-disc album and that is
    // lossy.
    disc: row.discNumber,
    track: row.trackNumber,
    locator,
    href: `${albumHref}/track/${locator}`,
    coverUrl: albumCover({ coverPath: row.albumCoverPath, mbid: row.albumMbid }, size),
    // The per-track credit wins when there is one — a featured guest is the answer to "who is
    // this by" on a track card — and falls back to the album artist, which is what the
    // provider omits precisely when the two are the same.
    artistName: row.artistName ?? row.albumArtistName ?? "Unknown artist",
    artistHref: artistHrefFor(row.albumArtistId, row.albumArtistName),
    albumTitle: row.albumTitle,
    albumHref,
    durationMs: row.durationMs ?? 0,
    // Validated here rather than at the component, so a stale or foreign URL renders no play
    // button at all instead of a button that fails silently when pressed.
    previewUrl: previewSource(row.previewUrl),
    memberAverage: row.memberAverage ?? null,
    memberCount: row.memberCount ?? 0,
    viewerRating: row.viewerRating ?? null,
    crowned: row.crowned ?? false,
  };
}

/**
 * A Deezer summary to a card, for a discovery surface that renders before it mirrors.
 *
 * `localId` IS THE RESOLVED LOCAL SERIAL ID, or null when the row has not been mirrored yet —
 * see the module docblock for why a provider id cannot stand in for it. The slug is computed
 * from the summary's title on the fly so the cover still links correctly the moment the id
 * exists.
 *
 * THE AVERAGE SLOT IS LEFT EMPTY FOR PROVIDER-ONLY RESULTS, ALWAYS. The card's average slot is
 * reserved for Deadwax's own ratings. Deezer hands us `fans` and `rank` in the same payload and
 * it would be trivial to put one of them in this slot, which is exactly why the rule is
 * written down: those are POPULARITY, not quality, and relabelling popularity as a rating is
 * the single most tempting dishonesty available in a music app. A browse page therefore shows
 * no average until a member here has rated the record.
 */
export function cardFromDeezerSummary(
  summary: DeezerAlbumSummary,
  localId?: number | null,
  size: CoverSize = 500,
): AlbumCard {
  const title = summary.title;
  const slug = localId ? albumSlug(title, localId) : "";
  const artistRef = summary.artist;
  return {
    id: localId ?? null,
    deezerId: String(summary.id),
    title,
    slug,
    href: slug ? `/album/${slug}` : null,
    // Deezer returns a pre-rendered size ladder of absolute URLs, so `pickImage` chooses a rung
    // and `albumCover` normalises it to the requested width. There is no Cover Art Archive
    // fallback here: a summary carries no release-group mbid.
    coverUrl: albumCover({ coverPath: pickImage(summary, size) }, size),
    artistName: artistRef?.name ?? "Unknown artist",
    // NULL rather than a Deezer link: an artist href must point inside Deadwax, and the local
    // artist id is not known from a summary alone.
    artistHref: null,
    year: releaseYear(summary.release_date ?? null),
    memberAverage: null,
    memberCount: 0,
    viewerRating: null,
    replayCount: 0,
    recordType: summary.record_type ?? "album",
    // A summary has no MusicBrainz secondary types, so canonicality is unknown at this point;
    // `true` matches the column default and the ingest mapper's own starting assumption.
    isCanonical: true,
  };
}

/**
 * A Deezer artist reference to a card. Same `localId` contract as the album adapter.
 *
 * `albumCount` comes from Deezer's `nb_album` when present, which counts releases we have never
 * mirrored. That is acceptable on a provider-only card — the number is the provider's claim
 * about its own catalogue — but a card built from a mirrored row should use
 * `getMirroredAlbumCounts`, or the count disagrees with the discography it links to.
 */
export function cardFromDeezerArtist(
  artist: DeezerArtistRef | DeezerArtistDetail,
  localId?: number | null,
  size: CoverSize = 500,
): ArtistCard | null {
  if (!localId) return null; // nothing to link to; see the module docblock
  const slug = artistSlug(artist.name, localId);
  return {
    id: localId,
    name: artist.name,
    slug,
    href: `/artist/${slug}`,
    pictureUrl: artistPicture({ picturePath: pickImage(artist, size) }, size),
    albumCount: "nb_album" in artist ? (artist.nb_album ?? 0) : 0,
    memberAverage: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Merging                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Dedupes a merged card list, keeping the FIRST occurrence.
 *
 * Used wherever local and remote results meet — /search merges the mirror with a provider
 * search, and a record already mirrored appears in both. First-wins matters: the local card is
 * placed first by every caller because it is the one carrying member figures, and keeping the
 * provider copy instead would blank the average on exactly the records Deadwax knows most
 * about.
 *
 * Keyed by local id when there is one and by `deezerId` otherwise, so two unmirrored provider
 * copies of the same album still collapse to one. A card with neither key cannot be deduped
 * and is kept, because dropping it would be worse than showing it twice.
 */
export function uniqueCards<T extends { id?: number | null; deezerId?: string | null }>(cards: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const card of cards) {
    const key = card.id ? `id:${card.id}` : card.deezerId ? `dz:${card.deezerId}` : null;
    if (key === null) {
      out.push(card);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(card);
  }
  return out;
}

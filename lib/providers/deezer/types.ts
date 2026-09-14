/**
 * Deezer response shapes, transcribed from captured payloads in tests/fixtures/ rather than
 * from documentation.
 *
 * Two shapes matter more than the rest, and the difference between them is a real trap:
 *
 *   DeezerAlbumDetail.tracks.data[]  — the EMBEDDED tracklist. Has id/title/duration/rank/
 *                                      preview, and NO track_position, NO disk_number,
 *                                      NO isrc. Fine for display order, useless as identity.
 *   DeezerTrack (from /album/{id}/tracks) — HAS track_position, disk_number and isrc.
 *
 * Since (album_id, disc_number, track_number) is a track's addressable identity and a unique
 * index depends on it, ingest must call the dedicated endpoint. See lib/ingest/albums.ts.
 */

export type DeezerImageSet = {
  cover?: string | null;
  cover_small?: string | null;
  cover_medium?: string | null;
  cover_big?: string | null;
  cover_xl?: string | null;
  picture?: string | null;
  picture_small?: string | null;
  picture_medium?: string | null;
  picture_big?: string | null;
  picture_xl?: string | null;
};

export type DeezerGenre = { id: number; name: string };

export type DeezerArtistRef = {
  id: number;
  name: string;
  link?: string;
  picture?: string;
  picture_small?: string;
  picture_medium?: string;
  picture_big?: string;
  picture_xl?: string;
};

export type DeezerContributor = DeezerArtistRef & { role?: string };

export type DeezerArtistDetail = DeezerArtistRef & {
  nb_album?: number;
  nb_fan?: number;
  radio?: boolean;
  tracklist?: string;
};

/** The embedded, position-less track shape. Named to make its deficiency impossible to miss. */
export type DeezerEmbeddedTrack = {
  id: number;
  readable?: boolean;
  title: string;
  title_short?: string;
  title_version?: string;
  link?: string;
  duration: number; // seconds
  rank?: number;
  explicit_lyrics?: boolean;
  preview?: string | null;
  md5_image?: string;
  artist?: DeezerArtistRef;
};

/** The full track shape, only available from /album/{id}/tracks and /track/{id}. */
export type DeezerTrack = DeezerEmbeddedTrack & {
  isrc?: string | null;
  track_position?: number;
  disk_number?: number;
  contributors?: DeezerContributor[];
};

export type DeezerAlbumSummary = DeezerImageSet & {
  id: number;
  title: string;
  link?: string;
  genre_id?: number;
  genres?: { data?: DeezerGenre[] };
  nb_tracks?: number;
  release_date?: string | null;
  record_type?: string;
  explicit_lyrics?: boolean;
  fans?: number;
  artist?: DeezerArtistRef;
  /** Present on chart/search results; absent on some summaries. */
  position?: number;
};

export type DeezerAlbumDetail = DeezerAlbumSummary & {
  upc?: string | null;
  label?: string | null;
  duration?: number; // seconds, whole album
  available?: boolean;
  contributors?: DeezerContributor[];
  tracklist?: string;
  tracks?: { data?: DeezerEmbeddedTrack[] };
};

export type DeezerList<T> = { data?: T[]; total?: number; next?: string };

/**
 * Deezer signals errors INSIDE A 200 RESPONSE:
 *   { "error": { "type": "DataException", "message": "no data", "code": 800 } }
 * The client inspects the parsed payload for this and converts it into a ProviderError, with
 * DataException mapped to 404 so ingest can tell "no such album" from "provider down".
 */
export type DeezerErrorBody = {
  error?: { type?: string; message?: string; code?: number };
};

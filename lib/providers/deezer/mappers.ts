/**
 * Deezer -> database row. PURE: this module imports insert types, slug helpers and the
 * canonical-release rule, and nothing else. No `db`, no `fetch`, no React.
 *
 * That purity is the whole point — it is what makes the provider's awkward cases testable
 * against captured fixtures rather than against a live API that changes under you. Every
 * non-obvious transform below is a real data-quality workaround, and each one says which.
 */

import { isCanonicalRelease } from "@/lib/canonical";
import type { NewAlbum, NewArtist, NewCredit, NewTrack } from "@/lib/db/schema";
import { slugify } from "@/lib/slug";

import type {
  DeezerAlbumDetail,
  DeezerAlbumSummary,
  DeezerArtistDetail,
  DeezerContributor,
  DeezerEmbeddedTrack,
  DeezerGenre,
  DeezerImageSet,
  DeezerTrack,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Date normalisation, and it is LOOSER than the television original's on purpose.
 *
 * The original accepts only `^\d{4}-\d{2}-\d{2}$` because TMDB returns "" for absent dates.
 * Applying that rule to a music catalogue would silently null a large fraction of it: release
 * date precision is genuinely `year` or `month` for a great deal of older material, and
 * "1969" is a true and useful answer.
 *
 * So `YYYY` and `YYYY-MM` are accepted and normalised to the first of the period. The
 * `infinity` guard is KEPT AND IS NOT OPTIONAL: Postgres accepts the literals 'infinity',
 * '-infinity', 'now', 'today' and 'epoch' as valid dates, and one stored 'infinity' made
 * `EXTRACT(YEAR ...)` throw on a member's public diary and year pages FOR EVERY VISITOR,
 * permanently, with no way to undo it from the interface.
 */
export function nullableDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Reject the Postgres date literals outright, whatever else they look like.
  if (/^(?:[+-]?infinity|now|today|tomorrow|yesterday|epoch|allballs)$/i.test(trimmed)) return null;

  if (/^\d{4}$/.test(trimmed)) return `${trimmed}-01-01`;
  if (/^\d{4}-\d{2}$/.test(trimmed)) return `${trimmed}-01`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;

  // A round-trip check, which is what rejects 2026-02-30 — a string that matches the shape
  // and is still not a date.
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString().slice(0, 10) !== trimmed) return null;

  const year = Number(trimmed.slice(0, 4));
  if (year < 1860 || year > 2200) return null; // before the phonograph, or absurd
  return trimmed;
}

/** Whitespace-only free text becomes NULL, which keeps it out of every "has a bio" branch. */
export function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Deezer returns a PRE-RENDERED image set (56 / 250 / 500 / 1000 px), not a path to
 * concatenate onto a base. So the television original's `posterUrl(path, size)` becomes a
 * pick from a set, and there is no `NEXT_PUBLIC_*_IMAGE_BASE` to configure.
 *
 * Returns NULL, NOT A PLACEHOLDER, so every call site has to branch — which is what stops a
 * missing cover from rendering as a broken image.
 */
export function pickImage(set: DeezerImageSet | null | undefined, minWidth = 500): string | null {
  if (!set) return null;
  const ladder: Array<[number, string | null | undefined]> = [
    [56, set.cover_small ?? set.picture_small],
    [250, set.cover_medium ?? set.picture_medium],
    [500, set.cover_big ?? set.picture_big],
    [1000, set.cover_xl ?? set.picture_xl],
  ];
  for (const [width, url] of ladder) {
    if (width >= minWidth && url) return url;
  }
  // Nothing at or above the requested width: fall back to the largest that exists.
  for (let index = ladder.length - 1; index >= 0; index -= 1) {
    const url = ladder[index]?.[1];
    if (url) return url;
  }
  return blankToNull(set.cover ?? set.picture);
}

/**
 * Deezer `rank` runs to roughly 1,000,000 and is a streaming-derived popularity figure.
 *
 * Normalised to 0..100 so it is comparable across albums and tracks. IT IS NOT A RATING and is
 * never rendered as stars — it feeds retrieval, the notability floor and a labelled
 * "Popularity" meter, and nothing else. Relabelling popularity as quality is the single most
 * tempting dishonesty available in a music app.
 */
export function normaliseRank(rank: number | null | undefined): number {
  if (!rank || rank <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(rank / 10_000)));
}

/**
 * Label normalisation.
 *
 * Deezer returns `label` as free text with the wild variation the brief predicted, and
 * probing confirmed it immediately: Discovery's label is the literal string
 * "Daft Life Ltd./ADA France". Unnormalised, that is a distinct affinity key from
 * "Daft Life Ltd." and from "Daft Life", so a label axis built on raw strings has a support
 * count of 1 for everything and contributes nothing.
 *
 * Strategy: split on the separators, strip legal and generic suffixes, take the longest
 * surviving token, and return null if nothing survives — because a label axis with a wrong
 * key is worse than a label axis with no key.
 */
const LABEL_SUFFIX = /\b(?:ltd\.?|limited|inc\.?|llc|gmbh|s\.?a\.?r\.?l\.?|b\.?v\.?|ab|oy|records?|recordings?|recs\.?|music|musique|entertainment|group|company|co\.?|corp\.?|international|worldwide|distribution|media)\b/gi;

/**
 * Distributors, not labels.
 *
 * These appear in Deezer's `label` field alongside the real imprint — "Daft Life Ltd./ADA
 * France" is Daft Life (the label) distributed by ADA (Warner's distribution arm). The label
 * axis is meant to capture CURATORIAL STYLE ("a small enough set with a recognisable house
 * sound"), and a distributor has none: ADA moves records for hundreds of unrelated imprints,
 * so an "ADA affinity" is an affinity for nothing at all.
 */
const DISTRIBUTORS = new Set([
  "ada",
  "ada france",
  "ingrooves",
  "the orchard",
  "orchard",
  "believe",
  "believe digital",
  "awal",
  "fuga",
  "kobalt",
  "caroline",
  "pias",
  "absolute",
  "virtual label",
  "symphonic",
  "distrokid",
  "cd baby",
  "tunecore",
  "under exclusive license",
]);

/**
 * Picks the FIRST surviving token, not the longest.
 *
 * Discovered by running the real ingest path: "longest" chose "ADA France" (10 chars) over
 * "Daft Life" (9), which is exactly backwards. There is no rule that is right every time —
 * "Daft Life Ltd./ADA France" puts the label first while "Beggars Group / 4AD" puts the
 * parent first and the imprint second — so the criterion that matters is not accuracy but
 * CONSISTENCY: the same input must always produce the same key, or support never accumulates
 * and the axis contributes nothing regardless of how right any single answer is.
 *
 * First-token is right more often than longest-token, is cheaper to reason about, and the
 * residual error is bounded: this axis carries a weight of 0.15, the lowest of the three,
 * precisely because it is the noisiest.
 */
export function normaliseLabel(value: string | null | undefined): string | null {
  const raw = blankToNull(value);
  if (!raw) return null;

  const candidates = raw
    .split(/\s*[/|,;]\s*|\s+-\s+/)
    .map((part) =>
      part
        .replace(LABEL_SUFFIX, " ")
        .replace(/[^\p{L}\p{N}&'’.\- ]/gu, " ")
        .replace(/\s+/g, " ")
        // Strip punctuation left stranded by the suffix removal. Without this,
        // "Daft Life Ltd./ADA France" normalises to the literal string "Daft Life ." — which
        // is a distinct affinity key from "Daft Life", so the label axis would end up with a
        // support count of 1 for every record and contribute nothing. Caught by running the
        // real ingest path, not by reading the regex.
        .replace(/[\s.\-&'’]+$/u, "")
        .replace(/^[\s.\-&'’]+/u, "")
        .trim(),
    )
    .filter((part) => part.length >= 2 && !DISTRIBUTORS.has(part.toLowerCase()));

  const best = candidates[0];
  return best && best.length >= 2 ? best.slice(0, 200) : null;
}

/**
 * Deezer album summaries carry `genre_id` but not always a `genres` array. A summary cached
 * with no genre NAMES is an album the recommender cannot see at all, and the television
 * original measured what that costs: 370 of 433 mirrored rows — 85% — had no genres, and
 * every one was structurally unrankable.
 */
export function resolveGenres(
  album: Pick<DeezerAlbumSummary, "genres" | "genre_id">,
  vocabulary: Map<number, string>,
): string[] {
  const named = (album.genres?.data ?? []).map((genre) => genre.name).filter(Boolean);
  if (named.length > 0) return unique(named);
  if (album.genre_id !== undefined && album.genre_id !== null) {
    const name = vocabulary.get(album.genre_id);
    if (name) return [name];
  }
  return [];
}

export function genreVocabulary(genres: DeezerGenre[]): Map<number, string> {
  return new Map(genres.map((genre) => [genre.id, genre.name]));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/* -------------------------------------------------------------------------- */
/* Artists                                                                    */
/* -------------------------------------------------------------------------- */

export function mapArtistDetail(artist: DeezerArtistDetail): NewArtist {
  return {
    deezerId: String(artist.id),
    name: artist.name,
    slug: slugify(artist.name, "artist"),
    picturePath: pickImage(artist, 500),
    fans: artist.nb_fan ?? 0,
    albumCount: artist.nb_album ?? 0,
    synced_at: new Date(),
  };
}

/**
 * An artist reference inside an album payload knows a name and a picture and nothing else.
 *
 * `syncedAt: new Date(0)` — THE UNIX EPOCH AS A PERMANENT-STALE SENTINEL. The row exists so
 * the foreign key resolves and the page links correctly, and it is guaranteed to be refreshed
 * the first time anything actually reads it as an artist.
 *
 * `fans` and `albumCount` are left at their defaults rather than zeroed explicitly, which
 * matters for the upsert: a summary must not overwrite a detail sync's real numbers with
 * zeros.
 */
export function mapArtistRef(artist: { id: number; name: string } & DeezerImageSet): NewArtist {
  return {
    deezerId: String(artist.id),
    name: artist.name,
    slug: slugify(artist.name, "artist"),
    picturePath: pickImage(artist, 250),
    synced_at: new Date(0),
  };
}

/* -------------------------------------------------------------------------- */
/* Albums                                                                     */
/* -------------------------------------------------------------------------- */

export function mapAlbumDetail(
  album: DeezerAlbumDetail,
  artistId: number,
  vocabulary: Map<number, string> = new Map(),
): NewAlbum {
  const recordType = (album.record_type ?? "album").toLowerCase();
  const title = album.title;

  return {
    deezerId: String(album.id),
    artistId,
    title,
    slug: slugify(title, "album"),
    coverPath: pickImage(album, 500),
    releaseDate: nullableDate(album.release_date),
    recordType: recordType.slice(0, 12),
    // MusicBrainz has not been consulted at this point, so the title regex is the only
    // signal available and `musicbrainzKnown` is false. enrichFromMusicBrainz recomputes
    // this with better information later.
    isCanonical: isCanonicalRelease({ recordType, title, musicbrainzKnown: false }),
    label: normaliseLabel(album.label),
    upc: blankToNull(album.upc)?.slice(0, 20) ?? null,
    explicit: album.explicit_lyrics ?? false,
    genres: resolveGenres(album, vocabulary),
    fans: album.fans ?? 0,
    popularity: 0, // albums have no `rank`; popularity is derived from fans + track ranks
    synced_at: new Date(),
  };
}

/**
 * A discovery summary. TWO FIELDS ARE POISONED ON PURPOSE:
 *
 *   trackCount / discCount are left at their column defaults, because a summary DOES NOT
 *   KNOW THE COUNTS and overwriting a detailed row with zeros would corrupt completion maths.
 *
 *   syncedAt is `new Date(0)` — the epoch sentinel again, so `isStale()` always returns true
 *   for a summary-only row and the first real read triggers a detail sync.
 *
 * `mbSyncedAt` is DELIBERATELY OMITTED from this shape, which is the mechanism that preserves
 * an album's MusicBrainz enrichment stamp across a Deezer refresh. (The television original
 * does the same thing by omitting `syncedAt` from its season-summary mapper.)
 */
export function mapAlbumSummary(
  album: DeezerAlbumSummary,
  artistId: number,
  vocabulary: Map<number, string> = new Map(),
): NewAlbum {
  const recordType = (album.record_type ?? "album").toLowerCase();
  return {
    deezerId: String(album.id),
    artistId,
    title: album.title,
    slug: slugify(album.title, "album"),
    coverPath: pickImage(album, 500),
    releaseDate: nullableDate(album.release_date),
    recordType: recordType.slice(0, 12),
    isCanonical: isCanonicalRelease({ recordType, title: album.title, musicbrainzKnown: false }),
    explicit: album.explicit_lyrics ?? false,
    genres: resolveGenres(album, vocabulary),
    fans: album.fans ?? 0,
    synced_at: new Date(0),
  };
}

/* -------------------------------------------------------------------------- */
/* Tracks                                                                     */
/* -------------------------------------------------------------------------- */

export function mapTrack(track: DeezerTrack, albumId: number, artistId: number, albumArtistName?: string): NewTrack {
  return {
    albumId,
    artistId,
    deezerId: String(track.id),
    // Defaults exist because /album/{id}/tracks is the only endpoint that supplies these and
    // the degraded fallback path has to put something here. See mapEmbeddedTracks.
    discNumber: track.disk_number ?? 1,
    trackNumber: track.track_position ?? 0,
    title: track.title,
    // Deezer reports SECONDS. The column is milliseconds, because that is what every
    // listening-time sum wants and because a seconds column invites somebody to add them to
    // a milliseconds column later.
    durationMs: Math.max(0, Math.round((track.duration ?? 0) * 1000)),
    isrc: blankToNull(track.isrc)?.slice(0, 15) ?? null,
    explicit: track.explicit_lyrics ?? false,
    previewUrl: blankToNull(track.preview),
    popularity: normaliseRank(track.rank),
    // Display-only, and only when it differs — a per-track artist name equal to the album
    // artist is noise on twelve consecutive rows.
    artistName:
      track.artist?.name && track.artist.name !== albumArtistName ? track.artist.name.slice(0, 200) : null,
  };
}

/**
 * THE DEGRADED FALLBACK, and it is only that.
 *
 * `GET /album/{id}` embeds a tracklist, but that embedded shape omits `track_position`,
 * `disk_number` and `isrc` — verified against Discovery and The Wall. Positions here are
 * therefore DERIVED FROM ARRAY INDEX, which is a guess: it is right for a single-disc album
 * and silently wrong for a multi-disc one, where The Wall's 26 tracks would become
 * 1..26 on one disc instead of 13 + 13.
 *
 * So this is used only when the dedicated tracks call has already failed, and having a
 * slightly-wrong tracklist beats having none. `ensureAlbum` leaves `tracksSyncedAt` NULL when
 * it takes this path, so the next read retries the real endpoint.
 */
export function mapEmbeddedTracks(
  tracks: DeezerEmbeddedTrack[],
  albumId: number,
  artistId: number,
  albumArtistName?: string,
): NewTrack[] {
  return tracks.map((track, index) =>
    mapTrack({ ...track, disk_number: 1, track_position: index + 1 }, albumId, artistId, albumArtistName),
  );
}

/* -------------------------------------------------------------------------- */
/* Credits                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Album contributors plus per-track contributors, deduped and ranked by how often a person
 * appears.
 *
 * Sorted by `999 - appearances` so the most-credited person leads, and sliced to 20 —
 * contributor lists are dominated by one-track guests, exactly as television crew lists are
 * dominated by one-episode contributors.
 *
 * NOTE the unique index on (album_id, person_id, kind, role) includes the NULLABLE `role`, and
 * Postgres treats NULLs as distinct, so `onConflictDoNothing` will NOT dedupe rows with a null
 * role. Ingest handles that by DELETEing the album's credits before inserting. Do not
 * "optimise" that DELETE away.
 */
export function mapCredits(
  album: DeezerAlbumDetail,
  tracks: DeezerTrack[],
  albumId: number,
): NewCredit[] {
  const appearances = new Map<string, { person: DeezerContributor; count: number; role: string }>();

  const add = (person: DeezerContributor | undefined, role: string) => {
    if (!person?.id || !person.name) return;
    const key = `${person.id}:${role}`;
    const existing = appearances.get(key);
    if (existing) existing.count += 1;
    else appearances.set(key, { person, count: 1, role });
  };

  for (const contributor of album.contributors ?? []) {
    add(contributor, contributor.role === "Featured" ? "Featured" : "Main");
  }
  for (const track of tracks) {
    for (const contributor of track.contributors ?? []) {
      add(contributor, contributor.role === "Featured" ? "Featured" : "Main");
    }
  }

  return [...appearances.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .map((entry) => ({
      albumId,
      personId: String(entry.person.id),
      name: entry.person.name.slice(0, 200),
      picturePath: pickImage(entry.person, 250),
      role: entry.role.slice(0, 40),
      kind: "artist" as const,
      creditOrder: Math.max(0, 999 - entry.count),
    }));
}

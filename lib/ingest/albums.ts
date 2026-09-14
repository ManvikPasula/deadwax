import "server-only";

import { cache } from "react";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { isActiveArtist, isCanonicalRelease } from "@/lib/canonical";
import { db } from "@/lib/db";
import { type Album, type Artist, albums, artistSimilar, artists, credits, tracks } from "@/lib/db/schema";
import { ProviderError } from "@/lib/providers/errors";
import {
  getAlbumDetail,
  getAlbumTracks,
  getArtistAlbums,
  getArtistDetail,
  getGenres,
  getRelatedArtists,
} from "@/lib/providers/deezer";
import {
  genreVocabulary,
  mapAlbumDetail,
  mapAlbumSummary,
  mapArtistDetail,
  mapArtistRef,
  mapCredits,
  mapEmbeddedTracks,
  mapTrack,
} from "@/lib/providers/deezer/mappers";
import type { DeezerAlbumSummary } from "@/lib/providers/deezer/types";
import { findReleaseGroup, getArtist as getMbArtist, getReleaseGroupOutcome } from "@/lib/providers/musicbrainz";
import { mapAlbumEnrichment, mapArtistEnrichment } from "@/lib/providers/musicbrainz/mappers";
import { slugify } from "@/lib/slug";

/**
 * THE ONLY WRITER OF THE CONTENT MIRROR.
 *
 * Cache-through, not a crawler:
 *
 *   The database is the read path, the providers are the fill path. Nothing crawls. A row is
 *   mirrored the first time somebody looks at it, and refreshed when the mirror goes stale.
 *
 * Why mirror at all: every member aggregate — rating histograms, per-member DISTINCT ON votes,
 * listening-time sums, both heatmaps — is a SQL join against these tables. Without a local
 * mirror each one would need a network call.
 *
 * Why on-demand: it bounds the mirror to what the community actually uses, needs no scheduler
 * or worker, and makes a cold deployment instantly usable.
 */

const DAY_MS = 86_400_000;

/** An artist with a release in the last 18 months. The `in_production` analogue. */
const ARTIST_ACTIVE_TTL = DAY_MS;
const ARTIST_INACTIVE_TTL = 14 * DAY_MS;
/** A released tracklist is immutable, so this is the longest TTL in the system by design. */
const ALBUM_TTL = 30 * DAY_MS;
const MUSICBRAINZ_TTL = 30 * DAY_MS;
const SIMILAR_TTL = 7 * DAY_MS;

/** ensureDiscography fills at most this many albums per request, and logs what it dropped. */
const DISCOGRAPHY_FILL_CAP = 12;

/**
 * `isStale` keys on the EPOCH SENTINEL plus a TTL, and deliberately NOT on `trackCount === 0`.
 *
 * The rejected alternative matters: zero tracks is also the honest value for an announced
 * album with no tracklist yet, so keying on it would pin such a row as permanently stale and
 * re-run the whole non-transactional write path on every single view.
 */
function isStale(syncedAt: Date | null | undefined, ttlMs: number): boolean {
  if (!syncedAt) return true;
  if (syncedAt.getTime() === 0) return true; // the epoch sentinel written by every summary mapper
  return Date.now() - syncedAt.getTime() > ttlMs;
}

/** `excluded."column"` for an upsert `set` clause. The column name is always a literal here. */
function sqlExcluded(column: string) {
  return sql.raw(`excluded."${column}"`);
}

/* -------------------------------------------------------------------------- */
/* The genre vocabulary                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Cached per request AND for a week at the HTTP layer.
 *
 * This is load-bearing, not a nicety. Album summaries carry `genre_id` but not always a
 * `genres` array, and a summary cached with no genre NAMES is an album the recommender cannot
 * see at all — `genres.length > 0` is one of its three hard filters. The television original
 * measured exactly what getting this wrong costs: 370 of 433 mirrored rows, 85%, had no
 * genres, and every one of them was unrankable.
 */
const vocabulary = cache(async () => genreVocabulary(await getGenres()));

/* -------------------------------------------------------------------------- */
/* Artists                                                                    */
/* -------------------------------------------------------------------------- */

async function ensureArtistUncached(deezerId: string): Promise<Artist | null> {
  const existing = await db.query.artists.findFirst({ where: eq(artists.deezerId, deezerId) });
  const ttl = existing?.isActive ? ARTIST_ACTIVE_TTL : ARTIST_INACTIVE_TTL;

  // 1. The only path that avoids the provider entirely.
  if (existing && !isStale(existing.synced_at, ttl)) return existing;

  try {
    const detail = await getArtistDetail(deezerId);
    const row = mapArtistDetail(detail);

    // Full-row overwrite: a detail payload is authoritative for every column it carries,
    // including `slug` — so a renamed artist gets a new slug here. The `mb_*` columns and
    // `isCanonical`-adjacent fields are omitted, because MusicBrainz owns them.
    const [inserted] = await db
      .insert(artists)
      .values(row)
      .onConflictDoUpdate({
        target: artists.deezerId,
        set: {
          name: sqlExcluded("name"),
          slug: sqlExcluded("slug"),
          picturePath: sqlExcluded("picture_path"),
          fans: sqlExcluded("fans"),
          albumCount: sqlExcluded("album_count"),
          synced_at: sqlExcluded("synced_at"),
        },
      })
      .returning();

    const artist = inserted ?? (await db.query.artists.findFirst({ where: eq(artists.deezerId, deezerId) })) ?? null;
    if (artist) await enrichArtistFromMusicBrainz(artist);
    return artist ? ((await db.query.artists.findFirst({ where: eq(artists.id, artist.id) })) ?? artist) : null;
  } catch (error) {
    if (error instanceof ProviderError && error.isMissing && !existing) return null;
    /**
     * A provider failure does not fail the caller when a mirror already exists — the page
     * renders slightly stale rather than not at all. ONLY A COLD MISS CAN RETURN NULL.
     */
    console.warn("[ingest] artist sync failed, serving mirror —", error instanceof Error ? error.message : error);
    return existing ?? null;
  }
}

/**
 * React's per-request `cache()`.
 *
 * Without it, every stale row ran the whole non-transactional sync TWICE per page view —
 * because `generateMetadata` and the page body both need it — including two
 * DELETE-then-INSERT cycles over its credits.
 */
export const ensureArtist = cache(ensureArtistUncached);

/** Resolves a provider artist reference to a local row, creating a stub if needed. */
async function ensureArtistStub(ref: { id: number; name: string } & Record<string, unknown>): Promise<number> {
  const deezerId = String(ref.id);
  const existing = await db.query.artists.findFirst({
    where: eq(artists.deezerId, deezerId),
    columns: { id: true },
  });
  if (existing) return existing.id;

  const [inserted] = await db
    .insert(artists)
    .values(mapArtistRef(ref as never))
    .onConflictDoNothing({ target: artists.deezerId })
    .returning({ id: artists.id });
  if (inserted) return inserted.id;

  const found = await db.query.artists.findFirst({ where: eq(artists.deezerId, deezerId), columns: { id: true } });
  if (!found) throw new Error(`could not resolve artist ${deezerId}`);
  return found.id;
}

/* -------------------------------------------------------------------------- */
/* Albums                                                                     */
/* -------------------------------------------------------------------------- */

async function ensureAlbumUncached(deezerId: string): Promise<Album | null> {
  const existing = await db.query.albums.findFirst({ where: eq(albums.deezerId, deezerId) });

  // 1. Fresh AND with a tracklist. A row whose tracks were never fetched is not usable, even
  //    if its metadata is young — so both conditions gate the early return.
  if (existing && !isStale(existing.synced_at, ALBUM_TTL) && existing.tracksSyncedAt) return existing;

  try {
    // 2. Metadata.
    const detail = await getAlbumDetail(deezerId);
    if (!detail.artist) throw new ProviderError("deezer", 422, `/album/${deezerId}`, "album payload carries no artist");

    // 3. The artist first, so the foreign key exists.
    const artistId = await ensureArtistStub(detail.artist as never);

    // 4. Albums upsert — full-row overwrite of the Deezer-owned columns only.
    const row = mapAlbumDetail(detail, artistId, await vocabulary());
    const [inserted] = await db
      .insert(albums)
      .values(row)
      .onConflictDoUpdate({
        target: albums.deezerId,
        set: {
          artistId: sqlExcluded("artist_id"),
          title: sqlExcluded("title"),
          slug: sqlExcluded("slug"),
          coverPath: sqlExcluded("cover_path"),
          releaseDate: sqlExcluded("release_date"),
          recordType: sqlExcluded("record_type"),
          label: sqlExcluded("label"),
          upc: sqlExcluded("upc"),
          explicit: sqlExcluded("explicit"),
          genres: sqlExcluded("genres"),
          fans: sqlExcluded("fans"),
          synced_at: sqlExcluded("synced_at"),
          // mbid / critic_* / tags / original_release_date / secondary_types / is_canonical /
          // mb_synced_at are ALL omitted: MusicBrainz owns them, and letting a Deezer refresh
          // clear them would re-fetch the flakiest provider on every album view.
        },
      })
      .returning();

    const album =
      inserted ?? (await db.query.albums.findFirst({ where: eq(albums.deezerId, deezerId) })) ?? null;
    if (!album) return existing ?? null;

    // 5. The tracklist, from the DEDICATED endpoint.
    //
    //    `GET /album/{id}` embeds a tracks array, but that shape omits track_position,
    //    disk_number and isrc — verified against Discovery and The Wall. Since
    //    (album, disc, track) IS a track's addressable identity and a unique index depends on
    //    it, positions cannot be inferred from array order on the primary path.
    let rows = [] as ReturnType<typeof mapTrack>[];
    let positionsAreReal = true;
    try {
      const full = await getAlbumTracks(deezerId, detail.nb_tracks);
      rows = full.map((track) => mapTrack(track, album.id, artistId, detail.artist?.name));
    } catch (error) {
      // THE DEGRADED FALLBACK. Positions come from array index, which is right for a
      // single-disc album and silently wrong for a multi-disc one. `tracksSyncedAt` is left
      // NULL below so the next read retries the real endpoint.
      console.warn("[ingest] tracklist fetch failed, falling back to the embedded array —", String(error));
      rows = mapEmbeddedTracks(detail.tracks?.data ?? [], album.id, artistId, detail.artist?.name);
      positionsAreReal = false;
    }

    if (rows.length > 0) {
      // Dedupe on the unique key IN JS FIRST. Postgres refuses an ON CONFLICT DO UPDATE that
      // would touch the same row twice in one statement and FAILS THE WHOLE STATEMENT — which
      // in the original manifested as a silent no-op inside a try/catch, leaving every
      // candidate in the batch untagged.
      const seen = new Set<string>();
      const deduped = rows.filter((track) => {
        const key = `${track.discNumber ?? 1}:${track.trackNumber}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      await db
        .insert(tracks)
        .values(deduped)
        .onConflictDoUpdate({
          target: [tracks.albumId, tracks.discNumber, tracks.trackNumber],
          set: {
            deezerId: sqlExcluded("deezer_id"),
            title: sqlExcluded("title"),
            durationMs: sqlExcluded("duration_ms"),
            isrc: sqlExcluded("isrc"),
            explicit: sqlExcluded("explicit"),
            previewUrl: sqlExcluded("preview_url"),
            popularity: sqlExcluded("popularity"),
            artistName: sqlExcluded("artist_name"),
            // critic_score / critic_votes omitted: MusicBrainz owns them.
          },
        });
    }

    // 6. Credits: DELETE then INSERT.
    //
    //    NOT an upsert. The unique index includes the NULLABLE `role`, and Postgres treats
    //    NULLs as distinct, so onConflictDoNothing would not dedupe. Do not "optimise" this.
    const creditRows = mapCredits(detail, [], album.id);
    await db.delete(credits).where(eq(credits.albumId, album.id));
    if (creditRows.length > 0) await db.insert(credits).values(creditRows).onConflictDoNothing();

    // 7. Derived columns, one statement.
    await recomputeAlbumDerived(album.id, positionsAreReal);

    // 8. MusicBrainz enrichment — optional, and its failure never fails the caller.
    await enrichAlbumFromMusicBrainz(album.id);

    return (await db.query.albums.findFirst({ where: eq(albums.id, album.id) })) ?? album;
  } catch (error) {
    if (error instanceof ProviderError && error.isMissing && !existing) return null;
    console.warn("[ingest] album sync failed, serving mirror —", error instanceof Error ? error.message : error);
    return existing ?? null;
  }
}

export const ensureAlbum = cache(ensureAlbumUncached);

/**
 * `duration_ms`, `mean_track_ms`, `track_count` and `disc_count`, all from the mirrored rows.
 *
 * This REPLACES the television original's `backfillEpisodeRunTime`, which the brief says
 * explicitly should NOT be ported: it is a TMDB data-quality workaround for a provider whose
 * own runtime field is empty. Every Deezer track carries a reliable duration, so the
 * equivalent is a deterministic SUM at ingest — which is both simpler and more accurate.
 *
 * Verified against the provider's own figure: Discovery's 14 tracks sum to 3,662 seconds, and
 * Deezer reports the album `duration` as 3662.
 */
export async function recomputeAlbumDerived(albumId: number, tracksAreAuthoritative = true): Promise<void> {
  await db.execute(sql`
    UPDATE albums SET
      duration_ms      = t.total,
      mean_track_ms    = t.mean,
      track_count      = t.n,
      disc_count       = t.discs,
      tracks_synced_at = ${tracksAreAuthoritative ? sql`now()` : sql`NULL`}
    FROM (
      SELECT COALESCE(SUM(duration_ms), 0)::int AS total,
             COALESCE(AVG(duration_ms), 0)::int AS mean,
             COUNT(*)::int                      AS n,
             GREATEST(COALESCE(MAX(disc_number), 1), 1)::int AS discs
      FROM tracks WHERE album_id = ${albumId}
    ) AS t
    WHERE albums.id = ${albumId}
  `);
}

/* -------------------------------------------------------------------------- */
/* MusicBrainz enrichment — never on a critical path                          */
/* -------------------------------------------------------------------------- */

/**
 * Writes `mbid`, `critic_score`, `critic_votes`, `tags`, `original_release_date`,
 * `secondary_types`, and RECOMPUTES `is_canonical` with better information than the title
 * regex had.
 *
 * Everything here runs through the optional client, so a busy MusicBrainz — which probing
 * found to be one response in three — produces an unchanged row and nothing else. The 30-day
 * stamp means a flaky failure is retried on the next view rather than on every view.
 */
export async function enrichAlbumFromMusicBrainz(albumId: number): Promise<void> {
  const album = await db.query.albums.findFirst({
    where: eq(albums.id, albumId),
    with: { artist: { columns: { name: true } } },
  });
  if (!album) return;
  if (album.mbSyncedAt && Date.now() - album.mbSyncedAt.getTime() < MUSICBRAINZ_TTL) return;

  /**
   * TWO REQUESTS, AND IT HAS TO BE TWO.
   *
   * The MusicBrainz SEARCH endpoint and the LOOKUP endpoint return different shapes, and the
   * difference is the entire enrichment:
   *
   *   /release-group?query=…   ->  id, score, title, first-release-date, primary-type,
   *                                artist-credit, releases, tags
   *   /release-group/{mbid}    ->  …plus RATING, GENRES, SECONDARY-TYPES, disambiguation
   *
   * `inc=ratings+genres` is accepted on the search URL and silently ignored. The first version
   * of this function called search only, so it resolved MBIDs and first-release dates
   * correctly — which is why the reissue fix appeared to work — while producing a catalogue
   * with `critic_votes = 0` on every single row. A whole seeding run looked successful and the
   * consensus card, the feature this provider exists for, was never reachable.
   *
   * It was also quietly WRONG rather than merely incomplete: with no `secondary-types` in the
   * payload, the `is_canonical` recompute below ran with an empty array and
   * `musicbrainzKnown: true`, so it trusted "no secondary types" as a checked-and-clean answer
   * when in fact nothing had been checked.
   *
   * Once an album has an mbid the search is skipped, so the steady-state cost is one request.
   */
  const resolved = album.mbid
    ? ({ status: "found", value: { id: album.mbid } } as const)
    : await findReleaseGroup(album.artist?.name ?? "", album.title);

  if (resolved.status === "unavailable") return;
  if (resolved.status === "absent") {
    await db.update(albums).set({ mbSyncedAt: new Date() }).where(eq(albums.id, albumId));
    return;
  }

  const found = await getReleaseGroupOutcome(resolved.value.id);

  /**
   * THREE OUTCOMES, AND ONLY TWO OF THEM MAY BE CACHED.
   *
   *   found       — write the enrichment and stamp.
   *   absent      — stamp, so a title with genuinely no MusicBrainz match is not re-queried on
   *                 every page view for the next month. This is the difference between an
   *                 optional provider and a provider that costs a request per page load
   *                 forever.
   *   unavailable — DO NOT STAMP. Leave the row unenriched so the next view tries again.
   *
   * The first version of this function collapsed `absent` and `unavailable` into one null and
   * stamped both, which is how a five-minute MusicBrainz outage became thirty days of
   * permanent absence: the first seeding run stamped an entire 37-album batch during a busy
   * spell and produced a catalogue with `critic_votes = 0` everywhere — no consensus card at
   * all, from an endpoint verified working minutes earlier.
   */
  if (found.status === "unavailable") return;
  if (found.status === "absent") {
    await db.update(albums).set({ mbSyncedAt: new Date() }).where(eq(albums.id, albumId));
    return;
  }

  const enrichment = mapAlbumEnrichment(found.value);
  await db
    .update(albums)
    .set({
      mbid: enrichment.mbid,
      criticScore: enrichment.criticScore,
      criticVotes: enrichment.criticVotes,
      tags: enrichment.tags,
      originalReleaseDate: enrichment.originalReleaseDate,
      secondaryTypes: enrichment.secondaryTypes,
      isCanonical: isCanonicalRelease({
        recordType: album.recordType,
        secondaryTypes: enrichment.secondaryTypes,
        primaryType: enrichment.primaryType,
        title: album.title,
        musicbrainzKnown: true,
      }),
      mbSyncedAt: new Date(),
    })
    .where(eq(albums.id, albumId));

  /**
   * Propagate the artist MBID we were just handed for free.
   *
   * This is the only cheap source of one: resolving an artist MBID by search would cost a
   * request per artist against the flakiest provider in the stack. Writing it here is what
   * makes `enrichArtistFromMusicBrainz` able to run at all on a later pass — and therefore
   * what makes `artists.critic_score` reachable, which the artist page's consensus card needs.
   */
  if (enrichment.artistMbid) {
    const artist = await db.query.artists.findFirst({
      where: eq(artists.id, album.artistId),
      columns: { id: true, mbid: true },
    });
    if (artist && !artist.mbid) {
      await db
        .update(artists)
        // onConflictDoNothing is not available on an UPDATE, and two albums by one artist can
        // race here. `artists_mbid_uq` would then reject the second write, so the update is
        // guarded rather than allowed to throw into the caller's page render.
        .set({ mbid: enrichment.artistMbid })
        .where(and(eq(artists.id, artist.id), isNull(artists.mbid)));
    }
  }
}

export async function enrichArtistFromMusicBrainz(artist: Artist): Promise<void> {
  if (artist.mbSyncedAt && Date.now() - artist.mbSyncedAt.getTime() < MUSICBRAINZ_TTL) return;
  if (!artist.mbid) {
    // No MBID yet and no cheap way to resolve one without a search; stamp and move on. The
    // album enrichment path resolves artist MBIDs as a side effect of release-group lookups
    // in a later pass, which is the cheaper order.
    await db.update(artists).set({ mbSyncedAt: new Date() }).where(eq(artists.id, artist.id));
    return;
  }

  const found = await getMbArtist(artist.mbid);
  if (!found) {
    await db.update(artists).set({ mbSyncedAt: new Date() }).where(eq(artists.id, artist.id));
    return;
  }

  const enrichment = mapArtistEnrichment(found);
  await db
    .update(artists)
    .set({
      country: enrichment.country,
      beganOn: enrichment.beganOn,
      endedOn: enrichment.endedOn,
      criticScore: enrichment.criticScore,
      criticVotes: enrichment.criticVotes,
      tags: enrichment.tags,
      mbSyncedAt: new Date(),
    })
    .where(eq(artists.id, artist.id));
}

/* -------------------------------------------------------------------------- */
/* Discography                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `ensureAllSeasons`' replacement. THREE PROPERTIES TO PRESERVE:
 *
 *  1. NON-CANONICAL RELEASES ARE NEVER BULK-FILLED — only on direct navigation. This is the
 *     equivalent of the original never bulk-filling season 0, and for the same reason: a
 *     deluxe edition's bonus tracks in a discography grid corrupt both the shape and the
 *     completion denominator.
 *  2. THE LOOP IS AWAITED SEQUENTIALLY. A thirty-album discography would otherwise fire
 *     thirty parallel requests on a cold page and eat the platform-wide budget that every
 *     other member is also drawing on.
 *  3. IT IS CAPPED, AND IT SAYS WHAT IT DROPPED. A silent cap reads as "covered everything"
 *     when it did not.
 */
export async function ensureDiscography(artist: Artist): Promise<void> {
  const summaries = await getArtistAlbums(artist.deezerId);
  if (summaries.length === 0) return;

  await cacheAlbumSummaries(summaries, artist.id);

  // Refresh `is_active`, which is the only thing choosing between the two artist TTLs.
  const latest = summaries
    .map((summary) => summary.release_date)
    .filter((date): date is string => Boolean(date))
    .sort()
    .at(-1);
  const active = isActiveArtist(latest);
  if (active !== artist.isActive) {
    await db.update(artists).set({ isActive: active }).where(eq(artists.id, artist.id));
  }

  const pending = await db.query.albums.findMany({
    where: and(eq(albums.artistId, artist.id), eq(albums.isCanonical, true), isNull(albums.tracksSyncedAt)),
    columns: { deezerId: true },
    orderBy: (table, { desc }) => [desc(table.fans)],
  });

  const batch = pending.slice(0, DISCOGRAPHY_FILL_CAP);
  for (const album of batch) {
    await ensureAlbum(album.deezerId); // sequential ON PURPOSE
  }

  const dropped = pending.length - batch.length;
  if (dropped > 0) {
    console.info(
      `[ingest] discography for artist ${artist.id}: filled ${batch.length}, deferred ${dropped} to the next view`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Summary caching — the asymmetric backfill upsert                           */
/* -------------------------------------------------------------------------- */

/**
 * The write path for every discovery surface, and THREE DETAILS EACH OF WHICH IS A BUG
 * POSTMORTEM:
 *
 *  1. GENRE IDS ARE RESOLVED TO NAMES. Without it a row is stored with no genres and the
 *     recommender cannot see the album at all — 85% of the original's mirror, measured.
 *  2. DEDUPE BY EXTERNAL ID IN JS BEFORE THE BULK INSERT. Postgres refuses an
 *     ON CONFLICT DO UPDATE that touches the same row twice in one statement and fails the
 *     WHOLE batch.
 *  3. THE UPSERT TOUCHES ONLY FIVE COLUMNS, AND ONLY ROWS WITH NOTHING TO LOSE.
 *
 * A detail sync knows more than a summary does — its track counts, label, credits and critic
 * score must not be overwritten by this path — but A ROW WITH NO GENRES HAS NOTHING TO LOSE.
 *
 * CONSEQUENCE, and it is worth knowing: once a row has genres, this path can never refresh its
 * popularity or fan count. Only a detail sync can.
 */
export async function cacheAlbumSummaries(
  summaries: DeezerAlbumSummary[],
  knownArtistId?: number,
): Promise<void> {
  if (summaries.length === 0) return;

  try {
    const vocab = await vocabulary();

    // Resolve artists first. Deduped, so twelve albums by one artist cost one lookup.
    const artistIds = new Map<string, number>();
    for (const summary of summaries) {
      const ref = summary.artist;
      if (!ref?.id) continue;
      const key = String(ref.id);
      if (artistIds.has(key)) continue;
      artistIds.set(key, await ensureArtistStub(ref as never));
    }

    const seen = new Set<string>();
    const rows = summaries
      .filter((summary) => {
        const key = String(summary.id);
        if (seen.has(key)) return false; // detail 2
        seen.add(key);
        return true;
      })
      .map((summary) => {
        /**
         * `knownArtistId` IS THE FALLBACK, NOT A HINT — and getting that backwards cost 38
         * silently-dropped rows.
         *
         * `GET /artist/{id}/albums` returns summaries with NO `artist` OBJECT AT ALL (verified:
         * the keys are id, title, link, cover*, md5_image, genre_id, fans, release_date,
         * record_type, tracklist, explicit_lyrics, type — and nothing else). The first version
         * of this function read `knownArtistId` only for rows that already carried an artist,
         * and then filtered out every row that did not — so a discography fill inserted
         * NOTHING, reported success, and left the artist page with the two albums the seed had
         * mirrored by hand.
         *
         * That is the exact silent-failure shape the brief records for the television version:
         * "every summary cache write failed silently — the console line was there, the
         * candidates were simply untagged." Hence the explicit count logged below.
         */
        const artistId = summary.artist?.id ? artistIds.get(String(summary.artist.id)) : knownArtistId;
        return artistId === undefined ? null : mapAlbumSummary(summary, artistId, vocab);
      })
      .filter((row): row is NonNullable<typeof row> => row !== null && Number.isInteger(row.artistId));

    const dropped = summaries.length - rows.length;
    if (dropped > 0) {
      // Never silent. A summary that cannot be attributed to an artist is a row the
      // recommender will never see, and the failure is invisible from the interface.
      console.warn(`[ingest] summary cache: dropped ${dropped} of ${summaries.length} rows with no resolvable artist`);
    }

    if (rows.length === 0) return;

    await db
      .insert(albums)
      .values(rows)
      .onConflictDoUpdate({
        target: albums.deezerId,
        set: {
          genres: sqlExcluded("genres"),
          fans: sqlExcluded("fans"),
          coverPath: sqlExcluded("cover_path"),
          recordType: sqlExcluded("record_type"),
          releaseDate: sqlExcluded("release_date"),
        },
        setWhere: sql`albums.genres = '[]'::jsonb`, // detail 3
      });
  } catch (error) {
    // Deliberately non-fatal: this is a write-behind for a surface that has already rendered.
    // But it is LOGGED AS A WARNING, because the original's equivalent failure was swallowed
    // so completely that "every summary cache write failed silently — the console line was
    // there, the candidates were simply untagged".
    console.warn("[ingest] summary cache write failed —", error instanceof Error ? error.message : error);
  }
}

/* -------------------------------------------------------------------------- */
/* The neighbour graph                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Fills `artist_similar` from Deezer `/artist/{id}/related`.
 *
 * THE MOST IMPORTANT NON-OBVIOUS THING IN THIS FILE. The neighbour term is the largest single
 * term in the recommender and the reason ranking works at all; the brief's measurement is that
 * without it, every candidate in a genre pool lands within a few hundredths of every other and
 * the ordering collapses to provider-score order.
 *
 * It is CACHED IN A TABLE rather than fetched per render, which the television original does
 * not do, because /for-you fans out over the member's top artists and re-fetching that set on
 * every render would dominate the outbound budget.
 */
export async function ensureArtistSimilar(artist: Artist): Promise<void> {
  const existing = await db.query.artistSimilar.findFirst({
    where: eq(artistSimilar.artistId, artist.id),
    columns: { synced_at: true },
  });
  if (existing && Date.now() - existing.synced_at.getTime() < SIMILAR_TTL) return;

  const related = await getRelatedArtists(artist.deezerId, 20);
  if (related.length === 0) return;

  const rows: Array<{ artistId: number; similarId: number; position: number; source: string }> = [];
  for (const [index, neighbour] of related.entries()) {
    if (!neighbour.id || !neighbour.name) continue;
    const similarId = await ensureArtistStub(neighbour as never);
    if (similarId === artist.id) continue; // an artist is not their own neighbour
    rows.push({ artistId: artist.id, similarId, position: index, source: "deezer" });
  }
  if (rows.length === 0) return;

  await db.delete(artistSimilar).where(eq(artistSimilar.artistId, artist.id));
  await db.insert(artistSimilar).values(rows).onConflictDoNothing();
}

/* -------------------------------------------------------------------------- */
/* Lookups by internal id (the shape routes actually have)                    */
/* -------------------------------------------------------------------------- */

/**
 * Routes carry INTERNAL ids, because the slug grammar is `<title>-<serialId>`. These resolve
 * to a fresh row via the external id, which keeps every caller one function away from a
 * guaranteed-fresh mirror.
 */
export const ensureAlbumById = cache(async (id: number): Promise<Album | null> => {
  const row = await db.query.albums.findFirst({ where: eq(albums.id, id) });
  if (!row) return null;
  if (!isStale(row.synced_at, ALBUM_TTL) && row.tracksSyncedAt) return row;
  return (await ensureAlbum(row.deezerId)) ?? row;
});

export const ensureArtistById = cache(async (id: number): Promise<Artist | null> => {
  const row = await db.query.artists.findFirst({ where: eq(artists.id, id) });
  if (!row) return null;
  const ttl = row.isActive ? ARTIST_ACTIVE_TTL : ARTIST_INACTIVE_TTL;
  if (!isStale(row.synced_at, ttl)) return row;
  return (await ensureArtist(row.deezerId)) ?? row;
});

/** Used by the admin resync action, which is the only `revalidateTag` caller. */
export async function albumsByIds(ids: number[]): Promise<Album[]> {
  if (ids.length === 0) return []; // `IN ()` is invalid SQL
  return db.query.albums.findMany({ where: inArray(albums.id, ids) });
}

export { slugify };

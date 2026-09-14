/**
 * The tracklist. A Server Component, and the server half of a split pair.
 *
 * ---------------------------------------------------------------------------------------
 * THE SPLIT IS WHAT KEEPS `server-only` OUT OF THE BROWSER
 * ---------------------------------------------------------------------------------------
 *
 * `trackKey(disc, track)` and `albumTrackKey(albumId, disc, track)` are the two key shapes the
 * viewer maps are built with, and they live in `lib/db/queries/albums.ts`, which opens with
 * `import "server-only"`. A client component cannot import either — which is why
 * components/artist/discography-heatmap.tsx has to re-declare one of them by hand, with a
 * comment explaining that a mismatched lookup fails SILENTLY (it returns undefined and renders
 * an uncoloured cell rather than an error).
 *
 * THIS FILE AVOIDS THAT COPY BY DOING THE LOOKUPS HERE. Every row receives plain resolved
 * values — a rating, a boolean, a count — so `TrackRow` never names a key and there is nothing
 * to keep in step. That is the whole reason the tracklist is not simply one client component
 * holding everything: twenty-two rows of markup would also ship twice, once as HTML and once
 * as props, which is the same trade `ActivityFeed` documents.
 *
 * ---------------------------------------------------------------------------------------
 * THE DISC HEADING, AND WHY IT IS A HEADING RATHER THAN A ROW
 * ---------------------------------------------------------------------------------------
 *
 * A multi-disc album gets one list per disc under a real `<h3>`, so the discs are two
 * navigable landmarks in a screen reader's heading list rather than one 22-item list with a
 * decorative divider in the middle. A single-disc album gets NO heading at all — the same
 * decision `trackLocator` makes when it drops the redundant "1-": on a 12-track record the
 * disc number is noise.
 *
 * ---------------------------------------------------------------------------------------
 * `<ul>`, NOT `<table>`
 * ---------------------------------------------------------------------------------------
 *
 * The rejected alternative was a real table, which would buy free header association for the
 * popularity and duration columns. It costs more than it pays: every row carries a star
 * slider, a toggle button and a crown, so the cells are controls rather than data; the
 * popularity column disappears below `sm`, which a table's fixed column count has to be told
 * about twice; and a per-disc `<tbody>` with a spanning heading row is markup nobody can read.
 * A list of rows with one label row above them is the same information with none of that, and
 * it matches every other list in the app.
 *
 * The label row is `aria-hidden`: each control in the row below already carries its own name
 * ("Popularity 62 out of 100 …", "43 seconds long", "Your rating for Aerodynamic"), so
 * announcing five orphan words before the list would be the same information twice, in the
 * wrong order. The label row is the sighted reader's version of those names.
 */

import { Eyebrow } from "@/components/ui/primitives";
import { TrackRow, type TrackRowTrack } from "@/components/album/track-row";
import { albumTrackKey, trackKey, type ViewerLog } from "@/lib/db/queries/albums";
import { cn } from "@/lib/utils";

/** The row shape this component needs, which is every column `TrackRow` renders. */
export type TracklistTrack = TrackRowTrack;

export type TracklistProps = {
  /**
   * `getAlbumWithTracks(albumId).tracks` — ALREADY ORDERED BY `(disc_number, track_number)`.
   * Nothing here re-sorts: the query owns that order, and an id order would put a bonus track
   * in the middle of the record after a re-sync from a different edition.
   */
  tracks: TracklistTrack[];
  albumId: number;
  /** `/album/<slug>` — every row's link and the strip's links are built from it. */
  albumHref: string;
  /** `album.discCount`. Drives the disc prefix and the heading; NOT derived from the rows. */
  discCount: number;
  /** The album artist, so a per-track credit is rendered only when it genuinely differs. */
  albumArtistName: string;
  /** False for a signed-out visitor — the row's write controls collapse to nothing. */
  canWrite?: boolean;
  /**
   * `getViewerAlbumState(...).trackLogs`, keyed by `trackKey(disc, track)`.
   *
   * Only `rating` is read. The rest of the `ViewerLog` (review, tags, diary date) belongs to
   * the log dialog, and the tracklist deliberately does not mount one: a dialog posts every
   * field and is only safe primed from a real row.
   */
  trackLogs?: ReadonlyMap<string, Pick<ViewerLog, "rating">> | null;
  /** `getViewerAlbumState(...).listenedTracks`, keyed by `trackKey`. */
  listenedTracks?: ReadonlySet<string> | null;
  /** `getViewerAlbumState(...).replayCounts`, keyed by `trackKey`. */
  replayCounts?: ReadonlyMap<string, number> | null;
  /** `getCrownedTracks(viewerId, albumId)` — keyed by `albumTrackKey`, NOT `trackKey`. */
  crowned?: ReadonlySet<string> | null;
  /** `countHeld(userId)` — the GLOBAL Desert Island count across every artist. */
  desertIslandUsed?: number;
  /** `DESERT_ISLAND_QUOTA`. Omit it and no row offers a crown. */
  desertIslandQuota?: number;
  className?: string;
};

type DiscGroup = { disc: number; tracks: TracklistTrack[] };

/**
 * A SINGLE PASS over an already-sorted array, the same shape `groupByDay` uses in the activity
 * feed: consecutive runs of one disc are contiguous by construction, so the only question per
 * track is "is this the same disc as the one before it". Grouping into a keyed object and
 * sorting the keys would re-derive an order the query already established, and would paper over
 * a caller who handed us unsorted rows — which is worth seeing as interleaved headings rather
 * than silently repaired.
 */
export function groupByDisc(tracks: TracklistTrack[]): DiscGroup[] {
  const groups: DiscGroup[] = [];
  let current: DiscGroup | null = null;

  for (const track of tracks) {
    if (!current || current.disc !== track.discNumber) {
      current = { disc: track.discNumber, tracks: [] };
      groups.push(current);
    }
    current.tracks.push(track);
  }

  return groups;
}

export function Tracklist({
  tracks,
  albumId,
  albumHref,
  discCount,
  albumArtistName,
  canWrite = false,
  trackLogs,
  listenedTracks,
  replayCounts,
  crowned,
  desertIslandUsed = 0,
  desertIslandQuota,
  className,
}: TracklistProps) {
  /*
   * NOTHING, NOT AN EMPTY STATE — the album hero above already reports the track count, and a
   * card saying "no tracks" under a record that says it has eleven is a contradiction on one
   * page. An unmirrored tracklist is our gap, and `ensureAlbum` is what closes it.
   */
  if (tracks.length === 0) return null;

  const groups = groupByDisc(tracks);
  const multiDisc = groups.length > 1;

  return (
    <div className={cn("space-y-4", className)}>
      {/* The column labels. See the docblock for why this is `aria-hidden`. */}
      <div aria-hidden="true" className="flex items-center gap-x-3 border-b border-line pb-1.5">
        <Eyebrow className="w-8 shrink-0">#</Eyebrow>
        <Eyebrow className="min-w-0 flex-1">Track</Eyebrow>
        {/* Hidden at the same breakpoint as the meter itself, so a bar never appears unlabelled. */}
        <Eyebrow className="hidden w-16 shrink-0 sm:block">Pop.</Eyebrow>
        <Eyebrow className="w-10 shrink-0 text-right">Time</Eyebrow>
      </div>

      {groups.map((group) => (
        <section key={group.disc}>
          {multiDisc ? (
            <h3 className="section-rule mb-1 pt-1">
              <span className="eyebrow">Disc {group.disc}</span>
            </h3>
          ) : null}

          <ul className="divide-y divide-line">
            {group.tracks.map((track) => {
              // THE LOOKUPS, DONE ONCE, HERE. Two key shapes, and they are not interchangeable:
              // `trackKey` is scoped to this album, `albumTrackKey` spans a discography.
              const within = trackKey(track.discNumber, track.trackNumber);
              const across = albumTrackKey(albumId, track.discNumber, track.trackNumber);

              return (
                <TrackRow
                  key={within}
                  track={track}
                  albumId={albumId}
                  albumHref={albumHref}
                  discCount={discCount}
                  albumArtistName={albumArtistName}
                  canWrite={canWrite}
                  viewerRating={trackLogs?.get(within)?.rating ?? null}
                  listened={listenedTracks?.has(within) ?? false}
                  playCount={replayCounts?.get(within) ?? 0}
                  crowned={crowned?.has(across) ?? false}
                  desertIslandUsed={desertIslandUsed}
                  desertIslandQuota={desertIslandQuota}
                />
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

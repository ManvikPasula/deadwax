/**
 * THE REPLAY PILLAR — most-played albums and most-played tracks.
 *
 * NO `"use client"`. Two passes over two arrays.
 *
 * ---------------------------------------------------------------------------------------
 * THIS REPLACES "PROGRESS", AND IT HAD TO
 * ---------------------------------------------------------------------------------------
 *
 * The television original's second profile pillar is continue-watching: a meter per show
 * reporting how far through it a viewer is. NOBODY IS PARTWAY THROUGH A 42-MINUTE ALBUM. A
 * record is consumed in one sitting, so a progress bar over it is either 0% or 100% within an
 * hour and says nothing about the listener in between — whereas "how many times" is the
 * question a music diary can actually answer, and the one a listener cares about.
 *
 * So the number here is a COUNT, not a fraction, and there is no meter: a count of plays has
 * no denominator. `CoverCard` makes the same substitution one level down, where television's
 * progress bar becomes a teal `×4` badge.
 *
 * TWO RANKINGS, NOT ONE. `getReplayLeaders` returns `{ albums, tracks }` from one call for the
 * same reason `TopRated` keeps three apart: album plays and track plays are counted from
 * different rows and mean different things, and merging them would rank a record against one
 * of its own songs.
 *
 * ---------------------------------------------------------------------------------------
 * THE TWO NUMBERS PER ROW DISAGREE, AND BOTH ARE REPORTED
 * ---------------------------------------------------------------------------------------
 *
 * `plays` is log rows. `markedReplays` is `logs.is_replay`, the member's OWN flag. They differ
 * often and for good reasons — the first logged play of a record somebody has owned for twenty
 * years is legitimately flagged a replay, and a member who never touches the checkbox has five
 * plays and zero marked replays. NEITHER IS A CORRECTION OF THE OTHER, so this component shows
 * `plays` as the rank-bearing figure and `markedReplays` only when it is non-zero, rather than
 * quietly preferring one.
 *
 * ALBUM PLAYS ARE ALBUM-LEVEL LOG ROWS, not anything derived from track rows. The known cost,
 * recorded in the query: a member who only ever logs individual tracks has no album leaders at
 * all. That is honest — they never told us they played the record — and it is why the empty
 * state below names the behaviour rather than the number.
 *
 * TEAL IS THE REPLAY AND COMPLETION COLOUR AND IS USED FOR NOTHING ELSE IN THE APP. This is
 * the section it exists for.
 *
 * URLS ARE BUILT WITH `albumSlug`, NEVER FROM THE `slug` COLUMN THE QUERY RETURNS.
 * `albums.slug` is `slugify(title)` with NO trailing id — the Deezer mapper writes it that
 * way — and the URL grammar keys on the trailing id. Using `row.slug` produces `/album/kid-a`,
 * which `parseAlbumSlug` cannot resolve, so every link would 404. `lib/view.ts` recomputes it
 * for the same reason.
 */

import { Disc3, Music4, Repeat2 } from "lucide-react";
import Link from "next/link";

import { Badge, EmptyState, SectionHeading } from "@/components/ui/primitives";
import type { ReplayAlbum, ReplayTrack } from "@/lib/stats/profile";
import { formatCount, formatDate, plural } from "@/lib/format";
import { albumCover } from "@/lib/providers/images";
import { albumSlug, trackLocator } from "@/lib/slug";
import { cn } from "@/lib/utils";

/** 48px rendered; 250 is the next CDN rung, so the thumbnail is sharp at 2x. */
const THUMB_SOURCE_WIDTH = 250;

/** One row, resolved once, so the two columns cannot drift apart. */
type Leader = {
  key: string;
  href: string;
  imageUrl: string | null;
  primary: string;
  secondary: string;
  plays: number;
  markedReplays: number;
  lastListenedOn: string | null;
  isTrack: boolean;
};

export type ReplayLeadersProps = {
  /** `getReplayLeaders(userId)` — both rankings from one call, already ordered by plays. */
  leaders: { albums: ReplayAlbum[]; tracks: ReplayTrack[] };
  /**
   * The threshold the query applied, for the empty-state copy. Defaults to two, which is
   * `REPLAY_LEADER_MIN_PLAYS`: "one play is not a replay — a leaderboard of records played once
   * is just the diary under a different heading, and on a fresh account every row would tie at
   * 1 and the ordering would collapse to insertion order."
   *
   * A PROP RATHER THAN AN IMPORT. The constant lives in lib/stats/profile.ts, which opens with
   * `import "server-only"`; importing the value would pin this component to the server for one
   * number in one sentence, and the type import above is erased either way.
   */
  minPlays?: number;
  className?: string;
};

export function ReplayLeaders({ leaders, minPlays = 2, className }: ReplayLeadersProps) {
  const albumRows: Leader[] = leaders.albums.map((album) => ({
    key: `album-${album.albumId}`,
    href: `/album/${albumSlug(album.title, album.albumId)}`,
    imageUrl: albumCover({ coverPath: album.coverPath, mbid: album.mbid }, THUMB_SOURCE_WIDTH),
    primary: album.title,
    secondary: album.artistName,
    plays: album.plays,
    markedReplays: album.markedReplays,
    lastListenedOn: album.lastListenedOn,
    isTrack: false,
  }));

  const trackRows: Leader[] = leaders.tracks.map((track) => {
    const albumHref = `/album/${albumSlug(track.albumTitle, track.albumId)}`;
    // `discCount` comes from `albums.disc_count` precisely so the locator can drop a redundant
    // "1-" on a single-disc record; it is also the URL segment, so it must be built once.
    const locator = trackLocator({
      disc: track.discNumber,
      track: track.trackNumber,
      discCount: track.discCount,
    });
    return {
      key: `track-${track.trackId}`,
      href: `${albumHref}/track/${locator}`,
      imageUrl: albumCover({ coverPath: track.coverPath, mbid: track.mbid }, THUMB_SOURCE_WIDTH),
      primary: track.title,
      secondary: `${track.albumTitle} · ${locator} · ${track.artistName}`,
      plays: track.plays,
      markedReplays: track.markedReplays,
      lastListenedOn: track.lastListenedOn,
      isTrack: true,
    };
  });

  return (
    <section className={cn("space-y-4", className)}>
      <SectionHeading eyebrow="Replays" title="Played again and again" />

      {albumRows.length === 0 && trackRows.length === 0 ? (
        /*
         * A REAL EMPTY STATE HERE, unlike `TopRated`, and the difference is that this one has a
         * RULE the member cannot guess. Nothing on the page says that a single play does not
         * qualify, so an absent section would read as a broken feature rather than as a
         * threshold not yet met. `EmptyState` always offers the next move, and here the next
         * move is simply "play something twice".
         */
        <EmptyState
          title="Nothing replayed yet"
          description={`A record needs ${plural(minPlays, "play")} before it appears here — one play is the diary, not a replay.`}
        />
      ) : (
        <div className="grid gap-x-8 gap-y-8 lg:grid-cols-2">
          <Ranking title="Albums" rows={albumRows} empty="No album plays logged yet — logging a whole record is what counts one." />
          <Ranking title="Tracks" rows={trackRows} empty="No track plays logged yet." />
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* One ranking                                                                */
/* -------------------------------------------------------------------------- */

function Ranking({ title, rows, empty }: { title: string; rows: Leader[]; empty: string }) {
  return (
    <div>
      <h3 className="section-rule mb-1">
        <span className="eyebrow">{title}</span>
      </h3>

      {rows.length === 0 ? (
        // A sentence, not a bordered panel: one of the two columns being empty is ordinary (see
        // the album-plays note in the module docblock), and a box inside a two-column grid makes
        // the ordinary state look like a failure in half the section.
        <p className="py-3 text-[0.8125rem] text-faint">{empty}</p>
      ) : (
        <ol className="divide-y divide-line">
          {rows.map((row) => {
            const played = formatDate(row.lastListenedOn);
            return (
              <li key={row.key} className="group flex items-center gap-3 py-2.5">
                <span className="sleeve block w-12 shrink-0" aria-hidden="true">
                  {row.imageUrl ? (
                    <img
                      src={row.imageUrl}
                      // Empty alt: the title beside it is the link text and therefore the name.
                      alt=""
                      loading="lazy"
                      decoding="async"
                      width={48}
                      height={48}
                      className="size-full object-cover"
                    />
                  ) : (
                    <span className="flex size-full items-center justify-center text-line-bright">
                      {row.isTrack ? <Music4 className="size-4" /> : <Disc3 className="size-4" />}
                    </span>
                  )}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.8125rem] leading-snug">
                    <Link href={row.href} className="text-paper transition-colors group-hover:text-amber">
                      {row.primary}
                    </Link>
                  </p>
                  <p className="truncate font-mono text-[0.6875rem] tabular text-faint">
                    {row.secondary}
                    {played ? (
                      <>
                        <span aria-hidden="true"> · </span>
                        <span className="sr-only">, last played </span>
                        <time dateTime={row.lastListenedOn ?? undefined}>{played}</time>
                      </>
                    ) : null}
                  </p>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1">
                  {/*
                    THE COUNT IS THE DATUM AND THE BADGE IS TEAL, the replay colour. The glyph
                    reads as "times four" to nobody, so the visible text is `aria-hidden` and the
                    sentence beside it carries the number in words.
                  */}
                  <Badge tone="teal" aria-hidden="true">
                    <Repeat2 />
                    {`×${formatCount(row.plays)}`}
                  </Badge>
                  <span className="sr-only">
                    {plural(row.plays, "play")}
                    {row.markedReplays > 0 ? `, ${formatCount(row.markedReplays)} of them marked as replays` : ""}
                  </span>
                  {/*
                    The member's own flag, shown only when they have used it — and labelled
                    "marked" rather than presented as a correction to `plays`, because the two
                    numbers answer different questions.
                  */}
                  {row.markedReplays > 0 ? (
                    <p aria-hidden="true" className="font-mono text-[0.6875rem] tabular text-faint">
                      {formatCount(row.markedReplays)} marked
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

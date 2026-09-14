"use client";

/**
 * One row of the tracklist, and the densest write surface in the product: a rating, a listened
 * tick and a Desert Island crown, on twelve to twenty-two rows of one page.
 *
 * `"use client"` because there are two optimistic states, two transitions and event handlers.
 * THE LOOKUPS ARE NOT DONE HERE THOUGH — `Tracklist` is a Server Component and resolves
 * `trackKey`/`albumTrackKey` against the viewer maps before this row is mounted, so nothing in
 * the browser needs `lib/db/queries/albums.ts`. That module is `server-only`, and the
 * discography heatmap has to duplicate its key helper as a consequence (its docblock explains
 * why); keeping the lookups in the server half is how this file avoids the same copy.
 *
 * ---------------------------------------------------------------------------------------
 * THE POPULARITY METER IS A METER, AND IT WILL NEVER BE STARS
 * ---------------------------------------------------------------------------------------
 *
 * Deezer's `popularity` is `rank / 10_000` — A STREAM COUNT, NORMALISED. It is not a rating,
 * it is not a vote, and nobody has expressed an opinion by producing it. Rendering it as
 * stars, or as a heatmap colour, is THE ONE DISHONESTY THIS PRODUCT REFUSES: the row would look
 * identical to one built from ratings while meaning something entirely different, and no
 * caption can undo that. So it is a `Meter` with a neutral fill, sitting under a column header
 * that says "Pop.", with its full sentence in the bar's own `aria-label`.
 *
 * `Meter` TAKES A RATIO OF 0..1 and `meterPercent()` RETURNS 0..100. The division is explicit
 * below; passing the percent straight through pins every meter at 100%, which looks like a
 * working feature.
 *
 * ---------------------------------------------------------------------------------------
 * TWO WRITES, TWO NARROW WRITERS, TWO TRANSITIONS
 * ---------------------------------------------------------------------------------------
 *
 *   `StarInput`  -> `saveLog({ albumId, discNumber, trackNumber, rating })`
 *   the tick     -> `toggleTrackListened({ ..., listened, listenedOn })`
 *
 * The star write sends ONLY `rating`, because `saveLog` leaves every column it was not given
 * alone (I-1) — so nudging a star on a track the member reviewed cannot touch the review. THIS
 * IS THE REASON THE ROW DOES NOT MOUNT A LOG DIALOG: a dialog posts every field and is only
 * safe when primed from the real row, which is a per-track query the tracklist does not run.
 *
 * TWO SEPARATE `useTransition`s, not one. A shared pending flag disables the tick while a
 * debounced rating commit is in flight, and the star input's own 250ms debounce makes that
 * window routine rather than rare.
 *
 * ROLLBACK IS TO THE PROP. The rating's optimistic slot is `number | null | undefined` and NOT
 * `number | null`, because `null` is a real value here — "clear my rating" — and `undefined` is
 * the separate state "nothing local, defer to the server". Collapsing them drops a clear, which
 * is exactly the distinction `StarInput`'s own pending ref draws.
 */

import { Check, LoaderCircle, Repeat2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import { saveLog, toggleTrackListened } from "@/app/actions/logs";
import { DesertIslandButton } from "@/components/album/desert-island-button";
import { PreviewButton } from "@/components/album/preview-button";
import { StarInput } from "@/components/rating/star-input";
import { FormError } from "@/components/ui/field";
import { Badge, Meter } from "@/components/ui/primitives";
import type { TrackRow as TrackRecord } from "@/lib/db/queries/albums";
import { formatDuration, localCalendarDate } from "@/lib/format";
import { meterPercent } from "@/lib/ratings";
import { trackLocator } from "@/lib/slug";
import { cn } from "@/lib/utils";

/** Exactly the columns a row renders. A `Pick` rather than a copy, so a rename reaches here. */
export type TrackRowTrack = Pick<
  TrackRecord,
  "discNumber" | "trackNumber" | "title" | "durationMs" | "popularity" | "explicit" | "artistName" | "previewUrl"
>;

export type TrackRowProps = {
  track: TrackRowTrack;
  albumId: number;
  /** `/album/<slug>`. The title links to `${albumHref}/track/${locator}`. */
  albumHref: string;
  /** `album.discCount` — drives `trackLocator`'s disc prefix and nothing else. */
  discCount: number;
  /**
   * The album artist. A per-track credit is rendered ONLY when it differs from this: the
   * mirror already stores `tracks.artist_name` as null when they match, and the comparison
   * here is the second belt — an edition that spells the album artist differently on one track
   * would otherwise print the same name twelve times down the page.
   */
  albumArtistName: string;
  /** False for a signed-out visitor: every write control collapses to nothing. */
  canWrite?: boolean;
  /** `trackLogs.get(trackKey(disc, track))?.rating ?? null`. THE ROLLBACK TARGET. */
  viewerRating?: number | null;
  /**
   * `listenedTracks.has(trackKey(disc, track))`. THE ROLLBACK TARGET for the tick.
   *
   * There is no `listened` column in the schema: at track level "listened" means a
   * track-targeted log row exists, which is why a rating saved with "Add to diary" unchecked
   * still ticks this.
   */
  listened?: boolean;
  /** `replayCounts.get(...)` — EVERY row for the track, not only the `is_replay` ones. */
  playCount?: number;
  /** `crowned.has(albumTrackKey(...))`. */
  crowned?: boolean;
  /** `countHeld(userId)` — global, and already counting this track when `crowned`. */
  desertIslandUsed?: number;
  /** `DESERT_ISLAND_QUOTA`. Passed so the button never hard-codes ten. */
  desertIslandQuota?: number;
  className?: string;
};

export function TrackRow({
  track,
  albumId,
  albumHref,
  discCount,
  albumArtistName,
  canWrite = false,
  viewerRating = null,
  listened = false,
  playCount = 0,
  crowned = false,
  desertIslandUsed = 0,
  desertIslandQuota,
  className,
}: TrackRowProps) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  /** `undefined` = defer to the prop; `null` = a real cleared rating. See the docblock. */
  const [optimisticRating, setOptimisticRating] = React.useState<number | null | undefined>(undefined);
  const [optimisticListened, setOptimisticListened] = React.useState<boolean | null>(null);
  const [ratingPending, startRating] = React.useTransition();
  const [listenPending, startListen] = React.useTransition();

  const discNumber = track.discNumber;
  const trackNumber = track.trackNumber;
  // TWO CALLS, ON PURPOSE. The display form is zero-padded so a column of numbers lines up in
  // a tabular-nums gutter; the URL form is not, because `07` and `7` would be two addresses
  // for one track. Both suppress the redundant "1-" on a single-disc record.
  const shown = trackLocator({ disc: discNumber, track: trackNumber, discCount, pad: true });
  const locator = trackLocator({ disc: discNumber, track: trackNumber, discCount });

  const rating = optimisticRating === undefined ? viewerRating : optimisticRating;
  const isListened = optimisticListened ?? listened;
  const featured =
    track.artistName && track.artistName.toLowerCase() !== albumArtistName.toLowerCase() ? track.artistName : null;

  /** The debounced network write from `StarInput`'s `onCommit`. */
  function commitRating(next: number | null) {
    setError(null);
    startRating(async () => {
      // NARROW: only `rating`. Every other column of the row is left exactly as it was.
      const result = await saveLog({ albumId, discNumber, trackNumber, rating: next });
      if (!result.ok) {
        setOptimisticRating(undefined); // ROLL BACK TO THE PROP
        setError(result.error);
        return;
      }
      /*
       * `router.refresh()` because a track rating moves things this row cannot see: the
       * community average and the histogram above it, the track strip's cell, the artist
       * page's heatmap, the album's own rollup, and the member's lifetime counters.
       */
      router.refresh();
    });
  }

  function toggleListened() {
    const next = !isListened;
    setError(null);
    setOptimisticListened(next);
    startListen(async () => {
      const result = await toggleTrackListened({
        albumId,
        discNumber,
        trackNumber,
        listened: next,
        // THE MEMBER'S OWN CALENDAR DATE, not a UTC slice: somebody in UTC+13 logging at 09:00
        // local must not get yesterday's diary date. Used only on the insert path.
        listenedOn: localCalendarDate(),
      });
      if (!result.ok) {
        setOptimisticListened(null); // ROLL BACK TO THE PROP
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <li className={cn("group/track flex flex-wrap items-center gap-x-3 gap-y-1 py-2", className)}>
      {/* The locator gutter. Mono + `.tabular` + zero-padded is what keeps a two-digit row from
          shifting the titles of every row above it. */}
      <span className="w-8 shrink-0 font-mono text-[0.6875rem] tabular text-faint">{shown}</span>

      {/*
        A FIXED-WIDTH SLOT, HELD WHETHER OR NOT THERE IS A PREVIEW. `PreviewButton` renders
        NOTHING when Deezer sent no clip — which is most rows on most records — and without a
        reserved slot the title column would start 28px further right on the rows that do have
        one. A tracklist whose titles zig-zag down the page reads as broken, and the cause
        (a provider's coverage) is invisible.
      */}
      <span className="w-7 shrink-0">
        <PreviewButton previewUrl={track.previewUrl} trackTitle={track.title} />
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <Link
            href={`${albumHref}/track/${locator}`}
            prefetch={false}
            className="min-w-0 text-[0.8125rem] leading-snug text-paper transition-colors hover:text-amber"
          >
            {track.title}
          </Link>

          {track.explicit ? (
            <span title="Explicit lyrics">
              <span aria-hidden="true" className="font-mono text-[0.6875rem] text-faint">
                E
              </span>
              {/* The glyph is a letter to anybody who already knows the convention and nothing
                  to everybody else, so the word is carried separately. */}
              <span className="sr-only">Explicit lyrics</span>
            </span>
          ) : null}

          {/* A REPLAY COUNT, NOT A PROGRESS BAR: nobody is 40% of the way through a track, so
              the only honest number is how many times. Teal is replay/completion and nothing
              else in this palette. */}
          {playCount > 1 ? (
            <Badge tone="teal">
              <Repeat2 aria-hidden="true" />
              <span aria-hidden="true">{`×${playCount}`}</span>
              <span className="sr-only">{`Played ${playCount} times`}</span>
            </Badge>
          ) : null}
        </p>

        {/* THE FEATURED CREDIT ONLY WHEN IT DIFFERS. On twelve rows by one artist this line
            would otherwise repeat the album artist twelve times and say nothing. */}
        {featured ? <p className="truncate text-[0.6875rem] leading-tight text-faint">{featured}</p> : null}
      </div>

      {/*
        THE POPULARITY METER. Hidden below `sm` — it is the least important column in the row
        and the first thing a phone should drop. `Tracklist`'s caption ("bars are Deezer
        popularity…") is hidden at the SAME breakpoint, so a bar never appears without its
        explanation and the explanation never appears without a bar.
      */}
      <div
        className="hidden w-16 shrink-0 sm:block"
        // The pointer's copy of the bar's own `aria-label`. `Meter` hides an unlabelled bar
        // from assistive technology and names a labelled one, so the two never disagree.
        title={`Popularity ${track.popularity} of 100 — streams, not ratings`}
      >
        <Meter
          ratio={meterPercent(track.popularity, 100) / 100}
          // NEUTRAL, never amber. Amber is the rating colour in this app, and a popularity bar
          // painted in it is the same lie as rendering it as stars.
          tone="neutral"
          label={`Popularity ${track.popularity} out of 100 — how much this track is streamed, not how it is rated`}
        />
      </div>

      <span className="w-10 shrink-0 text-right font-mono text-[0.6875rem] tabular text-faint">
        {/* The word goes BEFORE the number, so this announces "Length 3:47" rather than
            "3:47 long" — and `formatDuration` prints "—" for a missing duration, which needs
            the label more than a real one does. */}
        <span className="sr-only">Length </span>
        {formatDuration(track.durationMs)}
      </span>

      {canWrite ? (
        <span className="flex shrink-0 items-center gap-2">
          {/*
            NOT `disabled={ratingPending}`, deliberately. The commit is debounced 250ms and then
            takes a round trip, and disabling the control for that window SWALLOWS THE NEXT
            GESTURE of a sweep — the member moves 3 stars to 4, the write fires, and the click
            that would have made it 5 lands on a dead input. Overlapping writes are safe here:
            `saveLog` patches the latest row and the last one to arrive wins, which is the same
            answer the member's last gesture asked for.
          */}
          <StarInput
            value={rating}
            size="sm"
            // Every star input in the app is named after what it rates. Ten hit targets with no
            // name, twelve times down a page, is unusable.
            label={`Your rating for ${track.title}`}
            onChange={setOptimisticRating}
            onCommit={commitRating}
          />

          {/*
            The rating write reports itself beside the stars rather than inside them. The
            spinner is a still glyph for anybody who asked for reduced motion (the blanket kill
            switch in globals.css), so the word is the only thing that still says "working".
          */}
          {ratingPending ? (
            <span className="inline-flex items-center">
              <LoaderCircle className="size-3 animate-spin text-faint" aria-hidden="true" />
              <span className="sr-only">Saving your rating</span>
            </span>
          ) : null}

          <button
            type="button"
            onClick={toggleListened}
            disabled={listenPending}
            aria-pressed={isListened}
            aria-label={isListened ? `Remove ${track.title} from your diary` : `Mark ${track.title} listened`}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-card border transition-colors",
              "disabled:pointer-events-none disabled:opacity-50",
              "[&_svg]:size-3.5 [&_svg]:shrink-0",
              isListened
                ? // Teal is completion. The tick glyph and `aria-pressed` carry the same state,
                  // so the colour is never the only channel.
                  "border-teal/40 bg-teal/12 text-teal"
                : "border-line bg-surface-2 text-faint hover:border-line-bright hover:text-paper",
            )}
          >
            {listenPending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
            {/* The spinner is a STILL GLYPH under `prefers-reduced-motion`, so the word is the
                only thing that still says "working". */}
            {listenPending ? <span className="sr-only">Saving</span> : null}
          </button>

          {/*
            THE CROWN IS REVEALED BY THE SAVED RATING, NOT THE OPTIMISTIC ONE.
            `crownTrack` gates on the LATEST SAVED rating for this exact track, so a button
            revealed the instant the fifth star is clicked would invite a click the server is
            required to refuse for the 250ms the debounce is still holding the write. The
            `router.refresh()` above is what brings it in, a moment later, when it will work.

            The component itself renders nothing unless the rating is exactly five stars, and
            `quota` is passed rather than assumed so nothing here hard-codes ten.
          */}
          {desertIslandQuota === undefined ? null : (
            <DesertIslandButton
              albumId={albumId}
              discNumber={discNumber}
              trackNumber={trackNumber}
              trackTitle={track.title}
              viewerRating={viewerRating}
              marked={crowned}
              used={desertIslandUsed}
              quota={desertIslandQuota}
            />
          )}
        </span>
      ) : null}

      {/* `basis-full` so a failure appears on its own line under the row that caused it rather
          than squeezing the title column. It renders nothing at all when there is no message. */}
      <div className="basis-full">
        <FormError message={error} />
      </div>
    </li>
  );
}

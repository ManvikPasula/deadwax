/**
 * The activity feed: the following feed on the home page, the global fallback, a member's
 * recent plays, and the diary.
 *
 * NO `"use client"`. Two pure passes over an array and some markup. The only interactive
 * things are the heart and the delete control, both of which are client components imported
 * as children — the alternative (one client feed owning the whole list) would ship fifty rows
 * of markup to the browser twice, once as HTML and once as props.
 *
 * TWO PASSES, IN THIS ORDER, AND THE ORDER IS THE DESIGN:
 *
 *   1. `groupByDay`   — split the already-sorted array into calendar days.
 *   2. `collapseRuns` — collapse listening runs, PER DAY GROUP.
 *
 * Collapsing inside the groups is what makes a day boundary break a run, which is the third
 * of the three run-breaking conditions. Running the collapse first and grouping after would
 * produce a run that spans two date headers and can only be filed under one of them.
 */

import { Heart, ListMusic, Repeat2, Star } from "lucide-react";
import Link from "next/link";
import type * as React from "react";

import { DeleteLogButton } from "@/components/social/delete-log-button";
import { LikeButton } from "@/components/social/like-button";
import {
  LogTargetLine,
  ReviewCard,
  logTargetHref,
  logTargetLabel,
} from "@/components/social/review-card";
import { Stars } from "@/components/rating/stars";
import { AvatarWithName } from "@/components/ui/avatar";
import { Badge, EmptyState } from "@/components/ui/primitives";
import type { LogAuthor, LogEntry } from "@/lib/db/queries/logs";
import { formatDate, formatRelative, localCalendarDate, plural } from "@/lib/format";
import { formatRating } from "@/lib/ratings";
import { albumSlug } from "@/lib/slug";
import { cn } from "@/lib/utils";

/* ========================================================================== *
 * PASS 1 — groupByDay
 * ========================================================================== */

export type DayGroup = { date: string; entries: LogEntry[] };

/**
 * A SINGLE PASS, not a `Map` and not a `reduce` over a dictionary.
 *
 * Entries arrive newest first from every caller (`getFollowingFeed`, `getDiary`,
 * `getRecentLogs` all order by `created_at DESC`), so consecutive runs of the same calendar
 * date are already contiguous: the only question per entry is "is this the same day as the
 * one before it". Grouping into a keyed object and then sorting the keys would re-derive an
 * order the query already established, and would silently paper over a caller that forgot to
 * sort — which is a bug worth seeing as interleaved date headers rather than hiding.
 *
 * THE KEY IS THE MEMBER'S LOCAL CALENDAR DATE, NOT A UTC ISO SLICE.
 *
 * The television original computes every date as `toISOString().slice(0, 10)`, which is UTC.
 * A listener in UTC+13 logging through their evening crosses UTC midnight halfway through it,
 * so ONE SITTING SPLITS ACROSS TWO DAY HEADERS — and, because collapsing happens per group,
 * their run splits with it. `localCalendarDate` is the same function the log dialog uses to
 * stamp a diary date, so the header a member reads and the date they wrote agree.
 *
 * The honest limit of this: `localCalendarDate` reads the RUNTIME's zone, and on the server
 * that is the deployment's. `users` carries no timezone column, so there is no per-member zone
 * to read; the fix that exists is deploying with a zone rather than pretending UTC is nobody's
 * local time. Adding the column later changes this one call.
 */
export function groupByDay(entries: LogEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;

  for (const entry of entries) {
    const date = localCalendarDate(entry.createdAt);
    if (!current || current.date !== date) {
      current = { date, entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }

  return groups;
}

/* ========================================================================== *
 * PASS 2 — collapseRuns
 * ========================================================================== */

/**
 * FIVE, NOT THREE.
 *
 * The television original collapses at three consecutive episode logs. An album is 10–14
 * tracks consumed in about forty minutes, so a listener working through a record generates
 * runs constantly and continuously — at three, nearly every listening session in the product
 * would collapse into a single row and the feed would stop showing what anybody is actually
 * playing. Five is above the length of an EP side and still well under an album, so a
 * deliberate front-to-back listen collapses while a handful of tracks stays legible as
 * individual entries.
 */
export const RUN_THRESHOLD = 5;

export type FeedRun = {
  author: LogAuthor;
  albumId: number;
  albumTitle: string;
  albumHref: string;
  artistName: string;
  /** Every entry in the run, still newest first. */
  entries: LogEntry[];
  /** The OLDEST entry's locator — where the run started. */
  from: string;
  /** The NEWEST entry's locator. */
  to: string;
  /** How many of the run's entries carry a rating. Can be fewer than `entries.length`. */
  ratedCount: number;
  /** `Math.round(sum / count)` on the stored 1..10 scale. Null when nothing in the run is rated. */
  average: number | null;
  /** The newest entry's timestamp, so the row can carry a relative time like any other. */
  createdAt: Date;
};

export type FeedRow = { kind: "entry"; entry: LogEntry } | { kind: "run"; run: FeedRun };

function summariseRun(run: LogEntry[]): FeedRun {
  /**
   * ENTRIES ARE NEWEST FIRST, SO THE LAST ONE IS WHERE THE RUN STARTED. The range reads
   * "1–11" because that is the shape of the record, not "11–1" because that is the shape of
   * the array. Getting this backwards produces a range that is descending on every row in the
   * product and looks like a formatting choice rather than a bug.
   */
  const newest = run[0];
  const oldest = run[run.length - 1];

  const rated = run.filter((entry) => entry.rating !== null);
  const sum = rated.reduce((total, entry) => total + (entry.rating ?? 0), 0);
  /**
   * A WHOLE-INTEGER APPROXIMATION, NOT A HALF-STAR AVERAGE. `Math.round` on the stored 1..10
   * scale means eleven tracks averaging 8.45 report as 8 — four stars — rather than as 8.45.
   * That is deliberate for a summary row: the run row exists to say "they liked this record",
   * and a two-decimal mean on a collapsed row implies a precision the row is not making. The
   * exact per-track numbers are one click away on the album page, which is where precision
   * belongs.
   */
  const average = rated.length === 0 ? null : Math.round(sum / rated.length);

  const locatorOf = (entry: LogEntry) =>
    entry.locator ?? (entry.trackNumber === null ? "?" : String(entry.trackNumber));

  return {
    author: newest.author,
    albumId: newest.album?.id ?? 0,
    albumTitle: newest.album?.title ?? "an album",
    albumHref: newest.album ? `/album/${albumSlug(newest.album.title, newest.album.id)}` : "#",
    artistName: newest.artist.name,
    entries: run,
    from: locatorOf(oldest),
    to: locatorOf(newest),
    ratedCount: rated.length,
    average,
    createdAt: newest.createdAt,
  };
}

/**
 * Collapse consecutive track logs by one author on one album into a single row.
 *
 * THREE THINGS BREAK A RUN, and each one is a real editorial signal rather than a limitation:
 *
 *   1. A NON-ADJACENT POSITION IN THE SORTED ARRAY. One rating of a different album in the
 *      middle of a session splits it, because the member did something else — the feed is
 *      reporting a sitting, and that sitting was interrupted.
 *   2. ANY ENTRY WITH A REVIEW. Somebody who stopped to write about one track has said the
 *      most interesting thing on the row, and burying it inside "rated 11 tracks" throws away
 *      the only prose in the group.
 *   3. A DAY BOUNDARY. Enforced by the caller, because this function is applied PER DAY GROUP.
 *
 * `flush()` is where the threshold is applied: a run under five emits its entries
 * individually, so nothing is ever lost — collapsing is a rendering choice and the entries are
 * still all there, in order.
 */
export function collapseRuns(entries: LogEntry[]): FeedRow[] {
  const rows: FeedRow[] = [];
  let run: LogEntry[] = [];

  function flush() {
    if (run.length === 0) return;
    if (run.length >= RUN_THRESHOLD) {
      rows.push({ kind: "run", run: summariseRun(run) });
    } else {
      for (const entry of run) rows.push({ kind: "entry", entry });
    }
    run = [];
  }

  for (const entry of entries) {
    // A review is never runnable — see reason 2 above.
    const runnable = entry.targetType === "track" && !entry.review;
    const continues =
      runnable &&
      run.length > 0 &&
      run[0].author.id === entry.author.id &&
      run[0].album?.id === entry.album?.id;

    if (continues) {
      run.push(entry);
      continue;
    }

    // Any non-continuation closes the open run first, which is what makes adjacency matter.
    flush();
    if (runnable) {
      run = [entry];
    } else {
      rows.push({ kind: "entry", entry });
    }
  }

  flush();
  return rows;
}

/* ========================================================================== *
 * Rows
 * ========================================================================== */

/** "Today" / "Yesterday" / "3 March 2001". Computed on the server, so it cannot desync. */
function dayLabel(date: string): string {
  const today = localCalendarDate();
  if (date === today) return "Today";
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date === localCalendarDate(yesterday)) return "Yesterday";
  return formatDate(date) ?? date;
}

function AuthorLine({ author, children }: { author: LogAuthor; children: React.ReactNode }) {
  return (
    <AvatarWithName
      username={author.username}
      displayName={author.displayName}
      seed={author.avatarSeed}
      isGuest={author.isGuest}
      size="sm"
    >
      <span className="min-w-0 text-sm">
        <Link href={`/@${author.username}`} className="text-paper transition-colors hover:text-amber">
          {author.displayName ?? author.username}
        </Link>{" "}
        {children}
      </span>
    </AvatarWithName>
  );
}

/** One log with no prose on it. The review-bearing case renders as a `ReviewCard` instead. */
function ActivityRow({
  entry,
  liked,
  canDelete,
  showAuthor,
}: {
  entry: LogEntry;
  liked: boolean;
  canDelete: boolean;
  showAuthor: boolean;
}) {
  const targetLabel = logTargetLabel(entry);
  const authorName = entry.author.displayName ?? entry.author.username;

  return (
    <li className="group/entry flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        {showAuthor ? (
          <>
            <AuthorLine author={entry.author}>
              <span className="text-faint">{entry.rating === null ? "logged" : "rated"}</span>
            </AuthorLine>
            {/* Indented to clear the avatar, so the target lines up down the column. */}
            <LogTargetLine entry={entry} className="pl-10" />
          </>
        ) : (
          <LogTargetLine entry={entry} />
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {entry.rating === null ? null : <Stars value={entry.rating} size="sm" />}
        {entry.liked ? (
          // `logs.liked` is the AUTHOR'S OWN heart on the thing they played — not the `likes`
          // table, which is other members hearting this entry. Three unrelated meanings of
          // "like" live in this codebase; see ARCHITECTURE §4.8.
          <span className="text-rose">
            <Heart className="size-3.5" fill="currentColor" aria-hidden="true" />
            <span className="sr-only">{authorName} loves this</span>
          </span>
        ) : null}
        {entry.isReplay ? (
          <Badge tone="teal">
            <Repeat2 />
            Replay
          </Badge>
        ) : null}
        <LikeButton
          targetType="log"
          targetId={entry.id}
          liked={liked}
          count={entry.likeCount}
          label={`${authorName}'s entry for ${targetLabel}`}
        />
        <time
          dateTime={entry.createdAt.toISOString()}
          className="font-mono text-[0.6875rem] tabular text-faint"
        >
          {formatRelative(entry.createdAt)}
        </time>
        {canDelete ? (
          <span className="opacity-0 transition-opacity group-hover/entry:opacity-100 focus-within:opacity-100">
            <DeleteLogButton logId={entry.id} label={`your entry for ${targetLabel}`} />
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** The collapsed row: *"Nadia rated 11 tracks of Blue · 1–11 · avg ★"*. */
function RunRow({ run }: { run: FeedRun }) {
  const verb = run.ratedCount === run.entries.length ? "rated" : "logged";

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <AuthorLine author={run.author}>
          <span className="text-faint">
            {verb} {plural(run.entries.length, "track")} of
          </span>{" "}
          <Link href={run.albumHref} className="text-paper transition-colors hover:text-amber">
            {run.albumTitle}
          </Link>
        </AuthorLine>
        <p className="flex flex-wrap items-center gap-x-2 pl-10 font-mono text-[0.6875rem] tabular text-faint">
          <ListMusic className="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {run.from}–{run.to}
            <span className="sr-only"> (tracks {run.from} to {run.to})</span>
          </span>
          <span aria-hidden="true">·</span>
          <span>{run.artistName}</span>
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {run.average === null ? null : (
          <span className="inline-flex items-center gap-1 font-mono text-[0.6875rem] tabular text-amber">
            avg {formatRating(run.average)}
            <Star className="size-3 shrink-0" fill="currentColor" aria-hidden="true" />
            {/* The colour and the glyph are never the only channel. */}
            <span className="sr-only">
              stars, averaged across {plural(run.ratedCount, "rated track")} and rounded to the nearest
              whole point
            </span>
          </span>
        )}
        <time dateTime={run.createdAt.toISOString()} className="font-mono text-[0.6875rem] tabular text-faint">
          {formatRelative(run.createdAt)}
        </time>
      </div>
    </li>
  );
}

/* ========================================================================== *
 * The feed
 * ========================================================================== */

export type ActivityFeedProps = {
  /** Newest first. Every caller's query already orders this way; the passes rely on it. */
  entries: LogEntry[];
  /** From `getLikedLogIds(viewerId, ids)` — ONE query for the page, never one per row. */
  likedIds?: Set<number>;
  /**
   * Render a delete control on every row. TRUE ONLY ON THE VIEWER'S OWN DIARY — the one
   * surface in the application where a log delete exists.
   */
  canDelete?: boolean;
  /** Suppress the author on a single-member surface, where repeating the name says nothing. */
  showAuthor?: boolean;
  /** What to render instead of nothing. The empty state is a real state, not a fallback. */
  empty?: React.ReactNode;
  className?: string;
};

export function ActivityFeed({
  entries,
  likedIds,
  canDelete = false,
  showAuthor = true,
  empty,
  className,
}: ActivityFeedProps) {
  if (entries.length === 0) {
    return (
      <>
        {empty ?? (
          <EmptyState
            title="Nothing here yet"
            description="Logged plays, ratings and reviews land here as they happen."
          />
        )}
      </>
    );
  }

  const groups = groupByDay(entries);

  return (
    <div className={cn("space-y-6", className)}>
      {groups.map((group) => (
        <section key={group.date}>
          {/*
            STICKY AT z-10 — the lowest rung of the five-value ladder, below the sticky site
            header (z-50) so a date header slides under it rather than over it. The ink wash
            plus blur is what keeps the rows behind it from showing through as it travels.
          */}
          <h3 className="section-rule sticky top-0 z-10 bg-ink/90 py-2 backdrop-blur-sm">
            <span className="eyebrow">{dayLabel(group.date)}</span>
          </h3>

          <ul className="divide-y divide-line">
            {collapseRuns(group.entries).map((row) =>
              row.kind === "run" ? (
                <RunRow key={`run-${row.run.entries[0].id}`} run={row.run} />
              ) : row.entry.review ? (
                // A review is never part of a run, so this branch and the run branch cannot
                // both claim the same entry.
                <li key={row.entry.id} className="py-3">
                  <ReviewCard
                    entry={row.entry}
                    liked={likedIds?.has(row.entry.id) ?? false}
                    canDelete={canDelete}
                    showAuthor={showAuthor}
                  />
                </li>
              ) : (
                <ActivityRow
                  key={row.entry.id}
                  entry={row.entry}
                  liked={likedIds?.has(row.entry.id) ?? false}
                  canDelete={canDelete}
                  showAuthor={showAuthor}
                />
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Re-exported so a caller can build a "see this play" link without importing the card file. */
export { logTargetHref };

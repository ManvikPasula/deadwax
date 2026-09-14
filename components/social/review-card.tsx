/**
 * One written review, wherever writing appears: the album and artist review pages, the
 * recent-reviews rail on the signed-out home, a member's own review list, and the review at
 * the top of /log/[id].
 *
 * NO `"use client"`. This component renders props. The two interactive things on it — the
 * heart and the delete control — are client components imported as children, which is the
 * split that keeps a page of twenty reviews from shipping twenty copies of a transition hook
 * to the browser.
 *
 * THE REVIEW BODY IS ESCAPED JSX CHILDREN. `{entry.review}` and nothing else.
 *
 * There is no markdown renderer in this application and that is a decision, not a gap: a
 * renderer is a second parser over member-supplied text, it arrives with its own XSS surface
 * (raw HTML passthrough, `javascript:` links, unbalanced tags), and it would have to be
 * mirrored by a sanitiser on the write path to be safe. `dangerouslySetInnerHTML` IS NEVER
 * CORRECT HERE and the prop does not appear anywhere in this file. `whitespace-pre-line` is
 * the whole formatting story: paragraph breaks survive because the member typed them, and
 * React escapes everything else by construction.
 *
 * THE COMMENT COUNT IS NOW A TRUE NUMBER. In the television original nothing anywhere renders
 * a comment thread on a log, so `commentCount` was structurally always 0 and the control was
 * decoration. `/log/[id]` exists here, so the count is real and the link is the way in.
 */

import { MessageSquare, Repeat2 } from "lucide-react";
import Link from "next/link";

import { DeleteLogButton } from "@/components/social/delete-log-button";
import { LikeButton } from "@/components/social/like-button";
import { Stars } from "@/components/rating/stars";
import { AvatarWithName } from "@/components/ui/avatar";
import { Badge, Chip } from "@/components/ui/primitives";
import type { LogEntry } from "@/lib/db/queries/logs";
import { formatCount, formatRelative } from "@/lib/format";
import { albumSlug, artistSlug } from "@/lib/slug";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Shared target rendering — also used by the activity feed                    */
/* -------------------------------------------------------------------------- */

/**
 * The href of whatever a log points at.
 *
 * THE SLUG IS COMPUTED, NOT READ. `albums.slug` and `artists.slug` are regenerated only on a
 * detail sync, so a row backfilled by `cacheAlbumSummaries` can still carry a slug from an
 * older title — and the URL grammar ignores everything before the trailing id anyway. One
 * code path, the same argument `lib/view.ts` makes for the card adapters.
 */
export function logTargetHref(entry: LogEntry): string {
  const artist = `/artist/${artistSlug(entry.artist.name, entry.artist.id)}`;
  if (!entry.album) return artist;
  const album = `/album/${albumSlug(entry.album.title, entry.album.id)}`;
  if (entry.targetType === "track" && entry.locator) return `${album}/track/${entry.locator}`;
  return album;
}

/**
 * The plain-text name of the target, for an accessible name on an icon-only control.
 *
 * A string rather than a component because `aria-label` takes text: the heart on a review
 * needs "Like Nadia's review of Kid A", and composing that out of JSX would mean rendering
 * the same names twice in two shapes.
 */
export function logTargetLabel(entry: LogEntry): string {
  if (entry.targetType === "artist" || !entry.album) return entry.artist.name;
  if (entry.targetType === "track") {
    const name = entry.trackTitle ?? (entry.locator ? `track ${entry.locator}` : "a track");
    return `${name} on ${entry.album.title}`;
  }
  return entry.album.title;
}

/**
 * The target as links: artist, album, or the track locator plus its title.
 *
 * THE LOCATOR IS MONO AND `tabular`, like every other number in the product. A track is
 * identified by its position as much as by its name — "2-5" is how a member finds it on the
 * record in front of them — and a proportional font makes a column of them ragged.
 */
export function LogTargetLine({ entry, className }: { entry: LogEntry; className?: string }) {
  const artistHref = `/artist/${artistSlug(entry.artist.name, entry.artist.id)}`;
  const albumHref = entry.album ? `/album/${albumSlug(entry.album.title, entry.album.id)}` : null;
  const link = "text-paper transition-colors hover:text-amber";

  if (entry.targetType === "artist" || !entry.album || !albumHref) {
    return (
      <p className={cn("text-sm", className)}>
        <Link href={artistHref} className={link}>
          {entry.artist.name}
        </Link>
      </p>
    );
  }

  if (entry.targetType === "track") {
    return (
      <p className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm", className)}>
        {entry.locator ? (
          <span className="font-mono text-[0.6875rem] tabular text-faint">{entry.locator}</span>
        ) : null}
        <Link href={logTargetHref(entry)} className={link}>
          {/* An unmirrored track row leaves no title; the locator is then the only name it has. */}
          {entry.trackTitle ?? `Track ${entry.locator ?? "—"}`}
        </Link>
        <span className="text-faint">on</span>
        <Link href={albumHref} className="text-muted transition-colors hover:text-amber">
          {entry.album.title}
        </Link>
      </p>
    );
  }

  return (
    <p className={cn("flex flex-wrap items-baseline gap-x-2 text-sm", className)}>
      <Link href={albumHref} className={link}>
        {entry.album.title}
      </Link>
      <span className="text-faint">by</span>
      <Link href={artistHref} className="text-muted transition-colors hover:text-amber">
        {entry.artist.name}
      </Link>
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* The card                                                                   */
/* -------------------------------------------------------------------------- */

export type ReviewCardProps = {
  entry: LogEntry;
  /** From `getLikedLogIds(viewerId, ids)` — one query for the whole page, never one per card. */
  liked?: boolean;
  /**
   * Render the delete control. TRUE ONLY ON THE VIEWER'S OWN DIARY: the action authorises the
   * author server-side regardless, so this is about not offering a control that will be
   * refused, not about security.
   */
  canDelete?: boolean;
  /**
   * Suppress the author row. False on a member's own review list, where the heading above
   * already names them and repeating the avatar twenty times says nothing.
   */
  showAuthor?: boolean;
  className?: string;
};

export function ReviewCard({
  entry,
  liked = false,
  canDelete = false,
  showAuthor = true,
  className,
}: ReviewCardProps) {
  const authorName = entry.author.displayName ?? entry.author.username;
  const targetLabel = logTargetLabel(entry);

  return (
    <article className={cn("card group/entry p-4", className)}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          {showAuthor ? (
            <AvatarWithName
              username={entry.author.username}
              displayName={entry.author.displayName}
              seed={entry.author.avatarSeed}
              isGuest={entry.author.isGuest}
              size="sm"
            >
              <Link
                href={`/@${entry.author.username}`}
                className="text-sm text-paper transition-colors hover:text-amber"
              >
                {authorName}
              </Link>
            </AvatarWithName>
          ) : null}
          <LogTargetLine entry={entry} />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/*
            Stars, never "7/10". The stored scale is 1..10 integers and this component converts;
            see lib/ratings.ts. A log with no rating renders no stars at all rather than zero —
            "listened, not rated" is a real state and zero stars is unrepresentable.
          */}
          {entry.rating === null ? null : <Stars value={entry.rating} size="sm" />}
          {entry.isReplay ? (
            <Badge tone="teal">
              <Repeat2 />
              Replay
            </Badge>
          ) : null}
        </div>
      </header>

      {/*
        `whitespace-pre-line` and escaped children. See the module docblock — there is no
        markdown renderer in this app and `dangerouslySetInnerHTML` is never the answer.
      */}
      {entry.review ? (
        <p className="mt-3 whitespace-pre-line text-[0.9375rem] leading-relaxed text-muted">{entry.review}</p>
      ) : null}

      {entry.tags.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {entry.tags.map((tag) => (
            <li key={tag}>
              {/*
                A span, not a link: there is no tag route in this application, and a chip that
                looks like a filter but navigates nowhere is worse than a chip that plainly
                does not.
              */}
              <Chip>{tag}</Chip>
            </li>
          ))}
        </ul>
      ) : null}

      <footer className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3">
        <LikeButton
          targetType="log"
          targetId={entry.id}
          liked={liked}
          count={entry.likeCount}
          label={`${authorName}'s review of ${targetLabel}`}
        />

        {/*
          THE COUNT LINKS TO THE THREAD. A log has its own page, so the comment count is a
          destination rather than a statistic — and it is a real number now that something
          renders the thread.
        */}
        <Link
          href={`/log/${entry.id}`}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-card px-1.5 py-1",
            "font-mono text-[0.6875rem] tracking-wider tabular text-faint transition-colors hover:text-paper",
          )}
        >
          <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{formatCount(entry.commentCount)}</span>
          <span className="sr-only">
            {entry.commentCount === 1 ? "comment on this review" : "comments on this review"}
          </span>
        </Link>

        <time
          dateTime={entry.createdAt.toISOString()}
          className="font-mono text-[0.6875rem] tabular text-faint"
        >
          {formatRelative(entry.createdAt)}
        </time>

        {canDelete ? (
          <span
            className={cn(
              "ml-auto opacity-0 transition-opacity",
              // BOTH, and the second one is not redundant: hover alone leaves the control
              // unreachable by keyboard, because a tab stop that is `opacity-0` is focusable
              // and invisible at the same time.
              "group-hover/entry:opacity-100 focus-within:opacity-100",
            )}
          >
            <DeleteLogButton logId={entry.id} label={`your entry for ${targetLabel}`} />
          </span>
        ) : null}
      </footer>
    </article>
  );
}

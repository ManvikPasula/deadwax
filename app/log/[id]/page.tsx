/**
 * `/log/[id]` — one diary entry and its thread.
 *
 * ============================================================================
 * NEW IN DEADWAX, AND IT IS WHAT MAKES A NUMBER TRUE.
 *
 * The source renders NO comment thread on a log anywhere. `comments` is polymorphic over
 * `('log' | 'list')` and `addComment` accepts both, but nothing in the interface ever asks for
 * the log side — so every review card's comment count is permanently 0, and the count is an
 * affordance that leads nowhere. `getLogComments`' own docblock records it: *"`log` is the case
 * that had no renderer at all there."*
 *
 * This route is the renderer. `ReviewCard`'s footer links its count here, so the number is now
 * a destination rather than a statistic — which is also why it is a `<Link>` there and not a
 * bare span.
 * ============================================================================
 *
 * THE ID IS BOUNDED BEFORE IT REACHES A QUERY. `parseBoundedInt` requires `^\d{1,10}$` and
 * caps at `MAX_DB_INT`, so `/log/9999999999` is a 404 rather than "value out of range for type
 * integer", which is a 500 where a 404 belongs (I-5). It returns NULL rather than clamping,
 * because clamping an out-of-range id to a valid one renders somebody else's entry.
 *
 * THERE IS NO PRIVACY RULE ON A LOG, AND THAT IS A DECISION RATHER THAN AN OMISSION. `logs` has
 * no visibility column: a rating is public the moment it is saved, which is what makes the
 * consensus figures and the heatmaps mean anything. `getLog` therefore carries no `notGuest`
 * filter either — a guest's own entry has to render for the guest who wrote it, and a guest's
 * profile and diary are public for the same reason. What guests are kept out of is the public
 * INDEXES (`getRecentReviews`, `getPublicLists`, `getActiveMembers` all filter), not their own
 * permalinks. If a private-log flag is ever added, THIS ROUTE NEEDS THE CHECK IN BOTH
 * `generateMetadata` AND THE BODY — the same two-entry-point rule as `/list/[slug]`.
 */

import type { Metadata } from "next";
import { Disc3, Heart, Repeat2 } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Stars } from "@/components/rating/stars";
import { CommentThread } from "@/components/social/comment-thread";
import { LikeButton } from "@/components/social/like-button";
import { LogTargetLine, logTargetHref, logTargetLabel } from "@/components/social/review-card";
import { AvatarWithName } from "@/components/ui/avatar";
import { Badge, Chip, Eyebrow, SectionHeading } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import { getLog, getLogComments, hasLiked } from "@/lib/db/queries/logs";
import { getUserByUsername } from "@/lib/db/queries/users";
import { formatDate, formatRelative, releaseYear } from "@/lib/format";
import { albumCover, artistPicture } from "@/lib/providers/images";
import { formatRating } from "@/lib/ratings";
import { MAX_DB_INT, parseBoundedInt } from "@/lib/slug";

/** 128px rendered (`size-32`); 250 is the next CDN rung, so it is sharp at 2x. */
const COVER_SOURCE_WIDTH = 250;
/** Excerpt length for the meta description. Long enough to be useful, short enough not to be
 *  truncated by every consumer that has its own limit. */
const DESCRIPTION_LIMIT = 200;

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id: rawId } = await params;

  const id = parseBoundedInt(rawId, { min: 1, max: MAX_DB_INT });
  if (id === null) notFound();

  const entry = await getLog(id);
  if (!entry) notFound();

  const authorName = entry.author.displayName ?? entry.author.username;
  const target = logTargetLabel(entry);
  const verb = entry.review ? "reviewed" : entry.rating === null ? "logged" : "rated";

  return {
    title: `${authorName} ${verb} ${target}`,
    description: entry.review
      ? entry.review.length > DESCRIPTION_LIMIT
        ? `${entry.review.slice(0, DESCRIPTION_LIMIT).trimEnd()}…`
        : entry.review
      : entry.rating === null
        ? `${authorName} played ${target}.`
        : // STARS IN PROSE, NOT "7/10". The stored scale is 1..10 and `formatRating` is what
          // every visible surface uses; a meta description is a visible surface.
          `${authorName} rated ${target} ${formatRating(entry.rating)} out of 5.`,
  };
}

export default async function LogPage({ params }: PageProps) {
  const { id: rawId } = await params;

  const id = parseBoundedInt(rawId, { min: 1, max: MAX_DB_INT });
  if (id === null) notFound();

  const [entry, viewer] = await Promise.all([getLog(id), currentUser()]);
  if (!entry) notFound();

  const [comments, liked, viewerMember] = await Promise.all([
    getLogComments({ targetType: "log", targetId: entry.id }),
    hasLiked(viewer?.id, "log", entry.id),
    /*
     * ONE EXTRA LOOKUP, FOR ONE FIELD — the same note as on `/list/[slug]`. `CommentThread`
     * inserts an optimistic row authored by `viewer`, and `SessionUser` deliberately carries no
     * `displayName`; without this the member's own comment would appear under their handle for
     * one frame and then swap to their display name, which reads as the wrong person posting.
     */
    viewer ? getUserByUsername(viewer.username) : Promise.resolve(null),
  ]);

  const authorName = entry.author.displayName ?? entry.author.username;
  const targetLabel = logTargetLabel(entry);
  const targetHref = logTargetHref(entry);

  /*
   * THE ARTWORK BORROWS, exactly as the list mosaic does: a TRACK has no cover of its own, so
   * it shows its album's, and an ARTIST-level entry shows the artist's picture. `mbid` is
   * passed through because `albumCover` falls back to the Cover Art Archive keyed by the
   * release-group mbid — except that `LogEntry.album` does not carry one, so this call has the
   * Deezer path only and renders the placeholder rather than a broken frame when it is null.
   */
  const image = entry.album
    ? albumCover({ coverPath: entry.album.coverPath }, COVER_SOURCE_WIDTH)
    : artistPicture({ picturePath: entry.artist.picturePath }, COVER_SOURCE_WIDTH);

  const played = formatDate(entry.listenedOn);
  const year = entry.album ? releaseYear(entry.album.releaseDate) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <article className="space-y-5">
        <div className="flex flex-wrap items-start gap-5">
          {/*
            The wrapping link is the `group`, which is what drives `.sleeve`'s lift everywhere
            in the app. `aria-hidden` plus `tabIndex={-1}` because the target's own links are
            directly beside it — two tab stops to the same record is one too many.
          */}
          <Link href={targetHref} className="group w-32 shrink-0" tabIndex={-1} aria-hidden="true">
            {/* `rounded-full` is a utility and beats `.sleeve`'s card radius: an artist entry
                gets a round portrait, an album or track entry a square sleeve. */}
            <div className={entry.album ? "sleeve" : "sleeve rounded-full"}>
              {image ? (
                <img
                  src={image}
                  alt=""
                  loading="eager"
                  decoding="async"
                  className="size-full object-cover"
                />
              ) : (
                <div className="flex size-full items-center justify-center">
                  <Disc3 className="size-10 text-line-bright" aria-hidden="true" />
                </div>
              )}
            </div>
          </Link>

          <div className="min-w-0 flex-1 space-y-3">
            <Eyebrow>
              {entry.review ? "Review" : entry.rating === null ? "Logged" : "Rating"}
              {year ? ` · ${year}` : ""}
            </Eyebrow>

            {/*
              THE ONE h1 ON THE PAGE, and it is the log's own sentence rather than the record's
              title: this page is one member's entry, and the record has its own page (linked
              directly below). Display serif, which is headlines only.
            */}
            <h1 className="font-display text-3xl leading-tight text-paper text-balance">
              {`${authorName} on ${targetLabel}`}
            </h1>

            {/* Every link to the artist, the album and the track, computed once in
                `LogTargetLine` so no surface re-derives a slug. */}
            <LogTargetLine entry={entry} />

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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

              {/* Stars, never "7/10". A log with no rating renders none at all rather than
                  zero: "listened, not rated" is a real state and zero stars is unrepresentable. */}
              {entry.rating === null ? <Badge>Not rated</Badge> : <Stars value={entry.rating} size="md" />}

              {entry.isReplay ? (
                <Badge tone="teal">
                  <Repeat2 />
                  Replay
                </Badge>
              ) : null}

              {entry.liked ? (
                /*
                  `logs.liked` IS THE AUTHOR'S OWN HEART ON THE THING THEY PLAYED — not the
                  `likes` table, which is other members hearting this entry. Three unrelated
                  meanings of "like" live in this codebase, and the two of them on this page are
                  four lines apart, so both carry their own text equivalent.
                */
                <span className="text-rose">
                  <Heart className="size-4" fill="currentColor" aria-hidden="true" />
                  <span className="sr-only">{`${authorName} loves this`}</span>
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {entry.review ? (
          // `whitespace-pre-line` with escaped children: there is no markdown renderer in this
          // application, and a review is member-supplied text.
          <p className="whitespace-pre-line text-[0.9375rem] leading-relaxed text-muted">
            {entry.review}
          </p>
        ) : null}

        {entry.tags.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {entry.tags.map((tag) => (
              <li key={tag}>
                {/* A span, not a link: there is no tag route in this application, and a chip
                    that looks like a filter but navigates nowhere is worse than one that
                    plainly does not. */}
                <Chip>{tag}</Chip>
              </li>
            ))}
          </ul>
        ) : null}

        <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4">
          <LikeButton
            targetType="log"
            targetId={entry.id}
            liked={liked}
            count={entry.likeCount}
            label={`${authorName}'s entry for ${targetLabel}`}
          />

          {/*
            TWO DATES, AND THEY ARE DIFFERENT FACTS. `listened_on` is the day the record was
            PLAYED and is what the diary is filed by; `created_at` is when the entry was
            written. They disagree whenever somebody backfills, which is the normal case for a
            record they have owned for twenty years — so printing only one of them would make
            the diary's ordering look wrong. An entry with no `listened_on` is a rating that
            never entered the diary, and then there is only one date to show.
          */}
          {played ? (
            <p className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
              Played{" "}
              <time dateTime={entry.listenedOn ?? undefined} className="text-muted">
                {played}
              </time>
            </p>
          ) : null}

          <p className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
            {played ? "Logged" : "Saved"}{" "}
            <time dateTime={entry.createdAt.toISOString()} className="text-muted">
              {formatRelative(entry.createdAt)}
            </time>
          </p>

          {/*
            NO DELETE CONTROL, EVEN FOR THE AUTHOR. The diary is the only surface in the
            application that carries one — a destructive control that appears in two places is
            one that has to be reasoned about in two places, and this page is where somebody
            reads a thread rather than where they tidy their diary.
          */}
        </footer>
      </article>

      <section>
        <SectionHeading eyebrow="Thread" title="Replies" />
        {/*
          `containerOwnerId` is THE LOG'S AUTHOR, and it is what makes owner moderation
          reachable: `deleteComment` has always authorised "the comment's author OR the
          container's owner" server-side, and the source only ever rendered the control for the
          author — so nobody could clear a reply from their own entry.
        */}
        <CommentThread
          target={{ targetType: "log", targetId: entry.id }}
          comments={comments}
          viewer={viewerMember}
          containerOwnerId={entry.author.id}
        />
      </section>
    </div>
  );
}

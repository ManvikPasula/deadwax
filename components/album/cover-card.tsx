/**
 * The cover card — the most-rendered component in the product.
 *
 * Server Component. It takes an `AlbumCard` from lib/view.ts and renders it; every href, every
 * cover width and the choice of year were all decided once, in the adapter.
 *
 * THE SLEEVE IS 1:1, NOT 2:3, and this is the one hard geometric change from a film or
 * television equivalent. `.sleeve` owns the aspect ratio and the hover lift, and THE WRAPPING
 * `<Link className="group">` IS WHAT DRIVES IT — the cover itself is never the hover target,
 * so the caption and the sleeve respond together from one link. Removing `group` here does not
 * error; it silently kills the lift on every grid in the app.
 *
 * A PLAIN `<img>`, NOT `next/image`. Cover art comes from four allowlisted CDNs at four known
 * pixel widths and `coverAt()` has already asked for the right one, so the optimiser would add
 * a serverless hop per cover on a page that renders twenty-four of them to re-derive a width
 * the CDN already rendered. The lint rule is disabled in eslint.config.mjs with this reason.
 *
 * THE REPLAY BADGE IS NOT A PROGRESS BAR. Nobody is 40% of the way through a 42-minute album,
 * so television progress becomes "how many times": a teal `×4` when the member holds more than
 * one log. Teal is the replay/completion colour and is used for nothing else.
 *
 * THE AVERAGE SLOT IS RESERVED FOR DEADWAX RATINGS. The browse and search pages deliberately
 * pass no `memberAverage` for provider-only results, because Deezer hands us `fans` and `rank`
 * in the same payload and dropping one of those into this slot is the single most tempting
 * dishonesty available in a music app. Absent ⇒ the slot renders nothing.
 */

import Link from "next/link";
import { Disc3 } from "lucide-react";

import { Stars } from "@/components/rating/stars";
import { Badge } from "@/components/ui/primitives";
import { formatRating } from "@/lib/ratings";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AlbumCard } from "@/lib/view";

/**
 * The four viewer-dependent figures are OPTIONAL here even though the adapter always emits
 * them, so a surface that has not joined the viewer overlay (or has deliberately withheld the
 * average, as browse does) can hand this component a hand-built object without inventing
 * zeroes for numbers it has not measured.
 */
export type CoverCardAlbum = Omit<AlbumCard, "memberAverage" | "memberCount" | "viewerRating" | "replayCount"> &
  Partial<Pick<AlbumCard, "memberAverage" | "memberCount" | "viewerRating" | "replayCount">>;

export type CoverCardProps = {
  album: CoverCardAlbum;
  /**
   * `eager` for the first row of a grid only. Everything below the fold stays lazy; a page of
   * twenty-four eager covers is twenty-four requests competing with the document.
   */
  eager?: boolean;
  className?: string;
};

export function CoverCard({ album, eager = false, className }: CoverCardProps) {
  const { title, coverUrl, artistName, year, href } = album;
  const replayCount = album.replayCount ?? 0;
  const viewerRating = album.viewerRating ?? null;
  const memberAverage = album.memberAverage ?? null;

  const body = (
    <>
      <div className="sleeve">
        {coverUrl ? (
          <img
            src={coverUrl}
            // Empty alt: the title sits in the caption inside the same link, so naming the
            // image as well makes a screen reader announce every card twice.
            alt=""
            loading={eager ? "eager" : "lazy"}
            decoding="async"
            className="size-full object-cover"
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            <Disc3 className="size-8 text-line-bright" aria-hidden="true" />
          </div>
        )}

        {replayCount > 1 ? (
          <>
            {/* The glyph reads as "times four" to nobody, so the visible badge is hidden from
                assistive technology and the sentence below carries the number. */}
            <Badge tone="teal" aria-hidden="true" className="absolute right-1.5 top-1.5 bg-ink/80">
              {`×${replayCount}`}
            </Badge>
            <span className="sr-only">{`Played ${replayCount} times.`}</span>
          </>
        ) : null}

        {viewerRating === null ? null : (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink/95 via-ink/60 to-transparent px-1.5 pb-1.5 pt-6">
            <Stars value={viewerRating} size="xs" label={null} />
            <span className="sr-only">{`Your rating: ${formatRating(viewerRating)} out of 5 stars.`}</span>
          </div>
        )}
      </div>

      <div className="mt-2">
        {/*
          Sans is re-asserted explicitly here — it is the body default, but a cover title is
          the one place in the app where a two-line block of prose sits directly under mono
          metadata, and the explicit class stops it drifting when a parent sets a family.
        */}
        <p className="line-clamp-2 font-sans text-[0.8125rem] leading-snug text-paper transition-colors group-hover:text-amber">
          {title}
        </p>
        <p className="mt-0.5 truncate font-mono text-[0.6875rem] tabular text-faint">
          {artistName}
          {year ? ` · ${year}` : ""}
          {memberAverage === null ? null : (
            <>
              {` · ★ ${formatRating(memberAverage)}`}
              <span className="sr-only">
                {` average member rating${album.memberCount ? ` from ${plural(album.memberCount, "member")}` : ""}`}
              </span>
            </>
          )}
        </p>
      </div>
    </>
  );

  /**
   * A NULL HREF IS A REAL STATE, NOT A BUG TO PAPER OVER. A provider result that has not been
   * mirrored yet has no local id and therefore no local URL (lib/view.ts explains why), so the
   * card renders inert rather than linking to somebody else on a guessed id. It also keeps no
   * `group`, because a card that lifts under the cursor and then does nothing is worse than one
   * that never invited the click.
   */
  if (!href) {
    return <div className={cn("block", className)}>{body}</div>;
  }

  return (
    <Link href={href} className={cn("group block", className)}>
      {body}
    </Link>
  );
}

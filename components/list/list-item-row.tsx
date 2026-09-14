/**
 * One row of a list — AN ARTIST, AN ALBUM OR A TRACK, because `list_items` is polymorphic
 * here (ARCHITECTURE §8) and a list is therefore allowed to be a playlist.
 *
 * NO `"use client"`, AND THAT IS NOT THE SAME AS "SERVER ONLY". It holds no state and no
 * handler, so it renders directly inside a Server Component (the list page) AND inside a
 * client one (`ListEditor`, which owns the optimistic order and therefore has to render the
 * rows itself). The same arrangement as `Stars` inside `StarInput`: a directive-free module
 * is usable from both sides, and adding `"use client"` here would drag every row of a
 * hundred-item list into the browser bundle for the ninety-nine surfaces that need no
 * interactivity.
 *
 * THE CONSEQUENCE, AND IT IS A REAL CONSTRAINT: this file may only VALUE-import from pure
 * modules. `lib/view.ts`'s card adapters are `server-only`, so they are unavailable — which
 * costs nothing, because `getListItems` has already resolved `href`, `imagePath` and `mbid`
 * for every row. `import type { ListItemEntry }` is erased and is fine.
 *
 * THE BORROWING RULE IS THE QUERY'S, NOT THIS COMPONENT'S. A track item shows its ALBUM'S
 * cover and an artist item its PICTURE, because a track has no artwork of its own; both
 * arrive already resolved in `imagePath`. This file only decides the GEOMETRY of the two
 * cases, and they differ:
 *
 *   album / track  →  `.sleeve`, the 1:1 record primitive, with the hover lift.
 *   artist         →  a round portrait, NOT `.sleeve`.
 *
 * That split is the same decision `SimilarArtists` records: `.sleeve` means "a release lives
 * here", and a square artist portrait in a column of square covers reads as one more album.
 *
 * `group` SITS ON THE ROW, NOT ON THE THUMBNAIL LINK, so hovering the title — or the owner's
 * move buttons — lifts the sleeve too. `.group:hover .sleeve` matches any ancestor carrying
 * the class, and the row is the innermost sensible one.
 */

import { Disc3, Music4, UserRound } from "lucide-react";
import Link from "next/link";
import type * as React from "react";

import { Badge } from "@/components/ui/primitives";
import type { ListItemEntry } from "@/lib/db/queries/lists";
import { formatDuration, releaseYear } from "@/lib/format";
import { albumCover, artistPicture } from "@/lib/providers/images";
import { cn } from "@/lib/utils";

/**
 * 56px rendered (`w-14`), requested at the 250px CDN rung — the same reasoning `ListCard`'s
 * mosaic uses. 56 is one of the four widths Deezer renders, but asking for it means a 2x
 * screen upscales a 56px JPEG, and the next rung up costs one HTTP response either way.
 */
const THUMB_SOURCE_WIDTH = 250;

/** The word, for the icon. A glyph alone is not a label — every kind here needs both. */
const KIND_LABEL = { artist: "Artist", album: "Album", track: "Track" } as const;

export type ListItemRowProps = {
  /** Straight from `getListItems`. `href`, `imagePath` and `mbid` are already resolved. */
  item: ListItemEntry;
  /**
   * The 1-based position shown in the gutter. PASS IT ONLY ON A RANKED LIST (`list.isRanked`):
   * on an unranked list a number in front of every row claims an order the maker did not
   * choose. It is deliberately the render index rather than `item.position`, because positions
   * can legitimately tie — `addToList` appends at `max(position) + 1` outside a transaction —
   * and a ranked list showing "4, 4, 6" reads as a bug in the ranking.
   */
  rank?: number | null;
  /**
   * Owner-only controls, rendered at the end of the row. `ListEditor` passes the move
   * buttons and the remove control through here; a read-only surface passes nothing.
   */
  actions?: React.ReactNode;
  className?: string;
};

export function ListItemRow({ item, rank = null, actions, className }: ListItemRowProps) {
  const isArtist = item.targetType === "artist";
  const kind = KIND_LABEL[item.targetType];

  /**
   * A TRACK TITLE CAN BE NULL AND THAT IS NOT A DATA ERROR. `getListItems` LEFT-joins `tracks`
   * on (album, disc, track), and `ensureAlbum` rewrites a tracklist on every detail sync — real
   * release groups genuinely disagree about numbering between editions — so a saved position can
   * outlive the row it pointed at. The locator is what the member actually saved, so it is the
   * fallback; dropping the row instead would silently shorten somebody's playlist.
   */
  const primary = isArtist
    ? item.artist.name
    : item.track
      ? (item.track.title ?? `Track ${item.track.locator}`)
      : (item.album?.title ?? "Unknown album");

  const imageUrl = isArtist
    ? artistPicture({ picturePath: item.imagePath }, THUMB_SOURCE_WIDTH)
    : albumCover({ coverPath: item.imagePath, mbid: item.mbid }, THUMB_SOURCE_WIDTH);

  const Placeholder = isArtist ? UserRound : item.track ? Music4 : Disc3;

  /**
   * THE META LINE IS PLAIN TEXT, NOT THREE MORE LINKS.
   *
   * The rejected alternative was linking the album and the artist from every row. On a
   * hundred-item playlist that is three hundred tab stops to reach the bottom of one list,
   * and both destinations are one click away from the row's own link. One link per row.
   */
  const meta: Array<string | null | undefined> = item.track
    ? [item.track.locator, item.album?.title, item.artist.name, formatDuration(item.track.durationMs ?? 0)]
    : isArtist
      ? [item.artist.name]
      : [item.artist.name, releaseYear(item.album?.releaseDate)];
  // An explicit predicate rather than `.filter(Boolean)`: the latter does not narrow the array
  // type under `strict`, so the JSX below would be mapping over `string | null | undefined`.
  const metaParts = meta.filter((part): part is string => typeof part === "string" && part.length > 0);

  return (
    <li className={cn("group flex items-start gap-3 py-3", className)}>
      {rank === null ? null : (
        <p className="w-7 shrink-0 pt-1 text-right font-mono text-[0.8125rem] tabular text-faint">{rank}</p>
      )}

      {/*
        DECORATIVE, exactly as `ListCard`'s mosaic link is: `tabIndex={-1}` and `aria-hidden`,
        so the artwork is not a second tab stop and a screen reader is not told the same
        destination twice. The real link is the title below.
      */}
      <Link href={item.href} tabIndex={-1} aria-hidden="true" className="shrink-0">
        <span
          className={cn(
            "block w-14 overflow-hidden bg-surface-2",
            // Round for an artist, `.sleeve` for a record. See the module docblock.
            isArtist ? "aspect-square rounded-full ring-1 ring-line" : "sleeve",
          )}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              // Empty alt rather than an omitted one: the title is inside the sibling link, so
              // naming the image announces every row twice. An omitted alt would instead make a
              // screen reader read out the CDN filename.
              alt=""
              loading="lazy"
              decoding="async"
              width={56}
              height={56}
              className="size-full object-cover"
            />
          ) : (
            <span className="flex size-full items-center justify-center text-line-bright">
              <Placeholder className="size-5" />
            </span>
          )}
        </span>
      </Link>

      <div className="min-w-0 flex-1">
        <p className="text-[0.9375rem] leading-snug">
          <Link href={item.href} className="text-paper transition-colors group-hover:text-amber hover:text-amber">
            {primary}
          </Link>
        </p>

        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[0.6875rem] tabular text-faint">
          {/* The badge is the TEXT EQUIVALENT for the placeholder glyph and for the round-vs-square
              geometry: neither of those says "track" to anybody who cannot see them. */}
          <Badge>{kind}</Badge>
          {metaParts.map((part, index) => (
            <span key={`${item.id}-meta-${index}`} className="flex items-center gap-2">
              {index > 0 ? (
                <span aria-hidden="true" className="text-line-bright">
                  ·
                </span>
              ) : null}
              {part}
            </span>
          ))}
        </p>

        {/*
          The curator's note. `list_items.note` is one line of context (280 chars), not a second
          review, so it renders as a quiet aside under the row rather than as prose beside it.
        */}
        {item.note ? (
          <p className="mt-1.5 border-l border-line pl-2 text-[0.8125rem] leading-relaxed text-muted">
            {item.note}
          </p>
        ) : null}
      </div>

      {actions ? <div className="flex shrink-0 items-center gap-1 pt-0.5">{actions}</div> : null}
    </li>
  );
}

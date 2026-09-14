/**
 * A list in a listing: /lists, /@name/lists, and the "lists containing this album" rails.
 *
 * NO `"use client"`. It renders props.
 *
 * THE FOUR-COVER MOSAIC IS THE WHOLE IDENTITY OF THE CARD, and it is SQUARE — four `size-20`
 * 1:1 tiles rather than the television original's four 2:3 posters. Album art is square, so
 * the fan is wider and shorter than the poster version and the offsets are re-proportioned
 * with it.
 *
 * THE TILES CARRY `alt=""`, DELIBERATELY AND NOT BY OMISSION. The mosaic is decorative: the
 * list's title is the meaning, and four album names read out before it ("Kid A, Blue, Spirit
 * of Eden, Loveless, Records I play in the rain") is four pieces of noise in front of the one
 * piece of information. An empty `alt` is the correct markup for a decorative image and is
 * what keeps it out of the accessibility tree entirely — an omitted `alt` would instead make
 * a screen reader announce the filename.
 *
 * A TRACK TILE BORROWS ITS ALBUM'S COVER AND AN ARTIST TILE ITS PICTURE, because `list_items`
 * is polymorphic here (artist | album | track) and a track has no artwork of its own. The
 * borrowing happens in `attachPreviews`; this component just renders `imagePath`.
 */

import { ListMusic } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/primitives";
import type { ListCard as ListCardRow, ListPreview } from "@/lib/db/queries/lists";
import { formatCount, plural } from "@/lib/format";
import { albumCover } from "@/lib/providers/images";
import { listSlug } from "@/lib/slug";
import { cn } from "@/lib/utils";

/** 80px rendered, requested at the 250px CDN rung so the tiles are sharp on a 2x screen. */
const TILE_SOURCE_WIDTH = 250;

export function ListMosaic({ previews, className }: { previews: ListPreview[]; className?: string }) {
  if (previews.length === 0) {
    return (
      <div
        className={cn(
          "flex aspect-square w-20 shrink-0 items-center justify-center rounded-card",
          "border border-dashed border-line-bright bg-surface-2 text-faint",
          className,
        )}
        aria-hidden="true"
      >
        <ListMusic className="size-5" />
      </div>
    );
  }

  return (
    // `aria-hidden` on the container as well as `alt=""` on each tile: the wrapper is a
    // decorative group, and hiding it once is cheaper than trusting four empty alts.
    <div className={cn("flex shrink-0 items-center", className)} aria-hidden="true">
      {previews.map((preview, index) => (
        <div
          key={preview.id}
          // THE GEOMETRY: 1:1 at w-20, and every tile after the first pulled back over the one
          // before it so the four read as records fanned out of a sleeve rather than as a
          // 2x2 grid. A grid would need the tiles to be a quarter of the size to fit the same
          // width, and at 40px a cover is a coloured square with no identity left in it.
          className={cn(
            "relative aspect-square w-20 overflow-hidden rounded-card",
            "bg-surface-2 shadow-[inset_0_0_0_1px_var(--color-line)]",
            index > 0 && "-ml-6",
          )}
          /**
           * A LOCAL STACKING ORDER, NOT A SIXTH RUNG ON THE APP'S z-INDEX LADDER.
           *
           * The ladder's five values (10 feed headers, 50 header, 60 grain, 70 overlay, 80
           * content, 90 skip link) govern VIEWPORT-LEVEL layers. These four integers order
           * four siblings inside one card and are invisible outside it. They are written
           * explicitly rather than left to DOM order so the fan cannot be silently inverted by
           * a future `flex-row-reverse` or by reordering the tiles.
           */
          style={{ zIndex: index }}
        >
          <img
            src={albumCover({ coverPath: preview.imagePath, mbid: preview.mbid }, TILE_SOURCE_WIDTH) ?? ""}
            // DECORATIVE. See the module docblock — this is the one place in the app where an
            // empty alt on a cover is correct rather than lazy.
            alt=""
            loading="lazy"
            width={80}
            height={80}
            className="size-full object-cover"
          />
        </div>
      ))}
    </div>
  );
}

export type ListCardProps = {
  list: ListCardRow;
  /** Hide the owner line on a member's own lists page, where the heading already names them. */
  showOwner?: boolean;
  className?: string;
};

export function ListCard({ list, showOwner = true, className }: ListCardProps) {
  const href = `/list/${listSlug(list.title, list.id)}`;
  const ownerName = list.owner.displayName ?? list.owner.username;

  return (
    <article className={cn("card flex items-start gap-4 p-4", className)}>
      {/*
        THE WRAPPING LINK IS THE `group`, which is the convention `.sleeve` depends on
        everywhere else in the app. The mosaic tiles are not `.sleeve` — they deliberately do
        not lift, because four overlapping tiles lifting together reads as the card breaking
        apart rather than as one object responding.
      */}
      <Link href={href} className="group shrink-0" tabIndex={-1} aria-hidden="true">
        <ListMosaic previews={list.previews} className="transition-transform group-hover:-translate-y-0.5" />
      </Link>

      <div className="min-w-0 flex-1">
        <h3 className="font-display text-xl leading-tight">
          <Link href={href} className="text-paper transition-colors hover:text-amber">
            {list.title}
          </Link>
        </h3>

        {showOwner ? (
          <p className="mt-0.5 font-mono text-[0.6875rem] tracking-wider text-faint">
            by{" "}
            <Link href={`/@${list.owner.username}`} className="transition-colors hover:text-paper">
              {ownerName}
            </Link>
          </p>
        ) : null}

        {list.description ? (
          <p className="mt-2 line-clamp-2 text-[0.8125rem] leading-relaxed text-muted">{list.description}</p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
            {plural(list.itemCount, "item")}
          </span>
          {list.isRanked ? <Badge tone="amber">Ranked</Badge> : null}
          {/*
            A private list only ever renders for its owner (the route 404s for everybody else,
            in both `generateMetadata` and the body), so this badge is a reminder to the owner
            rather than a warning to a visitor.
          */}
          {list.isPublic ? null : <Badge>Private</Badge>}
          {list.likeCount > 0 ? (
            <span className="font-mono text-[0.6875rem] tabular text-faint">
              {formatCount(list.likeCount)} <span className="sr-only">likes</span>
              <span aria-hidden="true"> ♥</span>
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

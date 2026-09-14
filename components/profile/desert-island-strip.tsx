/**
 * The Desert Island strip — up to ten crowned TRACKS.
 *
 * NO `"use client"`. Every toggle for this honour lives on the three surfaces where the
 * five-star entry condition can be checked (the track hero, the album's track row, the
 * discography accordion). This is the read: a shelf, not a control.
 *
 * ---------------------------------------------------------------------------------------
 * THE ONE PLACE THE FEATURE DOES NOT SURVIVE THE PORT INTACT
 * ---------------------------------------------------------------------------------------
 *
 * The television original argues, correctly there, that:
 *
 * > "A list of ten frames is a better answer to 'what does this person love' than a list of
 * > ten titles."
 *
 * THAT ARGUMENT COLLAPSES HERE, and not by a little. Tracks have no per-track artwork, so ten
 * frames would be ten album covers — and a member who crowned four songs from one record
 * would be shown the same square four times. A grid of ten images in which several are
 * identical does not say "these are the ten pieces of music I love"; it says "this person
 * likes three albums", which is a different and wrong sentence.
 *
 * THE RESOLUTION, IMPLEMENTED EXACTLY:
 *
 *   - 1:1 album covers at `size-20`, DIMMED TO `opacity-40`.
 *   - THE TRACK TITLE IS THE PRIMARY TEXT, in display serif, OVER the cover.
 *   - The album and the artist sit in mono BENEATH it.
 *
 * THE COVER IS SCENERY; THE TITLE IS THE CONTENT. The dim is what makes that true rather than
 * merely stated: at full strength the artwork wins the tile and the text becomes a caption on
 * it, which is the arrangement this whole decision rejects. It also means four tiles from one
 * record read as four songs that happen to share a backdrop.
 *
 * FIVE ACROSS ON LARGE SCREENS, so ten marks fill exactly two rows — the quota has a shape,
 * and a member who holds nine can see the gap.
 *
 * ---------------------------------------------------------------------------------------
 * UNFILLED SLOTS, AND THE RATING THAT IS REPORTED BUT NOT FILTERED ON
 * ---------------------------------------------------------------------------------------
 *
 * Dashed frames for the OWNER ONLY, the same rule as `TopFour`: they state the quota far more
 * plainly than a sentence would, and a visitor looking at an empty shelf gets nothing at all.
 *
 * `entry.rating` IS THE MEMBER'S CURRENT RATING AND IT MAY NO LONGER BE FIVE STARS.
 * `getDesertIsland` reports it through a `LEFT JOIN LATERAL` and deliberately does not filter
 * on it: the five-star gate is enforced once, at crown time, against the latest rating, and a
 * member who later cools on a song keeps the mark until they clear it themselves. So this
 * component renders whatever came back — including nothing, for a track whose rating has been
 * removed — rather than quietly overruling the member's own choice.
 */

import { Anchor, Music4 } from "lucide-react";
import Link from "next/link";

import { Stars } from "@/components/rating/stars";
import { Eyebrow } from "@/components/ui/primitives";
import { DESERT_ISLAND_QUOTA } from "@/lib/desert-island";
import type { DesertIslandEntry } from "@/lib/db/queries/users";
import { formatRating } from "@/lib/ratings";
import { albumCover } from "@/lib/providers/images";
import { albumSlug } from "@/lib/slug";
import { cn } from "@/lib/utils";

/** 80px rendered, asked for at the 250px rung so an 80px tile is sharp on a 2x screen. */
const COVER_SOURCE_WIDTH = 250;

export type DesertIslandStripProps = {
  /** `getDesertIsland(userId)`, newest mark first. Nothing here re-sorts it. */
  entries: DesertIslandEntry[];
  /**
   * The viewer is this member. Drives the dashed frames and the "n of ten" count; a visitor
   * sees only what is actually held.
   */
  isOwner: boolean;
  /**
   * The ceiling. Defaults to the REAL constant rather than a literal ten — `DESERT_ISLAND_QUOTA`
   * is imported, which is what keeps the number of frames drawn here and the number the
   * transaction enforces from drifting. The prop exists only so a caller can render a shorter
   * strip in a tighter column.
   */
  quota?: number;
  className?: string;
};

export function DesertIslandStrip({
  entries,
  isOwner,
  quota = DESERT_ISLAND_QUOTA,
  className,
}: DesertIslandStripProps) {
  // Nothing at all for a visitor looking at an empty shelf. See `TopFour` for the argument.
  if (!isOwner && entries.length === 0) return null;

  const held = entries.length;
  /**
   * `Math.max(0, …)` is not defensive padding: the quota is enforced inside a transaction
   * against the database, and lowering the constant later would leave existing members holding
   * MORE than the new ceiling. A negative `length` would then throw inside `Array.from`.
   */
  const emptySlots = isOwner ? Math.max(0, quota - held) : 0;

  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Eyebrow>Desert Island</Eyebrow>
        {/*
          The count is for the owner, because the number that matters to them is how many slots
          are left — the mark only means something because an eleventh requires taking one back.
          A visitor is told nothing about the ceiling: they are looking at what somebody loves,
          not at a progress bar.
        */}
        {isOwner ? (
          <p className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
            {held} of {quota} held
          </p>
        ) : null}
      </div>

      {/* FIVE ACROSS AT `lg`, so ten fills exactly two rows. Two on a phone keeps the display
          serif title legible inside an 80px square. */}
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {entries.map((entry) => {
          const href = `/album/${albumSlug(entry.album.title, entry.album.id)}/track/${entry.locator}`;
          const cover = albumCover(entry.album, COVER_SOURCE_WIDTH);
          /**
           * A crowned track's title can be NULL, and that is not a data error: `tracks` is
           * LEFT-joined on (album, disc, track) and `ensureAlbum` rewrites a tracklist on every
           * detail sync, so a re-synced edition can renumber underneath a mark. The mark
           * survives; the locator is the fallback, because it is what the member saved.
           */
          const title = entry.trackTitle ?? `Track ${entry.locator}`;

          return (
            <li key={entry.id} className="group">
              <Link href={href} className="block">
                {/*
                  `size-20` AND 1:1. Not `.sleeve`: that primitive carries the hover lift and the
                  amber rim that mean "a release lives here", and this tile is not a release — it
                  is a track wearing its album's cover as scenery. The tile still responds to
                  hover, through the title's colour rather than through the frame.
                */}
                <span className="relative block size-20 overflow-hidden rounded-card bg-surface-2 ring-1 ring-line">
                  {cover ? (
                    <img
                      src={cover}
                      // Empty alt, and this is the strongest case for it in the app: the image
                      // is deliberately not the content, and four tiles from one record would
                      // otherwise announce the same album name four times in front of four
                      // different songs.
                      alt=""
                      loading="lazy"
                      decoding="async"
                      width={80}
                      height={80}
                      // THE DIM IS THE DESIGN DECISION, not a mood. See the module docblock.
                      className="size-full object-cover opacity-40"
                    />
                  ) : (
                    <span className="flex size-full items-center justify-center text-line-bright" aria-hidden="true">
                      <Music4 className="size-6" />
                    </span>
                  )}

                  {/*
                    The title sits OVER the cover, and the ink wash under it is what makes the
                    display serif legible against artwork we do not control — the same argument
                    `.hero-scrim` makes at page scale: a blurred square of bright artwork is a
                    far less predictable field than a photograph.
                  */}
                  <span className="absolute inset-0 flex items-end bg-gradient-to-t from-ink/85 via-ink/40 to-transparent p-1.5">
                    <span className="line-clamp-3 font-display text-[0.9375rem] leading-tight text-paper transition-colors group-hover:text-amber">
                      {title}
                    </span>
                  </span>
                </span>

                <p className="mt-2 line-clamp-2 font-mono text-[0.6875rem] leading-snug tabular text-faint">
                  {entry.album.title}
                  <span aria-hidden="true"> · </span>
                  <span className="sr-only">by </span>
                  {entry.artist.name}
                </p>
              </Link>

              {/*
                The member's CURRENT rating, reported and not filtered on. Rendered outside the
                link so the stars are not part of its accessible name, and `Stars` supplies its
                own `sr-only` sentence — so the colour is never the only channel.
              */}
              {entry.rating === null ? null : (
                <p className="mt-1">
                  <Stars value={entry.rating} size="xs" label={`Your rating: ${formatRating(entry.rating)} out of 5 stars`} />
                </p>
              )}
            </li>
          );
        })}

        {Array.from({ length: emptySlots }, (_, index) => (
          <li key={`empty-${index}`}>
            <div
              className={cn(
                "flex size-20 items-center justify-center rounded-card",
                "border border-dashed border-line-bright bg-surface-2 text-line-bright",
              )}
              // Decorative. The "n of ten held" line above is the accessible version; four
              // frames each announcing "empty" is four pieces of noise in front of the shelf.
              aria-hidden="true"
            >
              <Anchor className="size-6" />
            </div>
          </li>
        ))}
      </ul>

      {/*
        THE ENTRY CONDITION IS THE ONLY EXPLANATION THE OWNER NEEDS, and it is the only place
        on the profile it appears: the toggle exists nowhere else, so somebody looking at ten
        dashed frames has no way to discover what fills them. Five stars is the whole rule.
      */}
      {isOwner && held < quota ? (
        <p className="text-[0.8125rem] text-faint">
          Give a track five stars and the crown appears on it. {quota} marks at a time, across every artist —
          clearing one frees its slot straight away.
        </p>
      ) : null}
    </section>
  );
}

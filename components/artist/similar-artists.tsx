/**
 * "Listeners also play" — the cached neighbour graph, made visible.
 *
 * NO `"use client"`. A rail of links.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THIS IS WORTH A RAIL AND NOT A FOOTNOTE
 * ---------------------------------------------------------------------------------------
 *
 * `artist_similar` is the table television did not have, and the +0.3..+1.0 neighbour term it
 * feeds is the LARGEST SINGLE TERM in the recommender — without it every candidate inside a
 * genre pool lands within a few hundredths of every other and the ranking collapses to
 * Deezer's own popularity order. Everything else the model knows about an album moves a
 * prediction by a couple of tenths.
 *
 * So this rail is the recommender's own reasoning, shown to the member as navigation. When
 * /for-you says "Listeners of Aphex Twin tend to play this too", this is the graph it means.
 *
 * ---------------------------------------------------------------------------------------
 * THE ORDER IS THE PROVIDER'S RELATEDNESS ORDER AND MUST NOT BE RE-SORTED
 * ---------------------------------------------------------------------------------------
 *
 * `getSimilarArtists` orders by `artist_similar.position`, which is Deezer's own relatedness
 * ranking. Re-sorting by `fans` was the rejected alternative and it is rejected here too: it
 * turns a similarity list into a popularity list, and every artist's neighbours become the
 * same five household names. Nothing in this file sorts.
 *
 * ROUND PICTURES, NOT `.sleeve`. `.sleeve` is the record geometry — 1:1 with the card radius
 * and the hover lift that means "a release lives here". A square artist portrait in a page of
 * square covers reads as one more album.
 */

import Image from "next/image";
import Link from "next/link";
import { UserRound } from "lucide-react";

import { SectionHeading } from "@/components/ui/primitives";
import type { ArtistRow } from "@/lib/db/queries/artists";
import { plural } from "@/lib/format";
import { cardFromArtistRow } from "@/lib/view";
import { cn } from "@/lib/utils";

export type SimilarArtistsProps = {
  /** `getSimilarArtists(artistId)` — already in `position` order. */
  artists: ArtistRow[];
  /** Whose neighbours these are. Used in the heading's explanatory line and nowhere else. */
  artistName: string;
  /** `getMirroredAlbumCounts` by artist id, so a caption cannot overstate the discography. */
  albumCounts?: ReadonlyMap<number, number> | null;
  className?: string;
};

export function SimilarArtists({ artists, artistName, albumCounts, className }: SimilarArtistsProps) {
  /*
   * NOTHING, NOT AN EMPTY STATE. An unfilled neighbour graph is our cache being cold, not a
   * statement about the artist — and "no similar artists" is a claim we cannot support about
   * anybody. The section simply does not exist until the graph does.
   */
  if (artists.length === 0) return null;

  return (
    <section className={cn("space-y-1", className)}>
      <SectionHeading
        eyebrow="Neighbours"
        title="Listeners also play"
        // The attribution is the point: this is a provider's relatedness graph, not a
        // Deadwax-computed similarity, and saying so is what keeps the number honest.
        action={
          <p className="font-mono text-[0.6875rem] tracking-wider text-faint">Related to {artistName}</p>
        }
      />
      {/*
        A HORIZONTAL RAIL THAT HIDES ITS SCROLLBAR — the opt-out globals.css documents, because
        a bar under a single row of portraits reads as an accident. The heatmap keeps its bar;
        a rail does not.

        `py-2` is not padding for looks: the hover lift translates a child upward, and without
        room for it the scroll container gains a vertical scrollbar the moment a portrait is
        hovered.
      */}
      <ul className="flex gap-4 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {artists.map((artist) => {
          const card = cardFromArtistRow(artist, 250);
          const mirrored = albumCounts?.get(artist.id);
          return (
            <li key={artist.id} className="w-[104px] shrink-0 sm:w-[120px]">
              {/*
                ONE WRAPPING LINK PER NEIGHBOUR, so the portrait and the caption respond to the
                same hover and there is one tab stop per artist rather than two.
              */}
              <Link href={card.href} className="group block text-center">
                <div
                  className={cn(
                    "relative mx-auto size-[88px] overflow-hidden rounded-full bg-surface-2 sm:size-[104px]",
                    "ring-1 ring-line transition-[transform,box-shadow] duration-150 ease-out-quick",
                    "group-hover:-translate-y-0.5 group-hover:ring-amber",
                  )}
                >
                  {card.pictureUrl ? (
                    <Image
                      src={card.pictureUrl}
                      // Empty alt: the artist's name is the link text directly below and is
                      // already the accessible name for this link. Naming the image too makes a
                      // screen reader read every neighbour twice.
                      alt=""
                      fill
                      sizes="104px"
                      className="object-cover object-top"
                    />
                  ) : (
                    <span className="flex size-full items-center justify-center text-faint" aria-hidden="true">
                      <UserRound className="size-8" />
                    </span>
                  )}
                </div>
                <p className="mt-2 truncate text-[0.8125rem] leading-tight text-paper group-hover:text-amber">
                  {artist.name}
                </p>
                {/*
                  THE MIRRORED COUNT WHEN WE HAVE IT, Deezer's own only as a fallback, and the
                  two are labelled the same way on purpose — but `getMirroredAlbumCounts` is
                  preferred because this caption sits on a LINK, and linking to a discography of
                  eleven rows under a label reading fourteen is the small lie that makes a page
                  untrustworthy.
                */}
                {(mirrored ?? card.albumCount) > 0 ? (
                  <p className="font-mono text-[0.6875rem] tracking-wider tabular text-faint">
                    {plural(mirrored ?? card.albumCount, "release")}
                  </p>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

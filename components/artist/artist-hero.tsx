/**
 * The artist hero.
 *
 * NO `"use client"` — same reasoning as components/album/album-hero.tsx: props in, two slots
 * out, nothing stateful.
 *
 * ---------------------------------------------------------------------------------------
 * DEEZER'S `picture_xl` IS THE ONE REAL IMAGE IN THIS PRODUCT, AND IT IS STILL SQUARE
 * ---------------------------------------------------------------------------------------
 *
 * The design note says the artist page "may use Deezer's `picture_xl` where one exists — a
 * real wide-ish image". Probing the ladder says otherwise, and the evidence is in
 * lib/providers/images.ts: `coverAt` rewrites the URL segment `/<w>x<h>-/`, and `COVER_SIZES`
 * is `[56, 250, 500, 1000]` — every rung is SQUARE, `picture_xl` included. There is no
 * wide-ish artist image to be had; the hoped-for asset does not exist in the provider.
 *
 * So this falls back to the album hero's treatment, using the artist picture in place of the
 * cover: `scale-[1.4] blur-2xl opacity-35 saturate-150`, with `.hero-scrim` and
 * `.hero-vignette` over it. A 1000×1000 portrait stretched across a 1280px band crops to a
 * chin and a shoulder, and there is no honest crop of a square portrait at that ratio — so it
 * is blurred into a colour field, exactly as a cover is, and the SHARP copy of the same
 * picture sits in the foreground where it can be read.
 *
 * The foreground portrait is ROUND, not a `.sleeve`. `.sleeve` is the record geometry: 1:1 with
 * the card radius, and it carries the hover lift that says "this is a link to a release". A
 * person is not a release, and a square artist portrait beside a page of square covers reads
 * as one more album.
 */

import Image from "next/image";
import Link from "next/link";
import { UserRound } from "lucide-react";
import type * as React from "react";

import { Chip, Eyebrow, Meter } from "@/components/ui/primitives";
import type { ArtistRow } from "@/lib/db/queries/artists";
import { formatCount, plural, releaseYear } from "@/lib/format";
import { artistPicture } from "@/lib/providers/images";
import { cn } from "@/lib/utils";

export type ArtistHeroProps = {
  artist: ArtistRow;
  /**
   * CANONICAL RELEASES IN OUR MIRROR — `getMirroredAlbumCounts`, NOT `artists.album_count`.
   *
   * Both numbers are true and they answer different questions. `artists.album_count` is
   * Deezer's claim about its own catalogue and counts releases we have never mirrored; this
   * one is the denominator the discography and the completion figure both use. Quoting
   * fourteen above a list of eleven is the kind of small lie that makes a whole page
   * untrustworthy.
   */
  albumCount: number;
  /**
   * `getCompletion(viewerId, artistId)`, or null when signed out or when nothing is mirrored.
   *
   * The numerator is already clamped to the denominator inside that query, which matters more
   * in music than in television: a member who played the remaster and then the original
   * legitimately holds more logged positions than the canonical edition has tracks, and
   * "63 of 62" reads as a bug even when nothing is wrong.
   */
  completion?: {
    albums: number;
    albumsComplete: number;
    tracks: number;
    tracksListened: number;
    /** 0..100. `Meter` wants 0..1, so this is divided before it is passed. */
    percent: number;
  } | null;
  /** The artist-scope consensus card. A slot; see the note in AlbumHero. */
  consensus?: React.ReactNode;
  /** `ArtistActions` — the discography mark and the rate-artist control. */
  actions?: React.ReactNode;
  className?: string;
};

/**
 * "1985–1997" / "1991–present" / "1985" / null.
 *
 * `beganOn` and `endedOn` are STRINGS, because Drizzle maps `date` to a string and
 * `timestamptz` to a `Date` — constructing a `Date` from one of these and formatting it is how
 * "Invalid Date" gets onto a page (I-9). `releaseYear` slices the four digits off the front and
 * never builds a Date at all.
 *
 * An `endedOn` with `isActive` still true is reported as ended: the date is a fact and the flag
 * is a provider's summary of it.
 */
function yearsActive(artist: Pick<ArtistRow, "beganOn" | "endedOn" | "isActive">): string | null {
  const from = releaseYear(artist.beganOn);
  const to = releaseYear(artist.endedOn);
  if (!from && !to) return null;
  if (!from) return to;
  if (to) return from === to ? from : `${from}–${to}`;
  return artist.isActive ? `${from}–present` : from;
}

export function ArtistHero({ artist, albumCount, completion, consensus, actions, className }: ArtistHeroProps) {
  const backdrop = artistPicture(artist, 1000);
  const portrait = artistPicture(artist, 500);
  const active = yearsActive(artist);

  return (
    <section className={cn("bleed relative overflow-hidden", className)}>
      {/* Painting order, no z-index — see the note in AlbumHero's layer stack. */}
      {backdrop ? (
        <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
          <Image
            src={backdrop}
            alt=""
            fill
            sizes="100vw"
            className="scale-[1.4] object-cover opacity-35 blur-2xl saturate-150"
            priority={false}
          />
        </div>
      ) : null}
      <div aria-hidden="true" className="hero-scrim" />
      <div aria-hidden="true" className="hero-vignette" />

      <div className="relative mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-end sm:gap-8 sm:py-14">
        <div className="shrink-0">
          <div className="relative size-28 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line sm:size-40">
            {portrait ? (
              <Image
                src={portrait}
                // The one accessible name for the picture. The `<h1>` beside it says the name
                // too, so this is deliberately a description rather than a repeat of it.
                alt={`${artist.name}, artist portrait`}
                fill
                sizes="(min-width: 640px) 160px, 112px"
                className="object-cover object-top"
                priority
              />
            ) : (
              // No placeholder image. A dimmed outline glyph, the same decision
              // components/ui/avatar.tsx makes for a guest: it reads as "we have no picture"
              // rather than as a person.
              <span className="flex size-full items-center justify-center text-faint" aria-hidden="true">
                <UserRound className="size-10 sm:size-14" />
              </span>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          <h1 className="font-display text-3xl leading-tight text-paper text-balance sm:text-5xl">
            {artist.name}
          </h1>

          {/* Mono: country · years active · album count. Every one of these is a label or a
              number, and `.tabular` keeps the counts from shifting the line. */}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
            {artist.country ? (
              <>
                <span>{artist.country}</span>
                <span aria-hidden="true">·</span>
              </>
            ) : null}
            {active ? (
              <>
                <span>{active}</span>
                <span aria-hidden="true">·</span>
              </>
            ) : null}
            <span>{plural(albumCount, "release")}</span>
            {/*
              `fans` IS POPULARITY, NOT QUALITY, and it is labelled as what it is. It is never
              rendered as stars, never called a rating, and never used as a heatmap colour
              source. The label is the whole safeguard.
            */}
            {artist.fans > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatCount(artist.fans)} Deezer fans</span>
              </>
            ) : null}
          </p>

          {artist.genres.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {artist.genres.map((genre) => (
                <li key={genre}>
                  <Chip asChild>
                    <Link href={`/artists?genre=${encodeURIComponent(genre)}`}>{genre}</Link>
                  </Chip>
                </li>
              ))}
            </ul>
          ) : null}

          {/*
            THE COMPLETION METER — the artist-level replacement for television's progress bar,
            and the one place a completion denominator still means something in music: "9 of 11
            releases complete".

            `tone="teal"`, because teal is replay and completion ONLY in this palette. The
            number is printed beside the bar, so the bar itself is decoration and takes no
            `label` — `Meter` hides an unlabelled bar from assistive technology for exactly
            this case.

            `percent / 100`: `meterPercent()` returns 0..100 and `Meter` wants 0..1. Passing the
            percent straight through pins every meter at 100%, which looks like a working
            feature.
          */}
          {completion && completion.tracks > 0 ? (
            <div className="max-w-sm space-y-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <Eyebrow>Your listening</Eyebrow>
                <p className="font-mono text-[0.6875rem] tracking-wider tabular text-muted">
                  {completion.albumsComplete} / {completion.albums} complete
                  <span className="text-faint">
                    {" · "}
                    {formatCount(completion.tracksListened)} of {formatCount(completion.tracks)} tracks
                  </span>
                </p>
              </div>
              <Meter ratio={completion.percent / 100} tone="teal" />
            </div>
          ) : null}

          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
          {consensus ? <div className="pt-1">{consensus}</div> : null}
        </div>
      </div>
    </section>
  );
}

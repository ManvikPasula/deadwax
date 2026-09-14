/**
 * The album hero.
 *
 * NO `"use client"`. This renders props and two slots; it holds no state and owns no events.
 * Everything interactive on the album page — the star input, the log dialog, the wantlist
 * toggle — arrives through `actions`, which is a slot precisely so this file does not become a
 * client component by association.
 *
 * ---------------------------------------------------------------------------------------
 * THERE IS NO BACKDROP IMAGE IN ANY MUSIC PROVIDER
 * ---------------------------------------------------------------------------------------
 *
 * Television heroes are built on a 16:9 still: a wide image made to be cropped, with
 * `.hero-scrim` and `.hero-vignette` layered over it to keep text legible. Neither Deezer nor
 * MusicBrainz returns anything of the kind. The size ladder in lib/providers/images.ts is
 * square at every rung (`coverAt` rewrites `<w>x<h>` and tops out at 1000×1000), and the Cover
 * Art Archive fallback is a record sleeve. There is no wide image to have.
 *
 * SO THE HERO'S IMAGE IS THE COVER ITSELF, USED TWICE: once sharp in the foreground at its own
 * 1:1 geometry, and once behind the content as its own scrim — `scale-[1.4]`, `blur-2xl`,
 * `opacity-35`, `saturate-150`. Each value is doing a job:
 *
 *   - `scale-[1.4]`  a square stretched across a 1280px band crops hard, and `blur-2xl` eats
 *                    its own edges; the overscan hides both.
 *   - `blur-2xl`     turns artwork into a colour field. A recognisable-but-wrong crop of the
 *                    cover reads as a layout bug; an abstract wash of the same palette reads
 *                    as intent.
 *   - `opacity-35`   measured against the scrim, not chosen. Above roughly 40% the two
 *                    gradients in `.hero-scrim` stop guaranteeing a dark field for the title.
 *   - `saturate-150` the blur averages colour toward grey, and a grey wash under a dark scrim
 *                    is indistinguishable from no image at all.
 *
 * `aria-hidden` on the whole backdrop stack, because it is the SAME IMAGE as the foreground
 * cover. Announcing it twice would have a screen reader read the album title, then the cover's
 * alt text, then the cover's alt text again.
 *
 * This makes `.hero-scrim` and `.hero-vignette` MORE important here than in television, not
 * less: a blurred square of bright artwork is a far less predictable field than a 16:9 still
 * that was composed.
 */

import Image from "next/image";
import Link from "next/link";
import type * as React from "react";

import { Badge, Chip } from "@/components/ui/primitives";
import type { AlbumRow } from "@/lib/db/queries/albums";
import { formatDuration, plural, releaseYear } from "@/lib/format";
import { albumCover } from "@/lib/providers/images";
import { artistSlug } from "@/lib/slug";
import { cn } from "@/lib/utils";

/** `album | single | ep | compilation` in the member's words. Mono, so it reads as a label. */
const RECORD_TYPES: Record<string, string> = {
  album: "Album",
  single: "Single",
  ep: "EP",
  compilation: "Compilation",
};

export type AlbumHeroProps = {
  /** `getAlbumWithTracks(...).album`. Carries the artist columns it needs for the link. */
  album: AlbumRow;
  /**
   * The two-column consensus card (MusicBrainz left, members right). A SLOT rather than props
   * because the card owns its own zero-votes collapse and its own low-confidence footer, and
   * this file has no business knowing those rules.
   */
  consensus?: React.ReactNode;
  /** The star input, the log dialog trigger, the wantlist and list controls. */
  actions?: React.ReactNode;
  className?: string;
};

export function AlbumHero({ album, consensus, actions, className }: AlbumHeroProps) {
  // 1000px for the backdrop because it is scaled 140% across the full window; 500 for the
  // foreground, which renders at 192–256px and takes the 2× rung.
  const backdrop = albumCover(album, 1000);
  const cover = albumCover(album, 500);

  /*
   * THE YEAR IS `original_release_date ?? release_date`, matching `cardFromAlbumRow`.
   *
   * The schema annotates `release_date` as "what displays", and on this page the DETAIL LINE
   * does report the edition in front of you — but the year in a hero is an identity, and it
   * sits a scroll above a heatmap row ordered by first release. Using the reissue's date here
   * makes the same record read 2017 in the hero and 1997 in the grid below it.
   */
  const year = releaseYear(album.originalReleaseDate ?? album.releaseDate);
  const recordType = RECORD_TYPES[album.recordType] ?? album.recordType;

  return (
    <section className={cn("bleed relative overflow-hidden", className)}>
      {/*
        NO z-INDEX ON ANY LAYER IN THIS STACK, and that is deliberate: the app's ladder is five
        values and none of them is for this. Painting order does the work — three absolutely
        positioned siblings in DOM order (image, scrim, vignette) followed by a `relative`
        content block, which is the last positioned element and therefore on top.
      */}
      {backdrop ? (
        <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
          <Image
            src={backdrop}
            alt=""
            fill
            // The blur destroys detail before a pixel reaches the screen, so this never needs
            // more than one modest rung regardless of viewport.
            sizes="100vw"
            className="scale-[1.4] object-cover opacity-35 blur-2xl saturate-150"
            // No `priority`: the sharp foreground cover is the LCP candidate and the one worth
            // preloading. Racing a blurred decoration against it would slow the thing a member
            // actually looks at.
            priority={false}
          />
        </div>
      ) : null}
      <div aria-hidden="true" className="hero-scrim" />
      <div aria-hidden="true" className="hero-vignette" />

      <div className="relative mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:gap-8 sm:py-14">
        {/*
          THE SHARP COVER, 1:1, AT `w-48 sm:w-64`.

          `.sleeve` is the primitive and it is `aspect-ratio: 1/1` — not 2:3. It is NOT wrapped
          in a `.group` link here: the hover lift exists so a card announces it is a link, and
          this cover is already on the album's own page. A cover that lifts and goes nowhere is
          a promise the page cannot keep.
        */}
        <div className="sleeve w-48 shrink-0 shadow-2xl shadow-black/60 sm:w-64">
          {cover ? (
            <Image
              src={cover}
              alt={`${album.title} by ${album.artistName}`}
              fill
              sizes="(min-width: 640px) 256px, 192px"
              className="object-cover"
              priority
            />
          ) : null}
          {/* No placeholder image, ever. `.sleeve`'s surface-2 field and hairline ARE the
              empty state — a generic "no artwork" graphic is a claim that we looked. */}
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          <div className="space-y-1.5">
            {/* Display serif, headlines only. `text-balance` because a three-word album title
                breaking after the first word is the most common ugly wrap on this page. */}
            <h1 className="font-display text-3xl leading-tight text-paper text-balance sm:text-5xl">
              {album.title}
            </h1>
            <p className="text-base text-muted">
              <Link
                href={`/artist/${artistSlug(album.artistName, album.artistId)}`}
                className="text-paper transition-colors hover:text-amber"
              >
                {album.artistName}
              </Link>
            </p>
          </div>

          {/*
            THE MONO DETAIL LINE: year · record type · track count · total duration.

            Mono because every item in it is a label or a number, and `.tabular` because the
            duration and the track count both change between albums — a proportional font makes
            a column of these jitter against each other down a page of cards.

            `formatDuration` gives `43:12` rather than "43 minutes": this line is the back of a
            sleeve, and a sleeve prints a running time.
          */}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
            <span>{year ?? "Undated"}</span>
            <span aria-hidden="true">·</span>
            <span>{recordType}</span>
            <span aria-hidden="true">·</span>
            <span>{plural(album.trackCount, "track")}</span>
            {album.discCount > 1 ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{plural(album.discCount, "disc")}</span>
              </>
            ) : null}
            {album.durationMs > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatDuration(album.durationMs)}</span>
              </>
            ) : null}
            {album.label ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="normal-case">{album.label}</span>
              </>
            ) : null}
          </p>

          {(album.explicit || !album.isCanonical) ? (
            <div className="flex flex-wrap items-center gap-2">
              {album.explicit ? <Badge>Explicit</Badge> : null}
              {/*
                A NON-CANONICAL RELEASE IS REACHABLE BY DIRECT NAVIGATION AND MUST SAY SO.

                It never enters a heatmap row, a completion denominator or a recommendation
                pool — so a member who lands on a deluxe reissue from a search result and sees
                it missing from the artist's grid is owed the reason on this page rather than
                left to infer a bug.
              */}
              {!album.isCanonical ? (
                <Badge tone="amber" title="Reissues, deluxe editions and compilations are excluded from the discography grid and from completion figures.">
                  Secondary release
                </Badge>
              ) : null}
            </div>
          ) : null}

          {/*
            GENRE CHIPS ARE LINKS, not decoration. `Chip` takes `asChild` for exactly this, and
            `aria-current` is the caller's job — there is no active genre on an album page, so
            none is set.
          */}
          {album.genres.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {album.genres.map((genre) => (
                <li key={genre}>
                  <Chip asChild>
                    <Link href={`/albums?genre=${encodeURIComponent(genre)}`}>{genre}</Link>
                  </Chip>
                </li>
              ))}
            </ul>
          ) : null}

          {actions ? <div className="flex flex-wrap items-center gap-2 pt-1">{actions}</div> : null}
          {consensus ? <div className="pt-1">{consensus}</div> : null}
        </div>
      </div>
    </section>
  );
}

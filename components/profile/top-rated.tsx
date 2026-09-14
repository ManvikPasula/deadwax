/**
 * THREE SEPARATE RANKINGS — artists, albums, tracks — side by side.
 *
 * NO `"use client"`. Three pure passes over three arrays.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THREE AND NOT ONE
 * ---------------------------------------------------------------------------------------
 *
 * > "An artist, an album and a track are different things to have an opinion about, and a
 * > member's best three minutes is often inside a record they would not put in their top four."
 *
 * That second clause is the whole argument, and it is sharper in music than in television. A
 * single merged "highest rated" list would sort a 10 given to an artist's entire body of work
 * against a 10 given to one four-minute song, and whichever tie-break won would be inventing
 * a comparison the member never made. `logs.target_type` keeps the three tiers apart in the
 * data; this component keeps them apart on the page.
 *
 * ---------------------------------------------------------------------------------------
 * THE QUERIES ALREADY OWN THE ORDER, AND THE TIE-BREAK IS NOT AESTHETIC
 * ---------------------------------------------------------------------------------------
 *
 * `getTopArtists` / `getTopAlbums` / `getTopTracks` order by `rating DESC` then by `fans DESC`
 * — "so a five-star given to a landmark leads a five-star given to something obscure instead
 * of the order falling out of however the rows happen to be stored". NOTHING HERE RE-SORTS.
 * Note also that `fans` is POPULARITY and is used only as that tie-break: it is never rendered
 * on this page, and never as stars.
 *
 * NO "N RATED X" CAPTIONS, AND THAT IS I-14 RATHER THAN A layout choice. `getTopTracks` joins
 * `tracks` with an INNER JOIN, so a log addressing a position the mirror no longer carries —
 * a re-synced edition renumbered the record — is dropped. The returned list can therefore be
 * SHORTER than `ProfileStats.ratingsGiven`, and a heading counting one while the body shows
 * the other contradicts itself. The rankings speak for their own length.
 *
 * ARTISTS GET ROUND PORTRAITS AND RECORDS GET `.sleeve`, the same split `SimilarArtists` and
 * `ListItemRow` make: `.sleeve` is the 1:1 record geometry and a square portrait in a column
 * of square covers reads as one more album.
 */

import { Disc3, Music4, UserRound, type LucideIcon } from "lucide-react";
import Link from "next/link";

import { Stars } from "@/components/rating/stars";
import { SectionHeading } from "@/components/ui/primitives";
import type { AlbumRow, TopArtist, TrackContextRow } from "@/lib/db/queries/albums";
import { formatRating } from "@/lib/ratings";
import { cardFromAlbumRow, cardFromArtistRow, cardFromTrackRow } from "@/lib/view";
import { cn } from "@/lib/utils";

/** 48px rendered. 250 is the next CDN rung up, so the thumbnail stays sharp at 2x. */
const THUMB_SOURCE_WIDTH = 250;

/** What a ranking row needs, once, so the three columns cannot drift apart. */
type Ranked = {
  key: string;
  href: string | null;
  imageUrl: string | null;
  primary: string;
  secondary: string | null;
  /** The member's own rating, on the stored 1..10 scale. */
  rating: number;
  /** Round portrait rather than `.sleeve`. Artists only. */
  round?: boolean;
  /** Drawn when there is no image. `LucideIcon` rather than a generic `ComponentType`, so the
   *  size class below is checked against the real prop type instead of a hand-written one. */
  Placeholder: LucideIcon;
};

export type TopRatedProps = {
  /** `getTopArtists(userId)`. */
  artists: TopArtist[];
  /** `getTopAlbums(userId)`. */
  albums: Array<AlbumRow & { viewerRating: number }>;
  /** `getTopTracks(userId)`. */
  tracks: Array<TrackContextRow & { viewerRating: number }>;
  /**
   * Whose rankings these are — "Nadia's" in the section eyebrow. The display name, not the
   * handle: this is prose, not an identifier.
   */
  displayName: string;
  className?: string;
};

export function TopRated({ artists, albums, tracks, displayName, className }: TopRatedProps) {
  /*
   * NOTHING AT ALL WHEN ALL THREE ARE EMPTY, rather than an `EmptyState`.
   *
   * `EmptyState`'s own docblock is right that an empty state is a real state in this product —
   * but it earns that by always offering the next move, and the next move here ("rate
   * something") is already the message on the diary directly below, and the stat tiles beside
   * it already report zero ratings. A third box saying the same thing is a page telling a new
   * member three times that they are new.
   */
  if (artists.length === 0 && albums.length === 0 && tracks.length === 0) return null;

  const artistRows: Ranked[] = artists.map((artist) => {
    const card = cardFromArtistRow(artist, THUMB_SOURCE_WIDTH);
    return {
      key: `artist-${artist.id}`,
      href: card.href,
      imageUrl: card.pictureUrl,
      primary: card.name,
      secondary: null,
      rating: artist.viewerRating,
      round: true,
      Placeholder: UserRound,
    };
  });

  const albumRows: Ranked[] = albums.map((album) => {
    const card = cardFromAlbumRow(album, THUMB_SOURCE_WIDTH);
    return {
      key: `album-${album.id}`,
      href: card.href,
      imageUrl: card.coverUrl,
      primary: card.title,
      // The artist, and the year from `original_release_date ?? release_date` — chosen once, in
      // the adapter, so the same record does not read as 1997 here and 2017 in a rail.
      secondary: [card.artistName, card.year].filter(Boolean).join(" · "),
      rating: album.viewerRating,
      Placeholder: Disc3,
    };
  });

  const trackRows: Ranked[] = tracks.map((track) => {
    const card = cardFromTrackRow(track, THUMB_SOURCE_WIDTH);
    return {
      key: `track-${track.id}`,
      href: card.href,
      imageUrl: card.coverUrl,
      primary: card.title,
      // The locator belongs in the caption here rather than in front of the title: this is a
      // ranking, so the leading number is the RANK, and two numbers in a row would be read as
      // one.
      secondary: [card.albumTitle, card.locator, card.artistName].filter(Boolean).join(" · "),
      rating: track.viewerRating,
      Placeholder: Music4,
    };
  });

  return (
    <section className={cn("space-y-4", className)}>
      <SectionHeading eyebrow="Highest rated" title={`What ${displayName} rates`} />

      {/* Three columns at `lg`, stacked below it. Side by side is the point: the three tiers
          are being shown as three separate opinions, not as one list with headings in it. */}
      <div className="grid gap-x-8 gap-y-8 lg:grid-cols-3">
        <Ranking title="Artists" rows={artistRows} empty="No artist ratings yet." />
        <Ranking title="Albums" rows={albumRows} empty="No album ratings yet." />
        <Ranking title="Tracks" rows={trackRows} empty="No track ratings yet." />
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* One ranking                                                                */
/* -------------------------------------------------------------------------- */

function Ranking({ title, rows, empty }: { title: string; rows: Ranked[]; empty: string }) {
  return (
    <div>
      {/* `.section-rule` supplies the hairline that trails off after the label — the same
          treatment the feed's day headers use, one level down from `SectionHeading`. */}
      <h3 className="section-rule mb-1">
        <span className="eyebrow">{title}</span>
      </h3>

      {rows.length === 0 ? (
        /*
         * A SENTENCE, NOT AN `EmptyState` BOX. One of the three tiers being empty is the normal
         * case — most members rate albums long before they rate an artist as a whole — so a
         * bordered panel inside a three-column grid would make the ordinary state look like a
         * failure in a third of the section.
         */
        <p className="py-3 text-[0.8125rem] text-faint">{empty}</p>
      ) : (
        <ol className="divide-y divide-line">
          {rows.map((row, index) => (
            <li key={row.key} className="group flex items-center gap-3 py-2.5">
              <p className="w-5 shrink-0 text-right font-mono text-[0.8125rem] tabular text-faint">{index + 1}</p>

              <span
                className={cn(
                  "block w-12 shrink-0 overflow-hidden bg-surface-2",
                  row.round ? "aspect-square rounded-full ring-1 ring-line" : "sleeve",
                )}
                // Decorative: the title beside it is the link text and therefore the name.
                aria-hidden="true"
              >
                {row.imageUrl ? (
                  <img
                    src={row.imageUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width={48}
                    height={48}
                    className="size-full object-cover"
                  />
                ) : (
                  <span className="flex size-full items-center justify-center text-line-bright">
                    <row.Placeholder className="size-4" />
                  </span>
                )}
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-[0.8125rem] leading-snug">
                  {/*
                    A NULL HREF IS A REAL STATE, not a bug to paper over: `lib/view.ts` returns
                    one for a row that has not been mirrored, and an inert span is better than a
                    link built on a guessed id. It is the same branch `CoverCard` takes.
                  */}
                  {row.href ? (
                    <Link href={row.href} className="text-paper transition-colors group-hover:text-amber">
                      {row.primary}
                    </Link>
                  ) : (
                    <span className="text-paper">{row.primary}</span>
                  )}
                </p>
                {row.secondary ? (
                  <p className="truncate font-mono text-[0.6875rem] tabular text-faint">{row.secondary}</p>
                ) : null}
              </div>

              {/* `Stars` takes the stored 1..10 scale and divides internally, and carries its own
                  `sr-only` sentence — so the glyphs are never the only channel. */}
              <Stars
                value={row.rating}
                size="xs"
                label={`${formatRating(row.rating)} out of 5 stars`}
                className="shrink-0"
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

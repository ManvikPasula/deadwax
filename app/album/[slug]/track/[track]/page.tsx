/**
 * /album/[slug]/track/[track] — one recording.
 *
 * `[track]` IS A LOCATOR, NOT AN ID: `7` on a single-disc record, `2-5` on a double. A log row
 * addresses a POSITION — `(album_id, disc_number, track_number)` — not a `tracks.id`, which is
 * why the URL carries the position too and why `getTrackAt` looks a track up by its addressable
 * identity rather than by its serial.
 *
 * ============================================================================
 * NO `loading.tsx` FOR THIS ROUTE, EVER (I-3)
 *
 * This function decides the response status. A `notFound()` raised after the shell has flushed
 * is sent as a 200, and a route-level `loading.tsx` flushes the shell immediately. There are
 * THREE 404 gates here and all three are above every other read:
 *
 *   1. the album slug does not parse          — `/album/kid-a-9999999999`
 *   2. the track segment does not parse       — `/track/2-5-1`, `/track/-5`, `/track/1e3`
 *   3. the album or the track row is missing  — a position this edition does not have
 *
 * Every parser returns null rather than clamping, precisely so the caller can answer with a
 * 404 instead of a 500: clamping a disc number silently renders a different track.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------------------
 * THE CONSENSUS CARD TAKES THE `label` OVERRIDE HERE AND NOWHERE ELSE
 * ---------------------------------------------------------------------------------------
 *
 * MusicBrainz per-RECORDING ratings are genuinely sparse — most tracks have none at all — so
 * the provider column on this page is usually absent, and when it IS present it is a rating of
 * the recording rather than of the release. Albums and artists both carry real attributed
 * figures and want the plain name; a track wants the qualifier. The card's zero-votes collapse
 * does the rest: it renders one column with a footnote rather than a greyed "0.0", because a
 * displayed zero on this scale is a verdict and there is no zero.
 *
 * ---------------------------------------------------------------------------------------
 * THE DESERT ISLAND CONTROL EXISTS ONLY AT FIVE STARS, AND THE COMPONENT OWNS THAT GATE
 * ---------------------------------------------------------------------------------------
 *
 * `DesertIslandButton` renders NOTHING unless `viewerRating === MAX_RATING`. It is mounted
 * unconditionally for a signed-in member rather than branched on here, because the gate and the
 * quota arithmetic belong together — and the two reads it needs (`getCrownedTracks`,
 * `countHeld`) are cheap indexed lookups that would otherwise have to be sequenced behind the
 * rating they are being gated on.
 */

import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NotebookPen } from "lucide-react";

import { DesertIslandButton } from "@/components/album/desert-island-button";
import { LogDialog, type LogDialogInitial } from "@/components/album/log-dialog";
import { PreviewButton } from "@/components/album/preview-button";
import { AddToListDialog } from "@/components/list/add-to-list-dialog";
import { Consensus } from "@/components/rating/consensus";
import { Stars } from "@/components/rating/stars";
import { ReviewCard } from "@/components/social/review-card";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, SectionHeading } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import { albumTrackKey, getCrownedTracks, getRatingStats, getTrackAt } from "@/lib/db/queries/albums";
import { getListOptions } from "@/lib/db/queries/lists";
import {
  countReviews,
  findExistingLog,
  getLikedLogIds,
  getReviews,
  type ReviewTarget,
} from "@/lib/db/queries/logs";
import { countHeld, DESERT_ISLAND_QUOTA } from "@/lib/desert-island";
import { formatDuration, plural, releaseYear } from "@/lib/format";
import { ensureAlbumById } from "@/lib/ingest/albums";
import { albumCover } from "@/lib/providers/images";
import { formatRating, MAX_RATING } from "@/lib/ratings";
import { albumSlug, artistSlug, parseAlbumSlug, parseTrackLocator, trackLocator } from "@/lib/slug";

/** Six reviews, then the album's paged list. A track rarely has more, and never has pages. */
const REVIEW_LIMIT = 6;

/**
 * THE BLANKS ARE ONLY CORRECT WHEN THE READ RETURNED NOTHING.
 *
 * `LogDialog`'s `initial` is required rather than optional so that forgetting the read is a
 * compile error: a dialog primed with blanks sends explicit nulls for the review, the diary
 * date, the replay flag and the tags, and a rating click then erases a written review
 * (SEC-01 / I-1).
 */
const NO_LOG: LogDialogInitial = {
  rating: null,
  review: null,
  listenedOn: null,
  isReplay: false,
  liked: false,
  tags: [],
};

type Params = Promise<{ slug: string; track: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  // `params` IS A PROMISE in Next 16.
  const { slug, track } = await params;
  const albumId = parseAlbumSlug(slug);
  const locator = parseTrackLocator(track);
  if (albumId === null || locator === null) return { title: "Track not found" };

  // React-`cache()`d, so `generateMetadata` and the body share one album resolution.
  const album = await ensureAlbumById(albumId);
  if (!album) return { title: "Track not found" };

  const row = await getTrackAt(album.id, locator.disc, locator.track);
  if (!row) return { title: "Track not found" };

  return {
    // A bare title: the root's `title.template` makes it "… · Deadwax".
    title: `${row.title} — ${row.albumTitle}`,
    description: `Ratings and reviews of ${row.title} from ${row.albumTitle} on Deadwax.`,
  };
}

export default async function TrackPage({ params }: { params: Params }) {
  /* -- 1. THE 404 DECISIONS, AND NOTHING ELSE ------------------------------------------ */
  const { slug, track: segment } = await params;

  const albumId = parseAlbumSlug(slug);
  if (albumId === null) notFound();

  // Bounded: disc 0..50, track 0..500. MIN IS 0 — a pregap or hidden track is legitimately 0.
  const locator = parseTrackLocator(segment);
  if (locator === null) notFound();

  const album = await ensureAlbumById(albumId);
  if (!album) notFound();

  const row = await getTrackAt(album.id, locator.disc, locator.track);
  // A POSITION THIS EDITION DOES NOT HAVE. A re-sync from a different pressing genuinely
  // changes a tracklist's length, so this is an ordinary 404 rather than an impossible one.
  if (!row) notFound();

  /* -- 2. everything else --------------------------------------------------------------- */
  const viewer = await currentUser();
  const viewerId = viewer?.id ?? null;

  const albumHref = `/album/${albumSlug(row.albumTitle, row.albumId)}`;
  /*
   * THE DISPLAY AND URL FORM, WHICH IS NOT THE SAME AS THE SEGMENT THAT WAS TYPED.
   * `parseTrackLocator` accepts both `7` and `1-7`; `trackLocator` drops the redundant "1-"
   * on a single-disc record, which is the canonical spelling every other surface uses.
   */
  const locatorText = trackLocator({
    disc: row.discNumber,
    track: row.trackNumber,
    discCount: row.discCount,
  });
  const trackHref = `${albumHref}/track/${locatorText}`;

  /** THE SAME TARGET FOR THE COUNT AND THE LIST (I-14), built once. */
  const reviewTarget: ReviewTarget = {
    albumId: row.albumId,
    discNumber: row.discNumber,
    trackNumber: row.trackNumber,
  };

  const [stats, reviews, reviewCount, existing, crowned, islandUsed, listOptions] = await Promise.all([
    getRatingStats({ type: "track", albumId: row.albumId, disc: row.discNumber, track: row.trackNumber }),
    getReviews(reviewTarget, { sort: "popular", limit: REVIEW_LIMIT }),
    countReviews(reviewTarget),
    /*
     * THE REAL ROW THE DIALOG IS PRIMED FROM, read by exact target — the narrow read rather
     * than `getViewerAlbumState`, which pulls every log the member holds for the whole album to
     * answer a question about one position.
     */
    viewer
      ? findExistingLog(viewer.id, {
          artistId: row.albumArtistId,
          albumId: row.albumId,
          discNumber: row.discNumber,
          trackNumber: row.trackNumber,
        })
      : null,
    getCrownedTracks(viewerId, row.albumId),
    viewer ? countHeld(viewer.id) : 0,
    viewer
      ? getListOptions(viewer.id, {
          artistId: row.albumArtistId,
          albumId: row.albumId,
          discNumber: row.discNumber,
          trackNumber: row.trackNumber,
        })
      : [],
  ]);

  /* A second round: one query for every review on the page, and it needs their ids. */
  const likedIds = await getLikedLogIds(viewerId, reviews.map((entry) => entry.id));

  const viewerRating = existing?.rating ?? null;
  /*
   * `getCrownedTracks` is keyed by `albumTrackKey`, NOT `trackKey` — the two shapes are not
   * interchangeable and a mismatched lookup fails SILENTLY, returning undefined. The helper is
   * imported rather than written inline for exactly that reason.
   */
  const marked = crowned.has(albumTrackKey(row.albumId, row.discNumber, row.trackNumber));

  const backdrop = albumCover({ coverPath: row.albumCoverPath, mbid: row.albumMbid }, 1000);
  const cover = albumCover({ coverPath: row.albumCoverPath, mbid: row.albumMbid }, 500);
  const year = releaseYear(row.albumOriginalReleaseDate ?? row.albumReleaseDate);
  /*
   * The per-track credit wins when there is one — a featured guest is the answer to "who is
   * this by" on a track — and falls back to the album artist, which is what the provider omits
   * precisely when the two are the same.
   */
  const performer = row.artistName ?? row.albumArtistName;

  return (
    <div className="space-y-12">
      {/*
        THE HERO TREATMENT IS THE ALBUM HERO'S, WITH THE ALBUM'S COVER.

        There is no backdrop image in any music provider — the size ladder is square at every
        rung — and there is no track artwork at all, so the hero's image is the RECORD'S sleeve
        used twice: sharp in the foreground at its own 1:1 geometry, and behind the content as
        its own scrim at `scale-[1.4] blur-2xl opacity-35 saturate-150`. Each of those four
        numbers is justified in components/album/album-hero.tsx and is copied rather than
        re-derived, so the two heroes cannot drift apart.

        It is page-local markup rather than a shared component because the `<h1>` is the TRACK
        and `AlbumHero`'s is the album: passing a title override into it would make one
        component answer to two different subjects, and the detail line, the breadcrumb and the
        controls all differ underneath.

        NO z-INDEX ON ANY LAYER. Painting order does the work — three absolutely positioned
        siblings in DOM order, then a `relative` content block, which is the last positioned
        element and therefore on top. The app's ladder is five values and none is for this.
      */}
      <section className="bleed relative overflow-hidden">
        {backdrop ? (
          <div aria-hidden="true" className="absolute inset-0 overflow-hidden">
            <Image
              src={backdrop}
              alt=""
              fill
              sizes="100vw"
              className="scale-[1.4] object-cover opacity-35 blur-2xl saturate-150"
              /* No `priority`: the sharp foreground cover is the LCP candidate. */
              priority={false}
            />
          </div>
        ) : null}
        <div aria-hidden="true" className="hero-scrim" />
        <div aria-hidden="true" className="hero-vignette" />

        <div className="relative mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:gap-8 sm:py-14">
          {/*
            `.sleeve` is 1:1 and is NOT wrapped in a `.group` link here — the hover lift exists
            so a card announces it is a link, and this sleeve's link is the album, which the
            breadcrumb below already names in words.
          */}
          <div className="sleeve w-36 shrink-0 shadow-2xl shadow-black/60 sm:w-48">
            {cover ? (
              <Image
                src={cover}
                alt={`${row.albumTitle} by ${row.albumArtistName}`}
                fill
                sizes="(min-width: 640px) 192px, 144px"
                className="object-cover"
                priority
              />
            ) : null}
            {/* No placeholder image, ever. `.sleeve`'s surface-2 field and hairline ARE the
                empty state — a generic "no artwork" graphic is a claim that we looked. */}
          </div>

          <div className="min-w-0 flex-1 space-y-4">
            <div className="space-y-1.5">
              {/* The locator is mono and `.tabular`: a track is identified by its position as
                  much as by its name, and "2-5" is how somebody finds it on the record. */}
              <p className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
                Track {locatorText}
              </p>
              <h1 className="font-display text-3xl leading-tight text-paper text-balance sm:text-5xl">
                {row.title}
              </h1>
              <p className="text-base text-muted">
                <Link
                  href={`/artist/${artistSlug(row.albumArtistName, row.albumArtistId)}`}
                  className="text-paper transition-colors hover:text-amber"
                >
                  {performer}
                </Link>
                <span className="text-faint"> — from </span>
                <Link href={albumHref} className="text-paper transition-colors hover:text-amber">
                  {row.albumTitle}
                </Link>
              </p>
            </div>

            {/* Mono detail line: year · duration · disc. `formatDuration` gives `3:45` rather
                than "3 minutes" — this is the back of a sleeve, and a sleeve prints a time. */}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
              <span>{year ?? "Undated"}</span>
              {row.durationMs > 0 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{formatDuration(row.durationMs)}</span>
                </>
              ) : null}
              {row.discCount > 1 ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Disc {row.discNumber}</span>
                </>
              ) : null}
            </p>

            {row.explicit ? <Badge>Explicit</Badge> : null}

            {/* -- the write controls ------------------------------------------------------ */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {/* Nothing at all when Deezer supplied no preview, or supplied a stale or foreign
                  URL — `previewSource` validates inside the component, so a dead preview is no
                  button rather than a button that fails when pressed. */}
              <PreviewButton previewUrl={row.previewUrl} trackTitle={row.title} />

              {viewer ? (
                <>
                  {/*
                    `initial` IS PASSED, AS IT IS AT EVERY MOUNT. `target` carries the ordinals,
                    and `targetType` is deliberately NOT a field — the server derives it, because
                    a caller who could set it could write `target_type = 'album'` on a row
                    carrying a track number and every aggregate would count that row twice.
                  */}
                  <LogDialog
                    target={{
                      artistId: row.albumArtistId,
                      albumId: row.albumId,
                      discNumber: row.discNumber,
                      trackNumber: row.trackNumber,
                    }}
                    initial={existing ?? NO_LOG}
                    title={row.title}
                    /* The mono code line: A TRACK LOCATOR for a track log. */
                    code={locatorText}
                    subtitle={performer}
                    coverUrl={albumCover({ coverPath: row.albumCoverPath, mbid: row.albumMbid }, 250)}
                  >
                    <Button variant={viewerRating === null ? "primary" : "secondary"}>
                      <NotebookPen />
                      {viewerRating === null ? "Log this track" : "Edit your log"}
                    </Button>
                  </LogDialog>

                  {/*
                    RENDERS NOTHING BELOW FIVE STARS — the component owns that gate, and the
                    quota is passed rather than hard-coded so the honour's size lives in one
                    place. `used` is GLOBAL across every artist and already counts this track
                    when `marked` is true.
                  */}
                  <DesertIslandButton
                    albumId={row.albumId}
                    discNumber={row.discNumber}
                    trackNumber={row.trackNumber}
                    trackTitle={row.title}
                    viewerRating={viewerRating}
                    marked={marked}
                    used={islandUsed}
                    quota={DESERT_ISLAND_QUOTA}
                  />

                  <AddToListDialog
                    target={{
                      artistId: row.albumArtistId,
                      albumId: row.albumId,
                      discNumber: row.discNumber,
                      trackNumber: row.trackNumber,
                    }}
                    targetLabel={row.title}
                    options={listOptions}
                    canWrite
                    signInNext={trackHref}
                  />
                </>
              ) : (
                /* A SIGN-IN OFFER RATHER THAN A HIDDEN CONTROL: a control that is not there
                   teaches nothing about what an account is for. */
                <Button asChild variant="primary">
                  <Link href={`/login?next=${encodeURIComponent(trackHref)}`}>Sign in to rate this track</Link>
                </Button>
              )}
            </div>

            {viewerRating === null ? null : (
              <p className="flex items-center gap-2 pt-1">
                <Stars value={viewerRating} size="sm" label={null} />
                <span className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
                  {viewerRating === MAX_RATING ? "Your rating — a Desert Island candidate" : "Your rating"}
                </span>
                <span className="sr-only">
                  {`You rated ${row.title} ${formatRating(viewerRating)} out of 5 stars.`}
                </span>
              </p>
            )}

            <div className="pt-1">
              {/*
                THE `label` OVERRIDE, AND THIS IS THE ONLY PAGE THAT PASSES IT. Per-recording
                MusicBrainz ratings are sparse, so the caption names what the figure is a rating
                OF. See the module docblock.
              */}
              <Consensus
                criticScore={row.criticScore}
                criticVotes={row.criticVotes}
                memberAverage={stats.average}
                memberCount={stats.ratingCount}
                label="MusicBrainz recording"
              />
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-3xl">
        <SectionHeading
          eyebrow={reviewCount === 0 ? "Reviews" : plural(reviewCount, "review")}
          title="What people wrote"
          action={
            /*
             * THE "ALL REVIEWS" LINK GOES TO THE ALBUM'S LIST, because there is no paged route
             * for one track — and the album list is `scope: "any"`, so this track's reviews are
             * genuinely in it. Shown only when there are more than this page holds, so the link
             * never promises a longer list than exists.
             */
            reviewCount > REVIEW_LIMIT ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={`${albumHref}/reviews`}>All reviews of the record</Link>
              </Button>
            ) : null
          }
        />
        {reviews.length === 0 ? (
          <EmptyState
            title="Nothing written about this track"
            description="A rating is a number; a review is the reason. Say what this one does."
          />
        ) : (
          <ul className="space-y-4">
            {reviews.map((entry) => (
              <li key={entry.id}>
                <ReviewCard entry={entry} liked={likedIds.has(entry.id)} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

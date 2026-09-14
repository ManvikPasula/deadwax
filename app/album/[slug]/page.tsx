/**
 * /album/[slug] — the record.
 *
 * ============================================================================
 * THERE IS NO `loading.tsx` FOR THIS ROUTE AND THERE MUST NEVER BE ONE (I-3)
 *
 * This function decides the response status. A `notFound()` raised after the shell has flushed
 * is sent as a 200, and a route-level `loading.tsx` on a content route flushes the shell
 * immediately — which turns every 404 into a 200 with not-found markup inside it. Search
 * engines index it, a client-side fetch reads it as success, and nothing in the page looks
 * wrong.
 *
 * So the order below is fixed: parse the slug, resolve the row, `notFound()`, AND ONLY THEN
 * start anything slow. There is deliberately no Suspense boundary anywhere on this route
 * either; the artist page has one, and it sits strictly after its own 404 decision.
 * ============================================================================
 *
 * A FAILED PARSE IS A 404, NEVER A 500. `parseAlbumSlug` returns null rather than clamping —
 * `/album/kid-a-9999999999` used to reach Postgres as "value out of range for type integer",
 * which is a 500 where a 404 belongs.
 *
 * ---------------------------------------------------------------------------------------
 * `scope: "any"` ON THE REVIEWS, AND IT IS NOT AN OVERSIGHT
 * ---------------------------------------------------------------------------------------
 *
 * The preview rolls up the album's OWN TRACKS' reviews as well as its album-level ones. Most
 * writing about music is about a specific song, so an album page restricted to album-level
 * reviews is usually an empty panel while all the writing sits one tier below it. The count and
 * the list are both asked the same question, with the same target and the same scope — a "12
 * reviews" heading over three visible ones is the kind of mismatch that looks like a bug in the
 * list (I-14).
 *
 * ---------------------------------------------------------------------------------------
 * `initial` IS PASSED TO EVERY `LogDialog` MOUNT ON THIS PAGE
 * ---------------------------------------------------------------------------------------
 *
 * The only dialog here is the one inside `AlbumActions`, which takes `logInitial` as a REQUIRED
 * prop for exactly this reason: a dialog primed with blanks sends explicit nulls for the
 * review, the diary date, the replay flag and the tags, so a rating click silently erases a
 * written review (SEC-01 / I-1). The blanks below are correct ONLY because
 * `getViewerAlbumState` returned nothing.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdSlot } from "@/components/ads/ad-slot";
import { AlbumActions } from "@/components/album/album-actions";
import { AlbumHero } from "@/components/album/album-hero";
import { ListenLinks } from "@/components/album/listen-links";
import { TrackStrip } from "@/components/album/track-strip";
import { Tracklist } from "@/components/album/tracklist";
import { CreditsRail } from "@/components/artist/credits-rail";
import { AddToListDialog } from "@/components/list/add-to-list-dialog";
import { Consensus } from "@/components/rating/consensus";
import { Histogram } from "@/components/rating/histogram";
import { ReviewCard } from "@/components/social/review-card";
import { Button } from "@/components/ui/button";
import { EmptyState, Eyebrow, SectionHeading } from "@/components/ui/primitives";
import { AD_PAGE_KEY, serveAds } from "@/lib/ads/serve";
import { currentUser } from "@/lib/auth/session";
import {
  getAlbumCredits,
  getAlbumWithTracks,
  getCrownedTracks,
  getRatingStats,
  getTrackStrip,
  getViewerAlbumState,
} from "@/lib/db/queries/albums";
import { getMirroredAlbumCounts } from "@/lib/db/queries/artists";
import { getListOptions } from "@/lib/db/queries/lists";
import { countReviews, getLikedLogIds, getReviews } from "@/lib/db/queries/logs";
import { isWanted } from "@/lib/db/queries/users";
import { countHeld, DESERT_ISLAND_QUOTA } from "@/lib/desert-island";
import { plural } from "@/lib/format";
import { ensureAlbumById } from "@/lib/ingest/albums";
import { albumCover } from "@/lib/providers/images";
import { albumSlug, parseAlbumSlug } from "@/lib/slug";
import type { LogDialogInitial } from "@/components/album/log-dialog";

/** Three reviews under the tracklist. The full list is its own paged route. */
const REVIEW_PREVIEW = 3;

/**
 * THE BLANKS ARE ONLY CORRECT WHEN THE READ RETURNED NOTHING.
 *
 * Declared as a constant so it cannot be mistaken for a default that papers over a missing
 * read: `LogDialog`'s `initial` is required precisely so that forgetting
 * `getViewerAlbumState` is a compile error rather than silent data loss.
 */
const NO_LOG: LogDialogInitial = {
  rating: null,
  review: null,
  listenedOn: null,
  isReplay: false,
  liked: false,
  tags: [],
};

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  // `params` IS A PROMISE in Next 16.
  const { slug } = await params;
  const id = parseAlbumSlug(slug);

  /*
   * NO `notFound()` HERE. `generateMetadata` runs alongside the page, and duplicating the 404
   * would be two places deciding one status; the body owns that decision. A neutral title is
   * what a 404 response needs anyway. (/list/[slug] is the exception and says why: a PRIVATE
   * list must not have its title leak through metadata.)
   */
  if (id === null) return { title: "Record not found" };

  // `ensureAlbumById` is React-`cache()`d, so this and the page body share ONE resolution.
  const album = await ensureAlbumById(id);
  if (!album) return { title: "Record not found" };

  return {
    // A bare title: the root's `title.template` makes it "… · Deadwax".
    title: album.title,
    description: `Ratings, reviews and the track-by-track shape of ${album.title} on Deadwax.`,
  };
}

export default async function AlbumPage({ params }: { params: Params }) {
  /* -- 1. THE 404 DECISION, AND NOTHING ELSE ------------------------------------------- */
  const { slug } = await params;
  const id = parseAlbumSlug(slug);
  if (id === null) notFound();

  const row = await ensureAlbumById(id);
  if (!row) notFound();

  const detail = await getAlbumWithTracks(row.id);
  // Deleted between the two statements. Still a 404, and still before anything has flushed.
  if (!detail) notFound();

  /* -- 2. everything else --------------------------------------------------------------- */
  const { album, tracks } = detail;
  const albumId = album.id;
  const artistId = album.artistId;
  /*
   * THE SLUG IS RECOMPUTED, NOT REUSED FROM `params`. The URL grammar ignores everything before
   * the trailing id, so `/album/anything-42` renders this page — and every link built from here
   * should carry the canonical text rather than whatever was typed. Same argument lib/view.ts
   * makes for the card adapters.
   */
  const albumHref = `/album/${albumSlug(album.title, albumId)}`;

  const viewer = await currentUser();
  const viewerId = viewer?.id ?? null;

  const [
    stats,
    strips,
    credits,
    reviews,
    reviewCount,
    ads,
    mirroredCounts,
    viewerState,
    wanted,
    crowned,
    islandUsed,
    listOptions,
  ] = await Promise.all([
    getRatingStats({ type: "album", albumId }),
    getTrackStrip(albumId, viewerId),
    getAlbumCredits(albumId),
    // THE SAME TARGET AND SCOPE AS THE COUNT BELOW. Edited together, always (I-14).
    getReviews({ albumId, scope: "any" }, { sort: "recent", limit: REVIEW_PREVIEW }),
    countReviews({ albumId, scope: "any" }),
    /*
     * ONE SERVE PER PAGE, not one per slot. `AdSlot` renders whatever it is handed and nothing
     * when handed `undefined`; two slots serving independently would have no shared `placed`
     * set, so a one-row inventory would render the same card twice. The Pro exemption is
     * enforced at the point of fetch, so for a Pro member no candidate query runs at all.
     */
    serveAds({ viewerId, pageKey: AD_PAGE_KEY.album(albumId), placement: "sidebar", slotCount: 1 }),
    getMirroredAlbumCounts([artistId]),
    /*
     * THE VIEWER READS. Each is `null`/`0`/`[]` for a signed-out visitor rather than a branch
     * around the whole block: two of the four query modules guard the empty viewer themselves
     * and the other two cannot, so the conditional lives at the call rather than in the page's
     * shape.
     */
    viewer ? getViewerAlbumState(viewer.id, albumId) : null,
    isWanted(viewerId, albumId),
    getCrownedTracks(viewerId, albumId),
    viewer ? countHeld(viewer.id) : 0,
    viewer ? getListOptions(viewer.id, { artistId, albumId }) : [],
  ]);

  /* A SECOND ROUND: one query for every review on the page, and it needs their ids. */
  const likedIds = await getLikedLogIds(viewerId, reviews.map((entry) => entry.id));

  /*
   * "EVERY TRACK ON THIS RECORD IS ALREADY MARKED", which drives the bulk marker's resting
   * label. Measured against the tracks WE HOLD rather than `album.track_count`: a member who
   * played the remaster and then the original legitimately holds more logged positions than the
   * canonical edition has tracks, which is the same clamping problem `clampListened` exists for
   * — and `>=` rather than `===` is what keeps that from reading as unfinished.
   */
  const albumListened = tracks.length > 0 && (viewerState?.listenedTracks.size ?? 0) >= tracks.length;

  return (
    <div className="space-y-12">
      <AlbumHero
        album={album}
        /*
         * TWO NUMBERS, NEVER MERGED, and the provider column disappears entirely at zero votes
         * rather than showing a greyed "0.0" — which would imply a measured zero. Most of the
         * catalogue carries no MusicBrainz rating, so that collapse is the COMMON state.
         */
        consensus={
          <Consensus
            criticScore={album.criticScore}
            criticVotes={album.criticVotes}
            memberAverage={stats.average}
            memberCount={stats.ratingCount}
          />
        }
        actions={
          <AlbumActions
            albumId={albumId}
            albumTitle={album.title}
            artistName={album.artistName}
            artistId={artistId}
            canWrite={Boolean(viewer)}
            signInNext={albumHref}
            /* THE ROLLBACK TARGETS, all read server-side. */
            viewerRating={viewerState?.albumLog?.rating ?? null}
            liked={viewerState?.albumLog?.liked ?? false}
            wanted={wanted}
            albumListened={albumListened}
            trackCount={album.trackCount}
            albumCount={mirroredCounts.get(artistId) ?? 0}
            /* REQUIRED, and primed from the real row. See the module docblock. */
            logInitial={viewerState?.albumLog ?? NO_LOG}
            coverUrl={albumCover(album, 250)}
            listControl={
              /*
               * A SLOT, because the add-to-list dialog needs the member's own lists and a
               * client component cannot run `getListOptions` — so the page reads them and the
               * dialog never queries.
               */
              <AddToListDialog
                target={{ artistId, albumId }}
                targetLabel={album.title}
                options={listOptions}
                canWrite={Boolean(viewer)}
                signInNext={albumHref}
              />
            }
          />
        }
      />

      {/*
        Two columns from `lg`, main first in the DOM so a screen reader and a phone both get the
        record before the furniture. The sidebar is `lg:w-72` rather than a grid fraction: the
        listen links and the ad unit are fixed-width objects, and a fraction makes them stretch.
      */}
      <div className="flex flex-col gap-10 lg:flex-row lg:gap-12">
        <div className="min-w-0 flex-1 space-y-12">
          {/*
            THE STRIP IS THE ALBUM PAGE'S HEATMAP, and it takes a FIXED source. There is
            deliberately no source switch here: the artist page owns that control, and a second
            one with the same name and a narrower scope would read as a bug to anybody who set
            "Critics" on one page and found "Members" on the other.
          */}
          <TrackStrip
            strips={strips}
            albumHref={albumHref}
            albumTitle={album.title}
            discCount={album.discCount}
          />

          <section>
            <SectionHeading eyebrow={plural(album.trackCount, "track")} title="Tracklist" />
            {/*
              THE KEY LOOKUPS HAPPEN INSIDE `Tracklist`, which is a Server Component for exactly
              that reason: `trackKey` and `albumTrackKey` live in a `server-only` module, the two
              shapes are not interchangeable, and a mismatched lookup fails SILENTLY as an
              uncoloured cell. Passing the maps down keeps one copy of each key shape.
            */}
            <Tracklist
              tracks={tracks}
              albumId={albumId}
              albumHref={albumHref}
              discCount={album.discCount}
              albumArtistName={album.artistName}
              canWrite={Boolean(viewer)}
              trackLogs={viewerState?.trackLogs ?? null}
              listenedTracks={viewerState?.listenedTracks ?? null}
              replayCounts={viewerState?.replayCounts ?? null}
              crowned={crowned}
              desertIslandUsed={islandUsed}
              /* Passed, so no row hard-codes ten. Omitting it offers no crown at all. */
              desertIslandQuota={DESERT_ISLAND_QUOTA}
            />
          </section>

          {/* Nothing at all when MusicBrainz has no relations for the release — which is most
              of them. An empty rail is our mirror being thin, not a record nobody made. */}
          <CreditsRail credits={credits} />

          <section>
            <SectionHeading
              eyebrow={reviewCount === 0 ? "Reviews" : plural(reviewCount, "review")}
              title="What people wrote"
              action={
                reviewCount > REVIEW_PREVIEW ? (
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`${albumHref}/reviews`}>All reviews</Link>
                  </Button>
                ) : null
              }
            />
            {reviews.length === 0 ? (
              <EmptyState
                title="Nobody has written about this yet"
                description="Ratings are a number; a review is the reason. Log this record and say what you thought."
              />
            ) : (
              /* Two columns, because a review is prose: one column makes three of them a page
                 of scrolling, three makes the line length too short to read. */
              <ul className="grid gap-4 sm:grid-cols-2">
                {reviews.map((entry) => (
                  <li key={entry.id}>
                    <ReviewCard entry={entry} liked={likedIds.has(entry.id)} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="space-y-8 lg:w-72 lg:shrink-0">
          {/*
            THE DISTRIBUTION, FROM DATA ALREADY IN HAND. `getRatingStats` returns exactly ten
            buckets whatever the rating count, so this costs no extra query — and the consensus
            card deliberately shows only two numbers, so the shape of the disagreement has
            nowhere else to live. Hidden entirely at zero ratings: ten empty bars under a
            heading is a chart of nothing.
          */}
          {stats.ratingCount > 0 ? (
            <section className="card p-4">
              <Eyebrow>Distribution</Eyebrow>
              <p className="mt-1 font-mono text-[0.6875rem] tabular text-faint">
                {plural(stats.ratingCount, "member rating")} · one vote each
              </p>
              <Histogram buckets={stats.histogram} className="mt-3" />
            </section>
          ) : null}

          {/*
            LISTEN LINKS ARE SEARCHES, NOT DEEP LINKS, on every service but Deezer — and the
            mirror holds no Deezer permalink column, so even Deezer is a search here. The
            component labels which is which; this page does not have a better URL to give it.
          */}
          <ListenLinks artist={album.artistName} title={album.title} />

          {/*
            AN EMPTY SLOT RENDERS NOTHING — not a frame, not a placeholder, not a reserved
            height. `plan[0]` is `undefined` whenever the shelf was empty, which is the normal
            state of a house-ad system with a handful of rows in it.
          */}
          <AdSlot ad={ads[0]} />
        </aside>
      </div>
    </div>
  );
}

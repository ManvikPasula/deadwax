/**
 * /artist/[slug] — THE SIGNATURE VIEW.
 *
 * The discography heatmap is this product's thesis: one row per canonical release, one cell per
 * track, chronological by first-release date, ragged. It draws a CAREER ARC — the sophomore
 * slump as a row of oranges between two rows of greens, the late return to form as a blue cell
 * in the last row of a long catalogue — and it is the thing music has that film does not.
 *
 * ============================================================================
 * NO `loading.tsx` FOR THIS ROUTE, EVER (I-3)
 *
 * This function decides the response status. A `notFound()` raised after the shell has flushed
 * is sent as a 200, and a route-level `loading.tsx` flushes the shell immediately — so every
 * bad slug would become a 200 with not-found markup inside it.
 *
 * THE ORDER BELOW IS THE WHOLE INVARIANT: parse the slug, resolve the artist row, `notFound()`,
 * AND ONLY THEN open a Suspense boundary. The boundaries on this page are strictly after the
 * 404 decision, which is what makes them safe here — and nothing inside them can raise
 * `notFound()`, so nothing they do can decide a status after the shell has gone out as a 200.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------------------
 * TWO BOUNDARIES, BECAUSE THERE ARE TWO INDEPENDENT PROVIDER FILLS
 * ---------------------------------------------------------------------------------------
 *
 * `ensureDiscography` ALWAYS reaches Deezer (it has no TTL guard of its own — the freshness
 * decisions are per album, inside it) and then bulk-upserts summaries and fills up to eight
 * tracklists SEQUENTIALLY. `ensureArtistSimilar` is TTL-guarded but on a cold artist it stubs
 * up to twenty neighbour rows. Neither may sit on the critical path of a page whose hero,
 * consensus, completion meter and reviews are all plain indexed reads.
 *
 * They are two boundaries rather than one because they are two unrelated fills feeding two
 * sections in different places on the page. Folding them together was the rejected alternative:
 * it makes the neighbours rail wait on a thirty-album tracklist fill, and it forces the rail to
 * render directly under the grid rather than where it belongs.
 *
 * THE TRANSIENT ASYMMETRY THIS BUYS, STATED PLAINLY: on the FIRST view of a cold artist the
 * hero's release count is the mirror as it stood when the shell flushed, while the grid and the
 * list below it are the mirror after the fill — so the hero can under-report for one render.
 * The alternative is blocking the artist's name and portrait on a provider walk, which is
 * exactly what the boundary exists to prevent, and any subsequent view reconciles them. What is
 * NOT accepted is two numbers disagreeing inside one section, which is why the grid, the
 * dual-rating panel and the release list are all read from the same post-fill snapshot.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NotebookPen } from "lucide-react";
import { Suspense } from "react";

import { LogDialog, type LogDialogInitial } from "@/components/album/log-dialog";
import { AdSlot } from "@/components/ads/ad-slot";
import { ArtistActions } from "@/components/artist/artist-actions";
import { ArtistHero } from "@/components/artist/artist-hero";
import { DiscographyHeatmap } from "@/components/artist/discography-heatmap";
import { DiscographyList } from "@/components/artist/discography-list";
import { SimilarArtists } from "@/components/artist/similar-artists";
import { Consensus } from "@/components/rating/consensus";
import { DualRating } from "@/components/rating/dual-rating";
import { ReviewCard } from "@/components/social/review-card";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionHeading, Spinner } from "@/components/ui/primitives";
import { AD_PAGE_KEY, serveAds } from "@/lib/ads/serve";
import { currentUser } from "@/lib/auth/session";
import { albumTrackKey, getRatingStats } from "@/lib/db/queries/albums";
import {
  getArtistDiscography,
  getCompletion,
  getDiscographyHeatmap,
  getMirroredAlbumCounts,
  getSimilarArtists,
} from "@/lib/db/queries/artists";
import { countReviews, findExistingLog, getLikedLogIds, getReviews, type ReviewTarget } from "@/lib/db/queries/logs";
import type { Artist } from "@/lib/db/schema";
import { plural } from "@/lib/format";
import { ensureArtistById, ensureArtistSimilar, ensureDiscography } from "@/lib/ingest/albums";
import { dualRating } from "@/lib/ratings/dual";
import { artistSlug, parseArtistSlug } from "@/lib/slug";
import { countRatedAlbums } from "@/lib/taste/profile";
import { MIN_RATED_ALBUMS } from "@/lib/taste/shared";
import { forecastTracks } from "@/lib/taste/tracks";

/** Three reviews under the discography. The full list is its own paged route. */
const REVIEW_PREVIEW = 3;

/** How many placeholder rows the heatmap fallback draws. Six is a short career. */
const SKELETON_ROWS = 6;

/**
 * THE BLANKS ARE ONLY CORRECT WHEN THE READ RETURNED NOTHING. `LogDialog`'s `initial` is
 * required rather than optional so that forgetting the read is a compile error: a dialog primed
 * with blanks sends explicit nulls for the review, the diary date, the replay flag and the tags,
 * and a rating click then erases a written review (SEC-01 / I-1).
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
  const id = parseArtistSlug((await params).slug);
  if (id === null) return { title: "Artist not found" };

  // React-`cache()`d, so `generateMetadata` and the body share one resolution.
  const artist = await ensureArtistById(id);
  if (!artist) return { title: "Artist not found" };

  return {
    // A bare title: the root's `title.template` makes it "… · Deadwax".
    title: artist.name,
    description: `The discography of ${artist.name}, rated track by track by Deadwax members.`,
  };
}

export default async function ArtistPage({ params }: { params: Params }) {
  /* -- 1. THE 404 DECISION, AND NOTHING ELSE ------------------------------------------ */
  const { slug } = await params;
  const id = parseArtistSlug(slug);
  if (id === null) notFound();

  const artist = await ensureArtistById(id);
  if (!artist) notFound();

  /* -- 2. the fast reads. No provider call anywhere in this block. --------------------- */
  const viewer = await currentUser();
  const viewerId = viewer?.id ?? null;
  /*
   * RECOMPUTED, NOT REUSED FROM `params`: the URL grammar ignores everything before the trailing
   * id, so `/artist/anything-7` renders this page, and every link built from here should carry
   * the canonical text rather than whatever was typed.
   */
  const artistHref = `/artist/${artistSlug(artist.name, artist.id)}`;

  const reviewTarget: ReviewTarget = { artistId: artist.id, scope: "any" };

  const [stats, mirroredCounts, reviews, reviewCount, completion, artistLog, ads] = await Promise.all([
    getRatingStats({ type: "artist", artistId: artist.id }),
    /*
     * CANONICAL RELEASES IN OUR MIRROR, not `artists.album_count`. Both numbers are true and
     * they answer different questions: the column is Deezer's claim about its own catalogue and
     * counts releases we have never mirrored, while this one is the denominator the discography
     * and the completion figure both use. Quoting fourteen above a list of eleven is the kind of
     * small lie that makes a whole page untrustworthy.
     */
    getMirroredAlbumCounts([artist.id]),
    // THE SAME TARGET AND SCOPE AS THE COUNT (I-14). `any` rolls up albums AND tracks, which is
    // most of what anybody writes about an artist.
    getReviews(reviewTarget, { sort: "recent", limit: REVIEW_PREVIEW }),
    countReviews(reviewTarget),
    viewer ? getCompletion(viewer.id, artist.id) : null,
    // The real row the artist-level dialog is primed from, and the whole-work half of the dual
    // rating. One read serves both.
    viewer ? findExistingLog(viewer.id, { artistId: artist.id }) : null,
    /*
     * ONE SERVE PER PAGE, not one per slot. Two slots serving independently would have no
     * shared `placed` set, so a one-row inventory would render the same card twice. Keyed by
     * artist so the unit rotates as somebody walks a discography, and `sidebar` because this
     * lands in a narrow column beside the reviews rather than across the page.
     */
    serveAds({ viewerId, pageKey: AD_PAGE_KEY.artist(artist.id), placement: "sidebar", slotCount: 1 }),
  ]);

  /* A second round: one query for every review on the page, and it needs their ids. */
  const likedIds = await getLikedLogIds(viewerId, reviews.map((entry) => entry.id));

  const albumCount = mirroredCounts.get(artist.id) ?? 0;

  return (
    <div className="space-y-12">
      <ArtistHero
        artist={artist}
        albumCount={albumCount}
        /*
         * The numerator is already clamped to the denominator inside `getCompletion`, which
         * matters more in music than in television: a member who played the remaster and then
         * the original legitimately holds more logged positions than the canonical edition has
         * tracks, and "63 of 62" reads as a bug even when nothing is wrong.
         */
        completion={completion}
        /*
         * TWO NUMBERS, NEVER MERGED, and the provider column disappears at zero votes rather
         * than showing a greyed "0.0". Probing found artists carry REAL MusicBrainz ratings
         * (Radiohead: 4.5 over 80 votes), which is why this page shows an attributed baseline
         * rather than the mean of that artist's rated albums wearing an artist's label.
         */
        consensus={
          <Consensus
            criticScore={artist.criticScore}
            criticVotes={artist.criticVotes}
            memberAverage={stats.average}
            memberCount={stats.ratingCount}
          />
        }
        actions={
          <ArtistActions
            artistId={artist.id}
            artistName={artist.name}
            canWrite={Boolean(viewer)}
            signInNext={artistHref}
            /*
             * THE ROLLBACK TARGET for the bulk marker's optimistic state. `albums === 0` is
             * guarded: an artist with nothing mirrored is not "complete", and `0 >= 0` would
             * say otherwise.
             */
            discographyComplete={Boolean(
              completion && completion.albums > 0 && completion.albumsComplete >= completion.albums,
            )}
            albumCount={albumCount}
            rateControl={
              viewer ? (
                <LogDialog
                  /* `{ artistId }` alone — the server derives `target_type` from which fields
                     are present, because a caller who could set it could write a row that every
                     aggregate counts twice. */
                  target={{ artistId: artist.id }}
                  /* REQUIRED, and primed from the real row. */
                  initial={artistLog ?? NO_LOG}
                  title={artist.name}
                  /*
                   * NO `code` AND NO `coverUrl`, both deliberately. An artist has no ordinal and
                   * no container, so the mono code line is absent rather than padded with the
                   * word "Artist" — and the dialog's thumbnail is `.sleeve`, which is the RECORD
                   * geometry: a round portrait squared off into a sleeve reads as a release.
                   */
                  subtitle={artist.country}
                >
                  <Button variant={artistLog?.rating ? "secondary" : "primary"}>
                    <NotebookPen />
                    {artistLog?.rating ? "Edit your verdict" : "Rate the artist"}
                  </Button>
                </LogDialog>
              ) : null
            }
          />
        }
      />

      {/*
        BOUNDARY 1 — the discography fill, and everything derived from it.

        The grid, the dual-rating panel and the release list are all read from ONE post-fill
        snapshot, so no two of them can disagree about how many releases exist. See the module
        docblock for the one number that can lag (the hero's) and why that trade is the right way
        round.
      */}
      <Suspense fallback={<DiscographySkeleton />}>
        <DiscographySection artist={artist} viewerId={viewerId} artistRating={artistLog?.rating ?? null} />
      </Suspense>

      {/* BOUNDARY 2 — the neighbour graph's own fill. */}
      <Suspense fallback={null}>
        <NeighboursSection artist={artist} />
      </Suspense>

      {/*
        AFTER BOTH PROVIDER BOUNDARIES AND BEFORE THE REVIEWS — a gap between two sections
        rather than a card inside one. `AdSlot` renders nothing when the plan is empty or the
        member is on Pro, so this line costs nothing on a deployment with no inventory.
      */}
      <AdSlot ad={ads[0]} className="mx-auto w-full max-w-md" />

      <section className="mx-auto w-full max-w-3xl">
        <SectionHeading
          eyebrow={reviewCount === 0 ? "Reviews" : plural(reviewCount, "review")}
          title="Writing about this artist"
          action={
            reviewCount > REVIEW_PREVIEW ? (
              <Button asChild variant="ghost" size="sm">
                <Link href={`${artistHref}/reviews`}>All reviews</Link>
              </Button>
            ) : null
          }
        />
        {reviews.length === 0 ? (
          <EmptyState
            title="Nobody has written about this artist yet"
            description="Reviews of their records and of individual tracks both land here, not only verdicts on the artist as a whole."
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

/* -------------------------------------------------------------------------- */
/* BOUNDARY 1 — the discography                                               */
/* -------------------------------------------------------------------------- */

/**
 * The streamed half: the provider fill, then the grid, the dual rating and the release list.
 *
 * `ensureDiscography` is the slow thing on this page — one `GET /artist/{id}/albums`, a bulk
 * summary upsert, and then up to eight tracklist fills AWAITED SEQUENTIALLY (parallel would fire
 * thirty requests at a platform-wide budget every other member is also drawing on). It is
 * awaited FIRST so everything below reads a mirror that already holds whatever this view added.
 *
 * NOTHING IN HERE CAN RAISE `notFound()`, which is what makes the boundary legal (I-3): the
 * artist row was resolved and the 404 decided before this component was ever created.
 */
async function DiscographySection({
  artist,
  viewerId,
  /**
   * THE VIEWER'S ARTIST-LEVEL RATING, PASSED DOWN RATHER THAN RE-READ.
   *
   * The page body already loaded it (`findExistingLog(viewer.id, { artistId })`) to prime the
   * log dialog, so reading it again inside this boundary would be a second query for a value
   * that is already in scope — and worse, a second query that could disagree with the one the
   * dialog was primed from if a write landed between them. One read, two consumers.
   */
  artistRating,
}: {
  artist: Artist;
  viewerId: number | null;
  artistRating: number | null;
}) {
  await ensureDiscography(artist);

  const [rows, discography] = await Promise.all([
    /*
     * FOUR QUERIES WHATEVER THE SIZE OF THE CATALOGUE: albums, tracks, community aggregates,
     * viewer overlay. Rows arrive canonical-only, chronological by
     * `original_release_date ?? release_date`, cells ordered by `(disc, track)`, and ragged.
     * Nothing here re-sorts or re-filters.
     */
    getDiscographyHeatmap(artist.id, viewerId),
    /*
     * `includeNonCanonical: true` — the LIST shows reissues, deluxe editions and compilations
     * and marks them, because they are reachable by direct navigation from a search result or
     * somebody's diary, and a page that hid them would disagree with the rest of the app. The
     * GRID above excludes them, which is why the badge in the list is the sentence that
     * reconciles the two counts.
     */
    getArtistDiscography(artist.id, { viewerId, includeNonCanonical: true }),
  ]);

  const predictions = await forecastPredictions(viewerId, rows, discography);

  /*
   * THE ARTIST-SCOPE DUAL RATING: their verdict on the body of work, beside the mean of the
   * albums they rated.
   *
   * THE PARTS ARE CANONICAL RELEASES ONLY, matching the completion figure and the grid — the
   * same denominator everywhere on this page. A rating given to a deluxe reissue is a real
   * rating, but counting it here would make the "derived from N albums" figure disagree with
   * every other N on the page.
   *
   * It is VIEWER-PRIVATE, which is why it carries no vote count and no attribution: there is
   * only one person in it. `dualRating` takes an iterable, so the ratings go in as a plain map.
   */
  const dual = dualRating(
    // The whole-work rating comes from the artist-level log the page body already read. It is
    // NOT derivable from `discography`, which holds album rows only — an earlier version tried
    // to find it in there and silently resolved to null on every request, so the panel showed
    // the parts average and never the member's own verdict beside it.
    artistRating,
    discography.filter((album) => album.isCanonical).map((album) => album.viewerRating),
  );

  return (
    <div className="space-y-12">
      <section>
        <SectionHeading
          eyebrow="The shape of a career"
          title="Discography"
          action={
            <Button asChild variant="ghost" size="sm">
              <Link href={`/artist/${artistSlug(artist.name, artist.id)}/albums`}>All releases</Link>
            </Button>
          }
        />
        {/*
          A CLIENT COMPONENT, and the four colour sources are switched rather than blended — a
          green cell is either the community's verdict, or MusicBrainz's, or the viewer's own, or
          the model's guess, and the switch says which. The payload arrives FULLY COMPUTED, so
          the only work in the browser is `ratingColor()`, a pure bracket lookup and an sRGB
          lerp.

          An EMPTY `predictions` map is the server's decision and cannot be talked into
          enabling itself: the "Predicted" button renders disabled with its own reason.
        */}
        <DiscographyHeatmap rows={rows} predictions={predictions} artistName={artist.name} />
      </section>

      {/* Nothing at all when there is neither a verdict nor a rated album — a panel holding two
          em dashes is noise on a page that already says the member has not rated anything. */}
      <DualRatingPanelSlot dual={dual} />

      <section>
        <SectionHeading as="h2" eyebrow={plural(discography.length, "release")} title="Every release" />
        <DiscographyList albums={discography} as="h3" />
      </section>
    </div>
  );
}

/**
 * The prediction map for the heatmap's fourth colour source, keyed by `albumTrackKey`.
 *
 * ---------------------------------------------------------------------------------------
 * THE GATE IS READ ONCE, NOT ONCE PER ALBUM
 * ---------------------------------------------------------------------------------------
 *
 * `forecastForViewer` is `forecastTracks` behind `countRatedAlbums(userId) >= MIN_RATED_ALBUMS`,
 * and it forecasts ONE album per call. Calling it per row is therefore one `COUNT(DISTINCT
 * album_id)` per album — thirty counts to draw one grid, all of them answering the same
 * question about the same member. So the gate is evaluated here, once, and the PURE half is
 * applied per album. The floor and the reason it exists are unchanged: *an unlabelled
 * fabrication is worse than an absent feature*, and below eight rated albums every prediction
 * would be the album baseline repeated twelve times wearing a per-track label.
 *
 * THE BASELINE PER ALBUM IS THE VIEWER'S OWN ALBUM RATING IF THEY GAVE ONE, ELSE THE COMMUNITY
 * AVERAGE. `forecastTracks` deliberately refuses to choose between those two, because the
 * choice is a product decision about whose opinion anchors a row rather than an arithmetic one.
 *
 * ONLY GENUINE ESTIMATES ARE STORED. A real rating comes back with `predicted: false`, and the
 * heatmap already resolves `cell.viewerRating ?? predicted` — so keeping the real ones here
 * would be a second copy of a number the cell already has, and would make `predictions.size`
 * non-zero for a member whose ratings alone unlocked nothing.
 */
async function forecastPredictions(
  viewerId: number | null,
  rows: Awaited<ReturnType<typeof getDiscographyHeatmap>>,
  discography: Awaited<ReturnType<typeof getArtistDiscography>>,
): Promise<Map<string, number> | null> {
  if (viewerId === null || rows.length === 0) return null;

  const rated = await countRatedAlbums(viewerId);
  if (rated < MIN_RATED_ALBUMS) return null; // the server's gate, and the only one

  const baselines = new Map(discography.map((album) => [album.id, album.viewerRating ?? album.memberAverage]));

  const predictions = new Map<string, number>();
  for (const row of rows) {
    const forecast = forecastTracks(
      row.cells.map((cell) => ({
        disc: cell.disc,
        track: cell.track,
        criticScore: cell.criticScore,
        viewerRating: cell.viewerRating,
      })),
      baselines.get(row.albumId) ?? null,
    );
    // NULL MEANS NO ANCHOR AT ALL — no rated tracks on the record and no album baseline — so the
    // row contributes nothing rather than a column of the same fabricated number.
    if (!forecast) continue;
    for (const entry of forecast) {
      if (!entry.predicted) continue;
      predictions.set(albumTrackKey(row.albumId, entry.disc, entry.track), entry.rating);
    }
  }
  return predictions;
}

/**
 * The dual-rating panel, with its own "is there anything to compare" gate kept out of the
 * section body so the JSX above reads as a list of sections.
 */
function DualRatingPanelSlot({ dual }: { dual: ReturnType<typeof dualRating> }) {
  if (dual.wholeRating === null && dual.partAverage === null) return null;
  return (
    <section className="max-w-xl">
      {/* `scope="artist"` — the career statement against the mean of their rated albums. The
          default is `album`, because an album is the primary work. */}
      <DualRating dual={dual} scope="artist" />
    </section>
  );
}

/**
 * The fallback for boundary 1.
 *
 * NO SHIMMER AND NO PULSE, AND THAT IS NOT A SHORTCUT. globals.css's blanket reduced-motion
 * block sets `animation-duration: 0.001ms !important` on everything, so a pulsing skeleton is a
 * STILL GREY BOX for anybody who asked for reduced motion — and a grid of still grey boxes with
 * no text says "broken", not "working". `Spinner` carries the `sr-only` label that says it.
 *
 * The rows are the heatmap's own geometry — a 10rem title gutter and 20px cells at 4px gaps —
 * so the page does not jump when the real grid replaces them.
 */
function DiscographySkeleton() {
  return (
    <section aria-busy="true">
      <SectionHeading
        eyebrow="The shape of a career"
        title="Drawing the discography"
        action={<Spinner label="Mirroring this artist's releases" />}
      />
      <div aria-hidden="true" className="space-y-1">
        {Array.from({ length: SKELETON_ROWS }, (_, row) => (
          <div key={row} className="flex items-center gap-2">
            <div className="h-3 w-40 shrink-0 rounded-sm bg-surface-2" />
            <div className="flex items-center gap-1">
              {/* Ragged on purpose, like the real rows: a uniform block would promise a
                  uniformity that no discography has. */}
              {Array.from({ length: 6 + ((row * 3) % 7) }, (_, cell) => (
                <div key={cell} className="size-4 shrink-0 rounded-sm bg-surface-2 sm:size-5" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* BOUNDARY 2 — the neighbour graph                                           */
/* -------------------------------------------------------------------------- */

/**
 * "Listeners also play" — `artist_similar`, filled here and read here.
 *
 * THIS IS THE ONLY CALLER OF `ensureArtistSimilar` IN THE APPLICATION, and the table it fills is
 * the largest single term in the recommender: without the neighbour bonus every candidate inside
 * a genre pool lands within a few hundredths of every other and the ranking collapses to
 * Deezer's own popularity order. /for-you reads the table and deliberately never fills it,
 * because fanning out over a member's top artists on every render would dominate the outbound
 * budget. So the artist page is where the graph is paid for, once per TTL, by the person looking
 * at that artist.
 *
 * THE FALLBACK IS `null`, not a skeleton. `SimilarArtists` already renders nothing for an empty
 * graph — *an unfilled neighbour graph is our cache being cold, not a statement about the
 * artist, and "no similar artists" is a claim we cannot support about anybody* — so a skeleton
 * here would reserve space for a section that may correctly never appear.
 */
async function NeighboursSection({ artist }: { artist: Artist }) {
  /*
   * TTL-GUARDED INSIDE, so a warm artist costs one indexed lookup and no provider call. The
   * boundary is for the cold case: one `GET /artist/{id}/related` plus up to twenty stub
   * upserts, awaited one at a time.
   */
  await ensureArtistSimilar(artist);

  const neighbours = await getSimilarArtists(artist.id, 12);
  if (neighbours.length === 0) return null;

  /*
   * The caption count comes from the mirror, never from `artists.album_count`: the caption sits
   * on a LINK, and linking to a discography of eleven rows under a label reading fourteen is the
   * small lie that makes a page untrustworthy.
   */
  const albumCounts = await getMirroredAlbumCounts(neighbours.map((row) => row.id));

  /* ORDERED BY `artist_similar.position` — Deezer's own relatedness order, and nothing here
     re-sorts it: sorting by fans turns a similarity list into a popularity list and every
     artist's neighbours become the same five household names. */
  return <SimilarArtists artists={neighbours} artistName={artist.name} albumCounts={albumCounts} />;
}

/**
 * The home page's non-personal rails: what the community has rated, what the catalogue holds,
 * what is new, who to follow, four genre rails, and the most recent writing.
 *
 * AN ASYNC SERVER COMPONENT. It reads its own rows — the same trade `SiteHeader` and
 * `GenreRail` make — because this is the composition of one surface rather than a reusable
 * shape: every one of these reads exists only to fill this page, and threading six results
 * through `app/page.tsx` as props would put the page's data layer in a file whose job is the
 * layout.
 *
 * ---------------------------------------------------------------------------------------
 * READ-ONLY, AND NO PROVIDER CALL. THIS IS THE FRONT DOOR.
 * ---------------------------------------------------------------------------------------
 *
 * The obvious build is `chartAlbums()` + `cacheAlbumSummaries()` — a real Deezer chart, freshly
 * mirrored, on every visit. It is rejected, and the reason is specific to this page rather than
 * a general preference:
 *
 *   - `/` is the ONLY route with a segment config, and it is `revalidate = 0`. Every anonymous
 *     visitor renders this component from scratch.
 *   - `cacheAlbumSummaries` is a bulk upsert, and PGlite allows EXACTLY ONE WRITER. A burst of
 *     traffic on the landing page would serialise behind a write nobody asked for.
 *   - the outbound budget is shared with /search, /albums and /for-you, which are the surfaces
 *     where a provider call is a member's own request rather than an ambient one.
 *
 * So everything here is a read of the mirror, and the mirror is filled by the paths where
 * somebody asked for a record: /search, /albums, /album/[slug], /for-you.
 *
 * ---------------------------------------------------------------------------------------
 * TWO ROUNDS OF QUERIES, NOT SEVEN
 * ---------------------------------------------------------------------------------------
 *
 * Round one is five reads in one `Promise.all`. Round two is two more, and it exists because
 * both of them need ids from round one — the viewer's own stars for the album ids on the page,
 * and the viewer's hearts for the review ids. Both are BATCHED (one query for every card, not
 * one per card): the N+1 rule this codebase states five different ways.
 *
 * ---------------------------------------------------------------------------------------
 * NOTHING ON THIS PAGE CALLS POPULARITY A RATING
 * ---------------------------------------------------------------------------------------
 *
 * `albums.popularity` is a 0..100 normalisation of Deezer `rank`; `albums.fans` and
 * `artists.fans` are follower counts. Two rails and one artist strip are ordered by them, and
 * all three say so in their eyebrow. `browseAlbums`/`browseArtists` return no member
 * aggregates, so `CoverCard`'s average slot renders nothing there — the slot is reserved for
 * Deadwax's own ratings, which is why the community rail (`getMostRatedAlbums`) is the only one
 * showing a star figure.
 */

import Link from "next/link";
import { UserRound } from "lucide-react";

import { CoverCard, type CoverCardAlbum } from "@/components/album/cover-card";
import { CoverRail } from "@/components/album/cover-rail";
import { GenreRail } from "@/components/discovery/genre-rail";
import { queryHref } from "@/components/discovery/sort-select";
import { ReviewCard } from "@/components/social/review-card";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionHeading } from "@/components/ui/primitives";
import {
  browseAlbums,
  getMostRatedAlbums,
  getViewerAlbumOverlay,
  type AlbumRow,
} from "@/lib/db/queries/albums";
import { browseArtists } from "@/lib/db/queries/artists";
import { getLikedLogIds, getRecentReviews } from "@/lib/db/queries/logs";
import { localCalendarDate, plural } from "@/lib/format";
import { cardFromAlbumRow, cardFromArtistRow } from "@/lib/view";
import { cn } from "@/lib/utils";

/** One rail's worth of covers, and the same number every rail uses. */
const RAIL_SIZE = 12;

/**
 * Four reviews, not twelve. A review is a paragraph: four fill the width at two columns and
 * still read as "what people are writing" rather than as a feed the page has to be scrolled
 * past. The real feed is the signed-in home's following feed.
 */
const REVIEW_COUNT = 4;

export type HomeRailsProps = {
  /**
   * The viewer, or null when signed out.
   *
   * IT ONLY OVERLAYS, IT NEVER FILTERS. Their own star and play count land on the cards, and
   * nothing is hidden because they have already rated it — hiding would quietly turn a
   * community rail into a recommender, which is what `PersonalRails` and /for-you are, with a
   * model behind them and a stated reason per row.
   */
  viewerId?: number | null;
  className?: string;
};

export async function HomeRails({ viewerId = null, className }: HomeRailsProps) {
  const [community, popular, fresh, artists, reviews] = await Promise.all([
    getMostRatedAlbums(viewerId, RAIL_SIZE),
    browseAlbums({ sort: "popular", perPage: RAIL_SIZE }),
    // DOUBLE THE WINDOW, because the future-dated filter below throws rows away and a rail
    // that renders seven covers out of twelve looks like the query failed.
    browseAlbums({ sort: "new", perPage: RAIL_SIZE * 2 }),
    browseArtists({ sort: "popular", perPage: RAIL_SIZE }),
    getRecentReviews(REVIEW_COUNT),
  ]);

  /*
   * ONE DATE FOR THE WHOLE SECTION, and the predicate is wrapped rather than passed to
   * `filter` directly: `Array.prototype.filter` hands its callback `(value, index, array)`, so
   * `filter(isReleased)` would pass the INDEX as the second argument and compare a date string
   * against 0 — a silent, always-false comparison that empties the rail.
   */
  const today = localCalendarDate();
  const newReleases = fresh.rows.filter((row) => isReleased(row, today)).slice(0, RAIL_SIZE);

  const [overlay, likedIds] = await Promise.all([
    getViewerAlbumOverlay(viewerId, [...popular.rows, ...newReleases].map((row) => row.id)),
    getLikedLogIds(viewerId, reviews.map((entry) => entry.id)),
  ]);

  const withViewer = (row: AlbumRow): CoverCardAlbum => {
    const own = overlay.get(row.id);
    return {
      ...cardFromAlbumRow(row),
      viewerRating: own?.rating ?? null,
      // `plays` is album-level logs by this member, which is what the teal `×N` badge means:
      // nobody is 40% of the way through a 42-minute record, so the replay count is the
      // progress figure a music card has.
      replayCount: own?.plays ?? 0,
    };
  };

  /*
   * A COLD MIRROR IS A STATEMENT ABOUT OUR CACHE, NOT ABOUT MUSIC. Every rail can be legitimately
   * empty on a fresh instance, and five empty headings would read as a broken page, so the whole
   * section collapses into one honest sentence with the one action that fills the mirror.
   */
  const anything =
    community.length > 0 ||
    popular.rows.length > 0 ||
    newReleases.length > 0 ||
    artists.rows.length > 0 ||
    reviews.length > 0;

  if (!anything) {
    return (
      <EmptyState
        className={className}
        title="The catalogue is still filling"
        description="Nothing has been mirrored into this instance yet. Searching for a record pulls it in, along with its tracklist and its artist."
        action={
          <Button asChild variant="primary">
            <Link href="/search">Search for a record</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className={cn("space-y-14", className)}>
      {community.length > 0 ? (
        <section>
          <SectionHeading
            eyebrow="The community"
            title="Most rated on Deadwax"
            // No "see all": there is no route that lists this ordering, and a link to
            // /albums?sort=popular would silently substitute Deezer's popularity for the
            // members' own attention, which is the one substitution this product refuses.
          />
          {/*
            Cards go in UNSIZED: `CoverRail` owns `[&>*]:w-[132px] sm:[&>*]:w-[152px]` and
            `[&>*]:shrink-0`, so a caller never sizes a rail child and twelve rails cannot
            drift into twelve widths.

            THIS IS THE ONLY RAIL ON THE PAGE THAT SHOWS A STAR FIGURE, because it is the only
            one carrying `memberAverage`/`memberCount` — real Deadwax ratings, one vote per
            member, guests excluded (I-12).
          */}
          <CoverRail>
            {community.map((row) => (
              <CoverCard key={row.id} album={cardFromAlbumRow(row)} />
            ))}
          </CoverRail>
        </section>
      ) : null}

      {popular.rows.length > 0 ? (
        <section>
          <SectionHeading
            eyebrow="Deezer popularity"
            title="Popular records"
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href={queryHref("/albums", { sort: "popular" })}>Browse all</Link>
              </Button>
            }
          />
          <CoverRail>
            {popular.rows.map((row) => (
              <CoverCard key={row.id} album={withViewer(row)} />
            ))}
          </CoverRail>
        </section>
      ) : null}

      {newReleases.length > 0 ? (
        <section>
          <SectionHeading
            eyebrow="New"
            // "Recently released", not "New releases": the ordering is by FIRST-release date
            // over whatever has been mirrored, so this is the newest music we hold rather than
            // a release calendar.
            title="Recently released"
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href={queryHref("/albums", { sort: "new" })}>Browse all</Link>
              </Button>
            }
          />
          <CoverRail>
            {newReleases.map((row) => (
              <CoverCard key={row.id} album={withViewer(row)} />
            ))}
          </CoverRail>
        </section>
      ) : null}

      {artists.rows.length > 0 ? (
        <section>
          <SectionHeading
            eyebrow="Deezer fans"
            title="Most followed artists"
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href={queryHref("/artists", { sort: "popular" })}>All artists</Link>
              </Button>
            }
          />
          {/*
            ROUND PORTRAITS IN THEIR OWN STRIP, NOT `CoverRail`. `CoverRail` is the record rail
            — it carries `.sleeve`'s 1:1 geometry and its hover lift, which together mean "a
            release lives here". The reasoning is components/artist/similar-artists.tsx's, and
            so is the markup: a hidden scrollbar (a bar under one row of portraits reads as an
            accident) and `py-2` to leave room for the lift, without which the scroll container
            gains a vertical bar the moment a portrait is hovered.
          */}
          <ul className="flex gap-4 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {artists.rows.map((row) => {
              const card = cardFromArtistRow(row, 250);
              return (
                <li key={row.id} className="w-[104px] shrink-0 sm:w-[120px]">
                  <Link href={card.href} className="group block text-center">
                    <div
                      className={cn(
                        "relative mx-auto size-[88px] overflow-hidden rounded-full bg-surface-2 sm:size-[104px]",
                        "ring-1 ring-line transition-[transform,box-shadow] duration-150 ease-out-quick",
                        "group-hover:-translate-y-0.5 group-hover:ring-amber",
                      )}
                    >
                      {card.pictureUrl ? (
                        // Empty alt: the name below is inside the same link and is already its
                        // accessible name.
                        <img
                          src={card.pictureUrl}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="size-full object-cover object-top"
                        />
                      ) : (
                        <span className="flex size-full items-center justify-center text-faint" aria-hidden="true">
                          <UserRound className="size-8" />
                        </span>
                      )}
                    </div>
                    <p className="mt-2 truncate text-[0.8125rem] leading-tight text-paper group-hover:text-amber">
                      {row.name}
                    </p>
                    {/*
                      `getMirroredAlbumCounts` is the honest number under a LINK, and it is
                      deliberately not fetched here: this caption would need a seventh query to
                      improve a one-line count, so the count is dropped entirely rather than
                      printed from `artists.album_count` — Deezer's claim about its own
                      catalogue, which counts releases we have never mirrored. Linking to a
                      discography of eleven rows under a label reading fourteen is the small lie
                      that makes a page untrustworthy.
                    */}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/*
        The genre rails read the mirror themselves, four parallel selects, and default to
        Alternative / Jazz / Electro / Metal — DELIBERATELY not the most popular genres, because
        Pop and Rap/Hip Hop would fill this page with the records the two rails above already
        showed.
      */}
      <GenreRail />

      {reviews.length > 0 ? (
        <section>
          <SectionHeading eyebrow={plural(reviews.length, "review")} title="Recent writing" />
          {/*
            Two columns, because a review is prose: at one column four of them is a page of
            scrolling, and at three the column is too narrow for a paragraph to hold a line
            length worth reading.
          */}
          <ul className="grid gap-4 sm:grid-cols-2">
            {reviews.map((entry) => (
              <li key={entry.id}>
                <ReviewCard entry={entry} liked={likedIds.has(entry.id)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Drops future-dated rows from the "recently released" rail.
 *
 * `sort: "new"` orders by `coalesce(original_release_date, release_date) DESC NULLS LAST`, so a
 * record Deezer has dated next month sits at the TOP of the rail — the one position where a
 * not-yet-released album is guaranteed to be read as "out now".
 *
 * AN UNDATED ROW IS KEPT. Null is "we do not know", not "the future", and NULLS LAST already
 * puts those at the end of the window.
 *
 * The string comparison also disposes of I-4: Postgres accepts `'infinity'` as a date, and
 * `'infinity' <= '2026-09-14'` is false because "i" sorts after "2", so a poisoned row is
 * excluded by the same expression rather than needing its own guard.
 *
 * `today` IS REQUIRED, WITH NO DEFAULT, so this can never be handed straight to `filter` —
 * which would pass the array index in its place.
 */
function isReleased(row: AlbumRow, today: string): boolean {
  const date = row.originalReleaseDate ?? row.releaseDate;
  if (!date) return true;
  return date.slice(0, 10) <= today;
}

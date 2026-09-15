/**
 * `/@name` — the profile.
 *
 * TEN READS IN ONE `Promise.all`, THEN ONE DEPENDENT READ.
 *
 * None of the ten needs another's output, so the wall-clock cost of this page is its slowest
 * single query rather than the sum of ten. The eleventh — `getLikedLogIds` — is a genuine data
 * dependency: it is keyed by the ids of the activity rows, which do not exist until the feed
 * read has returned. That is N+1 pattern 5, and it is the one place a `Promise.all` is broken
 * on purpose rather than by oversight.
 *
 * `getProfileStats` IS THE TWELFTH CALL AND COSTS NOTHING. The layout above already asked for
 * it and it is wrapped in React `cache()`, so the four-CTE aggregate runs once per request no
 * matter how many components ask. Calling it here rather than plumbing the value down from the
 * layout is the intended use of that wrapper — see its docblock, where running twice per
 * profile view is recorded as a defect in the source.
 *
 * SECTION ORDER IS A READING ORDER, NOT A LAYOUT ONE:
 *
 *   1. the guest save prompt   — only on your own guest profile, because it is about this page
 *   2. Top Four                — what they chose to say about themselves
 *   3. Desert Island           — the honour
 *   4. three rankings          — what they like
 *   5. stat tiles              — how much they have done
 *   6. genres + replay leaders — the shape of it
 *   7. continue discographies  — what to do next
 *   8. recent activity         — what they did last
 *   9. lists                   — what they made
 *
 * Every panel between 2 and 9 renders nothing at all when it is empty (each component decides
 * that for itself, and several of them have the argument written out: a new member must not be
 * told three times that they are new). So a profile with one rating is short rather than a
 * column of apologies.
 */

import type { Metadata } from "next";
import { Disc3, Library } from "lucide-react";
import Link from "next/link";

import { loadProfile } from "@/app/[username]/layout";
import { CoverRail } from "@/components/album/cover-rail";
import { ListCard } from "@/components/list/list-card";
import { DesertIslandStrip } from "@/components/profile/desert-island-strip";
import { GenreBreakdown } from "@/components/profile/genre-breakdown";
import { ReplayLeaders } from "@/components/profile/replay-leaders";
import { StatTiles } from "@/components/profile/stat-tiles";
import { TopFour } from "@/components/profile/top-four";
import { TopRated } from "@/components/profile/top-rated";
import { AdSlot } from "@/components/ads/ad-slot";
import { ActivityFeed } from "@/components/social/activity-feed";
import { Button } from "@/components/ui/button";
import { EmptyState, Eyebrow, Meter, SectionHeading } from "@/components/ui/primitives";
import { AD_PAGE_KEY, serveAds } from "@/lib/ads/serve";
import { currentUser } from "@/lib/auth/session";
import { getTopAlbums, getTopArtists, getTopTracks } from "@/lib/db/queries/albums";
import { getUserLists } from "@/lib/db/queries/lists";
import { getLikedLogIds, getRecentLogs } from "@/lib/db/queries/logs";
import { getDesertIsland, getFavorites } from "@/lib/db/queries/users";
import { plural } from "@/lib/format";
import { artistPicture } from "@/lib/providers/images";
import { meterPercent } from "@/lib/ratings";
import {
  getContinueDiscographies,
  getGenreBreakdown,
  getProfileStats,
  getReplayLeaders,
  REPLAY_LEADER_MIN_PLAYS,
} from "@/lib/stats/profile";
import { artistSlug } from "@/lib/slug";

/** A rail's worth, and the same twelve every other rail in the product uses. */
const RANKING_SIZE = 12;
/** Six leaders per column, which is `getReplayLeaders`' own default. */
const REPLAY_SIZE = 6;
/** Eight genres and eight discographies — enough to show a shape, short enough to read. */
const PANEL_SIZE = 8;
/** The activity preview. The diary tab is where the whole thing lives. */
const ACTIVITY_SIZE = 12;
/** Four list cards, then a link to the tab. */
const LIST_PREVIEW = 4;
/** 48px rendered; 250 is the next CDN rung, so the tile is sharp at 2x. */
const ARTIST_THUMB_WIDTH = 250;

type PageProps = { params: Promise<{ username: string }> };

/**
 * THE SECOND ENTRY POINT INTO THIS ROUTE, and it resolves the member independently.
 *
 * Nothing on a profile is private, so there is no privacy rule to duplicate here — but the
 * 404 still is, because a `generateMetadata` that resolved nothing would render
 * "undefined · Deadwax" for every bad handle. See app/[username]/wantlist/page.tsx for the
 * case where this pairing is carrying a security rule rather than a title.
 */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { username } = await params;
  const member = await loadProfile(username);
  const name = member.displayName ?? member.username;

  return {
    title: `${name} (@${member.username})`,
    description:
      member.bio ??
      `${name}'s records on Deadwax — ratings, reviews, a listening diary and a Desert Island shelf.`,
  };
}

export default async function ProfilePage({ params }: PageProps) {
  const { username } = await params;
  const [member, viewer] = await Promise.all([loadProfile(username), currentUser()]);

  const isOwner = viewer?.id === member.id;
  const name = member.displayName ?? member.username;

  const [
    stats,
    favorites,
    desertIsland,
    topArtists,
    topAlbums,
    topTracks,
    genres,
    replayLeaders,
    discographies,
    activity,
    lists,
    ads,
  ] = await Promise.all([
    // Cached. See the module docblock: the layout has already paid for this one.
    getProfileStats(member.id),
    getFavorites(member.id),
    getDesertIsland(member.id),
    getTopArtists(member.id, RANKING_SIZE),
    getTopAlbums(member.id, RANKING_SIZE),
    getTopTracks(member.id, RANKING_SIZE),
    getGenreBreakdown(member.id, PANEL_SIZE),
    getReplayLeaders(member.id, REPLAY_SIZE),
    getContinueDiscographies(member.id, PANEL_SIZE),
    getRecentLogs(member.id, ACTIVITY_SIZE),
    /*
     * `viewer?.id` IS THE ENTIRE PRIVACY SWITCH for lists, and it is applied inside the query
     * rather than filtered afterwards — one comparison against the session id decides whether
     * private lists are in the result at all, so there is no second place for the rule to
     * disagree with itself.
     */
    getUserLists(member.id, viewer?.id),
    /*
     * KEYED BY THE USERNAME BEING VIEWED, not by the viewer.
     *
     * The viewer is already in the seed (`pageSeed` composes viewer + page + hour), so keying on
     * the profile's owner is what makes walking five profiles show five different units instead
     * of the same one five times. `AD_PAGE_KEY.member` exists for exactly this surface.
     *
     * ONE SLOT, AT THE BOTTOM. A profile is somebody's own page, and the reasonable maximum
     * there is one unit after everything they wrote — not two, and not above their diary.
     */
    serveAds({
      viewerId: viewer?.id ?? null,
      pageKey: AD_PAGE_KEY.member(member.username),
      placement: "feed",
      slotCount: 1,
    }),
  ]);

  /*
   * THE DEPENDENT READ. One query for the whole feed rather than one per row, and it needs the
   * ids, so it cannot join the batch above.
   */
  const likedIds = await getLikedLogIds(viewer?.id, activity.map((entry) => entry.id));

  return (
    <div className="space-y-12">
      {/*
        THE GUEST SAVE PROMPT — ON YOUR OWN GUEST PROFILE ONLY.
        `GuestStrip` in the root layout already carries the global nudge, and it deliberately
        stays quiet until twelve distinct albums ("a banner people learn to ignore is worse
        than no banner"). This one is not a second nudge on a timer: it is the sentence that
        belongs on THIS page, because a profile is the thing that would be lost, and it is
        shown from the first visit for the same reason the leaving warning arms from the first
        entry. A visitor never sees it — somebody else's unfinished account is not information.
      */}
      {isOwner && member.isGuest ? (
        <section className="card border-amber/40 p-5">
          <Eyebrow>Guest session</Eyebrow>
          <h2 className="mt-2 font-display text-2xl leading-tight text-paper text-balance">
            This profile is not saved yet.
          </h2>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
            Everything here lives in one browser session. Creating an account keeps this exact
            profile — the same diary, the same ratings, the same Desert Island — because the
            account is written onto the row you are already using rather than copied into a new
            one.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button asChild variant="primary">
              <Link href="/signup">Create an account</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/login">I already have one</Link>
            </Button>
          </div>
        </section>
      ) : null}

      <TopFour favorites={favorites} isOwner={isOwner} />

      <DesertIslandStrip entries={desertIsland} isOwner={isOwner} />

      <TopRated artists={topArtists} albums={topAlbums} tracks={topTracks} displayName={name} />

      <section>
        <SectionHeading eyebrow="Lifetime" title="By the numbers" />
        <StatTiles stats={stats} />
      </section>

      {/*
        TWO PANELS, ONE ROW ON A WIDE SCREEN. They are the same kind of statement — the shape
        of a library rather than a count of it — and both render nothing when empty, so on a
        thin account this grid collapses to nothing rather than to two headings.
      */}
      <div className="grid gap-8 lg:grid-cols-2">
        <GenreBreakdown genres={genres} albumCount={stats.albumsStarted} />
        <ReplayLeaders leaders={replayLeaders} minPlays={REPLAY_LEADER_MIN_PLAYS} />
      </div>

      {/*
        THE CONTINUE-DISCOGRAPHIES RAIL. Artists whose catalogue is partly logged — the one
        completion denominator in music that means anything, because nobody is partway through
        an album but everybody is partway through a discography.

        THE DENOMINATOR IS WHAT THE MIRROR HOLDS, not the artist's true output, and the query's
        own docblock says so: an artist first seen through a single album page reads "1 of 1"
        until their artist page is visited. The fraction is printed as text beside the bar for
        exactly that reason — a bar alone would look like a claim about the discography.
      */}
      {discographies.length > 0 ? (
        <section>
          <SectionHeading
            eyebrow="Keep going"
            title="Discographies in progress"
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href="/artists">Browse artists</Link>
              </Button>
            }
          />
          <CoverRail>
            {discographies.map((row) => {
              const href = `/artist/${artistSlug(row.name, row.artistId)}`;
              const picture = artistPicture({ picturePath: row.picturePath }, ARTIST_THUMB_WIDTH);
              return (
                // The wrapping link is the `group`, which is what drives `.sleeve`'s lift —
                // the image is never the hover target, so the caption responds with it.
                <Link key={row.artistId} href={href} className="group block">
                  {/* `rounded-full` is a utility and `.sleeve` is in @layer components, so the
                      utility wins: a square sleeve becomes a round portrait for an artist. */}
                  <div className="sleeve rounded-full">
                    {picture ? (
                      <img
                        src={picture}
                        // Empty alt: the name is in the caption inside the same link, so
                        // naming the image as well announces every tile twice.
                        alt=""
                        loading="lazy"
                        decoding="async"
                        className="size-full object-cover"
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center">
                        <Disc3 className="size-8 text-line-bright" aria-hidden="true" />
                      </div>
                    )}
                  </div>
                  <p className="mt-2 truncate font-sans text-[0.8125rem] text-paper transition-colors group-hover:text-amber">
                    {row.name}
                  </p>
                  <p className="mt-0.5 font-mono text-[0.6875rem] tabular text-faint">
                    {row.loggedAlbums} of {row.totalAlbums}
                    <span className="sr-only">
                      {` canonical albums logged of the ${row.totalAlbums} Deadwax holds`}
                    </span>
                  </p>
                  {/* No `label`: the fraction is one line above, and naming the bar as well
                      would read every artist's progress out twice. */}
                  <Meter
                    ratio={meterPercent(row.loggedAlbums, row.totalAlbums) / 100}
                    tone="teal"
                    className="mt-1.5"
                  />
                </Link>
              );
            })}
          </CoverRail>
        </section>
      ) : null}

      <section>
        <SectionHeading
          eyebrow="Recent"
          title="What they played"
          action={
            <Button asChild variant="ghost" size="sm">
              <Link href={`/@${member.username}/diary`}>Full diary</Link>
            </Button>
          }
        />
        {/*
          `showAuthor={false}` — this is one member's own page and the header above already
          names them; repeating the avatar twelve times says nothing.

          `canDelete` IS DELIBERATELY NOT PASSED. The diary is the only surface in the
          application that carries a log delete control, so the owner's own preview here is
          read-only: a destructive control that appears in two places is one that has to be
          reasoned about in two places.
        */}
        <ActivityFeed
          entries={activity}
          likedIds={likedIds}
          showAuthor={false}
          empty={
            <EmptyState
              title={isOwner ? "Nothing logged yet" : `${name} has not logged anything yet`}
              description={
                isOwner
                  ? "Rate a record and it lands here, with the date you played it."
                  : "Ratings, reviews and diary entries appear here as they happen."
              }
              action={
                isOwner ? (
                  <Button asChild variant="primary">
                    <Link href="/albums">Find a record</Link>
                  </Button>
                ) : null
              }
            />
          }
        />
      </section>

      {lists.length > 0 ? (
        <section>
          <SectionHeading
            eyebrow="Lists"
            title={plural(lists.length, "list")}
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href={`/@${member.username}/lists`}>See all</Link>
              </Button>
            }
          />
          <ul className="grid gap-4 sm:grid-cols-2">
            {lists.slice(0, LIST_PREVIEW).map((list) => (
              <li key={list.id}>
                {/* `showOwner={false}`: the page heading already names them. */}
                <ListCard list={list} showOwner={false} />
              </li>
            ))}
          </ul>
        </section>
      ) : isOwner ? (
        <section>
          <SectionHeading eyebrow="Lists" title="Nothing collected yet" />
          <EmptyState
            title="Make a list"
            description="A list can hold artists, albums or individual tracks, ranked or not — so it works as a playlist as readily as a top ten."
            action={
              <Button asChild variant="primary">
                <Link href="/lists">
                  <Library />
                  Browse lists
                </Link>
              </Button>
            }
          />
        </section>
      ) : null}

      {/*
        LAST ON THE PAGE, after everything this member made. `AdSlot` renders nothing when the
        plan is empty or the viewer is on Pro.
      */}
      <AdSlot ad={ads[0]} className="mx-auto w-full max-w-md" />
    </div>
  );
}

/**
 * The home page — THE ONLY ROUTE IN THE APPLICATION WITH A SEGMENT CONFIG.
 *
 * `export const revalidate = 0` is below and it is the reason several things on this page are
 * shaped the way they are: every anonymous visitor renders this from scratch, so nothing here
 * may write. `HomeRails` and `GenreRail` both say the same thing from their side — the mirror
 * is filled from /search, /albums and /album/[slug], where a provider call is somebody's own
 * request rather than an ambient one, and PGlite allows exactly one writer.
 *
 * ---------------------------------------------------------------------------------------
 * TWO COMPLETELY DIFFERENT PAGES AT ONE ADDRESS
 * ---------------------------------------------------------------------------------------
 *
 *   SIGNED OUT   a hero, then the community/catalogue/new/artist rails, four genre rails and
 *                the most recent writing — all of it inside `HomeRails`, which owns its own
 *                reads because every one of them exists only to fill this page.
 *   SIGNED IN    the member's own lifetime figures, their recent plays, the following feed,
 *                and the taste rails LAST, behind a Suspense boundary.
 *
 * The rejected alternative was one page rendering both and hiding half of it. It costs both
 * halves' queries on every request and it puts a signed-out visitor's rails into the RSC
 * payload of a member who will never see them.
 *
 * ---------------------------------------------------------------------------------------
 * THE SUBSTITUTION IS SILENT IN THE DATA AND VISIBLE IN THE COPY
 * ---------------------------------------------------------------------------------------
 *
 * A member who follows nobody gets `getGlobalFeed` in place of `getFollowingFeed`, and the
 * EYEBROW FLIPS — "From people you follow" becomes "Across Deadwax". That flip is the whole
 * honesty mechanism: an empty feed teaches nothing, a silently substituted one would present
 * strangers as people they had chosen, and a second heading reading "nobody you follow has
 * logged anything" would be a report of an absence directly above a full feed.
 *
 * ---------------------------------------------------------------------------------------
 * THE SUSPENSE BOUNDARY IS SAFE HERE, AND WOULD NOT BE ON A CONTENT ROUTE (I-3)
 * ---------------------------------------------------------------------------------------
 *
 * `PersonalRails` is the most valuable thing on the signed-in page and the slowest — seven
 * retrieval sources, up to eight sequential detail syncs and a scoring pass — so it streams in
 * last behind `PersonalRailsSkeleton`. Nothing on this route can raise `notFound()`, so nothing
 * it does can decide a response status after the shell has already flushed as a 200. On
 * /album/[slug] or /artist/[slug] the same boundary would be a bug.
 *
 * ---------------------------------------------------------------------------------------
 * ONE `Promise.all`, THEN ONE AWAIT THAT GENUINELY DEPENDS ON IT
 * ---------------------------------------------------------------------------------------
 *
 * The three independent reads go together. The like-set is a SECOND round because it needs the
 * entry ids that round one produced — a real data dependency rather than an oversight, and the
 * one place the batching rule (`getLikedLogIds` once per page, never once per row) forces a
 * sequential await.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AdSlot } from "@/components/ads/ad-slot";
import { HeroCycle } from "@/components/home/hero-cycle";
import { HomeRails } from "@/components/home/home-rails";
import { PersonalRails, PersonalRailsSkeleton } from "@/components/home/personal-rails";
import { StatTiles } from "@/components/profile/stat-tiles";
import { ActivityFeed } from "@/components/social/activity-feed";
import { Button } from "@/components/ui/button";
import { EmptyState, Eyebrow, SectionHeading } from "@/components/ui/primitives";
import { AD_PAGE_KEY, serveAds } from "@/lib/ads/serve";
import { currentUser } from "@/lib/auth/session";
import { browseAlbums } from "@/lib/db/queries/albums";
import { getFollowingFeed, getGlobalFeed, getLikedLogIds, getRecentLogs } from "@/lib/db/queries/logs";
import { albumCover } from "@/lib/providers/images";
import { getProfileStats } from "@/lib/stats/profile";

/**
 * THE ONE SEGMENT CONFIG IN THE APPLICATION.
 *
 * The page is already dynamic — it reads the session cookie — so this is not what makes it
 * uncacheable. It is here as the explicit statement that the front door is never served from a
 * cache: the rails are "what the community has just rated", and a cached copy of that is a
 * claim about a moment which has passed.
 */
export const revalidate = 0;

/** Five frames is a 35s loop. `HeroCycle`'s docblock explains why more is worse, not better. */
const HERO_FRAMES = 5;

/** The member's own recent plays. Twelve is a screen of feed before it becomes a diary. */
const RECENT_LIMIT = 12;

/**
 * The feed window. `FOLLOWING_FEED_LIMIT` is the query's own default of 30; the home page asks
 * for less, because this is a summary with the real diary one click away.
 */
const FEED_LIMIT = 24;

export async function generateMetadata(): Promise<Metadata> {
  /*
   * NO `title` FIELD, DELIBERATELY. This is the one route where the root's `title.default`
   * ("Deadwax — a social diary for records") is the right answer: pushing a bare title through
   * `title.template` would replace the product's own tagline with the word "Home", and naming
   * the tagline again here would be a second copy of a string that can drift from the root's.
   * Omitting the field is how a route inherits the default.
   *
   * The canonical URL is worth stating precisely because two very different pages live at this
   * one address: signed-in and signed-out are the same document to a crawler.
   */
  return { alternates: { canonical: "/" } };
}

export default async function HomePage() {
  const viewer = await currentUser();
  return viewer ? <SignedInHome userId={viewer.id} username={viewer.username} /> : <SignedOutHome />;
}

/* -------------------------------------------------------------------------- */
/* Signed out                                                                 */
/* -------------------------------------------------------------------------- */

async function SignedOutHome() {
  /*
   * `sort: "fans"` rather than the community's most-rated, and the reason is what the hero is
   * FOR: five covers that read as a colour field behind a headline. Fan counts are POPULARITY,
   * never quality — nothing here renders one as a figure, a star or a label, so choosing
   * decoration is the one honest use for them. Borrowing `getMostRatedAlbums` instead would run
   * the six-CTE aggregate twice, once here and once inside `HomeRails`.
   */
  const { rows } = await browseAlbums({ sort: "fans", perPage: HERO_FRAMES });

  /*
   * 1000px, because the backdrop is scaled 140% across the full window. `HeroCycle` drops nulls
   * and duplicates itself and renders NOTHING when there is not one cover — a cold mirror gets
   * a dark band, which is what `bg-ink` already is.
   */
  const frames = rows.map((row) => ({ coverUrl: albumCover(row, 1000) }));

  /*
   * ONE SLOT, AND IT IS KEYED `home` RATHER THAN `feed`.
   *
   * The two keys exist because this route renders two different pages, and per-page keying is
   * one of the four frequency mechanisms: a visitor who signs in mid-session should not get the
   * same unit again under a heading that has changed. `viewerId: null` — a signed-out visitor
   * has no plan to exempt and no affinity to score with, and `serveAds` handles both by taking
   * the nullable id rather than making the caller branch.
   */
  const ads = await serveAds({
    viewerId: null,
    pageKey: AD_PAGE_KEY.home,
    placement: "feed",
    slotCount: 1,
  });

  return (
    <div className="space-y-14">
      {/*
        `.bleed` escapes the centred column, which is only safe because body carries
        `overflow-x: hidden` — the two are a pair, and globals.css says so at both ends.

        HeroCycle RENDERS ITS OWN `.hero-scrim` AND `.hero-vignette`. Adding another here would
        darken the band to near-black and the headline would stop needing one at all, which is
        how the treatment gets "fixed" by deleting it.
      */}
      <section className="bleed relative overflow-hidden">
        <HeroCycle frames={frames} />

        <div className="relative mx-auto max-w-6xl px-4 py-16 sm:py-24">
          <Eyebrow>A social diary for records</Eyebrow>
          <h1 className="mt-3 max-w-2xl font-display text-4xl leading-tight text-paper text-balance sm:text-6xl">
            Keep the record of what you played.
          </h1>
          <p className="mt-4 max-w-prose text-sm leading-relaxed text-muted sm:text-base">
            Rate albums, tracks and artists on the same scale, keep a diary of the plays and the
            replays, and watch a career arc appear one cell at a time.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            {/*
              AT MOST ONE `primary` PER VIEW — it is the answer to "what is this page for?".
              /start opens a guest session, so the first rating costs nobody an account.
            */}
            <Button asChild variant="primary" size="lg">
              <Link href="/start">Start rating</Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link href="/albums">Browse the catalogue</Link>
            </Button>
          </div>
        </div>
      </section>

      {/*
        `HomeRails` owns its own six reads and its own cold-mirror empty state. No viewer is
        passed: a signed-out visitor has no overlay to draw.
      */}
      <HomeRails />

      {/*
        BELOW THE RAILS, NOT BETWEEN THEM. An ad inside the rail stack would sit between two
        sections of catalogue and read as a third one — the unit is labelled, but the first
        signal a reader takes is position. `AdSlot` renders nothing at all when handed an empty
        plan, so a deployment with no inventory has no empty box here.
      */}
      <AdSlot ad={ads[0]} className="mx-auto max-w-md" />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Signed in                                                                  */
/* -------------------------------------------------------------------------- */

async function SignedInHome({ userId, username }: { userId: number; username: string }) {
  const [stats, recent, following, ads] = await Promise.all([
    getProfileStats(userId),
    getRecentLogs(userId, RECENT_LIMIT),
    getFollowingFeed(userId, FEED_LIMIT),
    /*
     * `feed` RATHER THAN `home`, and the placement is `feed` too.
     *
     * The page key rotates the unit when the same person's home changes shape; the placement
     * decides which inventory is eligible, since an ad booked `sidebar` only is not a candidate
     * for a full-width column. The Pro exemption is enforced at the point of fetch inside
     * `serveAds`, so for a Pro member no candidate query runs at all — which is why this sits
     * in the batch unconditionally rather than behind a plan check here.
     */
    serveAds({ viewerId: userId, pageKey: AD_PAGE_KEY.feed, placement: "feed", slotCount: 1 }),
  ]);

  /*
   * THE FALLBACK IS A SECOND AWAIT ON PURPOSE. Firing both feeds inside the `Promise.all` above
   * would read the global feed on every render for the large majority of members who do follow
   * somebody — two feed queries to use one. The cost of this shape is one extra round trip for
   * the members who follow nobody, which is exactly the population for whom this page would
   * otherwise be empty.
   */
  const fromFollowing = following.length > 0;
  const feed = fromFollowing ? following : await getGlobalFeed(FEED_LIMIT);

  /*
   * ROUND TWO: one query for every card on the page. It needs the ids from round one, which is
   * why it is not in the `Promise.all` — and both lists go in ONE call rather than two, because
   * `getLikedLogIds` guards its own empty cases and a single `IN (…)` over 36 ids costs less
   * than two over 12 and 24.
   */
  const likedIds = await getLikedLogIds(userId, [...recent, ...feed].map((entry) => entry.id));

  return (
    <div className="space-y-14">
      <header>
        <Eyebrow>Signed in as @{username}</Eyebrow>
        <h1 className="mt-2 font-display text-3xl leading-tight text-paper sm:text-4xl">
          What you have been playing
        </h1>
      </header>

      {/* Nine lifetime numbers in one round trip, React-`cache()`d per request. */}
      <StatTiles stats={stats} />

      <section>
        <SectionHeading
          eyebrow="Your diary"
          title="Recent plays"
          action={
            <Button asChild variant="ghost" size="sm">
              <Link href={`/@${username}/diary`}>Full diary</Link>
            </Button>
          }
        />
        {/*
          `showAuthor={false}`: this is one member's own surface and the heading above already
          names them, so twelve copies of their avatar say nothing.

          `canDelete` IS DELIBERATELY ABSENT. The diary is the one surface in the application
          where a log delete control exists, and a destructive control on a summary is a
          destructive control somebody reaches by accident.
        */}
        <ActivityFeed
          entries={recent}
          likedIds={likedIds}
          showAuthor={false}
          empty={
            <EmptyState
              title="Nothing logged yet"
              description="Rate a record and it lands here, with the date you played it and every replay after that."
              action={
                <Button asChild variant="primary">
                  <Link href="/albums">Find something to play</Link>
                </Button>
              }
            />
          }
        />
      </section>

      {/*
        BETWEEN THE TWO FEEDS, WHICH IS THE ONE PLACE ON THIS PAGE A UNIT IS NOT AN INTERRUPTION:
        both neighbours are section boundaries, so the card lands in a gap rather than inside
        somebody's diary. Renders nothing when the plan is empty or the member is on Pro.
      */}
      <AdSlot ad={ads[0]} className="mx-auto max-w-md" />

      <section>
        <SectionHeading
          /*
           * THE FLIP IS THE WHOLE DISCLOSURE. The data substitution is silent; the copy is not.
           * See the module docblock.
           */
          eyebrow={fromFollowing ? "From people you follow" : "Across Deadwax"}
          title={fromFollowing ? "Latest from your people" : "Latest on Deadwax"}
          action={
            fromFollowing ? null : (
              <Button asChild variant="ghost" size="sm">
                <Link href="/members">Find members</Link>
              </Button>
            )
          }
        />
        <ActivityFeed
          entries={feed}
          likedIds={likedIds}
          empty={
            <EmptyState
              title="Nothing here yet"
              description="Nobody has logged anything on this instance. Yours will be the first."
            />
          }
        />
      </section>

      {/*
        LAST, AND BEHIND A BOUNDARY. Everything above has already flushed by the time the
        recommender starts working, and the skeleton reuses `.sleeve` so the page does not jump
        when the real rail replaces it. See the module docblock on why this is safe here and
        would not be on a content route (I-3).
      */}
      <Suspense fallback={<PersonalRailsSkeleton />}>
        <PersonalRails userId={userId} />
      </Suspense>
    </div>
  );
}

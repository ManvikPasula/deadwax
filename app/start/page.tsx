/**
 * /start — twenty-four covers and a star control. The whole of onboarding.
 *
 * ============================================================================
 * IT IS GUEST-GATED, AND THAT FIXES A NAMED DEFECT.
 *
 * The source ships this route with NO AUTH GUARD AT ALL: a signed-out visitor loads the grid,
 * presses a star, and `saveLog` refuses every single time because there is no session to log
 * against. Twenty-four controls that all fail is not a degraded page, it is a page that lies
 * about what it can do — and it fails silently per card, so nothing on screen says why.
 *
 * WHY THE GUARD IS A GATE PANEL RATHER THAN A SESSION OPENED DURING THE RENDER. The obvious
 * fix is "create a guest session here", and the framework forbids it: opening a session writes
 * the Auth.js cookie, and NEXT.JS ALLOWS A COOKIE TO BE WRITTEN ONLY FROM A SERVER ACTION OR
 * A ROUTE HANDLER. Calling `startGuestSession()` from a page render throws. So the guard
 * renders the door instead of walking through it: `GuestStart` is a client island whose press
 * IS the Server Action, with `next="/start"` so the session lands straight back here. The
 * defect is closed either way — no grid is rendered without a session, so there is no star
 * that can fail.
 *
 * The rejected alternative was `redirect("/")`, which satisfies "or redirect" and leaves
 * somebody who asked for the onboarding grid on a landing page to find the button themselves.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------------------
 * `cacheAlbumSummaries` IS MANDATORY HERE, NOT AN OPTIMISATION
 * ---------------------------------------------------------------------------------------
 *
 * `logs.album_id` has a FOREIGN KEY to `albums.id`, so THE ROWS MUST EXIST BEFORE A STAR CLICK
 * CAN LOG AGAINST THEM. A provider summary alone cannot produce a local id — the primary key
 * is a local `serial` and the Deezer id is a secondary column (Decision 2) — so a grid built
 * straight from provider payloads would have no `albumId` to hand `QuickRate`, and the first
 * press would be a foreign-key violation rather than a rating. This is also why `cardFrom‑
 * DeezerSummary` takes a resolved local id and why `AlbumCard.href` is nullable.
 *
 * ---------------------------------------------------------------------------------------
 * 24 FROM 32, AND THE COVER-LESS ONES ARE DROPPED
 * ---------------------------------------------------------------------------------------
 *
 * > A cover-less card in an onboarding grid is a card nobody can recognise.
 *
 * The whole page asks one question — "do you know this record?" — and the sleeve is the only
 * part of a card that answers it quickly. 24 is `GRID_PAGE_SIZE`, divisible by 3, 4 and 6 so
 * the last row fills at every breakpoint; over-fetching 32 leaves eight to lose. The test is
 * `card.coverUrl === null` AFTER the adapter has run, not `coverPath === null` before it,
 * because `albumCover()` falls back to the Cover Art Archive when a row has an mbid — a row
 * with no Deezer cover may still have a picture.
 *
 * ---------------------------------------------------------------------------------------
 * THE FAMILIARITY HEURISTIC, RE-DERIVED — NEITHER PROVIDER HAS `vote_count`
 * ---------------------------------------------------------------------------------------
 *
 * > Popularity is whatever is streaming this week; vote count is how many people ever
 * > bothered, which is the closest thing to household familiarity the data has.
 *
 * The television original sorts a curated pool by TMDB's `vote_count`. Deezer has no votes, so
 * the closest available proxies are used, in this order:
 *
 *   1. `LASTFM_API_KEY` present -> Last.fm `listeners`, which is the true equivalent: a
 *      cumulative count of distinct people, not a streaming counter.
 *   2. Absent -> Deezer album `fans`, a cumulative favourite count. Also not a streaming
 *      counter, which is the only property that matters here.
 *
 * THE POOL IS A FIXED CURATED SEED AND DELIBERATELY NOT THE CHART. The chart is definitionally
 * "this week", which is the alternative the brief rejects: an onboarding grid of this week's
 * releases asks a new arrival about records nobody has had time to form an opinion on.
 *
 * ---------------------------------------------------------------------------------------
 * THE MIRROR IS THE CACHE, AND THAT IS WHY THIS PAGE IS CHEAP ON THE SECOND VISIT
 * ---------------------------------------------------------------------------------------
 *
 * Resolving sixty seed records against the provider is sixty searches. Doing that per render
 * would be wrong twice over: it is a sixth of the whole platform-wide Deezer budget, and
 * `CACHE_SECONDS.search` is ten minutes, so it would recur all day. So the pool is read from
 * THE MIRROR — which persists, carries `fans`, and is what `cacheAlbumSummaries` writes — and
 * the provider is consulted only for the seed entries the mirror does not have yet. A seeded
 * or warm instance therefore does one query and no outbound requests at all.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { and, eq, sql } from "drizzle-orm";

import { GuestStart } from "@/components/auth/guest-start";
import { CoverCard } from "@/components/album/cover-card";
import { CoverGrid, GRID_PAGE_SIZE } from "@/components/album/cover-grid";
import { IntroDialog } from "@/components/onboarding/intro-dialog";
import { QuickRate } from "@/components/onboarding/quick-rate";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import { albumIdentity, isCanonicalRelease } from "@/lib/canonical";
import { db } from "@/lib/db";
import { getViewerAlbumOverlay } from "@/lib/db/queries/albums";
import { albums, artists } from "@/lib/db/schema";
import { cacheAlbumSummaries } from "@/lib/ingest/albums";
import { searchAlbumByArtistTitle, searchAlbums } from "@/lib/providers/deezer";
import { albumInfo, lastfmConfigured } from "@/lib/providers/lastfm";
import type { DeezerAlbumSummary } from "@/lib/providers/deezer/types";
import { countRatedAlbums } from "@/lib/taste/profile";
import { MIN_RATED_ALBUMS } from "@/lib/taste/shared";
import { cardFromAlbumRow } from "@/lib/view";

export const metadata: Metadata = {
  title: "Start your diary",
  description: "Rate a few records you know and the rest of the product turns on.",
};

/**
 * OVER-FETCH 32 TO SHOW `GRID_PAGE_SIZE`. Eight spare is the margin for the cover-less drop;
 * measured against the seed below, one or two records in the low thirties routinely mirror
 * without a cover because Deezer's payload carries only `md5_image` for them.
 */
const OVER_FETCH = 32;

/**
 * How many provider lookups run at once while warming a cold mirror.
 *
 * The recommender's rule, applied here: parallel ACROSS sources and sequential WITHIN a
 * fan-out. Six concurrent searches is well inside `deezerOutbound` (400/60s) while ten rounds
 * of six resolve the whole seed in about the time one sequential pass would take to do ten.
 * `Promise.all` over all sixty would spend a sixth of the platform-wide budget in one burst
 * and would be the first thing to trip it when two people open this page together.
 */
const SEED_CONCURRENCY = 6;

/* ========================================================================== *
 * THE CURATED SEED
 * ========================================================================== */

/**
 * SIXTY CANONICAL RECORDS, 1959–2020, ACROSS GENRES — AND WITH DELIBERATE ARTIST OVERLAP.
 *
 * Three properties, each load-bearing:
 *
 *  1. A SPREAD OF ERAS AND GENRES, so the grid asks a jazz listener and a rap listener the
 *     same number of answerable questions. A pool drawn from one decade produces a taste
 *     profile whose `eraCentre` is an artefact of the pool rather than of the member.
 *  2. ARTIST OVERLAP ON PURPOSE (Radiohead ×4, Kendrick Lamar ×3, Daft Punk ×2, Massive
 *     Attack ×2, Sufjan Stevens ×2, Björk ×2). `buildTasteProfile`'s artist axis needs SUPPORT
 *     to say anything — `leanFor` is support-weighted — and a seed of sixty distinct artists
 *     gives every artist affinity a sample size of one.
 *  3. CANONICAL STUDIO ALBUMS ONLY, which is what makes `isCanonicalRelease` the right filter
 *     on the search results below: the seed's own titles are the studio titles, so a live
 *     album or a super-deluxe box coming back from the provider is a mismatch rather than a
 *     judgement call.
 *
 * WHY PAIRS AND NOT DEEZER IDS. scripts/seed.ts holds a list of ids "RESOLVED AGAINST THE LIVE
 * API rather than guessed", which is the correct approach for a script an operator runs and
 * the wrong one for a page: an id typed from memory that turns out to be a different record
 * renders a stranger's album in an onboarding grid with no way to notice, whereas a pair that
 * fails to resolve simply drops out and is logged. The resolution rules below are the four
 * provider facts that script recorded.
 */
const FAMILIAR_SEED: ReadonlyArray<{ artist: string; title: string }> = [
  { artist: "Miles Davis", title: "Kind of Blue" },
  { artist: "John Coltrane", title: "A Love Supreme" },
  { artist: "Bob Dylan", title: "Highway 61 Revisited" },
  { artist: "The Beach Boys", title: "Pet Sounds" },
  { artist: "The Velvet Underground", title: "The Velvet Underground & Nico" },
  { artist: "The Beatles", title: "Abbey Road" },
  { artist: "Marvin Gaye", title: "What's Going On" },
  { artist: "Joni Mitchell", title: "Blue" },
  { artist: "Led Zeppelin", title: "Led Zeppelin IV" },
  { artist: "Pink Floyd", title: "The Dark Side of the Moon" },
  { artist: "Patti Smith", title: "Horses" },
  { artist: "Stevie Wonder", title: "Songs in the Key of Life" },
  { artist: "Fleetwood Mac", title: "Rumours" },
  { artist: "Kraftwerk", title: "Trans-Europe Express" },
  { artist: "David Bowie", title: "Low" },
  { artist: "Television", title: "Marquee Moon" },
  { artist: "Bob Marley & The Wailers", title: "Exodus" },
  { artist: "The Clash", title: "London Calling" },
  { artist: "Joy Division", title: "Unknown Pleasures" },
  { artist: "Talking Heads", title: "Remain in Light" },
  { artist: "Prince", title: "Purple Rain" },
  { artist: "Kate Bush", title: "Hounds of Love" },
  { artist: "The Smiths", title: "The Queen Is Dead" },
  { artist: "Public Enemy", title: "It Takes a Nation of Millions to Hold Us Back" },
  { artist: "Sonic Youth", title: "Daydream Nation" },
  { artist: "The Stone Roses", title: "The Stone Roses" },
  { artist: "Nirvana", title: "Nevermind" },
  { artist: "A Tribe Called Quest", title: "The Low End Theory" },
  { artist: "My Bloody Valentine", title: "Loveless" },
  { artist: "Massive Attack", title: "Blue Lines" },
  { artist: "Aphex Twin", title: "Selected Ambient Works 85-92" },
  { artist: "Wu-Tang Clan", title: "Enter the Wu-Tang (36 Chambers)" },
  { artist: "Nas", title: "Illmatic" },
  { artist: "Portishead", title: "Dummy" },
  { artist: "Jeff Buckley", title: "Grace" },
  { artist: "Radiohead", title: "The Bends" },
  { artist: "Björk", title: "Post" },
  { artist: "DJ Shadow", title: "Endtroducing....." },
  { artist: "Radiohead", title: "OK Computer" },
  { artist: "Lauryn Hill", title: "The Miseducation of Lauryn Hill" },
  { artist: "Massive Attack", title: "Mezzanine" },
  { artist: "Boards of Canada", title: "Music Has the Right to Children" },
  { artist: "Neutral Milk Hotel", title: "In the Aeroplane Over the Sea" },
  { artist: "Radiohead", title: "Kid A" },
  { artist: "OutKast", title: "Stankonia" },
  { artist: "Daft Punk", title: "Discovery" },
  { artist: "The Strokes", title: "Is This It" },
  { artist: "The White Stripes", title: "Elephant" },
  { artist: "Arcade Fire", title: "Funeral" },
  { artist: "Sufjan Stevens", title: "Illinois" },
  { artist: "Radiohead", title: "In Rainbows" },
  { artist: "Burial", title: "Untrue" },
  { artist: "LCD Soundsystem", title: "Sound of Silver" },
  { artist: "Kanye West", title: "My Beautiful Dark Twisted Fantasy" },
  { artist: "Kendrick Lamar", title: "good kid, m.A.A.d city" },
  { artist: "Daft Punk", title: "Random Access Memories" },
  { artist: "Kendrick Lamar", title: "To Pimp a Butterfly" },
  { artist: "Sufjan Stevens", title: "Carrie & Lowell" },
  { artist: "Björk", title: "Vulnicura" },
  { artist: "Frank Ocean", title: "Blonde" },
  { artist: "SZA", title: "Ctrl" },
  { artist: "Kendrick Lamar", title: "DAMN." },
  { artist: "Tyler, the Creator", title: "IGOR" },
  { artist: "Fiona Apple", title: "Fetch the Bolt Cutters" },
];

/**
 * The seed's identity, and it DELIBERATELY OMITS THE MBID ARGUMENT.
 *
 * `albumIdentity` prefers `mb:<release-group mbid>` when it has one, which is the right
 * behaviour everywhere else and the wrong behaviour here: a mirrored row that has been through
 * MusicBrainz would hash to its mbid while the seed entry — which has no mbid and never will —
 * hashes to artist-plus-title, and the two could never match. Passing only the two fields the
 * seed has forces both sides onto the title-based branch, which is the comparison this page
 * actually wants: *are these two strings the same record in different clothes.*
 *
 * The fallback strips trailing qualifiers, so "Nevermind" matches
 * "Nevermind (Remastered 2021)", and normalises `&` to "and" so "The Velvet Underground &
 * Nico" matches "The Velvet Underground and Nico". It deliberately ignores the year, because
 * the year is exactly what a reissue changes.
 */
function seedIdentity(entry: { artist: string; title: string }): string {
  return albumIdentity({ artistName: entry.artist, title: entry.title });
}

/** Distinct, lower-cased artist names — the SQL filter's parameter list. */
const SEED_ARTIST_NAMES: readonly string[] = [
  ...new Set(FAMILIAR_SEED.map((entry) => entry.artist.toLowerCase())),
];

/* ========================================================================== *
 * The pool
 * ========================================================================== */

type PoolRow = Awaited<ReturnType<typeof mirroredSeedRows>>[number];

/**
 * The seed's records, as they exist in the mirror.
 *
 * WHY THIS QUERY IS WRITTEN HERE RATHER THAN IN lib/db/queries/albums.ts. Every function in
 * that module answers a question some surface asks repeatedly — browse, search, a rating
 * rollup — and each owns one table's reads. "The rows matching this page's own hard-coded
 * seed" is not a question anything else will ever ask, and a query module entry parameterised
 * on a constant that lives in a route would be a shared function with one caller and an
 * invisible coupling. The precedent for a surface reading directly is
 * components/auth/verify-banner.tsx, which does it for a narrower reason and says so.
 *
 * THE `IN` LIST IS BUILT WITH `sql.join` OVER BOUND PARAMETERS, the same shape as `idList` in
 * the query module: each name is its own placeholder, so nothing is interpolated as text and
 * an artist called `Bobby Tables` is a string like any other. The list is a compile-time
 * constant, so the `IN ()` empty-array hazard cannot arise — but the filter is on ARTIST and
 * not on title, because a title comparison belongs to `albumIdentity` and reimplementing its
 * normalisation in SQL would be a second copy of the rule that decides what "the same record"
 * means.
 *
 * `is_canonical` IS FILTERED IN SQL. A non-canonical release must never enter a completion
 * denominator, a discography heatmap row, or a recommendation pool — and an onboarding grid is
 * the same kind of surface: asking somebody to rate "Nevermind (30th Anniversary Super
 * Deluxe)" produces a rating attached to a 65-track box rather than to the album they think
 * they are answering about.
 */
async function mirroredSeedRows() {
  const names = sql.join(
    SEED_ARTIST_NAMES.map((name) => sql`${name}`),
    sql`, `,
  );

  return db
    .select({
      id: albums.id,
      deezerId: albums.deezerId,
      mbid: albums.mbid,
      title: albums.title,
      coverPath: albums.coverPath,
      releaseDate: albums.releaseDate,
      originalReleaseDate: albums.originalReleaseDate,
      recordType: albums.recordType,
      isCanonical: albums.isCanonical,
      fans: albums.fans,
      artistId: albums.artistId,
      artistName: artists.name,
    })
    .from(albums)
    .innerJoin(artists, eq(artists.id, albums.artistId))
    .where(and(eq(albums.isCanonical, true), sql`lower(${artists.name}) in (${names})`));
}

/** Parallel across a batch, sequential between batches. See `SEED_CONCURRENCY`. */
async function inBatches<T, R>(items: readonly T[], size: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(...(await Promise.all(items.slice(index, index + size).map(worker))));
  }
  return out;
}

/**
 * Resolves one seed entry to a provider summary, or null.
 *
 * THE FOUR PROVIDER FACTS scripts/seed.ts RECORDED, APPLIED IN ORDER:
 *
 *  1. Deezer's advanced grammar `artist:"X" album:"Y"` RETURNS NOTHING for several records
 *     that plainly exist — Discovery among them, which resolves fine from a plain `q=`. Hence
 *     the second search rather than trusting the first to be authoritative.
 *  2. MATCHING ON TITLE ALONE IS NOT ENOUGH: "Nevermind" matched an artist called Alison Rose
 *     and "Abbey Road" matched a tribute act called The Beatles Complete On Ukulele. The
 *     identity comparison covers both halves at once, which is why it is used instead of two
 *     separate string tests.
 *  3. THE TOP-RANKED RESULT IS OFTEN A LIVE ALBUM OR A SUPER-DELUXE BOX — Homogenic resolved
 *     to a live recording and The Velvet Underground & Nico to a 65-track anniversary box — so
 *     `isCanonicalRelease` runs on every candidate rather than only on the winner.
 *  4. FOR SEVERAL CANONICAL RECORDS THE ONLY EDITION THE CATALOGUE STOCKS IS THE REMASTER.
 *     That is why `isCanonicalRelease` does not treat "(Remastered)" as noise and why
 *     `albumIdentity` strips it: a remaster of a studio album IS the studio album.
 *
 * `musicbrainzKnown` IS LEFT UNSET, deliberately: nothing has been to MusicBrainz for a search
 * result, so the title regex is the only evidence there is and claiming otherwise would let a
 * box set through on an empty `secondaryTypes` array.
 *
 * A MISS RETURNS NULL AND IS NOT AN ERROR. Catalogues differ by territory and records come and
 * go from them; the seed is sixty entries for a grid of twenty-four precisely so that a
 * handful of misses costs nothing.
 */
async function resolveSeedEntry(entry: { artist: string; title: string }): Promise<DeezerAlbumSummary | null> {
  const wanted = seedIdentity(entry);

  const strict = await searchAlbumByArtistTitle(entry.artist, entry.title, 5);
  const loose = strict.length > 0 ? [] : await searchAlbums(`${entry.artist} ${entry.title}`, 8);

  for (const candidate of [...strict, ...loose]) {
    const artistName = candidate.artist?.name;
    if (!artistName) continue;
    if (!isCanonicalRelease({ recordType: candidate.record_type, title: candidate.title })) continue;
    if (albumIdentity({ artistName, title: candidate.title }) !== wanted) continue;
    return candidate;
  }

  return null;
}

/**
 * The pool, mirror-first.
 *
 * Returns rows for as much of the seed as this instance can see. On a cold mirror it resolves
 * the missing entries from the provider, writes them through `cacheAlbumSummaries` — which is
 * mandatory, see the module docblock — and reads the mirror again, because that function
 * returns no ids and the local `serial` is the thing the grid needs.
 *
 * THE RE-READ IS CONDITIONAL. An instance whose mirror already holds the seed never touches
 * the provider and never runs a second query.
 */
async function familiarPool(): Promise<PoolRow[]> {
  const wanted = new Set(FAMILIAR_SEED.map(seedIdentity));

  const keep = (rows: PoolRow[]) =>
    rows.filter((row) => wanted.has(albumIdentity({ artistName: row.artistName, title: row.title })));

  let pool = keep(await mirroredSeedRows());
  if (pool.length >= OVER_FETCH) return pool;

  /*
   * Only the entries the mirror is missing. A partially warmed instance therefore pays for the
   * gap rather than for the whole seed, and two visits in a row converge on zero requests.
   */
  const have = new Set(pool.map((row) => albumIdentity({ artistName: row.artistName, title: row.title })));
  const missing = FAMILIAR_SEED.filter((entry) => !have.has(seedIdentity(entry)));

  const resolved = (await inBatches(missing, SEED_CONCURRENCY, resolveSeedEntry)).filter(
    (summary): summary is DeezerAlbumSummary => summary !== null,
  );

  if (resolved.length === 0) return pool;

  // NEVER SILENT. The source's equivalent failure was swallowed so completely that "every
  // summary cache write failed silently — the console line was there, the candidates were
  // simply untagged", and an onboarding grid that quietly arrives half empty looks like a
  // layout bug rather than a resolution one.
  console.info(`[start] seed: mirror had ${pool.length}, resolved ${resolved.length} of ${missing.length} missing`);

  // `cacheAlbumSummaries` swallows its own failures by design (it is a write-behind), so there
  // is nothing to catch here; a failed write shows up as a shorter pool on the re-read.
  await cacheAlbumSummaries(resolved);
  pool = keep(await mirroredSeedRows());

  return pool;
}

/* ========================================================================== *
 * The familiarity ordering
 * ========================================================================== */

type Ranked = { row: PoolRow; familiarity: number };

/**
 * Orders the pool by the familiarity proxy this deployment has.
 *
 * WITH A LAST.FM KEY, `listeners` is the true equivalent of a vote count and is asked for once
 * per pool row, cached for a week by the provider module. An album Last.fm has never heard of
 * scores `-1` RATHER THAN 0, so it sinks below a record with genuinely no listeners — the two
 * are different facts and collapsing them would let an unresolvable title outrank a real one
 * on the `fans` tiebreak alone.
 *
 * THE TWO SIGNALS ARE NEVER MIXED IN ONE SORT KEY. `listeners` is in the millions and `fans`
 * in the tens of thousands, so a ranking that fell back per row would sort every Last.fm miss
 * to the bottom of a list ordered by a number a thousand times larger and call it familiarity.
 * `fans` is the tiebreak only, which is a comparison between two rows the primary key could
 * not separate.
 *
 * The final tiebreak is `id`, because Postgres is free to return rows with equal keys in any
 * order and a grid that reshuffles between identical requests reads as a broken page.
 */
async function rankByFamiliarity(pool: PoolRow[]): Promise<PoolRow[]> {
  let ranked: Ranked[];

  if (lastfmConfigured()) {
    ranked = await inBatches(pool, SEED_CONCURRENCY, async (row) => {
      // The provider module is silent on failure by design — a bonus source that logs a
      // warning on every page view teaches the operator to ignore warnings — so a null here
      // means "unknown", not "broken".
      const info = await albumInfo(row.artistName, row.title);
      return { row, familiarity: info ? info.listeners : -1 };
    });
  } else {
    ranked = pool.map((row) => ({ row, familiarity: row.fans }));
  }

  return ranked
    .sort(
      (left, right) =>
        right.familiarity - left.familiarity ||
        right.row.fans - left.row.fans ||
        left.row.id - right.row.id,
    )
    .map((entry) => entry.row);
}

/* ========================================================================== *
 * The page
 * ========================================================================== */

export default async function StartPage() {
  const viewer = await currentUser();

  /* ---- THE GUEST GATE. See the module docblock. -------------------------------- */
  if (!viewer) {
    return (
      <div className="mx-auto max-w-sm py-12">
        <Eyebrow>Before the grid</Eyebrow>
        <h1 className="mt-2 font-display text-4xl leading-tight text-paper text-balance">
          A rating needs somewhere to go.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          {/*
            IT NAMES THE REASON RATHER THAN THE RULE. "Sign in to continue" is a statement
            about us; "a star with nothing behind it is a star that does not save" is the
            actual mechanic, and it is the thing that makes the next press worth making.
          */}
          Every star you press here is written to a diary, so there has to be a diary first.
          One press below opens one — no email, no password, no form.
        </p>

        <div className="card mt-8 p-5">
          {/*
            `next="/start"` so the session lands straight back on this grid. The value is
            allowlisted inside the action by `safeNextPath`, never here: a second, weaker copy
            of that rule would only be a way for the two to disagree, and anything it refuses
            falls back to /start anyway — which is this page.
          */}
          <GuestStart next="/start" />
        </div>
      </div>
    );
  }

  /*
   * THREE READS IN PARALLEL, and they are independent: the pool does not depend on who is
   * looking, and the two viewer reads do not depend on the pool. `Promise.all` rather than
   * three awaits because the pool read can reach the provider on a cold mirror and the two
   * counts should not queue behind it.
   */
  const [pool, ratedAlbums] = await Promise.all([familiarPool(), countRatedAlbums(viewer.id)]);

  const ordered = await rankByFamiliarity(pool);

  /**
   * OVER-FETCH, THEN DROP THE COVER-LESS, THEN TAKE THE PAGE. The order is the point: dropping
   * first would leave the grid short whenever the top of the pool happened to be the part
   * without artwork, and taking first would leave holes in the grid.
   */
  const cards = ordered
    .slice(0, OVER_FETCH)
    .map((row) => ({ row, card: cardFromAlbumRow(row) }))
    .filter((entry) => entry.card.coverUrl !== null)
    .slice(0, GRID_PAGE_SIZE);

  /**
   * EXISTING RATINGS ARE PREFILLED.
   *
   * > An onboarding grid that offers back the albums somebody just rated reads as though the
   * > ratings did not save.
   *
   * `QuickRate` treats this prop as SERVER TRUTH and as its rollback target: a failed write
   * drops the local guess and lets this value be the truth again, which is why it must be the
   * real rating and not a zero. One batched query for the whole grid rather than one per card
   * — and it carries the `(rating IS NOT NULL) DESC` tiebreak, so a star survives the
   * member's own later unrated replay (I-11).
   */
  const overlay = await getViewerAlbumOverlay(
    viewer.id,
    cards.map((entry) => entry.row.id),
  );

  const remaining = Math.max(0, MIN_RATED_ALBUMS - ratedAlbums);

  return (
    <div className="py-8">
      {/*
        OPENS ON ARRIVAL WITH THE GRID ALREADY RENDERED BEHIND IT, so closing it is the whole
        interaction. Radix renders nothing during SSR, so the server response is the grid alone
        and the dialog arrives on hydration — which is also why a member with no JavaScript
        gets a working grid rather than a blocked one.
      */}
      <IntroDialog isGuest={viewer.isGuest} />

      <div className="max-w-2xl">
        {/*
          THE EYEBROW COUNTS DOWN. A number that goes up says "you have done some work"; a
          number that goes down says how much is left, which is the only question somebody
          halfway through a grid of twenty-four is asking. `.tabular` so the digits do not
          jitter as it changes, because `QuickRate` calls `router.refresh()` after every
          rating and this line re-renders on each one.
        */}
        <Eyebrow>
          {remaining > 0 ? (
            <span className="tabular">
              {ratedAlbums} rated · {remaining} more unlocks recommendations
            </span>
          ) : (
            <span className="tabular">{ratedAlbums} rated · recommendations are ready</span>
          )}
        </Eyebrow>

        <h1 className="mt-2 font-display text-4xl leading-tight text-paper text-balance">
          Which of these do you know?
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Half a star to five. Clear a card you have not heard and it gets out of the way —
          there is no &ldquo;not heard it&rdquo; in the database, and the absence of a rating
          already says the absence of a listen.
        </p>

        {remaining === 0 ? (
          <div className="mt-5">
            <Button asChild variant="primary" size="lg">
              <Link href="/for-you">See what to play next</Link>
            </Button>
          </div>
        ) : null}
      </div>

      {cards.length > 0 ? (
        <CoverGrid className="mt-8">
          {cards.map((entry, index) => (
            /*
              THE CARD IS THE CHILD, NOT A SIBLING. `QuickRate` fades it when somebody presses
              "not heard it", and a component cannot fade an element it does not contain. It is
              passed as children rather than rebuilt inside the client component so `CoverCard`
              stays SERVER-rendered: it is the most-rendered component in the product, and a
              client copy would ship twenty-four covers' worth of markup twice — once as HTML,
              once as props.
            */
            <QuickRate
              key={entry.row.id}
              albumId={entry.row.id}
              title={entry.card.title}
              rating={overlay.get(entry.row.id)?.rating ?? null}
            >
              {/* `eager` for the first row only — six is the widest column count. */}
              <CoverCard album={entry.card} eager={index < 6} />
            </QuickRate>
          ))}
        </CoverGrid>
      ) : (
        /*
          A REAL STATE, NOT A CRASH. Reached when the mirror is empty and the provider is
          unreachable or over budget — a fresh clone behind a captive portal, or a Deezer
          outage. It offers the search box rather than a retry, because searching is a path
          that works from the local mirror alone.
        */
        <div className="card mt-8 px-6 py-12 text-center">
          <p className="font-display text-2xl text-paper">The catalogue is not answering.</p>
          <p className="mx-auto mt-2 max-w-prose text-sm leading-relaxed text-muted text-balance">
            We could not reach the record catalogue to build a grid, so there is nothing here to
            rate yet. Search for a record you own and start there — the diary works the same way
            from either direction.
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <Button asChild variant="primary">
              <Link href="/search">Search for a record</Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/albums">Browse</Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

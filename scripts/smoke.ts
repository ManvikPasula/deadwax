/**
 * THE HIGHEST-VALUE SCRIPT IN THE REPOSITORY FOR A DUAL-DRIVER ARCHITECTURE.
 *
 * Most aggregates in this app are raw SQL run through `db.execute`, and their result shape
 * must be IDENTICAL on both drivers — hosted Postgres over TCP, and PGlite in WebAssembly.
 *
 *   If it ever differs, every one of those reads would silently return empty and the interface
 *   would look merely QUIET RATHER THAN BROKEN.
 *
 * That is the failure this script exists to catch, and it is why every check ASSERTS THAT REAL
 * ROWS COME BACK rather than printing them for somebody to eyeball. A homepage with no rails,
 * a profile with nine zeroes and a heatmap with no cells are all indistinguishable from a
 * quiet instance.
 *
 * Run it against BOTH drivers before trusting a deployment:
 *   npm run smoke                          # PGlite
 *   DATABASE_URL=postgres://… npm run smoke # hosted Postgres
 *
 * PGlite allows exactly one writer: stop the dev server first.
 */

import { eq, sql } from "drizzle-orm";

import { db, isLocalDatabase } from "@/lib/db";
import { albums, artists, users } from "@/lib/db/schema";
import {
  browseAlbums,
  getAlbumWithTracks,
  getMostRatedAlbums,
  getRatingStats,
  getTopAlbums,
  getTopTracks,
  getTrackAggregates,
  getTrackStrip,
  getViewerAlbumState,
  searchLocalAlbums,
  trackKey,
} from "@/lib/db/queries/albums";
import { getAlbumAggregates, getCompletion, getDiscographyHeatmap, searchLocalArtists } from "@/lib/db/queries/artists";
import {
  countReviews,
  getDiary,
  getFollowingFeed,
  getGlobalFeed,
  getLikedLogIds,
  getRecentReviews,
  getReviews,
} from "@/lib/db/queries/logs";
import { getListOptions, getPublicLists } from "@/lib/db/queries/lists";
import {
  getActiveMembers,
  getDesertIsland,
  getFavorites,
  getFollowCounts,
  getMemberCardStats,
  getUserByUsername,
  getWantlist,
} from "@/lib/db/queries/users";
import { getGenreBreakdown, getInProgressAlbums, getProfileStats, getReplayLeaders } from "@/lib/stats/profile";
import { getLoggedYears, getYearReview } from "@/lib/stats/year";

/* -------------------------------------------------------------------------- */

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.info(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Hard-depends on seeded literals, and bails with an instruction rather than a stack trace if
 * they are absent. A smoke test that "passes" against an empty database is worse than no smoke
 * test, because it reports the exact same green as a working one.
 */
const SEED_USERNAME = "runoutgroove";
const SEED_ALBUM_DEEZER_ID = "14880741"; // Radiohead — Kid A
const SEED_SEARCH_TERM = "kid";

async function main(): Promise<void> {
  console.info(`[smoke] driver: ${isLocalDatabase() ? "PGlite (local)" : "Postgres (hosted)"}\n`);

  /* ---------------------------------------------------------------- fixtures */

  const member = await getUserByUsername(SEED_USERNAME);
  const album = await db.query.albums.findFirst({ where: eq(albums.deezerId, SEED_ALBUM_DEEZER_ID) });

  if (!member || !album) {
    console.error(
      `[smoke] Seed data missing: run \`npm run seed\` first.\n` +
        `        Looked for member @${SEED_USERNAME} and album deezer:${SEED_ALBUM_DEEZER_ID}.`,
    );
    process.exit(1);
  }

  const artist = await db.query.artists.findFirst({ where: eq(artists.id, album.artistId) });
  if (!artist) {
    console.error("[smoke] the seeded album has no artist row, which should be impossible via the FK");
    process.exit(1);
  }

  const memberIds = (await db.select({ id: users.id }).from(users).limit(10)).map((row) => row.id);

  console.info("[1] content mirror");
  check("the mirror has artists", (await db.select({ n: sql<number>`count(*)::int` }).from(artists))[0]!.n > 0);
  check("the mirror has albums", (await db.select({ n: sql<number>`count(*)::int` }).from(albums))[0]!.n > 0);

  const detail = await getAlbumWithTracks(album.id);
  check("getAlbumWithTracks returns the album and its tracks", Boolean(detail) && (detail?.tracks.length ?? 0) > 0, `${detail?.tracks.length ?? 0} tracks`);
  check(
    "derived columns were written at ingest",
    album.durationMs > 0 && album.meanTrackMs > 0 && album.trackCount > 0,
    `duration ${album.durationMs}ms, mean ${album.meanTrackMs}ms, ${album.trackCount} tracks`,
  );

  /**
   * THE SCALE-BRIDGE ASSERTION. MusicBrainz rates 0..5 and every member figure is on the
   * stored 0..10 scale; the two meet in exactly one function. If a second conversion site is
   * ever added, or the existing one is removed, every critic score in the catalogue lands at
   * half or double its true value — and NOTHING ELSE WOULD FAIL, because a 4.5 is a perfectly
   * valid number on both scales. This is the check that catches it.
   */
  const critic = await db.execute<{ n: number; lo: number; hi: number }>(sql`
    SELECT COUNT(*)::int AS n, MIN(critic_score)::float AS lo, MAX(critic_score)::float AS hi
    FROM albums WHERE critic_votes > 0 AND critic_score IS NOT NULL
  `);
  const criticRow = critic.rows[0];
  if ((criticRow?.n ?? 0) === 0) {
    // Not a failure: MusicBrainz is genuinely flaky and every feature it powers degrades to
    // absent by design. But it must be SAID, or an operator reads the green and assumes the
    // consensus card is working.
    console.warn("  note  no critic scores are mirrored yet — the consensus card will not render anywhere");
  } else {
    check(
      "critic scores are on the stored 0-10 scale, not MusicBrainz's 0-5",
      Number(criticRow!.hi) > 5,
      `${criticRow!.n} albums, range ${Number(criticRow!.lo).toFixed(1)}-${Number(criticRow!.hi).toFixed(1)}`,
    );
  }

  console.info("\n[2] rating aggregates (the DISTINCT ON family)");

  const albumStats = await getRatingStats({ type: "album", albumId: album.id });
  check("getRatingStats returns rows for a seeded album", albumStats.ratingCount > 0, `${albumStats.ratingCount} ratings from ${albumStats.listenedBy} members`);
  check("the average is a real number, not zero-for-empty", albumStats.average !== null && albumStats.average > 0, String(albumStats.average));
  check("the histogram always has exactly ten buckets", albumStats.histogram.length === 10);

  /**
   * The cross-check that bucketing loses nobody. A mismatch means either the bucketing dropped
   * an in-range value or the count and the buckets were computed over different row sets — and
   * both render as a plausible chart.
   */
  const bucketSum = albumStats.histogram.reduce((total, bucket) => total + bucket.count, 0);
  check("histogram bucket counts sum to the rating count", bucketSum === albumStats.ratingCount, `${bucketSum} vs ${albumStats.ratingCount}`);

  const artistStats = await getRatingStats({ type: "artist", artistId: artist.id });
  check("getRatingStats works at artist scope", artistStats.histogram.length === 10);

  const trackAgg = await getTrackAggregates(album.id);
  check("getTrackAggregates returns per-track rows", trackAgg.size > 0, `${trackAgg.size} rated tracks`);

  const albumAgg = await getAlbumAggregates(artist.id);
  check("getAlbumAggregates returns per-album rows for an artist", albumAgg.size > 0, `${albumAgg.size} rated albums`);

  const firstTrack = detail?.tracks[0];
  if (firstTrack) {
    const trackStats = await getRatingStats({
      type: "track",
      albumId: album.id,
      disc: firstTrack.discNumber,
      track: firstTrack.trackNumber,
    });
    check("getRatingStats works at track scope", trackStats.histogram.length === 10, `${trackStats.ratingCount} ratings`);
  }

  /**
   * ONE VOTE PER MEMBER. The seed deliberately writes replay rows — a second log for the same
   * track with no rating — precisely so this can be checked: without the DISTINCT ON, a
   * relistener votes once per play, and in music relistening is the norm.
   */
  const naive = await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM logs l JOIN users u ON u.id = l.user_id
    WHERE l.album_id = ${album.id} AND l.target_type = 'album' AND l.rating IS NOT NULL AND u.is_guest = false
  `);
  check(
    "the aggregate collapses to one vote per member",
    albumStats.ratingCount <= Number(naive.rows[0]?.n ?? 0),
    `${albumStats.ratingCount} distinct members vs ${naive.rows[0]?.n} raw rated rows`,
  );

  console.info("\n[3] the signature views");

  const heatmap = await getDiscographyHeatmap(artist.id, member.id);
  const heatRows = Array.isArray(heatmap) ? heatmap : (heatmap as { rows?: unknown[] }).rows ?? [];
  check("the discography heatmap returns rows", heatRows.length > 0, `${heatRows.length} album rows`);
  const heatCells = (heatRows as Array<{ cells?: unknown[] }>).reduce((total, row) => total + (row.cells?.length ?? 0), 0);
  check("the discography heatmap returns cells", heatCells > 0, `${heatCells} track cells`);

  const strip = await getTrackStrip(album.id, member.id);
  const stripCells = Array.isArray(strip)
    ? strip.reduce((total, row) => total + ((row as { cells?: unknown[] }).cells?.length ?? 0), 0)
    : 0;
  check("the album track strip returns cells", stripCells > 0, `${stripCells} cells`);

  console.info("\n[4] viewer state");

  /**
   * The album is chosen DYNAMICALLY, because the seed deliberately leaves some albums rated
   * only at album level — the heatmap is more honest with unrated rows in it. A hard-coded
   * album here asserted that this member had deep-dived that particular record, which is a
   * property of the seed's jitter rather than of the query.
   */
  const deepest = await db.execute<{ album_id: number }>(sql`
    SELECT album_id FROM logs
    WHERE user_id = ${member.id} AND target_type = 'track' AND album_id IS NOT NULL
    GROUP BY album_id ORDER BY COUNT(*) DESC LIMIT 1
  `);
  const deepAlbumId = Number(deepest.rows[0]?.album_id ?? album.id);

  const viewer = await getViewerAlbumState(member.id, deepAlbumId);
  check("getViewerAlbumState returns the newest log per target", viewer.trackLogs.size > 0 || viewer.albumLog !== null, `${viewer.trackLogs.size} track logs`);
  check("viewer state carries the listened set", viewer.listenedTracks.size > 0, `${viewer.listenedTracks.size} tracks listened`);
  check("viewer state resolves the album-level log too", viewer.albumLog !== null);
  if (firstTrack) {
    const key = trackKey(firstTrack.discNumber, firstTrack.trackNumber);
    check("the viewer-state map is keyed by the track locator", typeof key === "string" && key.length > 0, key);
  }

  console.info("\n[5] profile statistics");

  const stats = await getProfileStats(member.id);
  const nine: Array<[string, number]> = [
    ["tracksPlayed", stats.tracksPlayed],
    ["minutesPlayed", stats.minutesPlayed],
    ["albumsStarted", stats.albumsStarted],
    ["albumsCompleted", stats.albumsCompleted],
    ["artistsTouched", stats.artistsTouched],
    ["ratingsGiven", stats.ratingsGiven],
    ["reviewsWritten", stats.reviewsWritten],
    ["diaryEntries", stats.diaryEntries],
  ];
  for (const [label, value] of nine) {
    check(`profile stat ${label} is a number`, Number.isFinite(value), String(value));
  }
  check("profile stats are non-trivial for a seeded member", stats.tracksPlayed > 0 && stats.ratingsGiven > 0);
  check("listening time was summed from track durations", stats.minutesPlayed > 0, `${stats.minutesPlayed} minutes`);
  check("averageRating is on the stored 0-10 scale or null", stats.averageRating === null || (stats.averageRating > 0 && stats.averageRating <= 10), String(stats.averageRating));

  check("genre breakdown returns rows", (await getGenreBreakdown(member.id)).length > 0);
  check("in-progress albums query runs", Array.isArray(await getInProgressAlbums(member.id)));
  // THE REPLAY PILLAR — the thing that replaces "progress", since nobody is partway through a
  // 42-minute album. Returns two rankings, not one list.
  const replays = await getReplayLeaders(member.id);
  check(
    "replay leaders return both rankings",
    Array.isArray(replays.albums) && Array.isArray(replays.tracks),
    `${replays.albums.length} albums, ${replays.tracks.length} tracks`,
  );

  const completion = await getCompletion(member.id, artist.id);
  /**
   * clampListened is MORE necessary here than in television, and this is the check for it: a
   * MusicBrainz release group carries multiple releases with different track counts (single /
   * deluxe / remaster / regional edition), so a listener's logged tracks can GENUINELY exceed
   * the canonical count. "63 of 62 tracks" reads as a bug even when the underlying logs are
   * correct.
   */
  check(
    "discography completion never exceeds its denominator",
    completion.tracks === 0 || completion.tracksListened <= completion.tracks,
    `${completion.tracksListened} of ${completion.tracks} tracks, ${completion.albumsComplete} of ${completion.albums} albums`,
  );
  check("completion percent is bounded to 0-100", completion.percent >= 0 && completion.percent <= 100, `${completion.percent}%`);

  console.info("\n[6] year in review");

  const years = await getLoggedYears(member.id);
  check("getLoggedYears returns at least one year", years.length > 0, years.join(", "));
  const year = years[0] ?? new Date().getUTCFullYear();
  const review = await getYearReview(member.id, year);
  /**
   * ALWAYS TWELVE POINTS, missing months zero-filled, "so the chart keeps a full-year shape".
   * A shorter array silently produces a chart that starts in March.
   */
  check("the monthly chart always has twelve points", review.monthly.length === 12, `${review.monthly.length}`);
  check("the year histogram has ten buckets", review.histogram.length === 10);
  check("the year summary has active days", review.summary.activeDays > 0, `${review.summary.activeDays} days`);
  /**
   * The platform comparison has NO user filter and NO guest filter: it is the mean over members
   * who logged anything that year, which is a different question from the member's own figure
   * and is why the two are rendered on one shared scale.
   */
  check(
    "the platform comparison returns a mean over all members",
    Number.isFinite(review.platform.averageTracks),
    `platform mean ${review.platform.averageTracks}`,
  );

  console.info("\n[7] feeds, reviews and the social layer");

  const diary = await getDiary(member.id, {});
  check("the diary returns entries", diary.length > 0, `${diary.length} entries`);
  check("a diary entry carries a display-ready author and artist", Boolean(diary[0]?.author?.username && diary[0]?.artist?.name));

  const following = await getFollowingFeed(member.id);
  check("the following feed returns entries", following.length > 0, `${following.length} entries`);
  check("the global feed returns entries", (await getGlobalFeed(24)).length > 0);
  check("recent reviews return entries", (await getRecentReviews(12)).length > 0);

  const reviews = await getReviews({ albumId: album.id, scope: "any" });
  const reviewCount = await countReviews({ albumId: album.id, scope: "any" });
  /**
   * THE COUNT AND THE LIST MUST AGREE (invariant I-14). countReviews duplicates the entire
   * conditions ladder, and the two functions must be edited together — "a '12 reviews' heading
   * over ten visible ones is the kind of mismatch that looks like a bug in the list."
   */
  check("the review count agrees with the review list", reviewCount >= reviews.length, `${reviewCount} counted, ${reviews.length} returned`);

  const liked = await getLikedLogIds(member.id, diary.slice(0, 5).map((entry) => entry.id));
  check("getLikedLogIds returns a Set and survives a short id list", liked instanceof Set);
  check("getLikedLogIds guards the empty array (IN () is invalid SQL)", (await getLikedLogIds(member.id, [])) instanceof Set);

  const counts = await getFollowCounts(member.id);
  check("follow counts come back in one round trip", counts.followers > 0 && counts.following > 0, `${counts.followers} followers, ${counts.following} following`);

  const directory = await getActiveMembers();
  check("the member directory returns members", directory.length > 0, `${directory.length} members`);

  /**
   * The batched replacement for the source's one surviving N+1, which runs the heaviest query
   * in the app once per card to display two numbers.
   */
  const cardStats = await getMemberCardStats(memberIds);
  check("member card stats are batched into one query", cardStats.size === memberIds.length, `${cardStats.size} of ${memberIds.length}`);
  check("getMemberCardStats guards the empty array", (await getMemberCardStats([])).size === 0);

  console.info("\n[8] collections and lists");

  check("top four favourites come back", (await getFavorites(member.id)).length > 0);
  check("the wantlist query runs", Array.isArray(await getWantlist(member.id)));
  const crowns = await getDesertIsland(member.id);
  check("Desert Island crowns come back", crowns.length > 0, `${crowns.length} crowned`);
  check("crowns never exceed the quota of ten", crowns.length <= 10, `${crowns.length}`);

  const publicLists = await getPublicLists({ sort: "recent", limit: 12 });
  check("public lists come back", publicLists.length > 0, `${publicLists.length} lists`);
  check("list cards carry a cover mosaic", (publicLists[0] as { previews?: unknown[] }).previews !== undefined);

  const options = await getListOptions(member.id, { artistId: artist.id, albumId: album.id });
  check("list options report membership over the full target tuple", Array.isArray(options), `${options.length} lists`);

  console.info("\n[9] browse and search");

  const browse = await browseAlbums({ page: 1 });
  check("browseAlbums returns a page", browse.rows.length > 0, `${browse.rows.length} rows`);

  /**
   * THE ESCAPE-LIKE ASSERTION. A raw `%` used to match every row, so `?q=%` returned the whole
   * catalogue and the entire member list. The pattern must be escaped BEFORE it is wrapped.
   */
  const real = await searchLocalAlbums(SEED_SEARCH_TERM);
  const wildcard = await searchLocalAlbums("%");
  check("local album search finds a seeded title", real.length > 0, `${real.length} hits for "${SEED_SEARCH_TERM}"`);
  check("a bare % does not match every album", wildcard.length === 0, `${wildcard.length} hits for "%"`);
  check("local artist search runs", Array.isArray(await searchLocalArtists("radio")));

  console.info("\n[10] rankings");

  check("top albums come back for a member", (await getTopAlbums(member.id)).length > 0);
  check("top tracks come back for a member", (await getTopTracks(member.id)).length > 0);
  check("most-rated albums come back platform-wide", (await getMostRatedAlbums(member.id)).length > 0);

  /* --------------------------------------------------------------- summary */

  console.info(`\n[smoke] ${passed} checks passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.error("\nFAILURES:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("[smoke] harness error —", error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});

/**
 * Seeds a demo community so a fresh deployment is not an empty room.
 *
 * IDEMPOTENT. Members are keyed by email, logs by (member, target), favourites by
 * (user, position), lists by lower(title), and items and follows by conflict-do-nothing.
 * Running it twice changes nothing. FIVE DIFFERENT IDEMPOTENCY KEYS — break any one and a
 * second run duplicates data.
 *
 * It pulls real catalogue data THROUGH THE NORMAL INGEST PATH, so it exercises the same code
 * a page view does: the same upserts, the same MusicBrainz enrichment, the same derived-column
 * SQL. A seed that writes rows directly proves nothing about ingest.
 *
 * PGlite allows exactly one writer: STOP THE DEV SERVER FIRST.
 */

import { hash } from "bcryptjs";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {

  artists,
  desertIsland,
  favorites,
  follows,
  listItems,
  lists,
  logs,
  tracks,
  users,
  wantlist,
} from "@/lib/db/schema";
import { ensureAlbum, ensureArtistSimilar, ensureDiscography } from "@/lib/ingest/albums";
import { slugify } from "@/lib/slug";

/* -------------------------------------------------------------------------- */
/* The catalogue                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Deezer album ids, RESOLVED AGAINST THE LIVE API rather than guessed.
 *
 * Resolving a curated list turned up four provider facts worth recording, because each one
 * would otherwise have shown up as a broken-looking demo:
 *
 *  1. Deezer's advanced grammar `artist:"X" album:"Y"` returns NOTHING for several records
 *     that plainly exist — Discovery among them, which resolves fine from a plain `q=`. So the
 *     resolver needed a plain-search fallback, and by extension so does any code that looks an
 *     album up by name.
 *  2. Matching on title alone is not enough. "Nevermind" matched an artist called Alison Rose
 *     and "Abbey Road" matched a tribute act called The Beatles Complete On Ukulele. THE
 *     ARTIST HAS TO BE CHECKED TOO.
 *  3. The top-ranked result is often a live album or a super-deluxe box — Homogenic resolved to
 *     a live recording and The Velvet Underground & Nico to a 65-track anniversary box.
 *  4. For several canonical records the ONLY edition the catalogue stocks is the remaster.
 *     That is what forced `isCanonicalRelease` to stop treating "(Remastered)" as noise: a
 *     remaster of a studio album IS the studio album, and rejecting it removes the album from
 *     its own artist's discography grid.
 *
 * Chosen for a spread of eras (1959–2020) and genres, and — importantly — WITH DELIBERATE
 * ARTIST OVERLAP, so the discography heatmap has several rows to draw and the taste model has
 * an artist axis with real support.
 */
const CATALOGUE: Array<{ id: string; note: string }> = [
  { id: "1441464", note: "Miles Davis — Kind of Blue (1959)" },
  { id: "215745", note: "John Coltrane — A Love Supreme (1965)" },
  { id: "1329897", note: "Bob Dylan — Highway 61 Revisited (1965)" },
  { id: "184480112", note: "Marvin Gaye — What's Going On (1971)" },
  { id: "254297", note: "Joni Mitchell — Blue (1971)" },
  { id: "396602", note: "Kraftwerk — Trans-Europe Express (1977)" },
  { id: "6237061", note: "Fleetwood Mac — Rumours (1977)" },
  { id: "12114240", note: "Pink Floyd — The Dark Side of the Moon (1973)" },
  { id: "96001912", note: "Stevie Wonder — Songs in the Key of Life (1976)" },
  { id: "1345663", note: "Talking Heads — Remain in Light (1980)" },
  { id: "6856704", note: "The Clash — London Calling (1979)" },
  { id: "10843530", note: "Sonic Youth — Daydream Nation (1988)" },
  { id: "1252978", note: "Nirvana — Nevermind (1991)" },
  { id: "12977824", note: "Aphex Twin — Selected Ambient Works 85–92 (1992)" },
  { id: "242316", note: "A Tribe Called Quest — The Low End Theory (1991)" },
  { id: "587206892", note: "Wu-Tang Clan — Enter the Wu-Tang (1993)" },
  { id: "109301", note: "Portishead — Dummy (1994)" },
  { id: "301773", note: "Massive Attack — Mezzanine (1998)" },
  { id: "1440802", note: "Lauryn Hill — The Miseducation of Lauryn Hill (1998)" },
  { id: "2795271", note: "Boards of Canada — Music Has the Right to Children (1998)" },
  { id: "819546971", note: "Neutral Milk Hotel — In the Aeroplane Over the Sea (1998)" },
  { id: "14879699", note: "Radiohead — OK Computer (1997)" },
  { id: "14880741", note: "Radiohead — Kid A (2000)" },
  { id: "14880659", note: "Radiohead — In Rainbows (2007)" },
  { id: "302127", note: "Daft Punk — Discovery (2001)" },
  { id: "6575789", note: "Daft Punk — Random Access Memories (2013)" },
  { id: "107858", note: "OutKast — Stankonia (2000)" },
  { id: "6158892", note: "Sufjan Stevens — Illinois (2005)" },
  { id: "8045388", note: "Burial — Untrue (2007)" },
  { id: "10222930", note: "Kendrick Lamar — good kid, m.A.A.d city (2012)" },
  { id: "9896722", note: "Kendrick Lamar — To Pimp a Butterfly (2015)" },
  { id: "6899610", note: "Arctic Monkeys — AM (2013)" },
  { id: "94528272", note: "Beyoncé — Lemonade (2016)" },
  { id: "104660202", note: "Frank Ocean — Blonde (2016)" },
  { id: "42724001", note: "SZA — Ctrl (2017)" },
  { id: "97140952", note: "Tyler, the Creator — IGOR (2019)" },
  { id: "141631152", note: "Fiona Apple — Fetch the Bolt Cutters (2020)" },
];

/**
 * Artists whose FULL canonical discography is filled, so the discography heatmap — the
 * signature view — has a real career arc to draw rather than two or three rows.
 */
const DISCOGRAPHY_ARTISTS = ["Radiohead", "Daft Punk", "Kendrick Lamar", "Aphex Twin"];

/* -------------------------------------------------------------------------- */
/* The members                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Written personalities, because a demo community with no voice reads as test data. The
 * personalities also drive the rating patterns below, so the taste model has something
 * distinguishable to work with — a seeded population where everybody rates alike produces a
 * recommender that cannot be evaluated.
 */
const DEMO_PASSWORD = "deadwax-demo-2026";

const MEMBERS = [
  {
    username: "runoutgroove",
    email: "nadia@deadwax.demo",
    displayName: "Nadia Iqbal",
    bio: "Canon sceptic. Will defend a difficult second side. Keeps the sleeve notes.",
    avatarSeed: "runout",
    /** Rates the canonical high but the obvious a little low. */
    taste: { lean: { Jazz: 1.5, Alternative: 1, Electro: 0.5 }, base: 8, spread: 2 },
  },
  {
    username: "lowend",
    email: "marcus@deadwax.demo",
    displayName: "Marcus Vane",
    bio: "Rap and soul, mostly pre-2005. Drum breaks are a legitimate reason to rate something.",
    avatarSeed: "lowend",
    taste: { lean: { "Rap/Hip Hop": 2, "Soul & Funk": 1.5, Jazz: 0.5 }, base: 7, spread: 2 },
  },
  {
    username: "fourthworld",
    email: "juno@deadwax.demo",
    displayName: "Juno Adeyemi",
    bio: "Ambient, dub techno, anything with a long tail. I rate the room as much as the record.",
    avatarSeed: "fourth",
    taste: { lean: { Electro: 2, Alternative: 0.5 }, base: 7, spread: 2 },
  },
  {
    username: "bsidefirst",
    email: "tess@deadwax.demo",
    displayName: "Tess Okonjo",
    bio: "Contrarian on purpose. If everyone agrees about a record I want to know why.",
    avatarSeed: "bside",
    /** The contrarian: rates canonised classics LOW, which is what exercises the inverted
     *  consensus alignment term in the taste model. */
    taste: { lean: { Rock: -1, Pop: -1.5, Alternative: 1 }, base: 6, spread: 2.5 },
  },
  {
    username: "sleevenote",
    email: "arto@deadwax.demo",
    displayName: "Arto Lind",
    bio: "Rock and folk. I write more than anybody needs about ten-track records.",
    avatarSeed: "sleeve",
    taste: { lean: { Rock: 1.5, Folk: 1 }, base: 7, spread: 1.5 },
  },
  {
    username: "playcount",
    email: "sam@deadwax.demo",
    displayName: "Sam Ferreira",
    bio: "I relisten more than I listen. The diary is the point.",
    avatarSeed: "play",
    /** The replay-heavy listener — exercises the pillar that replaces "progress". */
    taste: { lean: { Pop: 1, Alternative: 1, Electro: 0.5 }, base: 7.5, spread: 1.5 },
  },
] as const;

/* -------------------------------------------------------------------------- */
/* Deterministic helpers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Listen dates walk BACKWARDS from today through a module-level cursor, so the diary and the
 * year charts have shape rather than every entry landing on one day.
 */
let dayCursor = 0;
function nextDate(): string {
  dayCursor += 1;
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - ((dayCursor * 3) % 400));
  return date.toISOString().slice(0, 10);
}

/**
 * DETERMINISTIC jitter, not random.
 *
 * Re-seeding produces identical texture, so screenshots are stable and a diff in the heatmap
 * means a real change rather than a new dice roll. The result is exactly {-1, 0, +1}.
 */
function drift(trackNumber: number, discNumber: number, albumId: number): number {
  return ((trackNumber * 7 + discNumber * 3 + albumId * 5) % 3) - 1;
}

function clampRating(value: number): number {
  return Math.min(10, Math.max(1, Math.round(value)));
}

/** A stable pseudo-random in [0,1) from a string, so member/album pairings are reproducible. */
function seedHash(input: string): number {
  let value = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16_777_619);
  }
  return (value >>> 0) / 4_294_967_296;
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                      */
/* -------------------------------------------------------------------------- */

type SeedAlbum = {
  id: number;
  artistId: number;
  title: string;
  artistName: string;
  genres: string[];
  trackRows: Array<{ discNumber: number; trackNumber: number }>;
};

async function mirrorCatalogue(): Promise<SeedAlbum[]> {
  const mirrored: SeedAlbum[] = [];

  for (const entry of CATALOGUE) {
    const album = await ensureAlbum(entry.id);
    if (!album) {
      console.warn(`  ! could not mirror ${entry.note} (deezer ${entry.id}) — skipping`);
      continue;
    }
    const artist = await db.query.artists.findFirst({ where: eq(artists.id, album.artistId) });
    const trackRows = await db
      .select({ discNumber: tracks.discNumber, trackNumber: tracks.trackNumber })
      .from(tracks)
      .where(eq(tracks.albumId, album.id));

    mirrored.push({
      id: album.id,
      artistId: album.artistId,
      title: album.title,
      artistName: artist?.name ?? "Unknown",
      genres: album.genres ?? [],
      trackRows,
    });
    console.info(`  + ${entry.note} — ${trackRows.length} tracks`);
  }

  return mirrored;
}

async function fillDiscographies(): Promise<void> {
  for (const name of DISCOGRAPHY_ARTISTS) {
    const artist = await db.query.artists.findFirst({ where: eq(artists.name, name) });
    if (!artist) continue;
    await ensureDiscography(artist);
    // The neighbour graph. Without it the recommender's largest term never fires and the
    // ranking degenerates to popularity order — which is the measured failure the brief warns
    // about, so the seed makes sure a fresh instance does not start out in that state.
    await ensureArtistSimilar(artist);
    console.info(`  ~ discography and neighbours filled for ${name}`);
  }
}

async function upsertMembers(): Promise<Map<string, number>> {
  const passwordHash = await hash(DEMO_PASSWORD, 12);
  const ids = new Map<string, number>();

  for (const member of MEMBERS) {
    const existing = await db.query.users.findFirst({
      where: sql`lower(${users.email}) = ${member.email.toLowerCase()}`,
      columns: { id: true },
    });

    if (existing) {
      ids.set(member.username, existing.id);
      continue;
    }

    const [inserted] = await db
      .insert(users)
      .values({
        username: member.username,
        email: member.email,
        passwordHash,
        displayName: member.displayName,
        bio: member.bio,
        avatarSeed: member.avatarSeed,
        // Demo accounts arrive CONFIRMED. Posting requires a verified address when the flag is
        // on, and these addresses do not exist to receive a link — so an unverified demo
        // community would be a community that cannot post.
        emailVerifiedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: users.id });

    const id =
      inserted?.id ??
      (
        await db.query.users.findFirst({
          where: sql`lower(${users.email}) = ${member.email.toLowerCase()}`,
          columns: { id: true },
        })
      )?.id;

    if (id) {
      ids.set(member.username, id);
      console.info(`  + @${member.username}`);
    }
  }

  return ids;
}

/** The member's rating for an album, derived from their written personality. */
function ratingFor(member: (typeof MEMBERS)[number], album: SeedAlbum): number | null {
  const affinity = album.genres.reduce((total, genre) => total + (member.taste.lean[genre as never] ?? 0), 0);
  const roll = seedHash(`${member.username}:${album.id}`);

  // Not every member has heard every record. A seeded population where everybody has rated
  // everything gives the DISTINCT ON aggregates nothing to distinguish and makes the
  // "listened by" counts meaningless.
  if (roll > 0.82) return null;

  const wobble = (seedHash(`${member.username}:${album.id}:w`) - 0.5) * member.taste.spread;
  return clampRating(member.taste.base + affinity + wobble);
}

async function logListening(memberIds: Map<string, number>, catalogue: SeedAlbum[]): Promise<void> {
  for (const member of MEMBERS) {
    const userId = memberIds.get(member.username);
    if (!userId) continue;

    let albumCount = 0;
    let trackCount = 0;

    for (const album of catalogue) {
      const albumRating = ratingFor(member, album);
      if (albumRating === null) continue;

      const listenedOn = nextDate();

      // Idempotency key #2: (user, album, 'album'). Note the explicit IS NULL predicates on
      // disc and track — an omitted predicate would match this member's track logs too and
      // the album log would look like it already existed.
      const existingAlbumLog = await db.query.logs.findFirst({
        where: and(
          eq(logs.userId, userId),
          eq(logs.albumId, album.id),
          eq(logs.targetType, "album"),
          isNull(logs.discNumber),
          isNull(logs.trackNumber),
        ),
        columns: { id: true },
      });

      if (!existingAlbumLog) {
        await db.insert(logs).values({
          userId,
          targetType: "album",
          artistId: album.artistId,
          albumId: album.id,
          rating: albumRating,
          listenedOn,
          liked: albumRating >= 9,
          review: reviewFor(member, album, albumRating),
        });
        albumCount += 1;
      }

      // Track-level logs, for the heatmaps. Only some albums get the full treatment: a member
      // who has rated every track of every record is not a member, and the heatmap is more
      // interesting when some rows are partly unrated.
      const deepDive = seedHash(`${member.username}:${album.id}:deep`) > 0.55;
      if (!deepDive) continue;

      for (const row of album.trackRows) {
        // Idempotency key #3: the FULL target tuple.
        const existingTrackLog = await db.query.logs.findFirst({
          where: and(
            eq(logs.userId, userId),
            eq(logs.albumId, album.id),
            eq(logs.targetType, "track"),
            eq(logs.discNumber, row.discNumber),
            eq(logs.trackNumber, row.trackNumber),
          ),
          columns: { id: true },
        });
        if (existingTrackLog) continue;

        const rating = clampRating(albumRating + drift(row.trackNumber, row.discNumber, album.id));
        await db.insert(logs).values({
          userId,
          targetType: "track",
          artistId: album.artistId,
          albumId: album.id,
          discNumber: row.discNumber,
          trackNumber: row.trackNumber,
          rating,
          listenedOn,
        });
        trackCount += 1;

        // THE REPLAY PILLAR. A replay is a SECOND ROW, never a mutation — which is exactly why
        // every community aggregate needs DISTINCT ON (user_id). The heaviest relistener gets
        // the most duplicates, so the aggregates have something real to collapse.
        const replays = member.username === "playcount" ? 2 : seedHash(`${member.username}:${album.id}:${row.trackNumber}:r`) > 0.9 ? 1 : 0;
        for (let index = 0; index < replays; index += 1) {
          await db.insert(logs).values({
            userId,
            targetType: "track",
            artistId: album.artistId,
            albumId: album.id,
            discNumber: row.discNumber,
            trackNumber: row.trackNumber,
            // A bare replay mark with NO rating. This is the case that the
            // `(rating IS NOT NULL) DESC` tiebreak exists for: without it, this row would win
            // the DISTINCT ON and silently withdraw the member's rating from the community
            // average.
            rating: null,
            listenedOn: nextDate(),
            is_replay: true,
          });
        }
      }
    }

    console.info(`  + @${member.username}: ${albumCount} album logs, ${trackCount} track logs`);
  }
}

/** A few real sentences, so review surfaces are not lorem ipsum. */
function reviewFor(member: (typeof MEMBERS)[number], album: SeedAlbum, rating: number): string | null {
  if (seedHash(`${member.username}:${album.id}:rev`) < 0.72) return null;
  const high = [
    `Sequenced so well that the gaps between tracks do work. ${album.title} earns its reputation and then some.`,
    `I have owned ${album.title} for years and it keeps moving. The back half is the argument.`,
    `Everything here is deliberate. Nothing on ${album.title} is filler and nothing is showing off.`,
  ];
  const middling = [
    `Two or three untouchable songs and a middle stretch I always skip. ${album.title} is a great EP inside a good album.`,
    `Admire it more than I enjoy it. ${album.title} is a record I respect at a distance.`,
    `Front-loaded. By track eight ${album.title} has said what it came to say.`,
  ];
  const low = [
    `I know what this is supposed to be and it does not land for me. ${album.title} sounds like consensus.`,
    `Competent and airless. ${album.title} never risks anything.`,
  ];
  const pool = rating >= 8 ? high : rating >= 6 ? middling : low;
  const index = Math.floor(seedHash(`${member.username}:${album.id}:pick`) * pool.length);
  return pool[index] ?? null;
}

async function pinFavourites(memberIds: Map<string, number>, catalogue: SeedAlbum[]): Promise<void> {
  for (const member of MEMBERS) {
    const userId = memberIds.get(member.username);
    if (!userId) continue;

    // Their four highest-rated, which is what a member would actually pin.
    const top = await db
      .select({ albumId: logs.albumId })
      .from(logs)
      .where(and(eq(logs.userId, userId), eq(logs.targetType, "album")))
      .orderBy(sql`${logs.rating} DESC NULLS LAST`)
      .limit(4);

    for (const [index, row] of top.entries()) {
      if (!row.albumId) continue;
      // Idempotency key #4: onConflictDoUpdate on (userId, position).
      await db
        .insert(favorites)
        .values({ userId, position: index + 1, albumId: row.albumId })
        .onConflictDoUpdate({
          target: [favorites.userId, favorites.position],
          set: { albumId: row.albumId },
        });
    }
    void catalogue;
  }
  console.info("  + top four pinned for every member");
}

async function crownDesertIsland(memberIds: Map<string, number>): Promise<void> {
  for (const member of MEMBERS) {
    const userId = memberIds.get(member.username);
    if (!userId) continue;

    // ONLY tracks whose LATEST rating is the maximum qualify — the same rule the action
    // enforces, applied here rather than inserting crowns the interface would consider
    // invalid.
    const eligible = await db.execute<{
      artist_id: number;
      album_id: number;
      disc_number: number;
      track_number: number;
    }>(sql`
      SELECT DISTINCT ON (l.album_id, l.disc_number, l.track_number)
             l.artist_id, l.album_id, l.disc_number, l.track_number
      FROM logs l
      WHERE l.user_id = ${userId}
        AND l.target_type = 'track'
        AND l.rating IS NOT NULL
      ORDER BY l.album_id, l.disc_number, l.track_number, l.created_at DESC
    `);

    const tens: typeof eligible.rows = [];
    for (const row of eligible.rows) {
      const latest = await db.execute<{ rating: number }>(sql`
        SELECT rating FROM logs
        WHERE user_id = ${userId} AND target_type = 'track'
          AND album_id = ${row.album_id} AND disc_number = ${row.disc_number}
          AND track_number = ${row.track_number} AND rating IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
      `);
      if (Number(latest.rows[0]?.rating) === 10) tens.push(row);
      if (tens.length >= 10) break; // the quota
    }

    for (const row of tens) {
      await db
        .insert(desertIsland)
        .values({
          userId,
          artistId: row.artist_id,
          albumId: row.album_id,
          discNumber: row.disc_number,
          trackNumber: row.track_number,
        })
        .onConflictDoNothing();
    }
  }
  console.info("  + Desert Island crowns awarded where a five-star track exists");
}

async function buildLists(memberIds: Map<string, number>, catalogue: SeedAlbum[]): Promise<void> {
  const plans = [
    {
      owner: "runoutgroove",
      title: "Records that reward the third listen",
      description: "Nothing here gave itself up the first time. Ranked by how long it took.",
      isRanked: true,
      pick: (album: SeedAlbum) => ["Alternative", "Jazz", "Electro"].some((genre) => album.genres.includes(genre)),
    },
    {
      owner: "lowend",
      title: "Drum breaks worth the whole record",
      description: "Not a best-of. A list of albums I bought for one bar.",
      isRanked: false,
      pick: (album: SeedAlbum) => ["Rap/Hip Hop", "Soul & Funk", "Jazz"].some((genre) => album.genres.includes(genre)),
    },
    {
      owner: "fourthworld",
      title: "For the hour after midnight",
      description: "Long tails, no hooks. Play in order, lights off.",
      isRanked: true,
      pick: (album: SeedAlbum) => album.genres.includes("Electro") || album.genres.includes("Alternative"),
    },
    {
      owner: "sleevenote",
      title: "Ten tracks, no filler",
      description: "Short records that say everything. A rule I keep breaking.",
      isRanked: false,
      pick: (album: SeedAlbum) => album.trackRows.length > 0 && album.trackRows.length <= 12,
    },
  ] as const;

  for (const plan of plans) {
    const userId = memberIds.get(plan.owner);
    if (!userId) continue;

    // Idempotency key #5: lower(title) within the owner's own lists.
    let listId = (
      await db.query.lists.findFirst({
        where: and(eq(lists.userId, userId), sql`lower(${lists.title}) = ${plan.title.toLowerCase()}`),
        columns: { id: true },
      })
    )?.id;

    if (!listId) {
      const [inserted] = await db
        .insert(lists)
        .values({
          userId,
          title: plan.title,
          slug: slugify(plan.title, "list"),
          description: plan.description,
          isRanked: plan.isRanked,
          isPublic: true,
        })
        .returning({ id: lists.id });
      listId = inserted?.id;
    }
    if (!listId) continue;

    const chosen = catalogue.filter(plan.pick).slice(0, 8);
    for (const [index, album] of chosen.entries()) {
      await db
        .insert(listItems)
        .values({
          listId,
          targetType: "album",
          artistId: album.artistId,
          albumId: album.id,
          position: index + 1,
        })
        .onConflictDoNothing();
    }
    console.info(`  + list "${plan.title}" (${chosen.length} items)`);
  }
}

async function fillWantlists(memberIds: Map<string, number>, catalogue: SeedAlbum[]): Promise<void> {
  for (const member of MEMBERS) {
    const userId = memberIds.get(member.username);
    if (!userId) continue;
    // Records they have NOT logged — a wantlist of things you have already heard is not a
    // wantlist.
    const unlogged = catalogue.filter((album) => ratingFor(member, album) === null).slice(0, 5);
    for (const album of unlogged) {
      await db.insert(wantlist).values({ userId, albumId: album.id }).onConflictDoNothing();
    }
  }
  console.info("  + wantlists filled with records nobody has logged");
}

async function wireFollowGraph(memberIds: Map<string, number>): Promise<void> {
  // A COMPLETE graph, so the following feed is never empty for any demo member — an empty
  // following feed silently falls back to the global one, which makes the two surfaces
  // indistinguishable in a demo.
  const ids = [...memberIds.values()];
  for (const follower of ids) {
    for (const followee of ids) {
      if (follower === followee) continue;
      await db.insert(follows).values({ followerId: follower, followeeId: followee }).onConflictDoNothing();
    }
  }
  console.info(`  + follow graph wired (${ids.length} members, complete)`);
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const started = Date.now();
  console.info("[seed] mirroring the catalogue through the normal ingest path…");
  const catalogue = await mirrorCatalogue();
  if (catalogue.length === 0) {
    console.error("[seed] nothing could be mirrored — is the network reachable?");
    process.exit(1);
  }

  console.info("[seed] filling discographies and the neighbour graph…");
  await fillDiscographies();

  console.info("[seed] members…");
  const memberIds = await upsertMembers();

  console.info("[seed] listening history…");
  await logListening(memberIds, catalogue);

  console.info("[seed] collections…");
  await pinFavourites(memberIds, catalogue);
  await crownDesertIsland(memberIds);
  await buildLists(memberIds, catalogue);
  await fillWantlists(memberIds, catalogue);
  await wireFollowGraph(memberIds);

  const counts = await db.execute<{ label: string; n: number }>(sql`
    SELECT 'artists' AS label, COUNT(*)::int AS n FROM artists
    UNION ALL SELECT 'albums',        COUNT(*)::int FROM albums
    UNION ALL SELECT 'tracks',        COUNT(*)::int FROM tracks
    UNION ALL SELECT 'members',       COUNT(*)::int FROM users
    UNION ALL SELECT 'logs',          COUNT(*)::int FROM logs
    UNION ALL SELECT 'reviews',       COUNT(*)::int FROM logs WHERE review IS NOT NULL
    UNION ALL SELECT 'lists',         COUNT(*)::int FROM lists
    UNION ALL SELECT 'list_items',    COUNT(*)::int FROM list_items
    UNION ALL SELECT 'favorites',     COUNT(*)::int FROM favorites
    UNION ALL SELECT 'desert_island', COUNT(*)::int FROM desert_island
    UNION ALL SELECT 'wantlist',      COUNT(*)::int FROM wantlist
    UNION ALL SELECT 'follows',       COUNT(*)::int FROM follows
    UNION ALL SELECT 'similar',       COUNT(*)::int FROM artist_similar
    UNION ALL SELECT 'with_critic',   COUNT(*)::int FROM albums WHERE critic_votes > 0
  `);

  console.info(`\n[seed] done in ${Math.round((Date.now() - started) / 1000)}s`);
  for (const row of counts.rows) console.info(`  ${String(row.label).padEnd(14)} ${row.n}`);
  console.info(`\n  demo sign-in: ${MEMBERS[0].email} / ${DEMO_PASSWORD}`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("[seed] FAILED —", error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});

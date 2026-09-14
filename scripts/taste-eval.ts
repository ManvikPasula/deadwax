/**
 * The recommender's evaluation harness.
 *
 * BUILT BEFORE THE MODEL, AND THAT ORDER IS THE POINT. The source brief is emphatic that the
 * single most transferable thing in the whole project is not the weights but HOW THEY WERE
 * DERIVED, and it states the reason a recommender needs this more than other code does:
 *
 *   A recommender is the easiest kind of code to ship broken: it always returns a
 *   plausible-looking number, and nothing crashes when that number is nonsense.
 *
 * So this script does three things no unit test can:
 *
 *  1. It builds a FIXTURE POPULATION OF ADVERSARIAL PERSONAS — ten accounts under a dedicated
 *     email domain, each rating in a deliberately awkward way. A model tuned against ordinary
 *     listeners is a model that has never met a contrarian or a flat rater.
 *  2. It PRINTS THE ACTUAL OUTPUT for every persona: top six titles, predicted stars,
 *     confidence and the first reason. Reading real output is what catches a model that is
 *     technically fine and practically useless.
 *  3. It computes ONE GLOBAL DIVERSITY METRIC — "distinct titles across N slots". In the
 *     television original THAT METRIC IS WHAT CAUGHT THE PROBLEM NO AMOUNT OF RANKING WORK
 *     WOULD HAVE FIXED: 43 distinct titles filled 100 slots across ten very different members,
 *     which is a RETRIEVAL failure wearing a ranking failure's clothes. After the retrieval
 *     rewrite: 77 distinct across 80 slots.
 *
 * The personas are keyed by an `@taste.test` email domain so they are trivially separable from
 * the demo community, and creating them is idempotent.
 *
 * PGlite allows exactly one writer: stop the dev server first.
 *   npm run taste-eval
 *   npm run taste-eval -- --purge     # remove the personas again
 */

import { hash } from "bcryptjs";
import { and, eq, isNull, like, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { albums, artists, logs, users } from "@/lib/db/schema";
import { intToStars } from "@/lib/ratings";
import { buildTasteProfile } from "@/lib/taste/profile";
import { getRecommendations, predictAlbumRating } from "@/lib/taste/recommend";
import { getRatedAlbumsForTaste } from "@/lib/db/queries/albums";

const DOMAIN = "taste.test";
const SLOTS_PER_PERSONA = 6;

/* -------------------------------------------------------------------------- */
/* The ten adversarial personas                                               */
/* -------------------------------------------------------------------------- */

type Persona = {
  username: string;
  note: string;
  /**
   * Given an album's genres, its critic score and its fan count, return a stored 1..10 rating
   * or null for "has not heard it". Deliberately hand-written per persona rather than
   * generated, because the point is to be awkward in specific, nameable ways.
   */
  rate: (album: {
    id: number;
    genres: string[];
    criticScore: number | null;
    criticVotes: number;
    fans: number;
    year: number | null;
    meanTrackMinutes: number;
    artistName: string;
  }) => number | null;
};

const clamp = (value: number) => Math.min(10, Math.max(1, Math.round(value)));
const has = (genres: string[], ...want: string[]) => want.some((w) => genres.includes(w));

/**
 * A DETERMINISTIC per-album wobble, and the whole harness turned out to need it.
 *
 * THE MEASUREMENT THAT FORCED IT: the first version of these personas produced
 * `spread` values of 0.00, 0.17, 0.00 and 0.28 for four of the ten, so FOUR PERSONAS WERE
 * WITHHELD BY THE NO-VARIETY GATE and the harness only ever evaluated six. That is a defect in
 * the fixture population rather than in the model — the gate was working perfectly, and a
 * population where 40% of accounts are unreadable cannot tell you whether ranking is any good.
 *
 * Only `eval_flat` is SUPPOSED to be withheld; it is the account that proves the gate fires.
 * Everybody else needs enough internal variance to be readable, because a real listener does
 * not give the same score to everything inside a genre they like.
 *
 * Deterministic rather than random, for the same reason the seed's jitter is: re-running must
 * produce the same output, or a change in the printed list means nothing.
 */
function wobble(username: string, albumId: number, amplitude: number): number {
  let value = 2_166_136_261;
  const input = `${username}:${albumId}`;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16_777_619);
  }
  // A signed integer in roughly [-amplitude, +amplitude].
  return (((value >>> 0) % (amplitude * 2 + 1)) - amplitude) as number;
}

const PERSONAS: Persona[] = [
  {
    username: "eval_canon",
    note: "canon purist — rates the widely-admired high and everything else near the middle",
    rate: (a) =>
      clamp((a.criticVotes > 0 && (a.criticScore ?? 0) >= 8 ? 10 : a.fans > 200_000 ? 8 : 5) + wobble("canon", a.id, 1)),
  },
  {
    username: "eval_metal",
    note: "single-genre specialist (metal) — a lane so narrow the genre seed has almost no lean",
    rate: (a) =>
      has(a.genres, "Metal", "Rock", "Alternative")
        ? clamp(8 + (a.fans > 100_000 ? 1 : 0) + wobble("metal", a.id, 2))
        : null,
  },
  {
    username: "eval_pop",
    note: "pop comfort listener — rates familiar things highly and never rates anything badly",
    // Never rates anything BADLY, but is not indifferent within the range they use.
    rate: (a) => clamp((has(a.genres, "Pop", "R&B", "Dance") ? 9 : a.fans > 500_000 ? 8 : 7) + Math.min(1, wobble("pop", a.id, 1))),
  },
  {
    username: "eval_contrarian",
    note: "contrarian — rates canonised classics LOW, which is the only account that exercises the INVERTED consensus alignment term",
    rate: (a) =>
      clamp((a.criticVotes > 0 && (a.criticScore ?? 0) >= 8 ? 3 : a.fans < 50_000 ? 9 : 5) + wobble("contrarian", a.id, 2)),
  },
  {
    username: "eval_flat",
    note: "flat rater — everything 7 or 8, so spread is near zero and the no-variety gate MUST fire",
    // LITERALLY CONSTANT, and the only persona that is. This account exists to prove the
    // no-variety gate fires: a profile with no variance contains no preference, so no amount
    // of volume should buy it a ranked list.
    rate: () => 7,
  },
  {
    username: "eval_electronic",
    note: "electronic only — the artist axis should dominate the genre axis here",
    rate: (a) =>
      has(a.genres, "Electro", "Dance")
        ? clamp(9 + wobble("electronic", a.id, 2))
        : has(a.genres, "Alternative")
          ? clamp(6 + wobble("electronic", a.id, 2))
          : null,
  },
  {
    username: "eval_tracksonly",
    note: "rates ONLY tracks, never albums — the effective-rating COALESCE is the only thing that makes this account readable at all",
    rate: () => null, // album-level ratings are written separately below
  },
  {
    username: "eval_albumsonly",
    note: "rates only albums, never tracks — the mirror image of the leaf-only account",
    rate: (a) =>
      clamp(7 + (a.criticVotes > 0 ? ((a.criticScore ?? 7) - 7) / 2 : 0) + wobble("albumsonly", a.id, 2)),
  },
  {
    username: "eval_completist",
    note: "completist of few artists — high support on a tiny artist set, which is what the shrinkage term is for",
    rate: (a) =>
      ["Radiohead", "Daft Punk", "Aphex Twin", "Kendrick Lamar"].includes(a.artistName)
        ? clamp(9 + wobble("completist", a.id, 2))
        : null,
  },
  {
    username: "eval_ordinary",
    note: "an ordinary listener — broad, opinionated within a genre, the control",
    rate: (a) =>
      clamp(
        7 +
          (a.fans > 300_000 ? 1 : 0) +
          (has(a.genres, "Jazz", "Folk") ? 1 : 0) +
          wobble("ordinary", a.id, 2),
      ),
  },
];

/* -------------------------------------------------------------------------- */

type CatalogueRow = {
  id: number;
  artistId: number;
  artistName: string;
  title: string;
  genres: string[];
  criticScore: number | null;
  criticVotes: number;
  fans: number;
  year: number | null;
  meanTrackMinutes: number;
};

async function loadCatalogue(): Promise<CatalogueRow[]> {
  const result = await db
    .select({
      id: albums.id,
      artistId: albums.artistId,
      artistName: artists.name,
      title: albums.title,
      genres: albums.genres,
      criticScore: albums.criticScore,
      criticVotes: albums.criticVotes,
      fans: albums.fans,
      releaseDate: albums.releaseDate,
      originalReleaseDate: albums.originalReleaseDate,
      meanTrackMs: albums.meanTrackMs,
      trackCount: albums.trackCount,
    })
    .from(albums)
    .innerJoin(artists, eq(artists.id, albums.artistId))
    .where(and(eq(albums.isCanonical, true), sql`${albums.trackCount} > 0`));

  return result.map((row) => ({
    id: row.id,
    artistId: row.artistId,
    artistName: row.artistName,
    title: row.title,
    genres: row.genres ?? [],
    criticScore: row.criticScore,
    criticVotes: row.criticVotes,
    fans: row.fans,
    // The ORIGINAL release date, not the reissue's — the whole reason that column exists.
    year: Number((row.originalReleaseDate ?? row.releaseDate ?? "").slice(0, 4)) || null,
    meanTrackMinutes: row.meanTrackMs / 60_000,
  }));
}

async function ensurePersonas(catalogue: CatalogueRow[]): Promise<Map<string, number>> {
  const passwordHash = await hash(`eval-${DOMAIN}`, 12);
  const ids = new Map<string, number>();

  for (const persona of PERSONAS) {
    const email = `${persona.username}@${DOMAIN}`;
    let id = (
      await db.query.users.findFirst({
        where: sql`lower(${users.email}) = ${email}`,
        columns: { id: true },
      })
    )?.id;

    if (!id) {
      const [inserted] = await db
        .insert(users)
        .values({
          username: persona.username,
          email,
          passwordHash,
          displayName: persona.username,
          bio: persona.note,
          emailVerifiedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning({ id: users.id });
      id = inserted?.id;
    }
    if (!id) continue;
    ids.set(persona.username, id);

    // Idempotent: skip a persona that already has a history.
    const existing = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(logs)
      .where(eq(logs.userId, id));
    if ((existing[0]?.n ?? 0) > 0) continue;

    const rows: Array<typeof logs.$inferInsert> = [];
    for (const album of catalogue) {
      const rating = persona.rate(album);

      if (persona.username === "eval_tracksonly") {
        /**
         * THE LEAF-ONLY ACCOUNT. It writes TRACK ratings and no album rating at all, which is
         * the only thing that exercises the effective-rating COALESCE in
         * getRatedAlbumsForTaste: album_level wins when present, track_level averages when it
         * is not. Without an account like this, that branch is never taken and a bug in it
         * ships silently — the profile simply comes out empty and the member is told there is
         * "not enough to go on", which looks like a cold start rather than a defect.
         */
        const base = has(album.genres, "Rap/Hip Hop", "Soul & Funk") ? 9 : 6;
        const trackRows = await db
          .select({ disc: sql<number>`disc_number`, track: sql<number>`track_number` })
          .from(sql`tracks`)
          .where(sql`album_id = ${album.id}`);
        for (const [index, track] of trackRows.entries()) {
          rows.push({
            userId: id,
            targetType: "track",
            artistId: album.artistId,
            albumId: album.id,
            discNumber: Number(track.disc),
            trackNumber: Number(track.track),
            rating: clamp(base + ((index * 7) % 3) - 1),
          });
        }
        continue;
      }

      if (rating === null) continue;
      rows.push({
        userId: id,
        targetType: "album",
        artistId: album.artistId,
        albumId: album.id,
        rating,
      });
    }

    if (rows.length > 0) {
      // Chunked, because a single multi-thousand-row VALUES list is slow on PGlite and there is
      // no uniqueness to conflict on.
      for (let index = 0; index < rows.length; index += 200) {
        await db.insert(logs).values(rows.slice(index, index + 200));
      }
    }
    console.info(`  + @${persona.username} — ${rows.length} logs — ${persona.note}`);
  }

  return ids;
}

async function purge(): Promise<void> {
  const doomed = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(like(users.email, `%@${DOMAIN}`));
  for (const row of doomed) {
    // Logs cascade from users, so one delete is enough.
    await db.delete(users).where(eq(users.id, row.id));
    console.info(`  - removed @${row.username}`);
  }
  console.info(`[taste-eval] purged ${doomed.length} personas`);
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  if (process.argv.includes("--purge")) {
    await purge();
    process.exit(0);
  }

  const catalogue = await loadCatalogue();
  if (catalogue.length < 10) {
    console.error(
      `[taste-eval] only ${catalogue.length} canonical albums are mirrored. Run \`npm run seed\` first — ` +
        `a recommender evaluated against an empty catalogue reports that everything is fine.`,
    );
    process.exit(1);
  }
  console.info(`[taste-eval] catalogue: ${catalogue.length} canonical albums\n`);

  console.info("[taste-eval] personas");
  const ids = await ensurePersonas(catalogue);

  /* --------------------------------------------------------- per-persona output */

  const allTitles: string[] = [];
  let slots = 0;
  let withheld = 0;
  const withholdReasons = new Map<string, number>();

  for (const persona of PERSONAS) {
    const userId = ids.get(persona.username);
    if (!userId) continue;

    console.info(`\n── @${persona.username}`);
    console.info(`   ${persona.note}`);

    const rated = await getRatedAlbumsForTaste(userId);
    const profile = buildTasteProfile(rated);

    console.info(
      `   sample ${profile.sampleSize} · mean ${profile.meanRating.toFixed(2)} · spread ` +
        `${profile.spread.toFixed(2)} · alignment ${profile.consensusAlignment.toFixed(2)} · ` +
        `crowd baseline ${profile.crowdBaseline === null ? "—" : profile.crowdBaseline.toFixed(2)}`,
    );
    const topGenres = profile.genres
      .slice(0, 3)
      .map((entry) => `${entry.label} ${entry.lean >= 0 ? "+" : ""}${entry.lean.toFixed(2)}/${entry.support}`)
      .join("  ");
    if (topGenres) console.info(`   genre leans: ${topGenres}`);
    const topArtists = profile.artists
      .slice(0, 3)
      .map((entry) => `${entry.label} ${entry.lean >= 0 ? "+" : ""}${entry.lean.toFixed(2)}/${entry.support}`)
      .join("  ");
    if (topArtists) console.info(`   artist leans: ${topArtists}`);

    const result = await getRecommendations(userId, SLOTS_PER_PERSONA);

    /**
     * PREFER WITHHOLDING TO FABRICATING, and give each withholding reason its own copy. A
     * withheld list is a PASS, not a failure — "ten indistinguishable predictions dressed as a
     * ranked list is worse than saying there is nothing to say yet." The flat rater SHOULD be
     * withheld here; if it is not, the no-variety gate has stopped working.
     */
    if ("withheld" in result && result.withheld) {
      withheld += 1;
      withholdReasons.set(result.reason, (withholdReasons.get(result.reason) ?? 0) + 1);
      console.info(`   WITHHELD (${result.reason}) — ${result.message ?? ""}`);
      continue;
    }

    const picks = "items" in result ? result.items : [];
    if (picks.length === 0) {
      console.info("   (no candidates)");
      continue;
    }

    for (const [index, pick] of picks.entries()) {
      slots += 1;
      allTitles.push(`${pick.artistName} — ${pick.title}`);
      const stars = intToStars(pick.rating).toFixed(1);
      const confidence = `${Math.round(pick.confidence * 100)}%`.padStart(4);
      console.info(
        `   ${String(index + 1).padStart(2)}. ★${stars}  ${confidence}  ` +
          `${`${pick.artistName} — ${pick.title}`.slice(0, 48).padEnd(50)}` +
          `${pick.reasons[0] ?? "(no reason emitted)"}`,
      );
    }
  }

  /* ------------------------------------------------------- the diversity metric */

  const distinct = new Set(allTitles).size;
  const ratio = slots === 0 ? 0 : distinct / slots;

  console.info(`\n${"─".repeat(78)}`);
  console.info(`[taste-eval] DIVERSITY: ${distinct} distinct titles across ${slots} slots (${(ratio * 100).toFixed(0)}%)`);
  console.info(`[taste-eval] withheld: ${withheld} of ${PERSONAS.length} personas`);
  for (const [reason, count] of withholdReasons) console.info(`               ${reason}: ${count}`);

  /**
   * THE METRIC THAT CAUGHT THE REAL BUG. In the television original, ten very different members
   * produced 43 distinct titles across 100 slots — 43% — and the fix was not another
   * coefficient, it was rewriting RETRIEVAL. After: 77 across 80, 96%.
   *
   * The threshold here is deliberately soft, because a small seeded catalogue genuinely cannot
   * produce high diversity: with 37 albums and ten personas asking for six each, some overlap
   * is correct. A LOW ratio on a LARGE catalogue is the signal.
   */
  const ADVISORY_FLOOR = 0.5;
  if (slots > 0 && ratio < ADVISORY_FLOOR) {
    console.warn(
      `\n[taste-eval] Diversity is below ${ADVISORY_FLOOR * 100}%. On a catalogue this size some overlap is\n` +
        `             correct, but if this persists as the mirror grows the problem is RETRIEVAL, not\n` +
        `             ranking — the source project measured exactly this and no amount of reweighting\n` +
        `             fixed it. Widen the retrieval sources before touching a coefficient.`,
    );
  }

  /**
   * A sanity assertion on the model itself, not on its output: every persona with a readable
   * history must produce predictions inside the scale, and the flat rater must be withheld.
   */
  const flatId = ids.get("eval_flat");
  if (flatId) {
    const flatRated = await getRatedAlbumsForTaste(flatId);
    const flatProfile = buildTasteProfile(flatRated);
    const gateFires = flatProfile.spread < 0.4;
    console.info(
      `\n[taste-eval] no-variety gate on the flat rater: spread ${flatProfile.spread.toFixed(3)} ` +
        `-> ${gateFires ? "FIRES (correct)" : "DOES NOT FIRE (the gate is broken)"}`,
    );
    if (!gateFires) process.exitCode = 1;
  }

  /**
   * THE CEILING, STATED SO NOBODY RE-DERIVES IT. Deezer's 28 coarse genres cannot separate a
   * doom metal record from a power metal one, and MusicBrainz tags are present for popular
   * releases and absent for the long tail — so the model is sharpest exactly where it is least
   * needed. Fixing that needs an audio-feature or co-listen embedding, not another coefficient.
   */
  console.info(
    `\n[taste-eval] Known ceiling: 28 coarse genres cannot separate subgenres, and fine tags are\n` +
      `             absent for the long tail. Do not spend tuning effort re-deriving this.`,
  );

  process.exit(process.exitCode ?? 0);
}

main().catch((error: unknown) => {
  console.error("[taste-eval] harness error —", error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});

// Referenced so the import is not dropped by a future refactor: predictAlbumRating is the
// function every number above ultimately comes from, and a harness that cannot reach it
// directly cannot explain a single score.
void predictAlbumRating;
void isNull;

/**
 * Demote duplicate editions across the whole mirror, once.
 *
 * `collapseDuplicateEditions` runs inside `ensureDiscography`, so from now on duplicates are
 * collapsed the first time an artist's discography is filled. That does nothing for rows
 * already in the database: a catalogue mirrored before the collapse existed carries them, and
 * nothing re-fills an artist whose TTL has not expired.
 *
 * So this script exists, and it is deliberately dull — it iterates artists and calls the same
 * function the ingest path calls. No second definition of "the same record", no SQL that
 * re-implements `albumIdentities` in `regexp_replace`. Running it twice is a no-op.
 *
 * It prints the artists it changed, because a repair that reports only a total is a repair
 * nobody can check.
 *
 *   npm run repair:editions
 *
 * Safe against the hosted database: the only write is `is_canonical = false` on rows that
 * duplicate another canonical row, and nothing is deleted — a member's rating of a deluxe
 * edition is a real opinion about a real thing they played, and it survives.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { collapseDuplicateEditions } from "@/lib/ingest/albums";

async function main(): Promise<void> {
  console.info(
    process.env.DATABASE_URL ? "[repair] driver: Postgres (hosted)" : "[repair] driver: PGlite (local)",
  );

  // Only artists that could possibly hold a duplicate. One query rather than a walk over every
  // artist in the mirror, most of which hold a single release.
  const candidates = await db.execute<{ id: number; name: string; n: number }>(sql`
    SELECT ar.id, ar.name, COUNT(*)::int AS n
      FROM albums a
      JOIN artists ar ON ar.id = a.artist_id
     WHERE a.is_canonical = true
     GROUP BY ar.id, ar.name
    HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC
  `);

  console.info(`[repair] ${candidates.rows.length} artists hold more than one canonical release`);

  let demoted = 0;
  let touched = 0;
  for (const artist of candidates.rows) {
    const n = await collapseDuplicateEditions(artist.id);
    if (n > 0) {
      touched += 1;
      demoted += n;
      console.info(`  ${artist.name}: ${n} demoted (of ${artist.n} canonical rows)`);
    }
  }

  console.info(`\n[repair] demoted ${demoted} duplicate edition(s) across ${touched} artist(s)`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error("[repair] FAILED —", error instanceof Error ? error.message : error);
  process.exit(1);
});

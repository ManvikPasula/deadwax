/**
 * Applies ./drizzle to hosted Postgres. Runs INSIDE `npm run build`.
 *
 * Why inside the build: the alternative is a manual step somebody has to remember between
 * merging a schema change and the deploy that queries it — and the failure mode of
 * forgetting is every signed-in page returning 500 against a table that does not exist yet.
 *
 * A failure exits 1 and fails the build ON PURPOSE: a deploy whose schema did not land is
 * worse than no deploy. Safe to run on every deploy because drizzle records what it applied.
 *
 * It SKIPS SILENTLY when DATABASE_URL is unset — intentional, so a local `next build` and a
 * CI build need no server. The cost is that this is not the place that catches a
 * misconfigured deploy; `assertEnv()` at boot is.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.info("[migrate] DATABASE_URL is unset — skipping (local/CI build against no server)");
    return;
  }

  const pool = new Pool({
    connectionString: url,
    max: 1,
    ssl: url.includes("sslmode=disable") ? false : { rejectUnauthorized: true },
  });

  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
    console.info("[migrate] up to date");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("[migrate] FAILED —", error instanceof Error ? error.message : error);
  process.exit(1);
});

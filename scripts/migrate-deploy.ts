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

/**
 * THE CAUSE CHAIN IS PRINTED, NOT JUST THE MESSAGE — and this was learned the hard way.
 *
 * Drizzle wraps every driver error, so `error.message` is `Failed query: CREATE SCHEMA IF NOT
 * EXISTS "drizzle"` and the reason lives in `error.cause`. The first query the migrator runs is
 * that schema creation, which means **a connection failure and a permissions failure and a
 * genuine SQL failure all print the same line** — and that line was the entire content of a
 * failed production build. "The build failed and we cannot tell you why" is not an acceptable
 * output for the one step that gates a deploy.
 *
 * WHAT IS PRINTED IS A WHITELIST: `name`, `message`, `code`, `constraint`, `severity` — the
 * same shape as `safeErrorDetail` (I-35), for the same reason. Deliberately NOT `query`,
 * `parameters`, `detail` or `stack`: a driver error carries the failing SQL and, depending on
 * the driver, its bound parameters, and build logs are readable by anyone with project access.
 * A connection error's `message` names the host and the role, which is exactly what is needed
 * here and is already in the deployment's environment.
 */
function describe(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return String(error);

  const fields: string[] = [`${error.name}: ${error.message}`];
  for (const key of ["code", "constraint", "severity"] as const) {
    const value = (error as unknown as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) fields.push(`${key}=${value}`);
  }

  const line = `${"  ".repeat(depth)}${fields.join("  ")}`;
  // Bounded at three levels: pg wraps in drizzle wraps in nothing deeper, and an unbounded
  // walk over a cyclic `cause` would hang the build instead of failing it.
  const cause = depth < 2 ? (error.cause as unknown) : undefined;
  return cause ? `${line}\n${"  ".repeat(depth + 1)}caused by: ${describe(cause, depth + 1)}` : line;
}

main().catch((error: unknown) => {
  console.error(`[migrate] FAILED —\n  ${describe(error)}`);
  process.exit(1);
});

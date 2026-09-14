/**
 * Applies ./drizzle to the local PGlite store.
 *
 * This exists because `drizzle-kit push` talks to a Postgres server over TCP, which PGlite
 * is not. One folder, four runners: drizzle-kit generates, this applies locally,
 * migrate-deploy applies in the build, and each DB-backed test suite applies to a throwaway
 * store.
 *
 * It REFUSES TO RUN when DATABASE_URL is set, so a stray shell variable cannot point a
 * "local" command at production.
 *
 * It then PRINTS THE RESULTING TABLE LIST rather than a success message, so the operator
 * sees the schema that actually landed. A migrator that reports success while having applied
 * nothing is the failure this guards against.
 *
 * PGlite allows exactly one writer: STOP THE DEV SERVER FIRST.
 */
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { PGlite } from "@electric-sql/pglite";

async function main(): Promise<void> {
  if (process.env.DATABASE_URL) {
    console.error("[db:local] DATABASE_URL is set. Refusing to run: this command is for the local PGlite store only.");
    process.exit(1);
  }

  const dir = process.env.PGLITE_DATA_DIR ?? "./.pglite";
  const client = new PGlite(dir);
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });

  const result = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  const names = result.rows.map((row) => row.table_name);
  console.info(`[db:local] ${dir} — ${names.length} tables`);
  for (const name of names) console.info(`  ${name}`);
  await client.close();
}

main().catch((error: unknown) => {
  console.error("[db:local] FAILED —", error instanceof Error ? error.message : error);
  process.exit(1);
});

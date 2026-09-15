/**
 * The dual-driver switch — the single most portable piece of infrastructure in this codebase.
 *
 * Four properties, all load-bearing:
 *
 *  1. THE PRESENCE OF `DATABASE_URL` IS THE ENTIRE SWITCH. No dialect fork, no conditional
 *     query code, no second set of migrations. `DISTINCT ON`, lateral joins,
 *     `jsonb_array_elements`, `PERCENTILE_CONT` and `make_interval` all behave identically on
 *     both drivers, which is what makes the raw-SQL aggregates portable — and what makes
 *     `npm run smoke` the highest-value script in the repo, because it is the thing that
 *     proves the two drivers really do agree.
 *
 *  2. THE `Proxy` MAKES THE CONNECTION LAZY. Module-scope construction would make every route
 *     that merely imports a query module fail during `next build`, before it ever needed a
 *     database. This is what lets CI run a full build with no database at all.
 *
 *  3. THE INSTANCE IS MEMOISED ON `globalThis`, so Next's dev HMR does not open a pool per
 *     reload — and so THE DRIVER CHOICE IS FROZEN AT FIRST PROPERTY READ. Every DB-backed
 *     test therefore sets `PGLITE_DATA_DIR` and deletes `DATABASE_URL` in `beforeAll`
 *     *before* any dynamic `import("@/lib/db")`. A top-level static import in such a file
 *     binds the wrong database, silently.
 *
 *  4. TLS VERIFICATION STAYS ON unless the URL literally contains `sslmode=disable`.
 *
 * CAVEATS TO KNOW:
 *   - PGlite writes to the local filesystem, so it works for development and for one
 *     long-lived server but NOT on serverless hosting, where the filesystem is ephemeral and
 *     per-invocation.
 *   - PGlite allows EXACTLY ONE WRITER. Stop the dev server before `db:local`, `seed` or
 *     `smoke`, and keep `fileParallelism: false` in the Vitest config.
 */

import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { Pool } from "pg";

import * as schema from "./schema";

type Database = NodePgDatabase<typeof schema>;

const LOCAL_DATA_DIR = process.env.PGLITE_DATA_DIR ?? "./.pglite";

const globalForDb = globalThis as unknown as {
  deadwaxPool?: Pool;
  deadwaxDb?: Database;
};

function connect(): Database {
  if (globalForDb.deadwaxDb) return globalForDb.deadwaxDb;

  const url = process.env.DATABASE_URL;
  if (url) {
    globalForDb.deadwaxPool ??= new Pool({
      connectionString: url,
      // Serverless runs many short-lived instances, so a large per-instance pool is how you
      // exhaust the database's connection limit rather than how you go faster.
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      /*
       * ASSERTED, NOT ASSUMED. `pg` merges the parsed connection string OVER the explicit
       * options object (`Object.assign({}, config, parse(config.connectionString))`), so a URL
       * carrying `sslmode=no-verify` or `sslmode=prefer` silently wins against
       * `rejectUnauthorized: true` — and the docblock above would then be describing a
       * guarantee the process does not have. `assertTlsMode` refuses those two spellings at the
       * point of connection rather than letting the string quietly downgrade verification.
       */
      ssl: assertTlsMode(url) ? false : { rejectUnauthorized: true },
    });
    globalForDb.deadwaxDb = drizzlePg(globalForDb.deadwaxPool, { schema });
  } else {
    globalForDb.deadwaxDb = drizzlePglite(LOCAL_DATA_DIR, { schema }) as unknown as Database;
  }
  return globalForDb.deadwaxDb;
}

/**
 * Returns true when TLS is deliberately off, throws when the URL tries to weaken it.
 *
 * `sslmode=disable` is a legitimate local choice — a Postgres on localhost with no certificate —
 * and it is the ONE spelling this app honours. `no-verify` and `prefer` are different: they ask
 * for encryption without authentication, which is the shape that makes a man-in-the-middle
 * invisible, and because `pg` lets the connection string override the explicit `ssl` option
 * they would take effect while every comment in this file said otherwise.
 *
 * Refusing at connect time is the right moment: the alternative is a process that believes it
 * verified a certificate it did not.
 */
function assertTlsMode(url: string): boolean {
  const weak = ["sslmode=no-verify", "sslmode=prefer", "sslmode=allow"].find((mode) => url.includes(mode));
  if (weak) {
    throw new Error(
      `DATABASE_URL carries ${weak}, which asks for encryption without verification — and pg lets ` +
        "the connection string override the explicit ssl option, so this would silently disable " +
        "certificate checking. Use sslmode=require (verified) or sslmode=disable (plaintext, local only).",
    );
  }
  return url.includes("sslmode=disable");
}

export const db = new Proxy({} as Database, {
  get(_target, property, receiver) {
    const instance = connect();
    const value = Reflect.get(instance, property, receiver);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
  },
});

export { schema };
export const isLocalDatabase = () => !process.env.DATABASE_URL;

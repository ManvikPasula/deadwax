/**
 * Deletes the local PGlite store.
 *
 * HONOURS PGLITE_DATA_DIR, unlike the television original, whose `db:reset` hardcodes
 * `./.pglite` and therefore silently does nothing for anyone who moved the directory —
 * leaving them to debug "why is my old data still here".
 */
import { rmSync } from "node:fs";

if (process.env.DATABASE_URL) {
  console.error("[db:reset] DATABASE_URL is set. Refusing to run: this only deletes the local PGlite store.");
  process.exit(1);
}

const dir = process.env.PGLITE_DATA_DIR ?? "./.pglite";
rmSync(dir, { recursive: true, force: true });
console.info(`[db:reset] removed ${dir}`);

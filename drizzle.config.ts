import type { Config } from "drizzle-kit";

// `./drizzle` is the single source of truth for BOTH drivers: drizzle-kit generates SQL
// here, `scripts/migrate-deploy.ts` applies it to hosted Postgres during the build, and
// `scripts/db-local.ts` applies the same folder to PGlite. Never squash these files — each
// intermediate state is what some test was written against.
export default {
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  strict: true,
  verbose: true,
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/deadwax" },
} satisfies Config;

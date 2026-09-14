import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    // Nothing renders in these suites; the component layer is covered by the smoke script
    // and the dynamic probe rather than by jsdom.
    environment: "node",
    // The security and desert-island suites drive a real PGlite database and real bcrypt at
    // cost 12. These are not slow tests by accident.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    /**
     * PGlite is a WebAssembly Postgres and reserves a sizeable heap. Parallel workers each
     * starting one exhausted memory on a modest machine and surfaced as
     * "Array buffer allocation failed" DURING MIGRATION — which reads like a database bug
     * rather than a resource limit, and cost the original project real time to diagnose.
     *
     * It is also the correct setting for a different reason: PGlite allows exactly one
     * writer.
     */
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // `next/server` is deliberately NOT stubbed: Auth.js imports it internally, and
      // pointing it at the real module keeps the authorization path under test the genuine
      // one rather than a convenient fiction.
      "server-only": `${root}tests/stubs/server-only.ts`,
      "next/cache": `${root}tests/stubs/next-cache.ts`,
      "@": root.replace(/\/$/, ""),
    },
    conditions: ["react-server", "node", "import"],
  },
});

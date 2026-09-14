/**
 * Flat config, consuming eslint-config-next's own flat arrays DIRECTLY.
 *
 * The first version routed them through `FlatCompat` from `@eslint/eslintrc`, which is the
 * usual recipe for an eslintrc-shaped config — and in this install it throws
 * `TypeError: Converting circular structure to JSON` while validating
 * `next/core-web-vitals`, so `npm run lint` failed for the whole repository regardless of
 * source. eslint-config-next 16 already exports flat arrays (verified: four entries from
 * `eslint-config-next/core-web-vitals`), so the compatibility layer is not merely unnecessary
 * here, it is the bug.
 */
import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      ".pglite/**",
      // Generated SQL and drizzle's snapshots are not ours to lint.
      "drizzle/**",
      "next-env.d.ts",
      "scratch/**",
    ],
  },
  ...coreWebVitals,
  ...nextTypescript,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // `unknown` is the house style in catch clauses and provider payloads; `any` should be
      // visible but not blocking.
      "@typescript-eslint/no-explicit-any": "warn",
      /**
       * Cover art comes from four allowlisted CDNs at known pixel widths, and the grid already
       * requests the right size through `coverAt()`. next/image would add a serverless
       * optimiser hop per cover on a page that renders twenty-four of them, to re-derive a
       * width the CDN has already rendered.
       */
      "@next/next/no-img-element": "off",
    },
  },
  {
    // Scripts are operator tools: they log by design and run outside a request.
    files: ["scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
];

export default config;

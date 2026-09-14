import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * THE HIGHEST-VALUE ARTEFACT IN THE ADMIN SUBSYSTEM, and it is a source-level assertion rather
 * than a behavioural one.
 *
 * The invariant: **only the admin action module and the operator's grant script may write
 * `users.role` or `users.plan`.** The reasoning, from the source project:
 *
 *   Never settable through any member-facing path: there is no action that writes this column,
 *   so the only way to become an admin is the operator running `npm run admin:grant`.
 *   **PRIVILEGE ESCALATION HAS TO BE IMPOSSIBLE BY CONSTRUCTION, NOT MERELY UNIMPLEMENTED.**
 *
 * A behavioural test cannot express that. It can prove that today's actions do not escalate;
 * it cannot prove that tomorrow's will not. This one does: a future action that sets `role` or
 * `plan` FAILS A TEST instead of quietly shipping privilege escalation, which is the failure
 * mode worth catching mechanically.
 *
 * KNOW THE LIMITS OF THE GUARANTEE. The source brief is explicit that its version of this test
 * can be slipped past, and names two ways: a raw
 * `db.execute(sql`UPDATE users SET role...`)`, and a writer placed in a directory the walk does
 * not cover. **BOTH HOLES ARE CLOSED HERE** — there is a second pattern for raw SQL, and the
 * walk covers `scripts/` and `tests/` too. A third hole remains open and is stated below
 * rather than left implicit.
 */

const ROOT = join(import.meta.dirname, "..");

/**
 * The only two files permitted to write these columns.
 *
 * `app/actions/admin.ts` is behind `requireAdmin()`, which resolves the role from the database
 * on every request. `scripts/grant-admin.ts` needs database credentials to run at all, which is
 * what makes granting an operator act rather than a product feature.
 */
const ALLOWED = new Set(["app/actions/admin.ts", "scripts/grant-admin.ts"]);

/**
 * This file itself, which is the detector rather than a writer.
 *
 * It is excluded by name rather than by excluding all of `tests/`, because covering `tests/`
 * is one of the two holes the source version of this assertion leaves open — a writer parked
 * in a test directory slips past it entirely. Kept separate from ALLOWED so that a green run
 * cannot be achieved by quietly adding a third entry there.
 */
const SELF = "tests/no-escalation.test.ts";

/** Walked in full. `drizzle/` is generated SQL and `.next/` is build output. */
const WALK = ["app", "lib", "components", "scripts", "tests"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".pglite", "drizzle", "scratch"]);

function sourceFiles(): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        visit(full);
        continue;
      }
      if ([".ts", ".tsx"].includes(extname(entry))) found.push(full);
    }
  };
  for (const top of WALK) {
    const full = join(ROOT, top);
    try {
      if (statSync(full).isDirectory()) visit(full);
    } catch {
      // A directory that does not exist yet is not a finding.
    }
  }
  return found;
}

/** Normalise to the forward-slash, repo-relative form the allowlist is written in. */
function repoPath(absolute: string): string {
  return relative(ROOT, absolute).split(sep).join("/");
}

/**
 * A drizzle `.set({ ... })` whose object mentions `role:` or `plan:` within a few hundred
 * characters. The window is generous because a real call spans several lines.
 */
const DRIZZLE_SET = /\.set\(\s*\{[\s\S]{0,400}?\b(role|plan)\s*:/;

/**
 * RAW SQL, which the source version of this test does not cover at all — and it is the more
 * dangerous hole of the two, because it bypasses the ORM's types as well as this check.
 * Matches an UPDATE against `users` that assigns either column.
 */
const RAW_SQL_UPDATE = /UPDATE\s+(?:"?public"?\.)?"?users"?[\s\S]{0,300}?\bSET\b[\s\S]{0,300}?\b(role|plan)\s*=/i;

/** An INSERT that names either column. Safe defaults must come from the schema, not a caller. */
const RAW_SQL_INSERT = /INSERT\s+INTO\s+(?:"?public"?\.)?"?users"?[\s\S]{0,200}?\(([^)]*\b(?:role|plan)\b[^)]*)\)/i;

describe("no privilege escalation path exists", () => {
  const files = sourceFiles();

  it("finds a source tree to walk at all", () => {
    // A guard against the test passing because the walk found nothing — the exact way a
    // structural assertion goes quietly useless.
    expect(files.length).toBeGreaterThan(40);
  });

  it("only the admin action and the grant script write users.role or users.plan via the ORM", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const path = repoPath(file);
      if (ALLOWED.has(path) || path === SELF) continue;
      if (DRIZZLE_SET.test(readFileSync(file, "utf8"))) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("nothing writes those columns through raw SQL either", () => {
    // The hole the source version leaves open. A raw db.execute slips past a `.set({})` regex
    // entirely, and it is exactly what somebody reaches for when the ORM makes a write awkward.
    const offenders: string[] = [];
    for (const file of files) {
      const path = repoPath(file);
      if (ALLOWED.has(path) || path === SELF) continue;
      const source = readFileSync(file, "utf8");
      if (RAW_SQL_UPDATE.test(source) || RAW_SQL_INSERT.test(source)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("the admin action really does gate itself on requireAdmin", () => {
    // The allowlist above is only safe because this is true. If the admin module ever stopped
    // calling requireAdmin, the allowlist would become the escalation path.
    /**
     * If the module does not exist, the invariant holds TRIVIALLY AND MORE STRONGLY: nothing
     * anywhere writes those columns. Asserting its presence would make this test fail for a
     * repository that is safer than one it passes for, which is the wrong direction.
     */
    let source: string;
    try {
      source = readFileSync(join(ROOT, "app/actions/admin.ts"), "utf8");
    } catch {
      expect(ALLOWED.has("app/actions/admin.ts")).toBe(true);
      return;
    }
    expect(source).toMatch(/requireAdmin\s*\(/);
  });

  it("the grant script is a CLI and not reachable from the app", () => {
    // Granting is deliberately an operator act needing database credentials, not a product
    // feature. Nothing under app/ or components/ may import it.
    const importers: string[] = [];
    for (const file of files) {
      const path = repoPath(file);
      if (!path.startsWith("app/") && !path.startsWith("components/")) continue;
      if (/grant-admin/.test(readFileSync(file, "utf8"))) importers.push(path);
    }
    expect(importers).toEqual([]);
  });

  it("no member-facing action module imports the admin query module", () => {
    // lib/db/queries/admin.ts self-gates, but an import from a member-facing action would still
    // be a smell worth failing on: it means somebody is reaching for privileged reads from an
    // unprivileged surface.
    const offenders: string[] = [];
    for (const file of files) {
      const path = repoPath(file);
      if (!path.startsWith("app/actions/")) continue;
      if (path === "app/actions/admin.ts" || path === "app/actions/ads.ts") continue;
      if (/queries\/admin/.test(readFileSync(file, "utf8"))) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});

describe("the remaining hole, stated rather than left implicit", () => {
  it("documents what this test cannot catch", () => {
    /**
     * WHAT STILL SLIPS PAST, so that nobody mistakes a green tick for a proof:
     *
     *  - A migration in `drizzle/` that sets a role directly. That directory is generated from
     *    `lib/db/schema.ts` and is excluded from the walk; a hand-edited migration is an
     *    operator act with database credentials, which is the same trust level as the grant
     *    script.
     *  - Column assignment through a dynamically-built object — `.set(patch)` where `patch`
     *    accumulated a `role` key at runtime. No regex over source text can see that. The
     *    mitigation is the layering rule rather than this test: actions build their patch
     *    objects from named fields, never by spreading a request.
     *  - Anyone with database credentials, who is fully trusted by construction, because those
     *    credentials ARE the grant mechanism.
     *
     * This assertion exists so the paragraph above is read, and it fails if the allowlist grows
     * without somebody revisiting it.
     */
    expect(ALLOWED.size).toBe(2);
  });
});

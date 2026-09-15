/**
 * One-shot Vercel setup: link the project, push the three production variables, deploy.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN A LIST OF COMMANDS IN A README
 * ---------------------------------------------------------------------------------------
 *
 * The values it pushes are already correct in `.env.local`, and one of them is a 100-plus
 * character Postgres connection string with a password in it. A README asks somebody to
 * retype that into `vercel env add` — and the failure mode of a mistyped connection string is
 * a deployment that builds fine and 500s on every page, which is a genuinely confusing thing
 * to debug. Reading the file is the whole point.
 *
 * It is NOT a deploy pipeline. CI deploys happen through the git integration on push; this is
 * the first-time configuration a human runs once, which is why it lives in `scripts/` and not
 * in the GitHub workflow.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT PUSH
 * ---------------------------------------------------------------------------------------
 *
 *   NEXT_PUBLIC_SITE_URL   `http://localhost:3000` locally. `env.siteUrl` already falls back
 *                          to `VERCEL_PROJECT_PRODUCTION_URL`, so pushing the local value
 *                          would OVERRIDE a correct answer with a wrong one — every
 *                          verification link in production would point at the operator's
 *                          laptop.
 *   DATABASE_URL           Only when the project has none. A Marketplace integration injects it
 *                          into every environment and owns its rotation, so a pushed copy would
 *                          shadow the platform's value and go stale — the symptom is a 28P01 at
 *                          build time that looks exactly like a broken script. Pushed only for
 *                          the claimable-database route, where the string lives nowhere else.
 *   DATABASE_URL_UNPOOLED  Written by the Neon CLI beside the pooled string. Serverless wants
 *                          the pooled endpoint; the direct one is for long-lived connections
 *                          and migrations, and this app runs its migrations from the build
 *                          where either works.
 *   NEON_BRANCH            Metadata the app never reads.
 *   REQUIRE_EMAIL_VERIFICATION  Default-off is the safe default and turning it on without a
 *                          verified sending domain locks every new member out of posting with
 *                          no self-service fix. That is a decision to make deliberately, in
 *                          the dashboard, not a value to copy from a development file.
 *
 * ---------------------------------------------------------------------------------------
 * WINDOWS
 * ---------------------------------------------------------------------------------------
 *
 * `vercel` is resolved through `npm prefix -g` rather than assumed to be on PATH, because on
 * Windows the npm global prefix is frequently not (here it is `D:\npm-global`, and the Git
 * Bash PATH does not include it). Telemetry is disabled through the environment because the
 * first-run notice goes to stderr and makes a successful command look like a failure.
 *
 * `vercel deploy` uploads the working copy and builds ON VERCEL. That matters on this machine:
 * a local `vercel build` — which is what `vercel deploy --temporary` and `--prebuilt` use —
 * cannot complete, because the build output deduplicates identical serverless functions with
 * symlinks and symlink creation is denied to a non-elevated Windows process. `.vercelignore`
 * is what keeps the upload small.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The three the platform needs, and nothing else. See the docblock for every omission. */
const PUSH = ["DATABASE_URL", "AUTH_SECRET", "CRON_SECRET"];

/** Both, so a preview deployment of a pull request is a working site rather than a 500. */
const TARGETS = ["production", "preview"];

const DEFAULT_PROJECT = "deadwax-web";

/**
 * How the CLI gets invoked, and the shape of a wrong diagnosis worth keeping written down.
 *
 * The values are fed to `vercel env add` ON STDIN, and the first version of this script spawned
 * `vercel.cmd` with `shell: true` — the only way Node can execute a `.cmd` shim. The first
 * deploy then failed with `password authentication failed for user 'neondb_owner'` (28P01), and
 * the obvious inference was that stdin through `cmd.exe` had corrupted the password: the string
 * was structurally intact, since the role name survived, and wrong in exactly the bytes nobody
 * can see.
 *
 * **THAT INFERENCE WAS WRONG, AND THE CODE KEPT THE CHANGE ANYWAY.** Removing the shell did not
 * fix it. What did: running the same connection string locally, where it had worked an hour
 * earlier, and getting the identical 28P01 — so the credential itself had been revoked. The
 * Neon project was a claimable one, an attempt to claim it into a Vercel-managed organisation
 * is unsupported and left it in a `pending` state, and a pending claim revokes access and
 * permits nothing but status polling.
 *
 * The shell is still gone, on its own merits rather than on that story: running the package's
 * JS entry under THIS Node gives a clean argv and a clean stdin on every platform, and it costs
 * nothing. But the reason it is gone is "this removes a class of risk", not "this was the bug"
 * — and the difference matters, because a comment claiming a fix that was never demonstrated is
 * how the next person stops looking for the real cause.
 *
 * The `.cmd` shim remains as a fallback for an install layout where the entry cannot be found,
 * and the fallback is announced rather than silent.
 */
function resolveVercel() {
  /** The package's own JS entry, run under this Node: no shell, so stdin is bytes. */
  try {
    const prefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8", shell: true }).trim();
    for (const relative of [
      join("node_modules", "vercel", "dist", "vc.js"),
      join("lib", "node_modules", "vercel", "dist", "vc.js"),
    ]) {
      const entry = join(prefix, relative);
      if (existsSync(entry)) {
        return { bin: process.execPath, lead: [entry], shell: false, display: entry, viaShim: false };
      }
    }
  } catch {
    // fall through to the shim
  }

  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["vercel"], {
    encoding: "utf8",
  });
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (first) {
      const path = first.trim();
      // A POSIX shim is an executable script and needs no shell; a Windows `.cmd` does.
      const viaShim = process.platform === "win32";
      return { bin: path, lead: [], shell: viaShim, display: path, viaShim };
    }
  }
  return null;
}

/**
 * A minimal dotenv reader.
 *
 * NOT `dotenv`: this script must not add a dependency to read four lines, and the file it
 * reads was written by two tools that both emit `KEY=value` with no quoting and no
 * multi-line values. Strips a `KEY=` prefix, an optional surrounding pair of quotes, and
 * nothing else — a parser that did more would be guessing.
 */
function readEnvFile(path) {
  const values = new Map();
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    const key = trimmed.slice(0, at).trim();
    let value = trimmed.slice(at + 1).trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (value.length > 0) values.set(key, value);
  }
  return values;
}

function run(cli, args, options = {}) {
  return spawnSync(cli.bin, [...cli.lead, ...args], {
    encoding: "utf8",
    env: { ...process.env, VERCEL_TELEMETRY_DISABLED: "1" },
    shell: cli.shell,
    ...options,
  });
}

function main() {
  const project = process.argv[2] ?? DEFAULT_PROJECT;
  const cli = resolveVercel();

  if (!cli) {
    console.error(
      "[vercel-setup] the Vercel CLI is not installed.\n" +
        "  npm i -g vercel\n" +
        "then run this again.",
    );
    process.exit(1);
  }

  const who = run(cli, ["whoami"]);
  if (who.status !== 0) {
    /*
     * THE ONE STEP THIS SCRIPT CANNOT DO FOR YOU. `vercel login` opens a browser and waits for
     * a confirmation, so it is interactive by construction — there is no flag that makes it
     * otherwise, and a token pasted into a terminal is a credential in a shell history.
     */
    console.error(
      "[vercel-setup] the Vercel CLI is not logged in.\n\n" +
        `  ${cli.display} login\n\n` +
        "The resolved path is printed rather than the bare command because the npm global prefix\n" +
        "is often not on PATH on Windows. Run it in a REAL terminal window: the CLI defaults to\n" +
        "--non-interactive when it detects an agent, and its account picker needs arrow keys.\n" +
        "That is the only interactive step. Run this script again afterwards.",
    );
    process.exit(1);
  }
  console.info(`[vercel-setup] authenticated as ${who.stdout.trim().split(/\r?\n/).pop()}`);

  if (cli.viaShim) {
    /*
     * ANNOUNCED RATHER THAN SILENT. Values reach `vercel env add` on stdin, and stdin through
     * `cmd.exe` is one more layer between a password and the API — never demonstrated to corrupt
     * anything here (see the note above; the failure that looked like corruption was a revoked
     * credential), but it is the layer to suspect first if a pushed value ever fails to
     * authenticate. A warning is the right level: the shim works, and the alternative to trying
     * is doing nothing.
     */
    console.warn(
      `[vercel-setup] note: using the CLI shim at ${cli.display} rather than the package entry.\n` +
        "  Values are piped through a shell. If a pushed variable fails to authenticate, set it\n" +
        "  from the dashboard and compare.",
    );
  }

  const env = readEnvFile(".env.local");
  const missing = PUSH.filter((key) => !env.has(key));
  if (missing.length > 0) {
    console.error(
      `[vercel-setup] .env.local is missing ${missing.join(", ")}.\n` +
        "  DATABASE_URL  — npx neon@latest claim create --service postgres --file .env.local\n" +
        "  AUTH_SECRET   — node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"\n" +
        "  CRON_SECRET   — node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
    process.exit(1);
  }

  const link = run(cli, ["link", "--yes", "--project", project], { stdio: "inherit" });
  if (link.status !== 0) {
    console.error(`[vercel-setup] could not link to project "${project}".`);
    process.exit(1);
  }

  /*
   * DATABASE_URL IS SKIPPED WHEN THE PROJECT ALREADY HAS ONE, AND THAT IS THE COMMON CASE.
   *
   * A Neon (or Supabase, or any Marketplace) integration injects `DATABASE_URL` into production,
   * preview and development itself. Pushing a local copy over the top would **shadow the value
   * the platform owns** with one that goes stale the moment the provider rotates a credential —
   * and the symptom of that is a 28P01 at build time, which looks exactly like a broken script.
   * This project hit that failure from the other direction and it cost an hour.
   *
   * So the rule is: the platform's value wins if there is one, and a local `DATABASE_URL` is
   * pushed only when nothing is providing it — which is the case for the claimable-database
   * route, where the connection string genuinely lives nowhere but `.env.local`.
   *
   * `env ls` prints names, environments and types but never values, so this is a cheap read
   * that discloses nothing.
   */
  const existing = run(cli, ["env", "ls"]);
  const hasProvidedDatabaseUrl = /^\s*DATABASE_URL\s/m.test(existing.stdout ?? "");
  const push = PUSH.filter((key) => {
    if (key !== "DATABASE_URL" || !hasProvidedDatabaseUrl) return true;
    console.info(
      "[vercel-setup] DATABASE_URL is already set on the project — leaving it alone.\n" +
        "  A Marketplace integration owns that value in all three environments. Overwriting it\n" +
        "  with the local copy is how a rotated credential becomes a build failure.",
    );
    return false;
  });

  for (const key of push) {
    for (const target of TARGETS) {
      /*
       * REMOVE THEN ADD, rather than `add --force`.
       *
       * `--force` overwrites when the variable exists and errors on some CLI versions when it
       * does not, so the two cases would need different commands anyway. A remove that fails
       * because there was nothing there is the expected path on a fresh project and is
       * deliberately not treated as an error.
       */
      run(cli, ["env", "rm", key, target, "--yes"]);

      const added = run(cli, ["env", "add", key, target], { input: env.get(key) });
      if (added.status !== 0) {
        // The VALUE is never printed, on any path. The CLI's own stderr is, because it says
        // what went wrong and does not echo the input.
        console.error(`[vercel-setup] failed to set ${key} (${target}):\n${added.stderr}`);
        process.exit(1);
      }
      console.info(`[vercel-setup] set ${key} (${target})`);
    }
  }

  console.info("[vercel-setup] deploying to production — migrations run inside the build");
  const deploy = run(cli, ["deploy", "--prod", "--yes"], { stdio: "inherit" });
  if (deploy.status !== 0) {
    console.error("[vercel-setup] the deployment failed. The build log above says why.");
    process.exit(1);
  }

  /*
   * THE PROBE HINT IS PRINTED IN THE SHELL THE OPERATOR IS ACTUALLY IN.
   *
   * On Windows `VAR=x cmd` is a PARSE ERROR rather than an env-prefixed run, and it fails
   * quietly enough to read as a broken script rather than as the wrong syntax. PowerShell needs
   * the assignment and the call as separate statements.
   */
  const probeHint =
    process.platform === "win32"
      ? '$env:PROBE_BASE_URL = "https://<domain>"; $env:PROBE_ALLOW_REMOTE = "1"; npm run security:probe'
      : "PROBE_BASE_URL=https://<domain> PROBE_ALLOW_REMOTE=1 npm run security:probe";

  console.info(
    "\n[vercel-setup] done. Two things worth running against the live instance:\n" +
      "  npm run smoke     # 68 assertions against hosted Postgres\n" +
      `  ${probeHint}`,
  );
}

main();

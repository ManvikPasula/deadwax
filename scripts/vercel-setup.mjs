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

function resolveVercel() {
  // `where`/`which` first: a PATH install is the normal case and should win.
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["vercel"], {
    encoding: "utf8",
  });
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (first) return first.trim();
  }

  try {
    const prefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8", shell: true }).trim();
    for (const name of ["vercel.cmd", "vercel"]) {
      const candidate = join(prefix, name);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // fall through to the message below
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

function run(bin, args, options = {}) {
  return spawnSync(bin, args, {
    encoding: "utf8",
    env: { ...process.env, VERCEL_TELEMETRY_DISABLED: "1" },
    // `shell` on win32 so a `.cmd` shim is executable. The arguments here are literals and
    // values from a local file the operator owns, never from a request.
    shell: process.platform === "win32",
    ...options,
  });
}

function main() {
  const project = process.argv[2] ?? DEFAULT_PROJECT;
  const vercel = resolveVercel();

  if (!vercel) {
    console.error(
      "[vercel-setup] the Vercel CLI is not installed.\n" +
        "  npm i -g vercel\n" +
        "then run this again.",
    );
    process.exit(1);
  }

  const who = run(vercel, ["whoami"]);
  if (who.status !== 0) {
    /*
     * THE ONE STEP THIS SCRIPT CANNOT DO FOR YOU. `vercel login` opens a browser and waits for
     * a confirmation, so it is interactive by construction — there is no flag that makes it
     * otherwise, and a token pasted into a terminal is a credential in a shell history.
     */
    console.error(
      "[vercel-setup] the Vercel CLI is not logged in.\n\n" +
        `  ${vercel} login\n\n` +
        "The resolved path is printed rather than the bare command because the npm global prefix\n" +
        "is often not on PATH on Windows. Run it in a REAL terminal window: the CLI defaults to\n" +
        "--non-interactive when it detects an agent, and its account picker needs arrow keys.\n" +
        "That is the only interactive step. Run this script again afterwards.",
    );
    process.exit(1);
  }
  console.info(`[vercel-setup] authenticated as ${who.stdout.trim().split(/\r?\n/).pop()}`);

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

  const link = run(vercel, ["link", "--yes", "--project", project], { stdio: "inherit" });
  if (link.status !== 0) {
    console.error(`[vercel-setup] could not link to project "${project}".`);
    process.exit(1);
  }

  for (const key of PUSH) {
    for (const target of TARGETS) {
      /*
       * REMOVE THEN ADD, rather than `add --force`.
       *
       * `--force` overwrites when the variable exists and errors on some CLI versions when it
       * does not, so the two cases would need different commands anyway. A remove that fails
       * because there was nothing there is the expected path on a fresh project and is
       * deliberately not treated as an error.
       */
      run(vercel, ["env", "rm", key, target, "--yes"]);

      const added = run(vercel, ["env", "add", key, target], { input: env.get(key) });
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
  const deploy = run(vercel, ["deploy", "--prod", "--yes"], { stdio: "inherit" });
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

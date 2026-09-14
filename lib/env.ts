/**
 * Environment access.
 *
 * Three properties, each deliberate:
 *
 *  1. GETTERS, so nothing is evaluated at import. A module-scope read would make `next build`
 *     fail on any route that merely imports a module that touches env.
 *  2. THROWING, so a missing value cannot silently degrade into something insecure. The
 *     message names both the local fix and the hosted one, because whoever hits it is in one
 *     of exactly those two situations.
 *  3. `required()` REJECTS THE EMPTY STRING as well as undefined, which matters because
 *     `.env.example` ships blanks and copying it produces `KEY=` rather than an absent key.
 *
 * Notable property of this stack: THE CATALOGUE NEEDS NO CREDENTIAL. Deezer, MusicBrainz and
 * the Cover Art Archive are all keyless, so `AUTH_SECRET` is the only hard requirement. The
 * television original required a provider token and therefore could not be run by anyone who
 * had not first registered for one.
 *
 * There is also a startup validation pass — see `assertEnv()` and `instrumentation.ts`. The
 * original has none, so a missing variable surfaces on the first request that needs it rather
 * than at boot.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Locally: add it to .env.local (see .env.example). ` +
        `Hosted: set it in the project's environment variables and redeploy.`,
    );
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

export const env = {
  /** Read directly by lib/db/index.ts too — the presence of this value is the driver switch. */
  get databaseUrl(): string | undefined {
    return optional("DATABASE_URL");
  },

  /** Auth.js reads this itself; exposed here so assertEnv() can fail at boot instead. */
  get authSecret(): string {
    return required("AUTH_SECRET");
  },

  /**
   * Strict `=== "true"`. "1", "yes" and "TRUE" all read as false, on purpose: a flag that
   * turns a publishing gate on is not a flag to guess at.
   *
   * Default OFF. Enforcing the gate without a verified sending domain would lock every new
   * member out of posting with no self-service fix.
   */
  get requireEmailVerification(): boolean {
    return process.env.REQUIRE_EMAIL_VERIFICATION === "true";
  },

  get resendApiKey(): string | undefined {
    return optional("RESEND_API_KEY");
  },

  get emailFrom(): string {
    return optional("EMAIL_FROM") ?? "Deadwax <onboarding@resend.dev>";
  },

  /**
   * Base for email links, and the contact URL inside the MusicBrainz User-Agent — their
   * policy requires a way to reach the operator, and a request without one is refused.
   */
  get siteUrl(): string {
    const explicit = optional("NEXT_PUBLIC_SITE_URL") ?? optional("AUTH_URL");
    if (explicit) return explicit.replace(/\/$/, "");
    const vercel = optional("VERCEL_PROJECT_PRODUCTION_URL") ?? optional("VERCEL_URL");
    if (vercel) return `https://${vercel}`;
    return "http://localhost:3000";
  },

  /**
   * Optional. Present => Last.fm listener counts (the true equivalent of "how many people
   * ever bothered to rate it") and a second artist-similarity source. Absent => the
   * familiarity heuristic falls back to Deezer `fans` over a curated seed, and the second
   * neighbour source is skipped. Both features degrade to absent, never to wrong.
   */
  get lastfmApiKey(): string | undefined {
    return optional("LASTFM_API_KEY");
  },

  /** Absent => /api/cron/prune 404s rather than running unauthenticated. */
  get cronSecret(): string | undefined {
    return optional("CRON_SECRET");
  },

  get isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },
};

/**
 * Run once at boot from instrumentation.ts.
 *
 * Touches every REQUIRED getter so a misconfigured deployment fails immediately and loudly
 * instead of serving a homepage that 500s the moment somebody signs in. Optional values are
 * reported, not enforced — the point is that an operator can see what is off.
 */
export function assertEnv(): void {
  env.authSecret;

  const notes: string[] = [];
  if (!env.databaseUrl) notes.push("DATABASE_URL is unset — using PGlite at ./.pglite (not viable on serverless)");
  if (!env.resendApiKey) notes.push("RESEND_API_KEY is unset — verification and reset mail goes to the server log");
  if (!env.lastfmApiKey) notes.push("LASTFM_API_KEY is unset — familiarity falls back to Deezer fan counts");
  if (!env.cronSecret) notes.push("CRON_SECRET is unset — /api/cron/prune is disabled");
  if (env.requireEmailVerification && !env.resendApiKey) {
    notes.push(
      "REQUIRE_EMAIL_VERIFICATION is on with no mail provider — new members will be unable to post and unable to fix it",
    );
  }
  if (notes.length) console.info("[env]", notes.join("; "));
}

import "server-only";

import { sql } from "drizzle-orm";
import { headers } from "next/headers";

import { db } from "@/lib/db";

/**
 * Fixed-window rate limiting on one Postgres table, one statement per check.
 *
 * WHY POSTGRES AND NOT MEMORY: an in-process counter is per-instance, and serverless runs
 * many instances, so an attacker spreading requests across them would face no limit at all.
 *
 * WHY FIXED WINDOWS: they admit up to 2x a limit across a window boundary. That is accepted,
 * and THE LIMITS BELOW ARE SET WITH THAT DOUBLING IN MIND — so do not later "tighten" a limit
 * by halving it without re-reading this paragraph.
 *
 * IT FAILS OPEN. A rate limiter that takes the whole site down when Postgres hiccups trades a
 * small risk for a large one; the security controls that must fail closed are the
 * authorization checks, not this. Understand the corollary: THE LIMITER IS NOT A DEFENCE
 * AGAINST AN ATTACKER WHO CAN ALSO DEGRADE THE DATABASE.
 */

export type Budget = {
  bucket: string;
  limit: number;
  windowSeconds: number;
};

export type LimitResult = {
  ok: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
};

export const BUDGETS = {
  /* -- authentication: two limits per flow, one keyed by the SUBJECT, one by the SOURCE,
        because the two attacks look different. Both are counted BEFORE bcrypt runs, so a
        flood cannot be used to burn CPU either. --------------------------------------- */

  /** Password guessing against one account. Deliberately tight. */
  loginByAccount: { bucket: "login:account", limit: 5, windowSeconds: 900 },
  /** Credential stuffing from one source, spread across many accounts. */
  loginByIp: { bucket: "login:ip", limit: 20, windowSeconds: 900 },
  /** Mass account creation — the entry point for every other abuse. */
  signUpByIp: { bucket: "signup:ip", limit: 5, windowSeconds: 3600 },

  /* -- writes ---------------------------------------------------------------------- */

  /** Generous for a person, ruinous for a script. */
  writeByUser: { bucket: "write:user", limit: 120, windowSeconds: 60 },
  /** Mutations attempted without a session. */
  writeByAnon: { bucket: "write:anon", limit: 30, windowSeconds: 60 },

  /** Search reaches a provider. Over the limit, /search renders from the local mirror only. */
  searchByIp: { bucket: "search:ip", limit: 30, windowSeconds: 60 },

  /* -- mail: the recipient is what needs protecting here, not us ------------------- */

  /** An account becomes a way to repeatedly deliver to one address. */
  verifyEmailByUser: { bucket: "verify:user", limit: 3, windowSeconds: 3600 },
  /** A source cycling accounts becomes a way to deliver to many. */
  verifyEmailByIp: { bucket: "verify:ip", limit: 10, windowSeconds: 3600 },
  /** The only limit standing between a guesser and unlimited attempts. */
  passwordResetByIp: { bucket: "reset:ip", limit: 10, windowSeconds: 3600 },
  /** So nobody can be made to receive a stream of reset mail by an attacker cycling origins. */
  passwordResetByEmail: { bucket: "reset:email", limit: 3, windowSeconds: 3600 },

  /** A row-creating endpoint open to the world. Set generously enough for a shared address
   *  (an office, a campus, a phone network) to keep working. */
  guestByIp: { bucket: "guest:ip", limit: 20, windowSeconds: 3600 },

  /** The counters are reporting rather than billing, so this is loose on purpose. */
  adEventByIp: { bucket: "ad:ip", limit: 300, windowSeconds: 3600 },

  /* -- outbound: ONE PLATFORM-WIDE COUNTER PER PROVIDER, not per user or per IP,
        because the provider relationship is the scarce resource. Being throttled takes
        the data source down for everyone. ------------------------------------------- */

  /** Deezer allows roughly 50 requests / 5 s = 600/60s. 400 leaves room for the 2x burst. */
  deezerOutbound: { bucket: "deezer:global", limit: 400, windowSeconds: 60 },
  /** MusicBrainz's published policy is ~1 req/s. 45 plus the serialising queue stays inside it. */
  musicbrainzOutbound: { bucket: "musicbrainz:global", limit: 45, windowSeconds: 60 },
  /** Only reachable when LASTFM_API_KEY is configured. */
  lastfmOutbound: { bucket: "lastfm:global", limit: 250, windowSeconds: 60 },
} as const satisfies Record<string, Budget>;

/**
 * One statement. The CASE expressions are what make the window slide forward atomically
 * rather than needing a read, a decision and a write.
 *
 * `ok = count <= limit` — THE Nth REQUEST WHERE N EQUALS THE LIMIT IS ALLOWED; THE (N+1)th IS
 * REFUSED. Any reimplementation using `count < limit` silently tightens every budget by one.
 */
export async function consume(budget: Budget, identity: string): Promise<LimitResult> {
  const key = `${budget.bucket}:${identity}`;

  try {
    const result = await db.execute<{ count: number; age_seconds: number }>(sql`
      INSERT INTO rate_limits (key, window_start, count)
      VALUES (${key}, now(), 1)
      ON CONFLICT (key) DO UPDATE SET
        count = CASE
          WHEN rate_limits.window_start < now() - make_interval(secs => ${budget.windowSeconds})
          THEN 1 ELSE rate_limits.count + 1 END,
        window_start = CASE
          WHEN rate_limits.window_start < now() - make_interval(secs => ${budget.windowSeconds})
          THEN now() ELSE rate_limits.window_start END
      RETURNING count, EXTRACT(EPOCH FROM (now() - window_start))::int AS age_seconds
    `);

    const row = result.rows[0];
    const count = Number(row?.count ?? 0);
    const age = Number(row?.age_seconds ?? 0);

    return {
      ok: count <= budget.limit,
      count,
      limit: budget.limit,
      retryAfterSeconds: Math.max(1, budget.windowSeconds - age),
    };
  } catch (error) {
    // FAIL OPEN. See the module docblock: this is deliberate, and it is the one security
    // control here that is allowed to.
    console.warn("[rate-limit] check failed, allowing request —", error instanceof Error ? error.message : error);
    return { ok: true, count: 0, limit: budget.limit, retryAfterSeconds: 0 };
  }
}

/**
 * The refusal message shown to a member.
 *
 * Never names the mechanism: no bucket, no table, no SQL verb. A test asserts the output does
 * not match /bucket|rate_limits|select|insert/i, because a limiter that explains itself is a
 * limiter that tells an attacker how to pace.
 */
export function retryMessage(result: LimitResult): string {
  const seconds = Math.max(1, result.retryAfterSeconds);
  if (seconds <= 90) return `Too many attempts. Try again in ${seconds} seconds.`;
  const minutes = Math.ceil(seconds / 60);
  return `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/**
 * The client address, for per-source budgets.
 *
 * Takes the LEFT-MOST x-forwarded-for entry. This is only trustworthy because the hosting
 * platform terminates every request and overwrites the header. ON ANY OTHER DEPLOYMENT THIS
 * HEADER IS ATTACKER-CONTROLLED and this function would need to change with it — every
 * per-IP budget in this file is bypassable with one header off-platform.
 */
export async function clientAddress(): Promise<string> {
  const store = await headers();
  const forwarded = store.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return store.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Deletes windows older than `olderThanSeconds`.
 *
 * The television original ships this function with nothing scheduling it, so the table grows
 * by distinct (bucket, identity) pairs forever — including every IP that ever searched and
 * every email address ever tried at sign-in. That makes it a list of email addresses, which
 * is a data-retention problem as well as a disk one. Here /api/cron/prune calls it.
 */
export async function pruneRateLimits(olderThanSeconds = 86_400): Promise<number> {
  const result = await db.execute<{ key: string }>(sql`
    DELETE FROM rate_limits
    WHERE window_start < now() - make_interval(secs => ${olderThanSeconds})
    RETURNING key
  `);
  return result.rows.length;
}

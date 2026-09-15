/**
 * `GET /api/cron/prune` — the scheduled sweep. **New here; the television original has none.**
 *
 * ---------------------------------------------------------------------------------------
 * WHY THIS ROUTE EXISTS (brief defect #10)
 * ---------------------------------------------------------------------------------------
 *
 * The original ships `pruneRateLimits` with nothing calling it, and its `likes`/`comments`
 * tables carry `target_id` with **no foreign key** — a deliberate schema decision, because the
 * target is polymorphic and a column cannot reference two tables. The consequence was left
 * unhandled: deleting a log removes the log row only, and its likes and comments become rows
 * pointing at nothing, forever.
 *
 * Five things therefore grow without bound, and each is a different kind of problem:
 *
 *   `rate_limits`     one row per (bucket, identity) pair, forever — including every IP that
 *                     ever searched and **every email address ever tried at sign-in.** That
 *                     makes the table a list of email addresses, which is a data-retention
 *                     problem before it is ever a disk problem.
 *   orphaned likes    personal data attached to content that no longer exists.
 *   orphaned comments the same, plus a body of text.
 *   dead guests       a guest is a real `users` row reachable only through a session cookie, so
 *                     one older than the 14-day JWT **cannot ever be reached again**, by
 *                     themselves or by anybody else.
 *   spent tokens      a verification or reset row is an email address with an expiry. Once
 *                     consumed it is a retained address with no purpose.
 *
 * The sweeps themselves live in `lib/db/queries/prune.ts`, per the layering doctrine: this file
 * is the trigger and the authentication, and keeping the SQL out of it is also what makes the
 * SQL testable — `tests/prune.test.ts` seeds an orphan, a dead guest and a spent token against
 * a real throwaway Postgres and asserts every count, including the ones that must NOT move.
 *
 * ---------------------------------------------------------------------------------------
 * AUTHENTICATION: A BEARER SECRET, AND **404 WHEN IT IS UNSET**
 * ---------------------------------------------------------------------------------------
 *
 * `CRON_SECRET` absent means this route 404s rather than running unauthenticated. That is the
 * safe direction and it is worth being explicit about why: the alternative — run openly when no
 * secret is configured — would give any visitor to a fresh deployment a button that deletes
 * accounts. **A missing configuration value must never widen access.**
 *
 * The comparison is constant-time. The secret is a bearer credential, and a byte-by-byte
 * compare on a route anybody may call as often as they like is exactly the shape a timing
 * attack needs. `timingSafeEqual` requires equal lengths, so the length is checked first — which
 * does leak the length, and that is an acceptable leak for a value the operator generates with
 * `openssl rand -hex 32`.
 *
 * The response is JSON with `cache-control: no-store`, because a cached "0 removed" would be a
 * lie the next time anybody looked.
 */

import { timingSafeEqual } from "node:crypto";
import { pruneAll } from "@/lib/db/queries/prune";
import { env } from "@/lib/env";

export async function GET(request: Request): Promise<Response> {
  const secret = env.cronSecret;
  /* UNSET => THE ROUTE DOES NOT EXIST. Never "unset => open". */
  if (!secret) return new Response(null, { status: 404 });

  if (!authorized(request, secret)) {
    /*
     * 404 rather than 401, for the same reason the admin pages 404: a 401 confirms the route
     * exists and that a secret is configured, which is two facts more than a prober needs. The
     * legitimate caller arrives with the secret already in hand and never sees this branch.
     */
    return new Response(null, { status: 404 });
  }

  const swept = await pruneAll();

  /* Logged as well as returned: the response goes to a scheduler that discards it, and the log
     is where an operator looks a week later to see whether the sweep has been running. */
  console.info("[cron:prune]", swept);

  return Response.json(swept, { headers: { "cache-control": "no-store" } });
}

/**
 * `Authorization: Bearer <secret>`, compared in constant time.
 *
 * Vercel's scheduler sends exactly this header, so there is no second accepted shape — a
 * `?secret=` query parameter would put the credential in access logs and in the `Referer` of
 * anything the response linked to.
 */
function authorized(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;

  const offered = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(secret);
  // `timingSafeEqual` THROWS on a length mismatch rather than returning false, so this guard is
  // required, not an optimisation.
  if (offered.length !== expected.length) return false;
  return timingSafeEqual(offered, expected);
}

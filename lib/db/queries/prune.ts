import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pruneRateLimits } from "@/lib/security/rate-limit";

/**
 * The scheduled sweep, as queries rather than as a route.
 *
 * `/api/cron/prune` is the trigger and the authentication; this module is the work. The split
 * follows the layering doctrine — `lib/db/` holds the query modules, and a route handler with
 * four raw `DELETE`s inside it is a layering violation that also cannot be tested, because a
 * private function in a route file has no caller a test can reach. `tests/prune.test.ts` seeds
 * an orphan, a dead guest and a spent token against a real throwaway Postgres and asserts each
 * count, which is only possible because these are exported.
 *
 * ---------------------------------------------------------------------------------------
 * NOTHING HERE SELF-GATES, AND THAT IS A DEPARTURE WORTH STATING
 * ---------------------------------------------------------------------------------------
 *
 * Every other privileged module in this repository calls `requireAdmin()` itself (I-20), on the
 * principle that making the query refuse is the difference between one mistake and a breach.
 * These functions deliberately do not, because **their only caller has no session at all** — it
 * is a scheduler holding a bearer secret. A `requireAdmin()` here would make the route
 * permanently uncallable, and the usual fix for that is a flag, which is how a gate becomes
 * decoration.
 *
 * What protects them instead: `CRON_SECRET` compared in constant time, the route 404ing when
 * the secret is unset, and the fact that **every parameter is drawn from a closed union or a
 * module constant.** Two of these functions do take one — `sweepOrphanedInteractions` takes
 * `"likes" | "comments"` and `pruneRateLimits` takes an age with a default — so the earlier
 * wording ("nothing in this module takes a parameter") was simply false. What is true, and is
 * what the safety argument actually rests on, is that there is no path from a request to any of
 * them: no id, no username, no interval a caller can influence. The worst a caller who somehow
 * reached these functions could do is run the sweep that was going to run at 04:00 anyway.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THE SWEEPS ARE INDEPENDENT STATEMENTS AND NOT ONE TRANSACTION
 * ---------------------------------------------------------------------------------------
 *
 * They share no invariant. A pruned rate-limit window has nothing to do with a dead guest, so
 * wrapping them together would mean one failure discards four successes — and the failure mode
 * of a retention sweep should be "less was removed than intended", never "nothing was removed
 * and the reason is buried". Each is a `DELETE … RETURNING` so the caller can report real
 * counts: an operator reading the cron log sees what went, not that something ran.
 */

/**
 * A guest older than this is unreachable, so deleting them destroys nothing anybody can see.
 *
 * The session's own `maxAge` is 14 days, and it is a HARD cap — sessions are not re-issued (see
 * `lib/auth/index.ts`, where an inert `updateAge` was removed once it turned out the RSC
 * `auth()` branch discards the refreshed cookie). **21 is 14 plus a week of margin**, and the
 * margin is not decoration: a guest's cookie expires exactly 14 days after it was issued, so
 * pruning at 14 would race the last hours of a live session, and a week's slack costs nothing
 * but a few unreachable rows.
 *
 * This derivation used to read "updateAge re-issues an active session every day, so a guest who
 * visits on day 13 holds a cookie good until day 27" — which argued for a number larger than
 * the constant beneath it, from a mechanism that did not exist. If re-issue is ever made real,
 * THIS SWEEP MUST CHANGE FIRST: with rolling sessions, age since `created_at` would delete the
 * diary of a guest who visited yesterday.
 *
 * A constant here rather than an environment variable because it is coupled to
 * `SESSION_MAX_AGE_SECONDS` in `lib/auth/index.ts` — two values that must move together do not
 * belong in two different systems.
 */
export const GUEST_GRACE_DAYS = 21;

/** Expired tokens are kept a day, for "the link says expired — when did it go out?". */
export const TOKEN_GRACE_HOURS = 24;

export type PruneCounts = {
  rateLimits: number;
  orphanedLikes: number;
  orphanedComments: number;
  deadGuests: number;
  spentTokens: number;
};

/** The two polymorphic interaction tables. A closed union, not a string. */
export type InteractionTable = "likes" | "comments";

/**
 * Likes and comments whose target no longer exists.
 *
 * `target_type` is `log` or `list` and `target_id` carries **no foreign key** — deliberately, because
 * the target is polymorphic and a column cannot reference two tables. So this cannot be a
 * cascade, and without it deleting a log leaves its likes and comments pointing at nothing
 * forever. That is the whole reason this route exists (brief defect #10).
 *
 * The `NOT EXISTS` pair is written per target type rather than as one clever join, because the
 * two branches genuinely check different tables and a reader should be able to see both being
 * checked. The third clause sweeps any `target_type` outside the vocabulary: no writer can
 * produce one today, but a row that no reader recognises is unreachable by definition, and
 * leaving it to accumulate silently is how the next schema change strands data.
 *
 * `sql.raw` interpolates the table name because Drizzle cannot parameterise an identifier. The
 * value comes from this module's own two-member union and there is no path from a request to
 * it; the alternative is two near-identical copies of the statement.
 *
 * `RETURNING t.target_id`, NOT `t.id`: **`likes` has a composite primary key**
 * (`user_id, target_type, target_id`) and therefore no `id` column at all, while `comments` has
 * a serial. `target_id` is the one column both are guaranteed to have, and the rows are only
 * being counted. Asking for `t.id` failed against the real database on the first call — the
 * kind of mistake a shared helper over two differently-keyed tables invites.
 */
export async function sweepOrphanedInteractions(table: InteractionTable): Promise<number> {
  const result = await db.execute<{ target_id: number }>(sql`
    delete from ${sql.raw(table)} t
     where (t.target_type = 'log'  and not exists (select 1 from logs  l where l.id = t.target_id))
        or (t.target_type = 'list' and not exists (select 1 from lists s where s.id = t.target_id))
        or t.target_type not in ('log', 'list')
    returning t.target_id
  `);
  return result.rows.length;
}

/**
 * Guests whose session can no longer exist.
 *
 * THE FILTER IS AGE ALONE — NOT "AND THEY LOGGED NOTHING". That reads harsher than it is: a
 * guest's rows are excluded from every public aggregate by `u.is_guest = false`, so an
 * unreachable guest's diary is visible to nobody at all, including them. Keeping it would be
 * retaining data with exactly one possible future, which is being retained further.
 *
 * `created_at` is the clock rather than a last-seen column, and **the schema has no last-seen
 * column on purpose** — recording when each member was last active is a surveillance field that
 * would then need its own retention rule, and this sweep is meant to reduce what is held rather
 * than justify holding more. `GUEST_GRACE_DAYS` covers the gap the missing column would have
 * closed.
 *
 * `is_guest = true` is the entire scope, and it is the line to read twice: a bug here deletes
 * real accounts. The delete cascades through the whole graph — logs, lists, wantlist,
 * favourites, follows, likes, comments, Desert Island, both token tables — so this one
 * statement is the whole removal. `admin_audit_log` rows survive, because they carry no foreign
 * key and copy the username at write time.
 */
export async function sweepDeadGuests(): Promise<number> {
  const result = await db.execute<{ id: number }>(sql`
    delete from users
     where is_guest = true
       and created_at < now() - make_interval(days => ${GUEST_GRACE_DAYS})
    returning id
  `);
  return result.rows.length;
}

/**
 * Verification and reset tokens that are spent or long expired.
 *
 * Both tables cascade from `users`, so this only reaches rows whose owner still exists — which
 * is the point: **a live account with a consumed reset token is the case the cascade never
 * covers.**
 *
 * The stored value is a SHA-256 hash, never the token, so these rows are not credentials. They
 * are however an email address with a timestamp, and the address is already on the `users` row,
 * so a second copy with no remaining purpose is pure retention.
 */
export async function sweepSpentTokens(): Promise<number> {
  let removed = 0;
  for (const table of ["email_verification_tokens", "password_reset_tokens"] as const) {
    const result = await db.execute<{ id: number }>(sql`
      delete from ${sql.raw(table)}
       where consumed_at is not null
          or expires_at < now() - make_interval(hours => ${TOKEN_GRACE_HOURS})
      returning id
    `);
    removed += result.rows.length;
  }
  return removed;
}

/**
 * All five sweeps, sequentially.
 *
 * SEQUENTIAL RATHER THAN `Promise.all`, and not for correctness — they touch disjoint tables.
 * A serverless invocation gets one connection, and five concurrent `DELETE`s on one connection
 * is five statements queued behind each other anyway, with the interleaved locks making a
 * failure harder to attribute. The sweep runs once a day at four in the morning; nothing about
 * it is latency-sensitive.
 */
export async function pruneAll(): Promise<PruneCounts> {
  return {
    rateLimits: await pruneRateLimits(),
    orphanedLikes: await sweepOrphanedInteractions("likes"),
    orphanedComments: await sweepOrphanedInteractions("comments"),
    deadGuests: await sweepDeadGuests(),
    spentTokens: await sweepSpentTokens(),
  };
}

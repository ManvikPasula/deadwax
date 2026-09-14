/**
 * Grants or revokes the operator role.
 *
 *   npm run admin:grant -- someone@example.com
 *   npm run admin:grant -- someone@example.com --revoke
 *
 * GRANTING IS A COMMAND-LINE SCRIPT AND NOT A BUTTON, AND THAT IS THE WHOLE POINT.
 *
 * There is no action anywhere in the application that writes `users.role` — `app/actions/admin.ts`
 * writes `plan`, and nothing writes `role` — so the only way to become an administrator is an
 * operator holding database credentials running this file. PRIVILEGE ESCALATION HAS TO BE
 * IMPOSSIBLE BY CONSTRUCTION, NOT MERELY UNIMPLEMENTED: an admin panel with a "make this person
 * an admin" control is one authorization bug away from letting a member promote themselves,
 * whereas a missing code path cannot be reached by any bug at all.
 *
 * `tests/no-escalation.test.ts` asserts that mechanically at the source level: only this file
 * and `app/actions/admin.ts` may write `role` or `plan`, so a future action that sets either
 * fails a test instead of quietly shipping an escalation.
 *
 * THE SAME PROPERTY IS ALSO THE REASON DELETING AN ADMIN IS A TWO-KEY OPERATION. `deleteAccount`
 * refuses to delete a row whose role is `admin`, and demoting one needs this script — so one
 * compromised admin session cannot remove the others without somebody who has shell access
 * agreeing to it.
 *
 * DELIBERATELY ABSENT, each for a reason:
 *   - No confirmation prompt. This runs under `npm run`, and a script that reads from stdin
 *     hangs in every non-interactive context an operator would actually use it from.
 *   - No audit row. `admin_audit_log` records IN-APP actions, and the actor here is not a
 *     session — there is no `users.id` to put in `actor_id` and no honest value for
 *     `actor_username`. A row claiming otherwise would be worse than no row.
 *   - No "list current admins". The `· admin` suffix in the /admin accounts table is the only
 *     list there is, which is enough for a single-role system with a handful of operators.
 *
 * PGlite allows exactly one writer: STOP THE DEV SERVER FIRST when running this against the
 * local store.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

const USAGE = "usage: npm run admin:grant -- <email> [--revoke]";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const revoke = args.includes("--revoke");
  const email = args.find((arg) => !arg.startsWith("--"));

  if (!email) {
    console.error(`[admin:grant] no email address given.\n${USAGE}`);
    process.exit(1);
  }

  /**
   * CASE-INSENSITIVE LOOKUP, AND `lower()` ON BOTH SIDES.
   *
   * It matches the shape of the functional unique index `users_email_lower_uq`, so this is an
   * index scan; and, more importantly, it is THE SAME IMPLEMENTATION OF "lower" the index
   * enforces. Lowercasing the argument in JavaScript instead would introduce a second
   * implementation, and JavaScript and Postgres disagree on some non-ASCII characters — the
   * same defect class as I-8 — so an address stored through one would be unreachable through
   * the other. An operator typing `Someone@Example.com` from a support ticket has to find the
   * row that was created as `someone@example.com`.
   */
  const found = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      role: users.role,
      isGuest: users.isGuest,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);

  const account = found[0];
  if (!account) {
    // The address is echoed back. This is a local operator tool, not a public form, so there is
    // no membership oracle to protect here — and an operator who mistyped needs to see what
    // they typed.
    console.error(`[admin:grant] no account with the address ${email}`);
    process.exit(1);
  }

  /**
   * GUESTS ARE REFUSED. A guest row has no usable credentials — `authorize()` rejects it — so
   * granting one the role produces an administrator who cannot sign in, which presents to the
   * operator as "I ran the command and nothing happened". Refusing loudly is the useful answer.
   */
  if (account.isGuest) {
    console.error(
      `[admin:grant] ${account.username} is a guest account. It has no credentials, so an admin role on it would be unusable.`,
    );
    process.exit(1);
  }

  const target = revoke ? "member" : "admin";
  if (account.role === target) {
    console.info(`[admin:grant] ${account.username} is already ${target}. Nothing to do.`);
    return;
  }

  if (revoke) {
    /**
     * `email_verified_at` IS DELIBERATELY NOT TOUCHED ON REVOKE. Losing the operator role does
     * not un-confirm somebody's address, and clearing it would lock an ordinary member out of
     * publishing for a reason unconnected to anything they did.
     */
    await db.update(users).set({ role: "member" }).where(sql`${users.id} = ${account.id}`);
    console.info(`[admin:grant] revoked: ${account.username} <${account.email}> is now a member.`);
    return;
  }

  /**
   * THE GRANT ALSO CONFIRMS THE ADDRESS, BECAUSE AN UNVERIFIED ADMIN WOULD BE BLOCKED BY THE
   * PUBLISHING GATE. With `REQUIRE_EMAIL_VERIFICATION` on, `guard()` refuses every non-exempt
   * action for an unconfirmed member — and while the admin actions themselves are exempt, an
   * operator who cannot post a review or create a list is an operator who cannot use the
   * product they are administering.
   *
   * `coalesce(email_verified_at, now())` AND NOT `now()`. NEVER CLOBBER A REAL TIMESTAMP: the
   * column records WHEN somebody confirmed their address, and overwriting a two-year-old
   * confirmation with today's date silently rewrites history for no gain. The coalesce also
   * makes re-running this idempotent in the only way that matters.
   */
  await db
    .update(users)
    .set({ role: "admin", emailVerifiedAt: sql`coalesce(email_verified_at, now())` })
    .where(sql`${users.id} = ${account.id}`);

  const confirmed = account.emailVerifiedAt
    ? "address was already confirmed"
    : "address confirmed by this grant";
  console.info(`[admin:grant] granted: ${account.username} <${account.email}> is now an admin (${confirmed}).`);
}

main().catch((error: unknown) => {
  console.error("[admin:grant] FAILED —", error instanceof Error ? error.message : error);
  process.exit(1);
});

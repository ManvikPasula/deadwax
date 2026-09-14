import "server-only";

import { eq } from "drizzle-orm";

import { currentUser, ForbiddenError, UnauthorizedError, type SessionUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

/**
 * The admin gate. One function, one column, one query.
 *
 * THE ROLE IS NEVER IN THE SESSION TOKEN, AND THIS IS THE SINGLE MOST IMPORTANT LINE IN THE
 * FILE (I-18). `SessionUser` has no `role` field precisely so that a caller cannot read one
 * from the session by accident. Putting `role` in the JWT would be one property access instead
 * of one indexed query — and it would break the one authorization invariant this application
 * states, because the tokens are stateless and live for fourteen days: demoting an admin would
 * not take effect until their cookie expired. REVOCATION MUST TAKE EFFECT ON THE NEXT REQUEST.
 * If somebody arrives here to "save a query", this paragraph is the answer.
 *
 * IT THROWS RATHER THAN RETURNING A BOOLEAN, so a caller cannot forget to check the result.
 * `const admin = await isAdmin()` followed by a forgotten `if` is a silent full breach;
 * `await requireAdmin()` cannot be misused that way. The cost is that callers must know what
 * to do with the throw, and they do: an admin ROUTE catches `ForbiddenError` and calls
 * `notFound()` (I-21 — a 403 confirms the route exists and that they found a real admin
 * surface, while a 404 is indistinguishable from a typo), RETHROWING everything else so real
 * failures still surface as 500s. An admin ACTION lets `guard()` convert it, because by then
 * the caller already knows the action exists — they called it.
 *
 * THIS IS THE SECOND OF FOUR GATES ON EVERY PRIVILEGED READ, not the only one: the route, the
 * metadata (`noindex`, `no-referrer`), THE QUERY ITSELF (which self-gates — making the query
 * refuse is the difference between one mistake and a breach, I-20), and the action. Four
 * because a privileged surface reached by three entry points has three chances to be reached
 * by a fourth.
 *
 * There is no roles table and no per-capability grant. One `varchar(16)` column with two
 * values, and NO MEMBER-FACING PATH WRITES IT: the only way to become an admin is the operator
 * running `npm run admin:grant`. Privilege escalation has to be impossible by construction
 * rather than merely unimplemented, and tests/no-escalation.test.ts asserts that at the source
 * level so a future action fails a test instead of quietly shipping.
 */

/** The only value that grants access. `users.role` defaults to `'member'`. */
const ADMIN_ROLE = "admin";

/**
 * Returns the session user on success; throws `ForbiddenError` otherwise.
 *
 * The refusal is `ForbiddenError` even when the row has vanished, EXCEPT for the no-session
 * case, which is `UnauthorizedError` — a signed-out visitor should be told to sign in, not
 * told that they lack a privilege they have never heard of. A signed-in non-admin gets the
 * same flat message as everyone else and learns nothing about what they nearly reached.
 */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new UnauthorizedError();

  const rows = await db.select({ role: users.role }).from(users).where(eq(users.id, user.id)).limit(1);
  const row = rows[0];

  // A missing row also confirms the account still exists, so this doubles as the revocation
  // check `requireUser()` performs for ordinary writes. An admin action therefore does not
  // need both.
  if (!row || row.role !== ADMIN_ROLE) throw new ForbiddenError();

  return user;
}

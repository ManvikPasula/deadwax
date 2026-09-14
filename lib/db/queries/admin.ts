import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { requireAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { adminAuditLog, logs, users } from "@/lib/db/schema";
import { containsPattern } from "@/lib/like";

/**
 * The operator panel's reads, and the one write that belongs to the audit table.
 *
 * EVERY READ IN THIS FILE CALLS `requireAdmin()` ITSELF rather than trusting its caller to
 * have done so (I-20):
 *
 *   "These queries return email addresses and account state, so a page that forgot the check
 *    would be a disclosure bug; making the query refuse is the difference between one mistake
 *    and a breach."
 *
 * The cost is several extra indexed role lookups per /admin render — one per query, on top of
 * the route's own — and it is accepted as the price of the property. It is the third of four
 * gates on a privileged read: the route (`notFound()` on `ForbiddenError`, I-21), the metadata
 * (`noindex`, `no-referrer`), THIS, and the action. Four, because a privileged surface reached
 * by three entry points has three chances to be reached by a fourth.
 *
 * `requireAdmin()` reads `users.role` from the column on every call and never from the session
 * token (I-18), so a demotion takes effect on the next request rather than when a
 * fourteen-day JWT expires.
 *
 * THE EXCEPTION, AND IT IS TYPED RATHER THAN TRUSTED: `recordAction` does not self-gate,
 * because it takes a transaction handle as its first parameter and therefore cannot be called
 * from anywhere except inside a transaction an admin action has already opened. See its
 * docblock.
 */

/* -------------------------------------------------------------------------- */
/* Accounts                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The accounts table's row.
 *
 * THIS PROJECTION CARRIES AN EMAIL ADDRESS, which is why the whole file self-gates and why
 * this type is deliberately NOT reused anywhere outside /admin. Compare `MemberRecord` in
 * queries/users.ts, which omits `email` and `password_hash` precisely because it is handed to
 * public Server Components and props cross the wire in the RSC payload.
 *
 * `password_hash` is absent from HERE too, and there is no admin surface that shows it. An
 * operator has no question that a bcrypt hash answers.
 */
export type AdminAccount = {
  id: number;
  username: string;
  displayName: string | null;
  email: string;
  /** member | admin. The `· admin` suffix in the table is the only list of admins there is. */
  role: string;
  /** free | pro. Written by exactly one action, and by nothing else in the codebase. */
  plan: string;
  isGuest: boolean;
  emailVerifiedAt: Date | null;
  planUpdatedAt: Date | null;
  createdAt: Date;
  /**
   * How many diary rows this account holds.
   *
   * Here for one reason: the delete confirmation enumerates the child tables that cascade, and
   * a number is the only part of that sentence that conveys scale. Deleting an account with
   * four logs and deleting one with four thousand are different decisions, and an operator
   * should be able to tell them apart before pressing the button rather than after.
   *
   * It counts `logs` only, not every cascading table. One honest number beats six approximate
   * ones, and the diary is the table whose loss would actually matter to the member.
   */
  logCount: number;
};

/** The accounts table shows this many per page. */
export const ACCOUNT_PAGE_SIZE = 25;

export type AccountPage = {
  rows: AdminAccount[];
  page: number;
  hasMore: boolean;
};

/**
 * The accounts table, optionally filtered by a search box.
 *
 * THE SEARCH TEXT GOES THROUGH `containsPattern` (I-6). Without it a `%` matches every row —
 * in the original that made `/search?q=%` return the whole catalogue and every member — and,
 * the other way round, an operator looking for a member whose username contains an underscore
 * could never find them by typing it. `containsPattern` escapes first and wraps second; the
 * reverse order escapes the wildcards it just added.
 *
 * I-13 — THE PARENTHESES AROUND THE OR ARE LOAD-BEARING. Drizzle emits a raw `sql` fragment
 * unparenthesised and SQL binds AND tighter than OR, so an unbracketed three-way OR next to
 * any future AND silently becomes `(A and B) or C or D`. That exact shape shipped in the
 * original and made every guest account findable by searching "guest", because every guest's
 * display name is literally "Guest User". It was caught by a test rather than by reading.
 *
 * GUESTS ARE NOT FILTERED OUT HERE, unlike every public aggregate (I-12). This is the one
 * surface where they must be visible: a guest is a real row that can be deleted, can hold a
 * diary, and is the thing an operator is most likely to be asked about.
 *
 * `hasMore` comes from fetching one row past the page rather than from a second `count(*)`.
 * Two statements that have to agree about the same predicate are two statements that will one
 * day disagree (I-14), and the only thing this page needs to know is whether to draw a "next"
 * button.
 */
export async function listAccounts(options: { query?: string; page?: number } = {}): Promise<AccountPage> {
  await requireAdmin();

  const page = Math.max(1, Math.floor(options.page ?? 1) || 1);
  const trimmed = (options.query ?? "").trim();
  const pattern = trimmed.length > 0 ? containsPattern(trimmed) : null;

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      email: users.email,
      role: users.role,
      plan: users.plan,
      isGuest: users.isGuest,
      emailVerifiedAt: users.emailVerifiedAt,
      planUpdatedAt: users.planUpdatedAt,
      createdAt: users.createdAt,
      logCount: sql<number>`count(${logs.id})::int`,
    })
    .from(users)
    // LEFT, so an account that has logged nothing still appears — at zero — rather than
    // vanishing from the one table that is supposed to list every account.
    .leftJoin(logs, eq(logs.userId, users.id))
    .where(
      pattern
        ? and(
            sql`(${users.username} ilike ${pattern} or ${users.email} ilike ${pattern} or ${users.displayName} ilike ${pattern})`,
          )
        : undefined,
    )
    .groupBy(users.id)
    // Newest first: the accounts an operator is asked about are almost always recent ones.
    // `id` is the tiebreaker, because two accounts created in the same millisecond would
    // otherwise reshuffle between identical requests.
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(ACCOUNT_PAGE_SIZE + 1)
    .offset((page - 1) * ACCOUNT_PAGE_SIZE);

  return {
    rows: rows.slice(0, ACCOUNT_PAGE_SIZE),
    page,
    hasMore: rows.length > ACCOUNT_PAGE_SIZE,
  };
}

/**
 * One account by id — the read every account action makes before it acts.
 *
 * IT SELF-GATES LIKE EVERYTHING ELSE HERE, even though its only callers have already called
 * `requireAdmin()` as their first statement. That is one redundant indexed lookup per admin
 * mutation, and the alternative is an exception in a file whose entire value is that there
 * isn't one: "every function here refuses on its own" is a property a reviewer can check in a
 * second, and "every function except this one, because its callers are careful" is a property
 * that has to be re-verified every time a caller is added.
 *
 * `role` IS IN THE PROJECTION because `deleteAccount` refuses to delete an admin, and `plan`
 * because `setAccountPlan` is a no-op at the current value. Both are read from the row, never
 * from a token (I-18).
 */
export async function findAccountForAdmin(userId: number): Promise<{
  id: number;
  username: string;
  email: string;
  role: string;
  plan: string;
  isGuest: boolean;
} | null> {
  await requireAdmin();

  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      email: users.email,
      role: users.role,
      plan: users.plan,
      isGuest: users.isGuest,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* The audit trail                                                            */
/* -------------------------------------------------------------------------- */

/**
 * EVERY AUDITABLE ACTION, AS A UNION OF LITERAL STRINGS.
 *
 * The same device as `ActionLabel` in app/actions/result.ts and for the same reason: the column
 * is a `varchar(32)` with no check constraint, so a typo — `"ad.stauts"` — would insert
 * happily and simply never match anything a reader was filtering for. A union makes it a
 * compile error at the call site, and the list doubles as the inventory a reviewer reads to ask
 * "is everything that changes state in here?".
 *
 * Every value is under 32 characters. The longest is `account.password_reset` at 22, which
 * leaves room; a value that exceeded the width would fail at INSERT, after the effect it was
 * recording had already been applied — except that it cannot, because the audit row is written
 * FIRST inside the transaction.
 */
export type AdminAuditAction =
  | "plan.set"
  | "account.delete"
  | "account.password_reset"
  | "album.resync"
  | "ad.create"
  | "ad.status"
  | "ad.weight"
  | "ad.archive";

/**
 * The transaction handle, derived from `db.transaction` rather than imported as a type.
 *
 * Written this way so it cannot drift: the dual-driver switch in lib/db/index.ts means the
 * concrete transaction type depends on which driver is active, and naming
 * `PgTransaction<...>` here would pin one of them. `Parameters<Parameters<typeof
 * db.transaction>[0]>[0]` reads as "the first argument of the callback that `db.transaction`
 * takes", which is true for both.
 */
export type AdminTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AdminAuditEntry = {
  /**
   * ALWAYS THE ADMIN RETURNED BY `requireAdmin()`, NEVER ANYTHING FROM CLIENT INPUT. An audit
   * trail whose actor field can be supplied by the caller is a log of claims, not of facts.
   */
  actor: { id: number; username: string };
  action: AdminAuditAction;
  /** The affected account or ad. Null only where the action genuinely has no single target. */
  targetId?: number | null;
  /** Echoed from the row so the log stays readable after the account is gone. */
  targetUsername?: string | null;
  /** One short line: "free -> pro", "status: active", "weight: 40". */
  detail?: string | null;
};

/**
 * `actor_username` is `varchar(32)` and `target_username` is `varchar(32)`; `detail` is `text`
 * and is bounded here anyway, because an unbounded field on an append-only table is an
 * unbounded table. Two hundred characters is more than any of the callers produce.
 */
const MAX_DETAIL = 200;

/**
 * Writes one audit row. THE TRANSACTION HANDLE IS THE FIRST PARAMETER AND IT IS NOT OPTIONAL.
 *
 * That signature is the entire design. The row cannot be written outside the transaction that
 * applies the effect, because there is no overload that takes `db` — so "audited and applied"
 * and "neither" are the only two outcomes, and a deletion that half-succeeded cannot leave a
 * record saying it worked or an effect with no record at all.
 *
 * THE SOURCE BRIEF'S INCONSISTENCY IS FIXED HERE RATHER THAN COPIED. There, the ad actions use
 * a separate, non-transactional local `audit()` helper that runs AFTER the mutation with null
 * target fields — so an ad status change that committed and then failed to log left no trace,
 * and the rows it did write could not say which ad they were about. `app/actions/ads.ts` uses
 * this function, inside the same transaction as the mutation, with the ad id in `targetId`.
 *
 * IT DOES NOT SELF-GATE, and the typed handle is why that is not an exception to I-20: it is
 * unreachable except from inside a transaction that an admin action opened after calling
 * `requireAdmin()`. Calling `requireAdmin()` in here would also mean issuing a query on the
 * POOL while holding a transaction on one of its five connections, which is how a
 * five-connection pool deadlocks under load.
 *
 * "APPEND-ONLY" IS A CONVENTION, NOT AN ENFORCEMENT. No trigger, no `REVOKE UPDATE`, no hash
 * chain. Anyone with database credentials can rewrite this history — and database credentials
 * are also the grant mechanism (`npm run admin:grant`), so the operator is fully trusted by
 * construction and a tamper-proof log would be defending against nobody.
 */
export async function recordAction(tx: AdminTx, entry: AdminAuditEntry): Promise<void> {
  await tx.insert(adminAuditLog).values({
    actorId: entry.actor.id,
    actorUsername: entry.actor.username,
    action: entry.action,
    targetId: entry.targetId ?? null,
    targetUsername: entry.targetUsername ?? null,
    detail: entry.detail ? entry.detail.slice(0, MAX_DETAIL) : null,
  });
}

export type AdminActionRow = {
  id: number;
  /**
   * NULLABLE, and it is the only column in the table that is. `actor_id` has no foreign key:
   * a deleted admin's rows must survive, and the username is kept alongside precisely so the
   * log stays readable when the id no longer resolves to anything.
   */
  actorId: number | null;
  actorUsername: string;
  action: string;
  targetId: number | null;
  targetUsername: string | null;
  detail: string | null;
  createdAt: Date;
};

/** The panel shows the last ten. There is no full-history view; anything older needs SQL. */
export const ADMIN_ACTION_FEED_LIMIT = 10;

/**
 * The last few things an operator did.
 *
 * Served by `admin_audit_created_idx`. One read surface, no filter, no export, no pagination —
 * deliberately: this is a "did I just do that?" panel, not a compliance product, and building
 * a query interface over it would invite it to be used as one.
 */
export async function listRecentAdminActions(limit = ADMIN_ACTION_FEED_LIMIT): Promise<AdminActionRow[]> {
  await requireAdmin();

  return db
    .select({
      id: adminAuditLog.id,
      actorId: adminAuditLog.actorId,
      actorUsername: adminAuditLog.actorUsername,
      action: adminAuditLog.action,
      targetId: adminAuditLog.targetId,
      targetUsername: adminAuditLog.targetUsername,
      detail: adminAuditLog.detail,
      createdAt: adminAuditLog.createdAt,
    })
    .from(adminAuditLog)
    // `id` after `created_at` because two rows written inside one transaction share a
    // timestamp, and "audit row, then delete" is exactly that case.
    .orderBy(desc(adminAuditLog.createdAt), desc(adminAuditLog.id))
    .limit(Math.max(1, Math.min(Math.floor(limit) || ADMIN_ACTION_FEED_LIMIT, 100)));
}

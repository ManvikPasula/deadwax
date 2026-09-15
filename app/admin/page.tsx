/**
 * /admin — accounts, and the tail of the audit trail.
 *
 * ============================================================================
 * FOUR GATES STAND BETWEEN A VISITOR AND ONE PRIVILEGED READ, AND THIS FILE IS THE FIRST
 *
 *   1. THE ROUTE       `notFound()` on `ForbiddenError` — **and everything else rethrown**
 *   2. THE METADATA    `robots: noindex`, `referrer: "no-referrer"`
 *   3. THE QUERY       `listAccounts` and `listRecentAdminActions` both call `requireAdmin()`
 *                      themselves (I-20)
 *   4. THE ACTION      `requireAdmin()` as the first statement inside `guard()`
 *
 * They are not redundant. Each one fails differently, and the second one exists because the
 * first can be forgotten: *making the query refuse is the difference between one mistake and a
 * breach.* A page added next month that forgets the try/catch renders an error, not an email
 * column.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------------------
 * 404, NOT 403 (I-21) — AND THE RETHROW IS HALF THE INVARIANT
 * ---------------------------------------------------------------------------------------
 *
 * A 403 confirms two things to somebody probing: that the route exists, and that they found a
 * real admin surface worth coming back to with better credentials. A 404 is indistinguishable
 * from a typo.
 *
 * But a blanket `catch { notFound() }` would turn **every** failure into a 404 — a dropped
 * database connection, a migration half-applied, a bug in the query — and an admin panel that
 * silently 404s when the database is down is an admin panel that lies to the only person who
 * could fix it. So exactly two classes are converted and everything else is rethrown to become
 * a real 500.
 *
 * `notFound()` is called OUTSIDE the try block, because it works by throwing a sentinel error
 * that Next catches upstream. Called inside, the catch would swallow its own signal and the
 * rethrow would turn it into a 500 — which is the kind of bug that only shows up for the
 * visitors you were trying to refuse. The loader returns `null` instead, and the decision is
 * made after it returns.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT IS ON THE PAGE, AND WHAT IS DELIBERATELY NOT
 * ---------------------------------------------------------------------------------------
 *
 * Accounts (paged, searchable) and the last ten audit entries. There is no moderation queue, no
 * content takedown control and no role editor: `users.role` is written by exactly two files in
 * the repository and a source-level test asserts it, so promotion is an operator-with-a-shell
 * operation. **Privilege escalation has to be impossible by construction, not merely
 * unimplemented.**
 *
 * The audit tail is here rather than on its own route because ten entries is the useful window
 * for "did that plan change actually land" — the full history is a database query, and giving
 * it a paged UI would imply the log is authoritative. It is append-only by convention only: no
 * trigger, no `REVOKE`, no hash chain. Anyone with database credentials can rewrite it, and
 * database credentials are also the grant mechanism, so the operator is fully trusted by
 * construction.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountTable } from "@/components/admin/account-table";
import { queryHref } from "@/components/discovery/sort-select";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";
import { Badge, Eyebrow, Pagination, SectionHeading } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/auth/admin";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/session";
import {
  ACCOUNT_PAGE_SIZE,
  type AccountPage,
  type AdminActionRow,
  listAccounts,
  listRecentAdminActions,
} from "@/lib/db/queries/admin";
import { formatDate, formatRelative } from "@/lib/format";
import { parsePage } from "@/lib/slug";

export const metadata: Metadata = {
  title: "Admin",
  /*
   * NO `description`, and the omission is not laziness: a description is written to be read in
   * a search result, and this page must not appear in one. `noindex` plus `nofollow` keeps the
   * route out of an index even when somebody pastes the URL somewhere public, and
   * `no-referrer` keeps `/admin?q=someone@example.com` out of the `Referer` header of every
   * outbound link on the page — which for a page whose query string is a search over email
   * addresses is the leak that actually matters.
   */
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = (raw ?? "").trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 80);
}

type AdminData = {
  selfId: number;
  accounts: AccountPage;
  actions: AdminActionRow[];
};

/**
 * The whole privileged read, and the only place the two convertible errors are caught.
 *
 * Returns `null` for "refuse this visitor" so the caller can raise `notFound()` outside the
 * try — see the docblock. Everything that is not one of the two auth classes leaves this
 * function unchanged and becomes a 500.
 */
async function loadAdmin(query: string | null, page: number): Promise<AdminData | null> {
  try {
    /*
     * `requireAdmin()` IS CALLED HERE TOO, even though both queries self-gate.
     *
     * Not for the gate — for the id. `AccountTable` needs to know which row is the viewer's own
     * so it can refuse to offer a self-delete, and reading that from the session alone would
     * mean trusting a token for an identity used to shape a privileged UI. This resolves the
     * role from the database on every request, which is also the only way revocation takes
     * effect on the next request rather than on token expiry.
     */
    const admin = await requireAdmin();
    const [accounts, actions] = await Promise.all([
      listAccounts({ query: query ?? undefined, page }),
      listRecentAdminActions(),
    ]);
    return { selfId: admin.id, accounts, actions };
  } catch (error) {
    if (error instanceof ForbiddenError || error instanceof UnauthorizedError) return null;
    throw error; // a dropped connection is a 500, not a 404
  }
}

export default async function AdminPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const query = one(params.q);
  const page = parsePage(one(params.page));

  const data = await loadAdmin(query, page);
  if (!data) notFound();

  const { rows, hasMore } = data.accounts;

  return (
    <div className="space-y-10">
      <header className="letterbox">
        <Eyebrow>Operator</Eyebrow>
        <h1 className="mt-2 font-display text-3xl leading-tight text-paper sm:text-4xl">Accounts</h1>
        <p className="mt-2 text-sm text-muted">
          Every account, newest first. Plan changes, reset links and deletions are recorded in the
          audit trail below with the username of whoever performed them.
        </p>
      </header>

      {/*
        A GET FORM, NOT A SERVER ACTION. The result is a view, so it belongs in the URL: an
        operator can bookmark a search, reload it, and send it to somebody. `method` is left at
        its default for the same reason — a POST search would be a view with no address.
      */}
      <form action="/admin" method="get" className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <Label htmlFor="admin-q">Search accounts</Label>
          <Input
            id="admin-q"
            name="q"
            type="search"
            defaultValue={query ?? ""}
            maxLength={80}
            placeholder="Username, display name or email"
          />
        </div>
        <Button type="submit" variant="secondary">
          Search
        </Button>
        {query ? (
          <Button asChild variant="ghost">
            <Link href="/admin">Clear</Link>
          </Button>
        ) : null}
      </form>

      {rows.length === 0 ? (
        <p className="text-sm text-muted">
          {query ? `Nothing matches “${query}”.` : "No accounts yet."}
        </p>
      ) : (
        <AccountTable accounts={rows} selfId={data.selfId} />
      )}

      {/*
        `hasMore` COMES FROM READING ONE ROW PAST THE WINDOW, so there is no `COUNT(*)` and
        therefore no total page count to hand `Pagination`. Omitting `totalPages` is what makes
        it render a prev/next pair instead of a numbered list — the honest control for a
        cursor-shaped read.
      */}
      <Pagination
        page={page}
        hasNext={hasMore}
        buildHref={(next) => queryHref("/admin", { q: query, page: next <= 1 ? null : next })}
      />

      <section>
        <SectionHeading as="h2" eyebrow="Audit trail" title="Recent operator actions" />
        {data.actions.length === 0 ? (
          <p className="text-sm text-muted">Nothing has been done from this panel yet.</p>
        ) : (
          <ol className="space-y-2">
            {data.actions.map((entry) => (
              <li
                key={entry.id}
                className="card flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3 text-[0.8125rem]"
              >
                <Badge tone={entry.action.startsWith("account.delete") ? "rose" : "neutral"}>
                  {entry.action}
                </Badge>
                {/*
                  `actorUsername` IS THE COPY TAKEN AT WRITE TIME, not a join.
                  `admin_audit_log` has no foreign key to `users` on purpose — an audit trail
                  that vanishes with the account it describes is not an audit trail — so this
                  row still reads correctly after the actor has been deleted. `actorId` may be
                  a dangling integer, which is why it is not rendered as a link.
                */}
                <span className="text-paper">{entry.actorUsername}</span>
                {entry.targetUsername ? (
                  <span className="text-muted">
                    → <span className="font-mono text-[0.75rem]">@{entry.targetUsername}</span>
                  </span>
                ) : null}
                {entry.detail ? <span className="min-w-0 flex-1 truncate text-faint">{entry.detail}</span> : null}
                <time
                  dateTime={entry.createdAt.toISOString()}
                  title={formatDate(entry.createdAt) ?? undefined}
                  className="ml-auto shrink-0 font-mono text-[0.625rem] uppercase tracking-wider text-faint"
                >
                  {formatRelative(entry.createdAt)}
                </time>
              </li>
            ))}
          </ol>
        )}
      </section>

      <p className="text-[0.75rem] leading-relaxed text-faint">
        {ACCOUNT_PAGE_SIZE} accounts a page. There is no role control here: `users.role` is
        written by two files in the repository and nothing else, and a test asserts it — promotion
        is <code className="font-mono">npm run admin:grant</code> from a shell.{" "}
        <Link href="/admin/ads" className="text-muted transition-colors hover:text-amber">
          House ads
        </Link>
        .
      </p>
    </div>
  );
}

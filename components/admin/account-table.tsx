"use client";

/**
 * The account table — the only place in the product where one member acts on another's row.
 *
 * ---------------------------------------------------------------------------------------
 * `expectedUsername` IS ECHOED FROM THE ROW, AND THAT IS THE WHOLE SAFETY MECHANISM
 * ---------------------------------------------------------------------------------------
 *
 * Every one of the three account actions takes `{ userId, expectedUsername }`, and the server
 * compares the username against the database before acting. This component's contribution is
 * that it sends back **the username it drew**, not one re-derived from anything else: the
 * button's payload and the text the operator read are the same string.
 *
 * What that buys: a table loaded ten minutes ago, an account deleted and its id reissued, two
 * tabs open on different pages of the directory — in all three cases the id still resolves and
 * the username no longer matches, so the action refuses instead of acting on the wrong person.
 * **The id alone is not enough**, and no amount of care in this file would make it enough,
 * which is why the check lives on the server and this file only has to be honest.
 *
 * The comparison is case-sensitive, matching the server: usernames are stored case-preserving
 * behind a case-insensitive unique index, so "Bob" and "bob" cannot both exist — but the stored
 * form is the one on screen, and a case-insensitive compare here would accept a row that had
 * been recreated with different capitalisation.
 *
 * ---------------------------------------------------------------------------------------
 * DELETE IS TWO PRESSES WITH A SELF-DISARM, NOT A MODAL
 * ---------------------------------------------------------------------------------------
 *
 * The same pattern as `DeleteLogButton`, with a longer window. The first press arms, the second
 * commits, and it disarms itself — so an operator who armed it and then went to read something
 * else comes back to a row that is safe again rather than one press from a cascade.
 *
 * `DISARM_MS` is 5000 here rather than the 4000 used for a log, because the confirmation the
 * operator is supposed to perform between the two presses is *re-reading a username*, and four
 * seconds is a rushed window for a check whose entire purpose is to be unhurried. It is still
 * short enough that the armed state cannot be left lying around.
 *
 * A modal was rejected for the usual reason: it takes focus, needs its own escape handling, and
 * trains an operator to dismiss dialogs. It also cannot show the row it is about to destroy in
 * the same visual context as its neighbours, which is exactly the comparison that catches the
 * wrong-row mistake.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT THIS TABLE DELIBERATELY CANNOT DO
 * ---------------------------------------------------------------------------------------
 *
 * There is no "set a new password" control, because `sendAccountPasswordReset` mails a link to
 * the address stored on the row and the reset does not change the password. **An administrator
 * using this cannot take over an account without the owner's mailbox** — which is a property of
 * the action, not of this component, and is the reason no such control exists to be added here.
 *
 * There is no role control either. `users.role` is written by exactly two places in the whole
 * repository — `app/actions/admin.ts` and `scripts/grant-admin.ts` — and a source-level test
 * asserts it. Promotion is an operator-with-a-shell operation on purpose.
 */

import { KeyRound, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import * as React from "react";
import { deleteAccount, sendAccountPasswordReset, setAccountPlan } from "@/app/actions/admin";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { Badge } from "@/components/ui/primitives";
import type { AdminAccount } from "@/lib/db/queries/admin";
import { formatCount, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/** See the docblock: longer than a log's 4000 ms because the check is reading a name. */
const DISARM_MS = 5000;

export type AccountTableProps = {
  accounts: AdminAccount[];
  /** The signed-in administrator, so their own row can say so rather than offering a delete. */
  selfId: number;
  className?: string;
};

export function AccountTable({ accounts, selfId, className }: AccountTableProps) {
  return (
    /*
     * A REAL `<table>`, and the horizontal scroll is on a wrapper rather than the table.
     *
     * This is tabular data — nine fields about one entity per row, compared down columns — so
     * the grid of divs the rest of the app uses for cards would strip the row/column
     * relationships a screen reader needs to read a cell back with its heading. `overflow-x`
     * has to sit on an ancestor because a scroll container cannot also be the element whose
     * intrinsic width is being scrolled.
     */
    <div className={cn("-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0", className)}>
      <table className="w-full min-w-[56rem] border-collapse text-left text-[0.8125rem]">
        <caption className="sr-only">
          Every account, newest first, with the plan, verification state and log count for each.
        </caption>
        <thead>
          <tr className="border-b border-line font-mono text-[0.6875rem] uppercase tracking-wider text-faint">
            <th scope="col" className="py-2 pr-3 font-normal">
              Member
            </th>
            <th scope="col" className="py-2 pr-3 font-normal">
              Email
            </th>
            <th scope="col" className="py-2 pr-3 font-normal">
              Plan
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-normal">
              Logs
            </th>
            <th scope="col" className="py-2 pr-3 font-normal">
              Joined
            </th>
            <th scope="col" className="py-2 font-normal">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <AccountRow key={account.id} account={account} isSelf={account.id === selfId} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One row, owning its own pending / armed / error state                      */
/* -------------------------------------------------------------------------- */

/**
 * PER-ROW STATE, NOT A MAP KEYED BY ID IN THE PARENT.
 *
 * A single `armedId`/`error` pair in the table would be one shared slot for twenty-five rows,
 * and the failure mode is specific: an error from the row you pressed would render against
 * whichever row you pressed next. Giving each row its own component gives each row its own
 * three pieces of state, and nothing has to be cleared when the selection moves.
 */
function AccountRow({ account, isSelf }: { account: AdminAccount; isSelf: boolean }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [armed, setArmed] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), DISARM_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  /** The payload every action takes. Built once, from the row this component drew. */
  const target = { userId: account.id, expectedUsername: account.username };

  function run(work: () => Promise<{ ok: boolean; error?: string }>, success?: string) {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong. Try again.");
        return;
      }
      if (success) setNote(success);
      router.refresh();
    });
  }

  function togglePlan() {
    const plan = account.plan === "pro" ? "free" : "pro";
    run(() => setAccountPlan({ ...target, plan }), `Plan set to ${plan}.`);
  }

  function sendReset() {
    run(
      () => sendAccountPasswordReset(target),
      "Reset link issued. It goes to the address on the account, and it does not change the password.",
    );
  }

  function remove() {
    if (!armed) {
      setError(null);
      setNote(null);
      setArmed(true);
      return;
    }
    setArmed(false);
    run(() => deleteAccount(target));
  }

  const name = account.displayName ?? account.username;

  return (
    <tr className="border-b border-line/60 align-top">
      <td className="py-3 pr-3">
        <Link
          href={`/@${account.username}`}
          className="block max-w-[14rem] truncate text-paper transition-colors hover:text-amber"
        >
          {name}
        </Link>
        <p className="truncate font-mono text-[0.6875rem] tracking-wider text-faint">@{account.username}</p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {/* `rose` for admin, because the tone vocabulary reserves it for "handle with care"
              rather than for "bad" — and an admin row is the one a mis-click matters most on. */}
          {account.role === "admin" ? <Badge tone="rose">Admin</Badge> : null}
          {account.isGuest ? <Badge>Guest</Badge> : null}
          {/*
            UNVERIFIED IS ONLY WORTH A BADGE WHEN IT MEANS SOMETHING. Verification is gated by
            `REQUIRE_EMAIL_VERIFICATION`, but a null `email_verified_at` is a fact about the
            account either way, and an operator reading a support request needs to see it.
          */}
          {!account.isGuest && account.emailVerifiedAt === null ? <Badge tone="amber">Unverified</Badge> : null}
        </div>
      </td>

      <td className="max-w-[16rem] truncate py-3 pr-3 font-mono text-[0.6875rem] tracking-wider text-muted">
        {/*
          A GUEST'S ADDRESS IS A GENERATED PLACEHOLDER, not a mailbox. Printing it plainly
          alongside real addresses would invite somebody to try to contact it.
        */}
        {account.isGuest ? <span className="text-faint">no address</span> : account.email}
      </td>

      <td className="py-3 pr-3">
        <Badge tone={account.plan === "pro" ? "amber" : "neutral"}>{account.plan}</Badge>
        {account.planUpdatedAt ? (
          <p className="mt-1 font-mono text-[0.625rem] tracking-wider text-faint">
            {formatDate(account.planUpdatedAt)}
          </p>
        ) : null}
      </td>

      <td className="py-3 pr-3 text-right font-mono tabular text-muted">{formatCount(account.logCount)}</td>

      <td className="py-3 pr-3 font-mono text-[0.6875rem] tracking-wider text-faint">
        {formatDate(account.createdAt)}
      </td>

      <td className="py-3">
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={togglePlan}
              disabled={pending}
              /* The label says the destination, not the toggle: "Plan" with a state elsewhere
                 makes the operator work out what pressing it does. */
              aria-label={`Set ${account.username} to ${account.plan === "pro" ? "free" : "pro"}`}
            >
              {account.plan === "pro" ? "Make free" : "Make pro"}
            </Button>

            {/* A guest has no password and no mailbox, so the control is absent rather than
                present-and-refused: the action would fail, and a button that always fails is a
                worse explanation than no button. */}
            {account.isGuest ? null : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={sendReset}
                disabled={pending}
                aria-label={`Email a password reset link to ${account.username}`}
              >
                <KeyRound />
                Reset link
              </Button>
            )}

            {isSelf ? (
              /*
               * SELF-DELETE IS REFUSED ON THE SERVER TOO — before the database read, in fact.
               * This is not the check; it is the explanation, so the operator understands why
               * their own row looks different rather than pressing a button that refuses.
               */
              <span className="font-mono text-[0.625rem] uppercase tracking-wider text-faint">
                your account
              </span>
            ) : (
              <Button
                type="button"
                variant="danger"
                size="sm"
                onClick={remove}
                disabled={pending}
                aria-label={armed ? `Confirm delete ${account.username}` : `Delete ${account.username}`}
                className={cn(armed && "border-rose bg-rose/30 text-paper")}
              >
                <Trash2 />
                {/* The username is in the confirm label, not just the aria-label: the second
                    press is the one that has to be aimed, and "Confirm" alone is aimable at
                    the wrong row. */}
                {armed ? `Delete @${account.username}` : "Delete"}
              </Button>
            )}
          </div>

          {/*
            THE ARMED WARNING NAMES THE CASCADE. Deleting an account takes its logs, lists,
            wantlist, favourites, follows, likes, comments and Desert Island with it — 28
            cascading foreign keys — and the only thing that survives is the audit row, because
            `admin_audit_log` deliberately has no foreign key and copies the username at write
            time. An operator should know that before the second press, not after.
          */}
          {armed ? (
            <p role="status" className="max-w-[18rem] text-right text-[0.75rem] leading-snug text-rose">
              Press again to delete @{account.username} and everything they logged. This cannot be
              undone; only the audit entry survives.
            </p>
          ) : null}

          <FormError message={error} className="text-right" />
          {note ? (
            <p role="status" className="max-w-[18rem] text-right text-[0.75rem] leading-snug text-teal">
              {note}
            </p>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

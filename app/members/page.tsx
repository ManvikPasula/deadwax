/**
 * /members — the member directory.
 *
 * ---------------------------------------------------------------------------------------
 * THIS PAGE IS WHERE THE NAMED N+1 DEFECT LIVED (brief defect #3)
 * ---------------------------------------------------------------------------------------
 *
 * The television original renders this directory with
 *
 *     await Promise.all(members.map((m) => getProfileStats(m.id)))
 *
 * which is 24 executions of the heaviest query in the application — four CTEs and nine scalar
 * subqueries each — to print two numbers per card. `getMemberCardStats` answers all 24 with one
 * `GROUP BY user_id`, and the two numbers it returns are deliberately the SAME expressions the
 * ordering is computed from, so a card can never print a figure that contradicts its own
 * position in the list.
 *
 * That is the entire fix, and it is in the query module rather than here, so /members and
 * /@name/network share it instead of each having their own copy.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THE RANKING COUNTS DISTINCT ALBUMS RATHER THAN LOG ROWS
 * ---------------------------------------------------------------------------------------
 *
 * Copied here because it is a music-domain decision, not a ported one: in television a log row
 * is roughly an episode, so counting rows is a reasonable proxy for "how much have you
 * watched". Here one 40-minute record played once can be eleven rows — one per track — so a
 * raw-row ranking measures HOW GRANULARLY SOMEBODY LOGS rather than how much they listen. A
 * member who ticks every track would outrank one who rates whole albums by an order of
 * magnitude, and the directory would quietly become a leaderboard for a habit nobody chose.
 *
 * ---------------------------------------------------------------------------------------
 * NO PARAMETERS, ON PURPOSE
 * ---------------------------------------------------------------------------------------
 *
 * There is no `?q` here: member search already exists at /search, which searches records,
 * artists and members together, and a second search box against a third of that index would be
 * a worse version of a page that already works. The directory's job is the top of the list —
 * one address, one cache entry, no crawl surface.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { MemberCard } from "@/components/social/member-card";
import { Button } from "@/components/ui/button";
import { EmptyState, Eyebrow } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import {
  getActiveMembers,
  getMemberCardStats,
  MEMBER_DIRECTORY_LIMIT,
  viewerFollowSet,
} from "@/lib/db/queries/users";
import { plural } from "@/lib/format";

export const metadata: Metadata = {
  title: "Members",
  description: "The people keeping a record diary on Deadwax, ordered by how much they have logged.",
};

export default async function MembersPage() {
  const viewer = await currentUser();

  /*
   * THE VIEWER IS NOT EXCLUDED, although `getActiveMembers` takes a parameter for it.
   *
   * /@name/network passes it, because "who follows me" should not list me. A directory should:
   * somebody reading a ranked list of members wants to know where they stand in it, and a list
   * that silently omits the reader is a list that cannot be checked. The card's follow control
   * resolves to `null` for the viewer's own row, so there is no "follow yourself" button.
   *
   * GUESTS ARE EXCLUDED, by `getActiveMembers` itself. A guest is a real `users` row, so every
   * public surface has to filter them — this one gets it for free from the query.
   */
  const members = await getActiveMembers(MEMBER_DIRECTORY_LIMIT);

  const ids = members.map((row) => row.id);
  const [stats, followed] = await Promise.all([
    getMemberCardStats(ids),
    /* Returns an empty set for a signed-out visitor without a round trip. */
    viewerFollowSet(viewer?.id, ids),
  ]);

  /**
   * THE FOLLOW CONTROL IS A TRI-STATE: `null` MEANS "DRAW NOTHING".
   *
   * "Not following" and "cannot follow" are different answers, and a boolean collapses them
   * into the same button. Four situations produce null and each of them is a write that would
   * be refused: signed out, yourself, a guest target, or a guest viewer.
   */
  function followState(row: { id: number; isGuest: boolean }): boolean | null {
    if (!viewer || viewer.isGuest) return null;
    if (viewer.id === row.id) return null;
    if (row.isGuest) return null;
    return followed.has(row.id);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="letterbox">
        <Eyebrow>{members.length === 0 ? "Members" : plural(members.length, "member")}</Eyebrow>
        <h1 className="mt-2 font-display text-3xl leading-tight text-paper sm:text-4xl">Members</h1>
        <p className="mt-2 text-sm text-muted">
          Ordered by how many different records each of them has logged — not by how many rows they
          wrote, so rating a whole album counts the same as ticking it off track by track.
        </p>
      </header>

      {members.length === 0 ? (
        <EmptyState
          title="Nobody has signed up yet"
          description="A diary is more interesting with other people's in it. The first member sets the tone."
          action={
            <Button asChild variant="primary">
              <Link href="/signup">Create an account</Link>
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {members.map((row) => (
            <li key={row.id}>
              {/*
                `stats` MAY LEGITIMATELY HAVE NO ENTRY FOR A MEMBER. The batched query returns
                rows only for members who have logged something, so somebody who joined an hour
                ago is absent from the Map rather than present with zeroes. `MemberCard` treats
                an undefined `stats` as two zeroes, which is the truth about them.
              */}
              <MemberCard member={row} stats={stats.get(row.id)} following={followState(row)} />
            </li>
          ))}
        </ul>
      )}

      {/*
        THE TRUNCATION IS STATED RATHER THAN PAGINATED. There is no `COUNT(*)` on this page and
        no `?page`, because a ranked directory's second page is a list of people nobody is
        looking for by rank — the way you find a specific member is search, and the way you find
        an interesting one is a review. Saying the limit out loud is cheaper and more honest than
        a pager that walks a ranking whose tail reshuffles as people log records.
      */}
      {members.length >= MEMBER_DIRECTORY_LIMIT ? (
        <p className="text-center font-mono text-[0.6875rem] tracking-wider text-faint">
          The {MEMBER_DIRECTORY_LIMIT} most active. Looking for somebody in particular?{" "}
          <Link href="/search" className="text-muted transition-colors hover:text-amber">
            Search by name
          </Link>
          .
        </p>
      ) : null}
    </div>
  );
}

/**
 * `/@name/network` — followers and following.
 *
 * ============================================================================
 * DELIBERATELY NOT A PROFILE TAB. It is reached from the two counters in `ProfileHeader` and
 * from nowhere else.
 *
 * `ProfileTabs` records the reason from the other side: seven tabs on a phone is a scrolling
 * strip whose seventh label is off-screen, and "who follows this person" is a detour from
 * reading their diary rather than one of the six things a profile IS. The counters are
 * therefore links rather than text — including when they read zero, because on your own
 * profile the zero is exactly when you need the page that would explain it.
 *
 * The tab strip below is still lit correctly on this route: no tab's path is a prefix of
 * `/network`, so nothing highlights, which is the honest state for a page that is not a tab.
 * ============================================================================
 *
 * TWO TABS, TWO ADDRESSES. `?tab=following` is a query rather than a second route because the
 * two halves are the same page with one read swapped — and it is addressable, which is the
 * test `ProfileTabs` applies: if somebody might want to send a link to the panel, the panel
 * needs an address.
 *
 * `getMemberCardStats` IS THE BATCHED READ, and it is the point of the page's query budget:
 * 48 cards, two numbers each, ONE `GROUP BY user_id`. The source runs the heaviest aggregate
 * in the application once per card. See /members, where the same fix is the named defect.
 *
 * NO GUEST FILTER ON EITHER SIDE, and the absence is reasoned rather than forgotten: a guest
 * cannot follow (`requireMember` refuses) and cannot be followed (`toggleFollow` checks
 * `isGuest`), so neither direction of this graph can contain one. If either write-side check
 * is ever relaxed, `getFollowers`/`getFollowing` are where the guest becomes publicly visible.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { loadProfile } from "@/app/[username]/layout";
import { queryHref } from "@/components/discovery/sort-select";
import { MemberCard } from "@/components/social/member-card";
import { Button } from "@/components/ui/button";
import { Chip, EmptyState, Eyebrow, SectionHeading } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import {
  getFollowCounts,
  getFollowers,
  getFollowing,
  getMemberCardStats,
  viewerFollowSet,
} from "@/lib/db/queries/users";
import { plural } from "@/lib/format";

/** `getFollowers`/`getFollowing` default to 48; it is stated here so the copy can say so. */
const NETWORK_LIMIT = 48;

type NetworkTab = "followers" | "following";

type PageProps = {
  params: Promise<{ username: string }>;
  searchParams: Promise<{ tab?: string }>;
};

/** The whitelist. Anything unrecognised is "followers", which is the counter people click. */
function parseTab(value: string | undefined | null): NetworkTab {
  return value === "following" ? "following" : "followers";
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const [{ username }, query] = await Promise.all([params, searchParams]);
  const member = await loadProfile(username);
  const name = member.displayName ?? member.username;
  const tab = parseTab(query.tab);

  return {
    title: tab === "following" ? `Who ${name} follows` : `${name}'s followers`,
    description:
      tab === "following"
        ? `Members ${name} follows on Deadwax.`
        : `Members who follow ${name} on Deadwax.`,
    /*
     * NOINDEX, AND IT IS A PRODUCT DECISION RATHER THAN A PRIVACY ONE. The follow graph is
     * public and this page 404s for nobody — but it is a list of other people's handles
     * attached to somebody else's name, and it is reachable from one place on purpose. A
     * crawler indexing it turns "reached from the counters" into "arrived here from a search
     * for a member's name", which is a different product.
     */
    robots: { index: false, follow: true },
  };
}

export default async function NetworkPage({ params, searchParams }: PageProps) {
  const [{ username }, query] = await Promise.all([params, searchParams]);
  const tab = parseTab(query.tab);

  const [member, viewer] = await Promise.all([loadProfile(username), currentUser()]);
  const name = member.displayName ?? member.username;
  const basePath = `/@${member.username}/network`;

  /*
   * ONLY THE SELECTED HALF IS READ. Both counters come from `getFollowCounts` in one statement
   * — two scalars in one round trip, because they are always rendered together — so the tab
   * labels can print both numbers without fetching both lists.
   */
  const [counts, members] = await Promise.all([
    getFollowCounts(member.id),
    tab === "following" ? getFollowing(member.id, NETWORK_LIMIT) : getFollowers(member.id, NETWORK_LIMIT),
  ]);

  /*
   * THE TWO DEPENDENT READS, BOTH BATCHED AND BOTH KEYED BY THE SAME ID LIST. Each guards the
   * empty case itself: `IN ()` is invalid SQL, and `viewerFollowSet` additionally returns an
   * empty set for a signed-out visitor rather than spending a round trip on `user_id = null`.
   */
  const ids = members.map((row) => row.id);
  const [stats, followed] = await Promise.all([
    getMemberCardStats(ids),
    viewerFollowSet(viewer?.id, ids),
  ]);

  /**
   * THE FOLLOW CONTROL IS A TRI-STATE: `null` MEANS "DRAW NOTHING".
   *
   * "Not following" and "cannot follow" are different answers, and a boolean collapses them
   * into the same button — `MemberCard` and `ProfileHeader` both record the decision. Four
   * situations produce null and each of them is a write that would be refused: signed out,
   * yourself, a guest target, or a guest viewer.
   */
  function followState(row: { id: number; isGuest: boolean }): boolean | null {
    if (!viewer || viewer.isGuest) return null;
    if (viewer.id === row.id) return null;
    if (row.isGuest) return null;
    return followed.has(row.id);
  }

  const total = tab === "following" ? counts.following : counts.followers;
  const truncated = total > members.length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <SectionHeading
        eyebrow="Network"
        title={tab === "following" ? `Who ${name} follows` : `${name}'s followers`}
        as="h1"
      />

      {/*
        A ROW OF LINKS, NOT A RADIX TABLIST. Two addresses, so both halves survive a reload and
        a shared link; `role="tablist"` would promise arrow-key traversal between panels that do
        not exist. `aria-current` is the caller's job — `Chip`'s `active` is paint, and paint
        alone does not say which half is showing.
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Eyebrow>Show</Eyebrow>
        <div role="group" aria-label={`${name}'s network`} className="flex flex-wrap gap-1.5">
          <Chip asChild active={tab === "followers"}>
            <Link href={basePath} aria-current={tab === "followers" ? "true" : undefined}>
              {plural(counts.followers, "follower")}
            </Link>
          </Chip>
          <Chip asChild active={tab === "following"}>
            <Link
              href={queryHref(basePath, { tab: "following" })}
              aria-current={tab === "following" ? "true" : undefined}
            >
              {counts.following} following
            </Link>
          </Chip>
        </div>
      </div>

      {members.length === 0 ? (
        <EmptyState
          title={tab === "following" ? `${name} does not follow anybody yet` : "No followers yet"}
          description={
            tab === "following"
              ? "Following somebody puts their plays and reviews in the home feed."
              : "A follower arrives when somebody wants this member's plays in their own feed."
          }
          action={
            <Button asChild variant="ghost">
              <Link href="/members">Find members</Link>
            </Button>
          }
        />
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2">
            {members.map((row) => (
              <li key={row.id}>
                {/*
                  `stats` MAY LEGITIMATELY HAVE NO ENTRY FOR A MEMBER. The batched query only
                  returns rows for members who have logged something, so somebody who joined and
                  has not started is absent from the Map rather than present with zeros —
                  `MemberCard`'s own fallback renders the zeros.
                */}
                <MemberCard
                  member={row}
                  stats={stats.get(row.id)}
                  following={followState(row)}
                />
              </li>
            ))}
          </ul>

          {/*
            THE TRUNCATION IS STATED RATHER THAN HIDDEN. Both reads are capped at 48 and neither
            is paged, so a member with two hundred followers sees the 48 most recent edges —
            which is the ordering `getFollowers` applies ("who arrived most recently" is the
            only ordering a follower list has that is not arbitrary). Printing nothing would
            make the counter above disagree with the list below with no explanation.
          */}
          {truncated ? (
            <p className="text-[0.8125rem] text-faint">
              {`Showing the ${members.length} most recent of ${total}.`}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

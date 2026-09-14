/**
 * One member in the directory, in a follower/following list, or in member search results.
 *
 * NO `"use client"`. The only interactive part is the follow control, which is a client
 * component imported as a child — twenty-four cards on /members would otherwise mean
 * twenty-four hydrated cards to render two numbers each.
 *
 * THE NUMBERS ARRIVE AS A PROP, FROM ONE BATCHED QUERY. `getMemberCardStats(ids[])` returns a
 * `Map` for the whole page and the caller looks each card's entry up; this component must
 * never reach for a query of its own.
 *
 * That is defect #3 in the brief's list, and it is worth stating why it was a real problem
 * rather than an inefficiency: the television original calls `getProfileStats` per card, and
 * `getProfileStats` is a four-CTE aggregate with nine scalar subqueries over every log the
 * member owns. The directory renders twenty-four of them. Twenty-four heavy aggregates to
 * print two small integers is the most expensive page in that application, and the shape of
 * the fix — batch the read, pass the row in — is the shape of all five N+1 techniques used
 * here.
 */

import Link from "next/link";

import { FollowButton } from "@/components/social/follow-button";
import { Avatar } from "@/components/ui/avatar";
import type { MemberCardStats, MemberSummary } from "@/lib/db/queries/users";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

export type MemberCardProps = {
  /** `ActiveMember` satisfies this structurally — its extra `albums` is simply unused here. */
  member: MemberSummary;
  /**
   * The member's entry from `getMemberCardStats`. UNDEFINED IS A REAL AND COMMON CASE: the
   * batched query only returns rows for members who have logged something, so a member who
   * joined and has not started yet is absent from the Map rather than present with zeros.
   * Rendering zeros for them is correct and is what the fallback does.
   */
  stats?: MemberCardStats;
  /**
   * Whether the viewer follows this member, or NULL for "render no follow control" — signed
   * out, looking at yourself, or this member is a guest (who cannot be followed at all).
   * A tri-state rather than two booleans, because "not following" and "cannot follow" are
   * different answers and a boolean would collapse them into the same button.
   */
  following?: boolean | null;
  className?: string;
};

export function MemberCard({ member, stats, following = null, className }: MemberCardProps) {
  const name = member.displayName ?? member.username;
  const albums = stats?.albums ?? 0;
  const ratings = stats?.ratings ?? 0;

  return (
    <article className={cn("card flex items-center gap-3 p-4", className)}>
      {/*
        The avatar is `aria-hidden` by contract (see components/ui/avatar.tsx) — the name link
        beside it is the accessible name, so this pairing announces once, not twice.
      */}
      <Avatar
        username={member.username}
        displayName={member.displayName}
        seed={member.avatarSeed}
        isGuest={member.isGuest}
        size="lg"
      />

      <div className="min-w-0 flex-1">
        <Link
          href={`/@${member.username}`}
          className="block truncate text-[0.9375rem] text-paper transition-colors hover:text-amber"
        >
          {name}
        </Link>
        {/* The handle is mono because it is an identifier, not prose. */}
        <p className="truncate font-mono text-[0.6875rem] tracking-wider text-faint">@{member.username}</p>

        <p className="mt-2 flex flex-wrap gap-x-3 font-mono text-[0.6875rem] tabular text-muted">
          <span>
            {formatCount(albums)} <span className="text-faint">albums</span>
          </span>
          <span aria-hidden="true" className="text-line-bright">
            ·
          </span>
          <span>
            {formatCount(ratings)} <span className="text-faint">ratings</span>
          </span>
        </p>
      </div>

      {following === null ? null : (
        <FollowButton
          userId={member.id}
          username={member.username}
          following={following}
          size="sm"
          className="shrink-0"
        />
      )}
    </article>
  );
}

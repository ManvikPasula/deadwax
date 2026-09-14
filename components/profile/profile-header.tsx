/**
 * The top of a member's profile: avatar, display name, handle, bio, the two follow counters,
 * and the follow button.
 *
 * NO `"use client"`. The only interactive part is `FollowButton`, which is a client component
 * imported as a child — the split-component pattern from ARCHITECTURE §11.6. Making the whole
 * header a client component to hold one button would ship the bio and both counters to the
 * browser twice, once as HTML and once as props.
 *
 * ---------------------------------------------------------------------------------------
 * THE COUNTERS ARE THE ONLY DOOR TO `/network`
 * ---------------------------------------------------------------------------------------
 *
 * `/@name/network` is deliberately NOT one of the six profile tabs (see `ProfileTabs`): it is
 * reached from these two numbers and nowhere else. So they are LINKS, not text — which is also
 * the reason they are laid out as two separate links rather than one "12 followers · 30
 * following" sentence: the following list has its own address (`?tab=following`), and a single
 * link could only reach one of the two.
 *
 * A COUNT OF ZERO STILL LINKS. The rejected alternative was rendering "0 followers" as plain
 * text, which reads as tidier and quietly removes the only way to reach the page that would
 * explain the zero — and on your own profile that page is where you go to find people.
 *
 * ---------------------------------------------------------------------------------------
 * THE AVATAR CARRIES NO ACCESSIBLE NAME
 * ---------------------------------------------------------------------------------------
 *
 * By contract: components/ui/avatar.tsx is `aria-hidden` in both branches, because the
 * accessible name always comes from the surrounding text — here the `<h1>` immediately beside
 * it. A guest takes the outline-glyph branch rather than a generated gradient, because the
 * generated avatar is an identity and a guest does not have one yet.
 *
 * `isGuest` ARRIVES FROM THE DATABASE, never from a session token (I-18): `MemberRecord` is a
 * projection of the `users` row, and it deliberately omits `password_hash` and `email` because
 * this object crosses into the RSC payload.
 */

import Link from "next/link";

import { FollowButton } from "@/components/social/follow-button";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/primitives";
import type { FollowCounts, MemberRecord } from "@/lib/db/queries/users";
import { formatCount, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export type ProfileHeaderProps = {
  /** `getUserByUsername(username)`. The bio, the handle and the guest flag all come from it. */
  member: MemberRecord;
  /** `getFollowCounts(member.id)`. Both numbers, even when they are zero. */
  counts: FollowCounts;
  /**
   * Whether the viewer follows this member, or NULL for "render no follow control" — signed
   * out, looking at yourself, or this member is a guest (who cannot be followed at all).
   *
   * A TRI-STATE RATHER THAN TWO BOOLEANS, the same decision `MemberCard` records: "not
   * following" and "cannot follow" are different answers, and a boolean collapses them into
   * the same button.
   */
  following?: boolean | null;
  className?: string;
};

export function ProfileHeader({ member, counts, following = null, className }: ProfileHeaderProps) {
  const name = member.displayName ?? member.username;
  const network = `/@${member.username}/network`;
  const joined = formatDate(member.createdAt);

  /** Shared so the two counters cannot drift apart. */
  const counter = cn(
    "rounded-card px-2 py-1 font-mono text-[0.8125rem] tabular text-muted transition-colors",
    "hover:bg-surface-2 hover:text-paper",
  );

  return (
    <header className={cn("flex flex-wrap items-start gap-5", className)}>
      <Avatar
        username={member.username}
        displayName={member.displayName}
        seed={member.avatarSeed}
        isGuest={member.isGuest}
        size="xl"
        className="shrink-0"
      />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* The ONE h1 on the page. Display serif, which is headlines only. */}
          <h1 className="font-display text-3xl leading-tight text-paper">{name}</h1>
          {/*
            The badge is the text equivalent for the outline-glyph avatar, which is the only
            other thing on this page that says "this account is not finished". A guest profile
            is a real, readable profile — the whole point of guest mode — so this is a label,
            not a warning.
          */}
          {member.isGuest ? <Badge>Guest</Badge> : null}
        </div>

        {/* Mono because a handle is an identifier, not prose — the same treatment `MemberCard`
            gives it. */}
        <p className="mt-0.5 font-mono text-[0.8125rem] tracking-wider text-faint">@{member.username}</p>

        {member.bio ? (
          // `max-w-prose` rather than the column width: a bio is the only block of member-written
          // prose on the profile, and a 1280px-wide paragraph is unreadable at any font size.
          <p className="mt-3 max-w-prose whitespace-pre-line text-[0.9375rem] leading-relaxed text-muted">
            {member.bio}
          </p>
        ) : null}

        {/*
          `-ml-2` pulls the first counter's own padding back to the text column above it, so the
          numbers line up with the handle rather than sitting indented by the hover target.
        */}
        <nav aria-label={`${name}'s network`} className="mt-3 -ml-2 flex flex-wrap items-center gap-1">
          <Link href={network} className={counter}>
            {formatCount(counts.followers)}{" "}
            {/* The word is part of the link text, not a `title`: "12" alone is not a
                destination anybody can read. */}
            <span className="text-faint">{counts.followers === 1 ? "follower" : "followers"}</span>
          </Link>
          <span aria-hidden="true" className="text-line-bright">
            ·
          </span>
          <Link href={`${network}?tab=following`} className={counter}>
            {formatCount(counts.following)} <span className="text-faint">following</span>
          </Link>
          {joined ? (
            <>
              <span aria-hidden="true" className="text-line-bright">
                ·
              </span>
              <p className="px-2 py-1 font-mono text-[0.8125rem] tabular text-faint">
                joined <time dateTime={member.createdAt.toISOString()}>{joined}</time>
              </p>
            </>
          ) : null}
        </nav>
      </div>

      {following === null ? null : (
        <div className="shrink-0">
          <FollowButton userId={member.id} username={member.username} following={following} />
        </div>
      )}

      {/*
        NO `sr-only` SUMMARY OF THE TWO NUMBERS, deliberately. Both counters already carry
        their noun inside the link text ("12 followers", "30 following"), so a second copy in
        a hidden paragraph is the same information announced twice — which is exactly the
        mistake the avatar's `aria-hidden` contract exists to avoid.
      */}
    </header>
  );
}

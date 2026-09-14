/**
 * `/@name/lists` — one member's lists.
 *
 * `isSelf` IS THE ENTIRE PRIVACY SWITCH, AND IT LIVES INSIDE THE QUERY.
 *
 * `getUserLists(userId, viewerId)` compares the two ids itself and puts private rows in the
 * result only when they match, so there is exactly one comparison and no second place for the
 * rule to disagree with itself. This page passes `viewer?.id` and filters nothing afterwards —
 * a `.filter(list => list.isPublic || isOwner)` here would be a second copy of the rule, and
 * the copy that matters is the one that decided what SQL ran.
 *
 * WHY THERE IS NO DUPLICATED `generateMetadata` CHECK HERE, unlike the wantlist and
 * `/list/[slug]`. Nothing in the metadata below names a list: the title is the member's, whose
 * profile is public, and the description is a count. There is no private fact in the document
 * head to leak — which is the actual rule behind I-15, rather than "always call the guard
 * twice". `/list/[slug]` renders a specific list's title and therefore does duplicate it.
 *
 * NO GUEST FILTER, deliberately: this is one member's own tab and a guest's own lists must
 * read normally. `getPublicLists` (the /lists index) is the surface that excludes them,
 * because that one is a public index.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { loadProfile } from "@/app/[username]/layout";
import { ListCard } from "@/components/list/list-card";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionHeading } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import { getUserLists } from "@/lib/db/queries/lists";
import { plural } from "@/lib/format";

type PageProps = { params: Promise<{ username: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { username } = await params;
  const member = await loadProfile(username);
  const name = member.displayName ?? member.username;

  return {
    title: `${name}'s lists`,
    description: `Lists ${name} has made on Deadwax — ranked rundowns, playlists and collections of artists, albums and tracks.`,
  };
}

export default async function MemberListsPage({ params }: PageProps) {
  const { username } = await params;
  const [member, viewer] = await Promise.all([loadProfile(username), currentUser()]);

  const isOwner = viewer?.id === member.id;
  const name = member.displayName ?? member.username;

  // The private rows are in this result only when the viewer is the owner. See the docblock.
  const lists = await getUserLists(member.id, viewer?.id);

  const privateCount = lists.filter((list) => !list.isPublic).length;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <SectionHeading eyebrow="Lists" title={`${name}'s lists`} as="h1" />

      <p className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
        {plural(lists.length, "list")}
        {/*
          THE PRIVATE COUNT IS ONLY EVER NON-ZERO FOR THE OWNER, because private rows are not
          in this result for anybody else. It is printed because a member looking at their own
          tab needs to know which of these a visitor would see — the alternative is a badge per
          card and no total, and then the answer to "is my top ten public yet" is a count you
          do by hand.
        */}
        {privateCount > 0 ? ` · ${privateCount} private` : ""}
      </p>

      {lists.length === 0 ? (
        <EmptyState
          title={isOwner ? "No lists yet" : `${name} has not made a list yet`}
          description={
            isOwner
              ? "A list holds artists, albums or individual tracks — ranked or not — so it works as a playlist as readily as a top ten. Start one from any record's page."
              : "Lists appear here once they are made public."
          }
          action={
            isOwner ? (
              <Button asChild variant="primary">
                <Link href="/albums">Find something to add</Link>
              </Button>
            ) : (
              <Button asChild variant="ghost">
                <Link href="/lists">Browse every list</Link>
              </Button>
            )
          }
        />
      ) : (
        <ul className="space-y-4">
          {lists.map((list) => (
            <li key={list.id}>
              {/* `showOwner={false}`: the page heading already names them, and repeating the
                  handle on every card says nothing. */}
              <ListCard list={list} showOwner={false} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

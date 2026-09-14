/**
 * `/list/<slug>-<id>` — one list.
 *
 * ============================================================================
 * `parseListSlug` IS LITERALLY `parseIdSlug`: IT THROWS THE SLUG AWAY AND USES THE TRAILING
 * INTEGER. SO `/list/17` IS A VALID URL.
 *
 * That is deliberate and something depends on it: the clone button in `ListActions` pushes
 * `/list/${listSlug(title, id)}` for a list it has just created, and `cloneList` returns an id
 * — so a bare-id URL has to render. There is no canonical redirect and no unique constraint on
 * `lists.slug`; any slug text in front of the right id renders the page, which is what lets a
 * renamed list keep every link anybody has ever shared.
 *
 * `parseIdSlug` returns NULL rather than clamping, and its digit-length check runs BEFORE
 * `Number()` — because `/list/greatest-hits-9999999999` raised "value out of range for type
 * integer" in the source, which is a 500 where a 404 belongs (I-5).
 * ============================================================================
 *
 * ============================================================================
 * THE PRIVACY CHECK IS DUPLICATED IN `generateMetadata` AND IN THE BODY (I-15, SEC-02).
 *
 * THIS IS THE ROUTE THE DEFECT WAS FOUND ON. In the source the body 404'd a private list while
 * the `<title>` and `<meta name="description">` of every private list still rendered — so an
 * anonymous visitor could walk `/list/1`, `/list/2`, … and read every private list's title out
 * of the document head. Two entry points into one route, with the check on only one of them.
 *
 * ANY NEW ENTRY POINT NEEDS THE SAME `canViewList` CALL: an `opengraph-image.tsx` under this
 * folder, an RSS or JSON feed, an API `route.ts`, a sitemap entry. Each is a separate function
 * that Next calls independently, so each is a separate place for the rule to go missing. The
 * `viewerId` must come from the SESSION, never from a route parameter or a form field.
 *
 * `notFound()` rather than 403, uniformly for "no such list" and "not yours" — the read path
 * refuses to distinguish them. Note the deliberate asymmetry with the WRITE path, which does
 * distinguish ("That list no longer exists" vs "That is not your list") and therefore confirms
 * a private list's existence to a non-owner: accepted there, because by then the caller has
 * already had to know the id.
 * ============================================================================
 *
 * THE ONLY ROUTE THAT RENDERS A COMMENT THREAD ON A LIST. `/log/[id]` is the other thread in
 * the application; `getLogComments` serves both, keyed by the polymorphic target.
 */

import type { Metadata } from "next";
import { ListMusic } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ListActions } from "@/components/list/list-actions";
import { ListItemRow } from "@/components/list/list-item-row";
import { CommentThread } from "@/components/social/comment-thread";
import { LikeButton } from "@/components/social/like-button";
import { AvatarWithName } from "@/components/ui/avatar";
import { Badge, EmptyState, SectionHeading } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import { canViewList, getList, getListItems } from "@/lib/db/queries/lists";
import { getLogComments, hasLiked } from "@/lib/db/queries/logs";
import { getUserByUsername } from "@/lib/db/queries/users";
import { formatDate, plural } from "@/lib/format";
import { listSlug, parseListSlug } from "@/lib/slug";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;

  const id = parseListSlug(slug);
  if (id === null) notFound();

  const [list, viewer] = await Promise.all([getList(id), currentUser()]);
  if (!list) notFound();

  // ENTRY POINT 1 OF 2. THIS CALL IS THE FIX. Without it the title and description below
  // render for a private list to anybody who guesses the id — see the module docblock.
  if (!canViewList(list, viewer?.id)) notFound();

  const ownerName = list.owner.displayName ?? list.owner.username;

  return {
    title: list.title,
    description:
      list.description ??
      `A list by ${ownerName} on Deadwax — ${plural(list.itemCount, "entry", "entries")}.`,
    /*
     * A PRIVATE LIST REACHES THIS LINE ONLY FOR ITS OWNER, and it still asks not to be indexed.
     * A crawler is anonymous, so it takes the 404 above and never sees this — but the owner's
     * browser may be sharing a URL, and declaring the intent here costs nothing and means the
     * rule survives if the gate above is ever loosened.
     */
    robots: list.isPublic ? undefined : { index: false, follow: false },
  };
}

export default async function ListPage({ params }: PageProps) {
  const { slug } = await params;

  const id = parseListSlug(slug);
  if (id === null) notFound();

  const [list, viewer] = await Promise.all([getList(id), currentUser()]);
  if (!list) notFound();

  // ENTRY POINT 2 OF 2. Independently evaluated; there is no way to share it with the metadata
  // function, which is the whole shape of this defect class.
  if (!canViewList(list, viewer?.id)) notFound();

  const isOwner = viewer?.id === list.owner.id;
  const canonical = `/list/${listSlug(list.title, list.id)}`;

  const [items, comments, liked, viewerMember] = await Promise.all([
    getListItems(list.id),
    getLogComments({ targetType: "list", targetId: list.id }),
    hasLiked(viewer?.id, "list", list.id),
    /*
     * ONE EXTRA LOOKUP, FOR ONE FIELD. `CommentThread` needs a `MemberSummary` for the
     * optimistic row it inserts before the server answers, and `SessionUser` carries no
     * `displayName` — deliberately, because the token holds only what rendering needs and this
     * is the one surface that needs more. Without it the member's own comment would appear
     * under their handle for one frame and then swap to their display name when the refresh
     * lands, which reads as the wrong person having posted.
     */
    viewer ? getUserByUsername(viewer.username) : Promise.resolve(null),
  ]);

  const ownerName = list.owner.displayName ?? list.owner.username;
  const updated = formatDate(list.updatedAt);

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {list.isRanked ? <Badge tone="amber">Ranked</Badge> : null}
          {list.isPublic ? null : (
            // The text equivalent for a list that looks identical to a public one. Only the
            // owner can be here, and this is the only thing on the page that says so.
            <Badge tone="rose">Private</Badge>
          )}
          {list.clonedFromId === null ? null : (
            /*
              `cloned_from_id` HAS NO FOREIGN KEY, ON PURPOSE: a clone must survive its source
              being deleted. So the provenance is stated as text rather than as a link — a link
              to a row that may be gone is worse than the sentence.
            */
            <Badge>Cloned</Badge>
          )}
        </div>

        <h1 className="font-display text-4xl leading-tight text-paper text-balance">{list.title}</h1>

        {list.description ? (
          // `whitespace-pre-line` with escaped children: there is no markdown renderer in this
          // application, and the description is member-supplied text.
          <p className="max-w-prose whitespace-pre-line text-[0.9375rem] leading-relaxed text-muted">
            {list.description}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <AvatarWithName
            username={list.owner.username}
            displayName={list.owner.displayName}
            seed={list.owner.avatarSeed}
            isGuest={list.owner.isGuest}
            size="sm"
          >
            <Link
              href={`/@${list.owner.username}`}
              className="text-sm text-paper transition-colors hover:text-amber"
            >
              {ownerName}
            </Link>
          </AvatarWithName>

          <p className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
            {plural(list.itemCount, "entry", "entries")}
            {updated ? ` · updated ${updated}` : ""}
          </p>

          <LikeButton
            targetType="list"
            targetId={list.id}
            liked={liked}
            count={list.likeCount}
            // The glyph carries no text, so without this the control announces as "button".
            label={`${ownerName}'s list ${list.title}`}
          />
        </div>

        {/*
          THE CLONE BUTTON RELIES ON THE BARE-ID URL. `ListActions` builds `/list/<slug>-<id>`
          for the new list from the id the action returns, which is exactly the grammar the
          module docblock describes.

          `canWrite={viewer !== null}` AND FALSE DOES NOT HIDE THE CONTROL — it becomes an
          invitation to sign in, because a hidden button teaches nothing about what an account
          is for. `signInNext` is the canonical path so the member lands back here.
        */}
        <ListActions
          listId={list.id}
          title={list.title}
          isOwner={isOwner}
          canWrite={viewer !== null}
          isPublic={list.isPublic}
          afterDeleteHref={`/@${list.owner.username}/lists`}
          signInNext={canonical}
        />
      </header>

      <section>
        <SectionHeading eyebrow="Entries" title={list.isRanked ? "In order" : "Contents"} />
        {items.length === 0 ? (
          <EmptyState
            title="Nothing in this list yet"
            description={
              isOwner
                ? "Add an artist, an album or a single track from its own page — a list holds all three, so it works as a playlist as readily as a top ten."
                : `${ownerName} has not added anything yet.`
            }
            action={
              isOwner ? (
                <Link
                  href="/albums"
                  className="inline-flex items-center gap-2 rounded-card border border-line bg-surface-2 px-3 py-2 font-mono text-[0.6875rem] uppercase tracking-wider text-paper transition-colors hover:bg-surface-3"
                >
                  <ListMusic className="size-3.5" aria-hidden="true" />
                  Find something to add
                </Link>
              ) : null
            }
          />
        ) : (
          <ol className="divide-y divide-line">
            {items.map((item, index) => (
              <li key={item.id}>
                {/*
                  THE RANK IS THE RENDER INDEX, NOT `item.position`, and only on a ranked list.
                  `addToList` appends at `max(position) + 1` outside a transaction, so two
                  concurrent adds legitimately tie — and a ranked list printing "4, 4, 6" reads
                  as a bug in the ranking rather than as a harmless tie. On an unranked list a
                  number in front of every row claims an order the maker did not choose.
                */}
                <ListItemRow item={item} rank={list.isRanked ? index + 1 : null} />
              </li>
            ))}
          </ol>
        )}
      </section>

      {/*
        THE THREAD. `containerOwnerId` is what makes owner moderation reachable: `deleteComment`
        has always authorised "the comment's author OR the container's owner" server-side, and
        the source only ever rendered the control for the author — so a list owner could never
        remove a comment from their own list. A capability nobody can use is indistinguishable
        from one that does not exist.
      */}
      <CommentThread
        target={{ targetType: "list", targetId: list.id }}
        comments={comments}
        viewer={viewerMember}
        containerOwnerId={list.owner.id}
      />
    </div>
  );
}

/**
 * `/list/<slug>-<id>/edit` — rename, describe, reorder, remove. OWNER ONLY.
 *
 * NEW IN DEADWAX. The source has no edit surface at all: a list's title, description and order
 * are fixed at creation, so `updateList` and `reorderList` exist on the server with nothing
 * that can call them. That is the same class of defect as the unreachable comment thread — a
 * capability nobody can use is indistinguishable from one that does not exist.
 *
 * ============================================================================
 * THE OWNER CHECK IS DUPLICATED IN `generateMetadata` AND IN THE BODY, for the same reason
 * `/list/[slug]` duplicates `canViewList` (I-15, SEC-02): metadata is a separate function call
 * and inherits nothing from the body's guard, so a private list's title would render in the
 * document head of `/list/17/edit` for anybody who asked. ANY NEW ENTRY POINT UNDER THIS
 * FOLDER — an OG image route, an API handler — needs the same check.
 *
 * IT IS A STRICTER RULE THAN THE PARENT ROUTE'S, and the distinction is the point:
 * `canViewList` admits a public list to everybody, while editing admits nobody but the owner.
 * So this route does NOT call `canViewList` — a public list belonging to somebody else passes
 * that test and must still 404 here. Using the read guard for a write surface is exactly how
 * an edit page becomes world-writable-looking.
 * ============================================================================
 *
 * `notFound()`, NOT A 403 AND NOT A REDIRECT TO `/login`. A 403 confirms the list exists; a
 * sign-in redirect confirms it too, and then sends somebody who cannot edit it to a form that
 * will not help. The uniform answer is the same one the read path gives, which is
 * indistinguishable from a mistyped id.
 *
 * THE PAGE PROVES OWNERSHIP; `ListEditor` DOES NOT RE-CHECK IT. Its own docblock says so. The
 * actions it calls each re-derive ownership from the session server-side, so this gate is
 * about not offering a control that would be refused rather than about security.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ListEditor } from "@/components/list/list-editor";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import { getList, getListItems } from "@/lib/db/queries/lists";
import { listSlug, parseListSlug } from "@/lib/slug";

type PageProps = { params: Promise<{ slug: string }> };

/**
 * Resolve, then refuse anybody but the owner. Both entry points call it, so the two cannot
 * drift — and `notFound()` returns `never`, which is what makes the narrowed return type work.
 *
 * A GUEST OWNER IS ALLOWED. `updateList`, `reorderList` and `removeFromList` use `requireUser`
 * rather than `requireMember` — lists are not one of the three things guests are refused
 * (follow, like, comment) — so a guest editing their own list is a supported flow and gating
 * on `isGuest` here would break it.
 */
async function loadOwnedList(slug: string) {
  const id = parseListSlug(slug);
  if (id === null) notFound();

  const [list, viewer] = await Promise.all([getList(id), currentUser()]);
  if (!list) notFound();
  if (!viewer || viewer.id !== list.owner.id) notFound();

  return list;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  // ENTRY POINT 1 OF 2. Without this the list's title renders in the head for a non-owner.
  const list = await loadOwnedList(slug);

  return {
    title: `Editing ${list.title}`,
    /*
     * NOINDEX AND NO REFERRER, the same pair the token-bearing and admin routes carry. This URL
     * is only ever reachable by one person and there is nothing here for a crawler; the
     * referrer is suppressed so the list's id does not travel to an outbound link's host.
     */
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function EditListPage({ params }: PageProps) {
  const { slug } = await params;
  // ENTRY POINT 2 OF 2. Independently evaluated — see the module docblock.
  const list = await loadOwnedList(slug);

  const items = await getListItems(list.id);
  const canonical = `/list/${listSlug(list.title, list.id)}`;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="space-y-2">
        <Eyebrow>Editing</Eyebrow>
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
          <h1 className="font-display text-3xl leading-tight text-paper text-balance">
            {list.title}
          </h1>
          {/*
            THE WAY OUT IS A LINK, NOT A CANCEL BUTTON. There is no draft state here — the
            details form and the order each save on their own control — so "cancel" would be a
            promise to undo something that has already happened. "View list" is what it does.
          */}
          <Button asChild variant="ghost" size="sm">
            <Link href={canonical}>View list</Link>
          </Button>
        </div>
      </div>

      {/* `items` arrives in `(position, id)` order; the editor treats its own `order` state as
          null until a move happens, deferring to this prop. */}
      <ListEditor list={list} items={items} />
    </div>
  );
}

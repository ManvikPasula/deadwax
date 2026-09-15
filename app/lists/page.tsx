/**
 * `/lists` — the public list index.
 *
 * THE MOSAIC COMES FROM `attachPreviews`, AND `getPublicLists` ALREADY CALLS IT. One statement
 * fills every four-cover fan on the page: collect the list ids, one `IN` query, bucket into a
 * Map, slice to four in JavaScript (N+1 pattern 2). Calling it again here would be a second
 * copy of the same read.
 *
 * ITS KNOWN COST IS STATED AT THE QUERY, NOT HIDDEN: `attachPreviews` fetches every item of
 * every list on the page in order to use the first four of each, so 36 cards over 200-item
 * lists transfers 7,200 rows to build 144 thumbnails. The bounded rewrite is named there
 * (`cross join lateral … limit 4`) so the fix is one edit rather than an investigation. It is
 * relevant to THIS page because this is the surface that renders the most cards.
 *
 * PUBLIC LISTS ONLY, AND THEIR OWNERS MUST NOT BE GUESTS (I-12). A guest can create lists and
 * their own profile tab reads normally, but nothing of theirs reaches a public index — the same
 * asymmetry `notGuest` carries in queries/logs.ts. That filter lives in the query, so this page
 * cannot forget it.
 *
 * `sort` IS WHITELISTED BEFORE IT REACHES THE QUERY. `LIST_SORTS` is imported rather than
 * retyped: a sort key selects a branch of an ORDER BY, never travels as text, and an unknown
 * value falls back rather than 404ing — a silly `?sort=` should not break a link.
 */

import type { Metadata } from "next";

import { SortSelect } from "@/components/discovery/sort-select";
import { CreateListForm } from "@/components/list/create-list-form";
import { ListCard } from "@/components/list/list-card";
import { EmptyState, SectionHeading } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import { getPublicLists, LIST_SORTS, type ListSort } from "@/lib/db/queries/lists";
import { plural } from "@/lib/format";

/** A page's worth. Not `GRID_PAGE_SIZE`: these are full-width rows, not a six-column grid. */
const LIST_PAGE_SIZE = 36;

/**
 * NEITHER LABEL IS WORDED AS QUALITY. "popular" here is the correlated like count with a
 * recency tie-break — no hot ranking, no decay, no denormalised counter — so "Most liked" is
 * literally what it orders by, and "Best" would be a claim the number cannot support.
 */
const LIST_SORT_LABELS: Readonly<Record<ListSort, string>> = {
  popular: "Most liked",
  recent: "Recently updated",
};

function parseListSort(value: string | undefined | null): ListSort {
  return (LIST_SORTS as readonly string[]).includes(value ?? "") ? (value as ListSort) : "recent";
}

export const metadata: Metadata = {
  title: "Lists",
  description:
    "Lists made by members of Deadwax — ranked rundowns, playlists and collections of artists, albums and individual tracks.",
};

export default async function ListsPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>;
}) {
  const query = await searchParams;
  const sort = parseListSort(query.sort);

  const [lists, viewer] = await Promise.all([
    getPublicLists({ sort, limit: LIST_PAGE_SIZE }),
    currentUser(),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <SectionHeading
        eyebrow="Lists"
        title="What members have collected"
        as="h1"
        action={
          <SortSelect
            basePath="/lists"
            options={LIST_SORTS}
            value={sort}
            labels={LIST_SORT_LABELS}
            label="Sort lists by"
            legend={null}
          />
        }
      />

      {/*
        THE COMPOSER IS FOR SIGNED-IN MEMBERS ONLY, and its absence for a visitor is not a
        hidden feature: the header already carries Sign up, and a create form that refuses on
        submit is worse than one that is not there. `CreateListForm` navigates to the new list
        when no `onCreated` is given — which is right here, because the next thing anybody does
        with a new list is put something in it.

        A callback CANNOT be passed from this file anyway: props cross the server/client
        boundary in the RSC payload and a plain function is not serialisable. That is why
        `onCreated` exists for the dialog and not for this page.
      */}
      {viewer ? (
        <section className="card p-5">
          <SectionHeading eyebrow="New" title="Start a list" as="h2" />
          <CreateListForm submitLabel="New list" />
        </section>
      ) : null}

      <section>
        {/*
          AN `h2`, NOT A `<p>`. `ListCard` titles itself with an `h3`, so a count rendered as a
          paragraph left the document outline reading h1 -> h3 -> h3 -> h3 with no h2 anywhere,
          and a screen-reader user navigating by heading skipped a level into the cards. The
          count IS the section's heading — it says what the section contains — so it is marked
          up as one. `sr-only` is not used: it is legitimately visible text.
        */}
        <h2 className="mb-4 font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
          {plural(lists.length, "list")}
        </h2>

        {lists.length === 0 ? (
          <EmptyState
            title="No public lists yet"
            description="A list can hold artists, albums or individual tracks, ranked or not — so it works as a playlist as readily as a top ten. Make the first one."
          />
        ) : (
          <ul className="space-y-4">
            {lists.map((list) => (
              <li key={list.id}>
                {/* `showOwner` defaults to true, and it must be: this is a mixed index and the
                    owner is half of what a card here means. */}
                <ListCard list={list} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

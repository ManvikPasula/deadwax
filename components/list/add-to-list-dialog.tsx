"use client";

/**
 * "Add to list" — the dialog on an artist, an album and a track page.
 *
 * `"use client"`: a Radix dialog, optimistic membership state, two handlers and a transition.
 *
 * ---------------------------------------------------------------------------------------
 * MEMBERSHIP IS OVER THE FULL TARGET TUPLE, AND THAT IS THE WHOLE DIFFERENCE FROM THE SOURCE
 * ---------------------------------------------------------------------------------------
 *
 * There, a list item can only hold a series, so "is this already on the list" is one
 * `show_id` comparison. Here `list_items` is polymorphic — artist | album | track — and an
 * album item and one of its tracks differ ONLY in the ordinals. So `getListOptions` runs an
 * `EXISTS` over `(artist_id, album_id, disc_number, track_number)` with a per-column null
 * branch (`disc_number = NULL` is NULL, never true), and this component renders the
 * `containsTarget` it returns rather than deciding anything itself.
 *
 * What that buys, concretely: without it a list already holding *Kid A* would still offer
 * "Add", `onConflictDoNothing` would silently do nothing, and the member would press a button
 * that does not respond. With it the row reads "On this list" and is not pressable.
 *
 * THE TARGET IS NEVER TYPED BY THIS COMPONENT. `targetType` is derived server-side by
 * `targetTypeOf()` from the tuple, and is not a field of `targetSchema` at all — a caller who
 * could set it could write `target_type = 'album'` on a row carrying a track number, and every
 * aggregate that switches on the column would count it twice.
 *
 * ---------------------------------------------------------------------------------------
 * TWO PATHS, ONE DIALOG
 * ---------------------------------------------------------------------------------------
 *
 *   `addToList`       an existing list, by id.
 *   `quickAddToList`  create-or-append BY TITLE, matched case-insensitively against the
 *                     caller's OWN lists only. It is one `guard()` for the whole gesture — it
 *                     deliberately does not call `addToList` internally, which in the source
 *                     spends two rate-limit tokens and two verification reads on one click.
 *                     `created` comes back so the confirmation can say which of the two
 *                     things happened without this component guessing from titles it may not
 *                     have loaded.
 *
 * THERE IS NO REMOVE HERE, DELIBERATELY. `removeFromList` is keyed by `list_items.id` and
 * `getListOptions` does not return one — it returns a boolean from an `EXISTS`. Adding a
 * second query per row to fetch item ids, so that a dialog about adding could also un-add,
 * buys an undo for a gesture that has a list page one click away. Removal lives on the list.
 *
 * THE DIALOG STAYS OPEN AFTER A SUCCESSFUL ADD. Somebody who opened it is often filing one
 * record into two lists, and closing on the first press makes the second press a whole
 * re-open. The rows report their own new state instead.
 */

import { Check, ListPlus, LoaderCircle, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { addToList, quickAddToList } from "@/app/actions/lists";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldHint, FormError, Input, Label } from "@/components/ui/field";
import { Badge, EmptyState } from "@/components/ui/primitives";
import type { ListOption } from "@/lib/db/queries/lists";
import { plural } from "@/lib/format";
import { MAX_LIST_TITLE, type TargetInput } from "@/lib/security/schemas";

export type AddToListDialogProps = {
  /**
   * THE FULL POLYMORPHIC TARGET, exactly as `targetSchema` defines it and exactly as the page
   * built it from its own route params. Passed straight through to both actions; `artistId` is
   * optional here because the server RESOLVES IT FROM THE ALBUM ROW for an album or track
   * target and ignores whatever arrived, which closes "add a track under the wrong artist"
   * without a check of its own.
   */
  target: TargetInput;
  /** What is being added — "Kid A", "Idioteque", "Radiohead". Used in every accessible name. */
  targetLabel: string;
  /**
   * `getListOptions(viewerId, target)`, already ordered most-recently-touched first and
   * already carrying `containsTarget` per row. THIS COMPONENT MUST NEVER QUERY.
   */
  options: ListOption[];
  /**
   * Signed in at all. FALSE RENDERS AN INVITATION, NOT NOTHING — the same decision
   * `ArtistActions` records: a hidden control teaches nothing about what an account is for.
   * Note that a GUEST passes this: guests may curate, and are refused on exactly three things
   * (follow, like, comment), all of which involve another person.
   */
  canWrite: boolean;
  /** `?next=` for the sign-in invitation. A path inside Deadwax; the login route validates it. */
  signInNext?: string;
  /** Replace the default trigger button. Rendered through `asChild`, so pass one element. */
  trigger?: React.ReactNode;
  className?: string;
};

export function AddToListDialog({
  target,
  targetLabel,
  options,
  canWrite,
  signInNext,
  trigger,
  className,
}: AddToListDialogProps) {
  const router = useRouter();

  /**
   * THE OPTIMISTIC MEMBERSHIP MAP, AND AN ABSENT KEY MEANS "TRUST THE PROP".
   *
   * That is the rollback mechanism the whole app uses, written for a set of rows instead of
   * one boolean: on failure the key is DELETED, which restores `option.containsTarget`, rather
   * than being set to `false`, which would invent a third answer neither side believes. A
   * `Set` of added ids was the rejected shape — it can only express "now on the list" and has
   * no way back to "defer to the server".
   */
  const [added, setAdded] = React.useState<ReadonlyMap<number, boolean>>(() => new Map());
  const [newTitle, setNewTitle] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  /** Which row is mid-write, so only that row shows a spinner. Null for the quick-add path. */
  const [busyId, setBusyId] = React.useState<number | null>(null);

  const newTitleId = React.useId();

  function patch(listId: number, value: boolean | null) {
    setAdded((current) => {
      const next = new Map(current);
      if (value === null) next.delete(listId);
      else next.set(listId, value);
      return next;
    });
  }

  function add(option: ListOption) {
    setError(null);
    setNotice(null);
    setBusyId(option.id);
    patch(option.id, true);

    startTransition(async () => {
      const result = await addToList({ listId: option.id, target });
      setBusyId(null);
      if (!result.ok) {
        patch(option.id, null); // ROLL BACK TO THE PROP
        setError(result.error);
        return;
      }
      setNotice(`Added to ${option.title}.`);
      /**
       * `router.refresh()` even though this dialog has already painted the row.
       *
       * Everything else derived from the write is server-rendered: the list's item count on
       * every card, the four-cover mosaic, the "lists containing this album" rail on the page
       * behind this dialog, and the member's own profile. There is no honest way to reconcile
       * those in the browser, so the server tree is re-rendered and the optimistic value is
       * replaced by the truth.
       */
      router.refresh();
    });
  }

  function quickAdd(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);

    const title = newTitle;
    startTransition(async () => {
      const result = await quickAddToList({ title, target });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // `created` is the action's own answer, not a guess from the options list — which may not
      // even hold the matched list if the member has more than a hundred.
      setNotice(result.data.created ? `Created ${title} and added ${targetLabel}.` : `Added to ${title}.`);
      setNewTitle("");
      // The new list is not in `options` — that prop came from the server before this press —
      // so the refresh is what makes the row appear rather than the row appearing optimistically
      // under a title the server may have matched to an existing list instead.
      router.refresh();
    });
  }

  if (!canWrite) {
    return (
      <Button asChild variant="secondary" size="sm" className={className}>
        {/* A plain anchor, matching `ArtistActions`: a full navigation is what lets the app pick
            up the new session on the way back. */}
        <a href={signInNext ? `/login?next=${encodeURIComponent(signInNext)}` : "/login"}>
          Sign in to add to a list
        </a>
      </Button>
    );
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button" variant="secondary" size="sm" className={className}>
            <ListPlus aria-hidden="true" />
            Add to list
          </Button>
        )}
      </DialogTrigger>

      <DialogContent>
        {/* `DialogContent` injects no title on purpose — a dialog with no accessible name
            announces as "dialog" and nothing else — so every caller renders one. */}
        <DialogHeader>
          <DialogTitle>Add to a list</DialogTitle>
          <DialogDescription>{targetLabel}</DialogDescription>
        </DialogHeader>

        {options.length === 0 ? (
          <EmptyState
            title="No lists yet"
            description="Name one below and it will be created with this in it."
          />
        ) : (
          <ul className="max-h-72 divide-y divide-line overflow-y-auto">
            {options.map((option) => {
              const isOn = added.get(option.id) ?? option.containsTarget;
              const busy = busyId === option.id;
              return (
                <li key={option.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[0.9375rem] text-paper">{option.title}</p>
                    <p className="mt-0.5 flex items-center gap-2 font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
                      {plural(option.itemCount, "item")}
                      {/* A private list is the member's own business, but the badge is the only
                          thing on this row that says so, and they are about to file something
                          into it. */}
                      {option.isPublic ? null : <Badge>Private</Badge>}
                    </p>
                  </div>

                  {isOn ? (
                    /*
                     * A STATIC MARKER, NOT A DISABLED BUTTON. A disabled button is skipped by
                     * Tab and still reads as "something I could do if only", whereas this row
                     * is finished: the thing is on the list and removing it happens on the
                     * list. The glyph is `aria-hidden` and the word carries it.
                     */
                    <p className="flex shrink-0 items-center gap-1.5 font-mono text-[0.6875rem] uppercase tracking-wider text-teal">
                      <Check className="size-3.5" aria-hidden="true" />
                      On this list
                    </p>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => add(option)}
                      disabled={pending}
                      // The list's name is in the name of the control, because "Add" repeated
                      // down a column of twelve lists identifies nothing.
                      aria-label={`Add ${targetLabel} to ${option.title}`}
                      className="shrink-0"
                    >
                      {busy ? (
                        <LoaderCircle className="animate-spin" aria-hidden="true" />
                      ) : (
                        <Plus aria-hidden="true" />
                      )}
                      Add
                      {busy ? <span className="sr-only">Saving</span> : null}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/*
          THE QUICK-ADD PATH. A nested <form> inside the dialog rather than a second button on
          the footer, so Enter in the field submits it — which is what somebody who has just
          typed a title expects, and the only way to reach this path without a mouse in one
          gesture.
        */}
        <form onSubmit={quickAdd} className="mt-5 border-t border-line pt-4">
          <Field>
            <Label htmlFor={newTitleId}>Or start a new list</Label>
            <div className="flex items-start gap-2">
              <Input
                id={newTitleId}
                name="title"
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                placeholder="Records I play in the rain"
                maxLength={MAX_LIST_TITLE}
                autoComplete="off"
              />
              <Button type="submit" variant="primary" size="md" disabled={pending || newTitle.trim().length === 0}>
                {pending && busyId === null ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : (
                  <ListPlus aria-hidden="true" />
                )}
                Create
              </Button>
            </div>
            {/* The match rule is worth stating: retyping a title you already own appends rather
                than making a second list with the same name, and somebody else's list of the
                same name is not yours to append to. */}
            <FieldHint>
              If you already have a list with this name, {targetLabel} is added to it instead.
            </FieldHint>
          </Field>
        </form>

        {/*
          `role="status"` rather than a second `FormError`: a success is not an alert, and
          `aria-live="polite"` is what lets it be announced without interrupting whatever the
          member is reading. It renders nothing when there is nothing to say.
        */}
        {notice ? (
          <p role="status" className="mt-3 text-[0.8125rem] text-teal">
            {notice}
          </p>
        ) : null}
        <FormError message={error} className="mt-3" />
      </DialogContent>
    </Dialog>
  );
}

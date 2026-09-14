"use client";

/**
 * `/list/[slug]/edit` — rename, re-describe, re-publish, re-rank, and REORDER.
 *
 * THIS SURFACE EXISTS BECAUSE ITS ABSENCE WAS A NAMED DEFECT (source defect #8). `updateList`
 * and `reorderList` are both written, both tested and both authorized in the original, and
 * NEITHER HAS A CALLER OR ANY UI AT ALL. An action nobody can reach is an action nobody tests
 * against a real gesture and nobody notices rotting. This file is the caller for both.
 *
 * ---------------------------------------------------------------------------------------
 * REORDERING IS UP/DOWN BUTTONS, NOT DRAG-AND-DROP
 * ---------------------------------------------------------------------------------------
 *
 * Three reasons, in order of weight:
 *
 *   1. BUTTONS ARE KEYBOARD-OPERABLE BY CONSTRUCTION. A drag surface needs a parallel
 *      keyboard model (grab, move, drop, cancel) plus live-region announcements, and the
 *      keyboard path is the one that silently never gets built.
 *   2. NO DEPENDENCY. The app has exactly four Radix packages and no drag library; a fifth
 *      dependency for one screen is a client-bundle cost and a versioning liability.
 *   3. IT WORKS ON TOUCH without fighting the page's own scrolling, which is the failure mode
 *      every hand-rolled pointer-drag has on a phone.
 *
 * EVERY MOVE BUTTON NAMES THE ITEM IT MOVES — "Move Kid A up", not "Move up". Twenty rows of
 * identically-named buttons is a control that tells a screen-reader user nothing about where
 * they are, which is the same defect as an unnamed icon button.
 *
 * `reorderList` TAKES THE WHOLE ORDERED ARRAY, not a single move, and that is why one press
 * sends one call describing the FINISHED order: two calls that arrive out of order cannot
 * leave the list in a state neither press asked for. It is also one `UPDATE … FROM (VALUES …)`
 * inside one transaction, so the cost does not grow with the list.
 *
 * ---------------------------------------------------------------------------------------
 * STATE: `null` MEANS "TRUST THE PROP"
 * ---------------------------------------------------------------------------------------
 *
 * The order is `ListItemEntry[] | null`, exactly as `FollowButton`'s optimistic boolean is
 * `boolean | null`. A failed write sets it back to null — NOT to a hand-reversed move — so the
 * rendered order is whatever the server last said. Rolling back by re-applying the inverse
 * move looks identical in the common case and diverges permanently the moment two presses
 * overlap.
 *
 * ON SUCCESS THE LOCAL ORDER IS KEPT AND `router.refresh()` IS CALLED. The refreshed prop
 * agrees with it, so `order ?? items` reads the same either way — and nulling it on success
 * would flash the pre-press order for however long the refresh takes.
 *
 * PATCH SEMANTICS ON THE DETAILS FORM (I-1 / SEC-01): `undefined` leaves a column alone, an
 * explicit value writes it. This form DISPLAYS all four fields, so it posts all four; the
 * distinction is live in the action because other callers exist, and collapsing it is how the
 * source's rating click erased a member's review.
 */

import { ArrowDown, ArrowUp, LoaderCircle, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { removeFromList, reorderList, updateList } from "@/app/actions/lists";
import { ListItemRow } from "@/components/list/list-item-row";
import { Button } from "@/components/ui/button";
import { CheckboxField, Field, FieldHint, FormError, Input, Label, Textarea } from "@/components/ui/field";
import { EmptyState, SectionHeading } from "@/components/ui/primitives";
import type { ListDetail, ListItemEntry } from "@/lib/db/queries/lists";
import { plural } from "@/lib/format";
import { MAX_LIST_DESCRIPTION, MAX_LIST_TITLE } from "@/lib/security/schemas";
import { cn } from "@/lib/utils";

/** Four seconds — the one arm window in the app. See `DeleteLogButton` for the argument. */
const DISARM_MS = 4000;

export type ListEditorProps = {
  /** `getList(id)`. Only the owner reaches this route; the page proves that, not this file. */
  list: ListDetail;
  /** `getListItems(list.id)`, already in `(position, id)` order. */
  items: ListItemEntry[];
  className?: string;
};

export function ListEditor({ list, items, className }: ListEditorProps) {
  const router = useRouter();

  /* ---- The details form ------------------------------------------------------------- */
  const [title, setTitle] = React.useState(list.title);
  const [description, setDescription] = React.useState(list.description ?? "");
  const [isRanked, setIsRanked] = React.useState(list.isRanked);
  const [isPublic, setIsPublic] = React.useState(list.isPublic);
  const [detailsError, setDetailsError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [savingDetails, startDetailsTransition] = React.useTransition();

  /* ---- The order -------------------------------------------------------------------- */
  /** null = defer to the `items` prop. See the module docblock. */
  const [order, setOrder] = React.useState<ListItemEntry[] | null>(null);
  const [orderError, setOrderError] = React.useState<string | null>(null);
  const [savingOrder, startOrderTransition] = React.useTransition();
  /** Which row's remove control is armed. One at a time, by construction. */
  const [armedId, setArmedId] = React.useState<number | null>(null);

  const titleId = React.useId();
  const descriptionId = React.useId();

  const rows = order ?? items;

  React.useEffect(() => {
    if (armedId === null) return;
    const timer = window.setTimeout(() => setArmedId(null), DISARM_MS);
    // Unmount while armed, and a re-arm on another row, both clear the previous timer.
    return () => window.clearTimeout(timer);
  }, [armedId]);

  function saveDetails(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDetailsError(null);
    setSaved(false);

    startDetailsTransition(async () => {
      const result = await updateList({
        listId: list.id,
        title,
        /**
         * A STRING, INCLUDING "". The action distinguishes absent (leave the column alone) from
         * an explicit null (clear it), and runs `blankToNull` on whatever arrives — so emptying
         * the textarea genuinely clears the description rather than storing whitespace. Sending
         * `undefined` for a blank field would make the box impossible to empty.
         */
        description,
        isRanked,
        isPublic,
      });

      if (!result.ok) {
        setDetailsError(result.error);
        return;
      }
      setSaved(true);
      /**
       * The slug is regenerated server-side ONLY when the title arrives, which changes this
       * list's canonical URL — and that is safe because nothing reads the slug as a key
       * (`parseListSlug` throws it away and keeps the trailing id), so the address in the
       * browser keeps resolving. The refresh is what makes the page heading, the badges and
       * every card of this list agree with what was just written.
       */
      router.refresh();
    });
  }

  function commitOrder(next: ListItemEntry[]) {
    setOrderError(null);
    setOrder(next); // Optimistic: the rows move on the same frame as the press.

    startOrderTransition(async () => {
      const result = await reorderList({ listId: list.id, itemIds: next.map((item) => item.id) });
      if (!result.ok) {
        setOrder(null); // ROLL BACK TO THE PROP
        setOrderError(result.error);
        return;
      }
      router.refresh();
    });
  }

  /**
   * ONE SWAP, THEN THE WHOLE ARRAY IS SENT. `direction` is +1 or -1 and the bounds are checked
   * here rather than by disabling arithmetic later: the first row has no "up" and the last has
   * no "down", and the buttons for those are not rendered at all (see below), so this guard is
   * the second line rather than the first.
   */
  function move(index: number, direction: 1 | -1) {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    const moved = next[index];
    next[index] = next[target];
    next[target] = moved;
    commitOrder(next);
  }

  function remove(item: ListItemEntry) {
    if (armedId !== item.id) {
      setOrderError(null);
      setArmedId(item.id);
      return;
    }

    setArmedId(null);
    setOrderError(null);
    /**
     * OPTIMISTIC, UNLIKE `DeleteLogButton`, AND THE DIFFERENCE IS OWNERSHIP OF THE LIST.
     *
     * That control cannot remove its own row because the row belongs to a feed it cannot see,
     * and the delete also moves lifetime counters, heatmap cells and a year page. This editor
     * IS the list: dropping the row locally is the honest first half of the write, and the
     * refresh afterwards reconciles the item count and the mosaic that this component cannot
     * see either.
     */
    const next = rows.filter((row) => row.id !== item.id);
    setOrder(next);

    startOrderTransition(async () => {
      const result = await removeFromList({ listId: list.id, itemId: item.id });
      if (!result.ok) {
        setOrder(null); // ROLL BACK TO THE PROP — the row comes back.
        setOrderError(result.error);
        return;
      }
      // Not `setOrder(null)`: that would flash the removed row back for the length of the
      // refresh. The refreshed prop agrees with `next`, so keeping it is stable.
      router.refresh();
    });
  }

  /** What a row is called, for the move and remove buttons' accessible names. */
  function labelOf(item: ListItemEntry): string {
    if (item.targetType === "artist") return item.artist.name;
    if (item.track) return item.track.title ?? `track ${item.track.locator}`;
    return item.album?.title ?? "this item";
  }

  return (
    <div className={cn("space-y-10", className)}>
      {/* ================================================================== */}
      {/* Details                                                            */}
      {/* ================================================================== */}
      <section>
        <SectionHeading eyebrow="Edit" title="List details" />

        <form onSubmit={saveDetails} className="space-y-4">
          <Field>
            <Label htmlFor={titleId}>Title</Label>
            <Input
              id={titleId}
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              maxLength={MAX_LIST_TITLE}
              autoComplete="off"
            />
            {/* Worth saying, because a renamed list's URL changes and a member who has shared
                the old one deserves to know it still works. */}
            <FieldHint>Renaming changes the list&rsquo;s address. Links you have already shared keep working.</FieldHint>
          </Field>

          <Field>
            <Label htmlFor={descriptionId}>Description</Label>
            <Textarea
              id={descriptionId}
              name="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={MAX_LIST_DESCRIPTION}
            />
            <FieldHint>Clear the box to remove the description entirely.</FieldHint>
          </Field>

          <div className="space-y-2">
            <CheckboxField
              name="isRanked"
              checked={isRanked}
              onChange={(event) => setIsRanked(event.target.checked)}
              label="Ranked — number the rows in order"
            />
            <CheckboxField
              name="isPublic"
              checked={isPublic}
              onChange={(event) => setIsPublic(event.target.checked)}
              label="Public — anybody can open it"
            />
            {/* The flip has a consequence beyond this page: a just-privatised list leaves
                /lists, and a just-published one appears there. The action revalidates both
                states for exactly that reason. */}
            {list.isPublic && !isPublic ? (
              <FieldHint>Saving this removes the list from /lists and from anybody else&rsquo;s view.</FieldHint>
            ) : null}
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={savingDetails || title.trim().length === 0}>
              {savingDetails ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Save aria-hidden="true" />
              )}
              Save details
              {savingDetails ? <span className="sr-only">Saving</span> : null}
            </Button>
            {/* A success is a status, not an alert: `role="status"` is polite, so it is
                announced without interrupting whatever is being read. */}
            {saved && !savingDetails ? (
              <p role="status" className="font-mono text-[0.6875rem] uppercase tracking-wider text-teal">
                Saved
              </p>
            ) : null}
          </div>

          <FormError message={detailsError} />
        </form>
      </section>

      {/* ================================================================== */}
      {/* Order                                                              */}
      {/* ================================================================== */}
      <section>
        <SectionHeading
          eyebrow="Order"
          title={isRanked ? "The ranking" : "The order"}
          action={
            <p className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
              {plural(rows.length, "item")}
            </p>
          }
        />

        {rows.length === 0 ? (
          <EmptyState
            title="Nothing on this list yet"
            description="Add an artist, an album or a track from its own page — the button is called “Add to list”."
          />
        ) : (
          <>
            {/*
              THE INSTRUCTION IS RENDERED, NOT IMPLIED. A pair of arrow buttons is only obvious
              once you have pressed one, and this is the only reorder surface in the product.
            */}
            <p className="mb-2 font-mono text-[0.6875rem] tracking-wider text-faint">
              Each press saves the whole order. {isRanked ? "The numbers are the ranking." : null}
            </p>

            <ul className="divide-y divide-line">
              {rows.map((item, index) => {
                const label = labelOf(item);
                const armed = armedId === item.id;
                return (
                  <ListItemRow
                    key={item.id}
                    item={item}
                    // The RENDER INDEX, not `item.position`: positions can legitimately tie,
                    // because `addToList` appends at `max(position) + 1` outside a transaction.
                    rank={isRanked ? index + 1 : null}
                    actions={
                      <>
                        {/*
                          THE END BUTTONS ARE ABSENT, NOT DISABLED — the opposite of the
                          Desert Island button's "disabled rather than hidden". The difference
                          is what the control would be saying: an exhausted quota is the
                          feature working and worth reporting, whereas "the first row cannot
                          move up" is arithmetic, and a permanently dead button at the top of
                          every list is a tab stop that never does anything.
                        */}
                        {index > 0 ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => move(index, -1)}
                            disabled={savingOrder}
                            aria-label={`Move ${label} up`}
                          >
                            <ArrowUp aria-hidden="true" />
                          </Button>
                        ) : (
                          // A fixed-size placeholder so the two-button gutter does not change
                          // width on the first and last rows and shift every title by 36px.
                          <span className="size-9" aria-hidden="true" />
                        )}

                        {index < rows.length - 1 ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            onClick={() => move(index, 1)}
                            disabled={savingOrder}
                            aria-label={`Move ${label} down`}
                          >
                            <ArrowDown aria-hidden="true" />
                          </Button>
                        ) : (
                          <span className="size-9" aria-hidden="true" />
                        )}

                        <Button
                          type="button"
                          variant={armed ? "danger" : "ghost"}
                          size="icon"
                          onClick={() => remove(item)}
                          disabled={savingOrder}
                          // The armed state is announced, not only painted.
                          aria-label={armed ? `Confirm remove: ${label}` : `Remove ${label} from this list`}
                          className={cn(armed && "border-rose bg-rose/30 text-paper")}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </>
                    }
                  />
                );
              })}
            </ul>
          </>
        )}

        <FormError message={orderError} className="mt-3" />
      </section>
    </div>
  );
}

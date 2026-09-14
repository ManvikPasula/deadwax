"use client";

/**
 * "New list" — the one form that calls `createList`.
 *
 * `"use client"` because it holds four controlled fields, a failure message and a transition.
 *
 * EVERY BOUND COMES FROM lib/security/schemas.ts. `MAX_LIST_TITLE` and
 * `MAX_LIST_DESCRIPTION` are the same numbers the action validates with, and that module is
 * deliberately pure — no `server-only`, no database import — precisely so a client component
 * can read them instead of hard-coding a 120 beside a schema that already says 120. A
 * `maxLength` written by hand here is the shape of the audit finding where sign-up and
 * sign-in each grew their own password rule.
 *
 * `isPublic` DEFAULTS TO CHECKED, matching both the column default and the action's
 * `isPublic ?? true`. A list is a thing you make to show somebody; the private case is the
 * deliberate one and therefore the one that takes a click.
 *
 * `isRanked` DEFAULTS TO UNCHECKED and says what it does, because the flag is not cosmetic:
 * it turns the rows into a numbered ranking, and a member who ticks it without reading has
 * published an ordering they never chose.
 *
 * THE HOUSE CLIENT CONVENTION: `useTransition`, an inline `<FormError>` beside the control
 * that caused the failure, no `useActionState` and no error boundary. Nothing here is
 * optimistic, because a list that does not exist yet has nowhere to appear — the honest
 * feedback is the pending button and then the navigation.
 */

import { ListPlus, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { createList } from "@/app/actions/lists";
import { Button } from "@/components/ui/button";
import { CheckboxField, Field, FieldHint, FormError, Input, Label, Textarea } from "@/components/ui/field";
import { MAX_LIST_DESCRIPTION, MAX_LIST_TITLE } from "@/lib/security/schemas";
import { cn } from "@/lib/utils";

export type CreateListFormProps = {
  /**
   * Called instead of navigating, with what the action returned. For a caller that already has
   * the member's attention somewhere else — a dialog that wants to stay open and report "added
   * to Records I play in the rain" rather than throwing the page away.
   */
  onCreated?: (created: { listId: number; slug: string }) => void;
  /** The submit label. "New list" on `/lists`; a caller in a dialog may want its own verb. */
  submitLabel?: string;
  className?: string;
};

export function CreateListForm({ onCreated, submitLabel = "Create list", className }: CreateListFormProps) {
  const router = useRouter();

  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [isRanked, setIsRanked] = React.useState(false);
  const [isPublic, setIsPublic] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  // Generated ids, not literals: a literal id would let this form's label claim another
  // form's field if both ever rendered on the same page, and `useId` is stable across the
  // server and client renders of the same tree.
  const titleId = React.useId();
  const descriptionId = React.useId();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      const result = await createList({
        title,
        /**
         * SENT AS A STRING, INCLUDING THE EMPTY ONE. `createInput` takes
         * `description: listDescription.optional()` and the action runs `blankToNull`, so ""
         * becomes SQL NULL rather than a row holding an empty string. The distinction matters
         * on the UPDATE path (`undefined` leaves the column alone, `null` clears it) and it
         * does not here, where there is no prior value to leave alone — but the form posts what
         * it displays either way, which is the rule that keeps the two paths readable.
         */
        description,
        isRanked,
        isPublic,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      if (onCreated) {
        onCreated(result.data);
        return;
      }

      // Straight to the new list, which is empty and says so: `EmptyState` is a real state in
      // this product, and the first thing a member wants after making a list is to put
      // something in it. `refresh` because the lists index and their profile both changed.
      router.push(`/list/${result.data.slug}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className={cn("space-y-4", className)}>
      <Field>
        <Label htmlFor={titleId}>Title</Label>
        <Input
          id={titleId}
          name="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Records I play in the rain"
          required
          maxLength={MAX_LIST_TITLE}
          autoComplete="off"
        />
        <FieldHint>Up to {MAX_LIST_TITLE} characters. You can rename it later.</FieldHint>
      </Field>

      <Field>
        <Label htmlFor={descriptionId}>Description</Label>
        <Textarea
          id={descriptionId}
          name="description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={MAX_LIST_DESCRIPTION}
          placeholder="Optional. What holds these together?"
        />
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
        {/* The private case needs saying, because nothing on a private list's own page looks
            different except one badge, and the maker is the only person who ever sees it. */}
        {isPublic ? null : (
          <FieldHint>A private list is visible only to you, and stays off /lists entirely.</FieldHint>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending || title.trim().length === 0}>
          {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <ListPlus aria-hidden="true" />}
          {submitLabel}
          {/* Under reduced motion the spinner is a still glyph, so the word carries it. */}
          {pending ? <span className="sr-only">Saving</span> : null}
        </Button>
      </div>

      <FormError message={error} />
    </form>
  );
}

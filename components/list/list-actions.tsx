"use client";

/**
 * The controls on a list page: clone, delete, and the owner's edit link.
 *
 * `"use client"` for the three reasons that justify it anywhere in this app — local state, an
 * event handler and a transition. The edit link would be a Server Component on its own; it
 * lives here because the three controls are one row and splitting them would put two
 * components in the same flex box arguing about gaps.
 *
 * ---------------------------------------------------------------------------------------
 * THE CLONE BUTTON IS HIDDEN FOR THE OWNER, AND THE ACTION STILL PERMITS IT
 * ---------------------------------------------------------------------------------------
 *
 * `cloneList` only requires the source to be public OR yours, so cloning your own list is a
 * legal call — and it stays legal, because duplicating your own private list as a starting
 * point is the one case where it makes sense, and the only person who can see that list is
 * the only person who can make that call. What is removed here is the BUTTON: "cloning your
 * own list would just duplicate it, which nobody means to do", and an owner who presses it by
 * accident gets a second list on their profile with the same title and no explanation.
 *
 * `isPublic: true` is hard-coded inside the action, so a clone is always public. That is
 * stated in the confirmation copy rather than left as a surprise on the member's profile.
 *
 * ---------------------------------------------------------------------------------------
 * DELETE IS TWO PRESSES, NOT A DIALOG
 * ---------------------------------------------------------------------------------------
 *
 * The same arm/confirm with the same 4000ms self-disarm as `DeleteLogButton` and
 * `ArtistActions` — ONE DWELL TIME IN THE WHOLE APP, so a member learns it once. There is no
 * undo anywhere in this product and no soft-delete column, so the gesture carries the whole
 * weight of the confirmation; and the second press lands on the same pixel as the first, which
 * a modal cannot promise.
 *
 * NOTHING HERE IS OPTIMISTIC. A clone has nowhere to appear until the new list exists, and a
 * delete removes the page this component is standing on — so both simply navigate on success.
 * `router.refresh()` follows the push because the destination (the member's lists, or the
 * clone itself) is server-rendered from rows the write has just changed.
 */

import { Copy, LoaderCircle, Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import * as React from "react";

import { cloneList, deleteList } from "@/app/actions/lists";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { listSlug } from "@/lib/slug";
import { cn } from "@/lib/utils";

/** Four seconds. The same window as every other destructive control in the app. */
const DISARM_MS = 4000;

export type ListActionsProps = {
  listId: number;
  /** The title, for the accessible names and for rebuilding the `/edit` URL. */
  title: string;
  /**
   * `list.owner.id === viewerId`, computed on the SERVER from the session. The owner gets edit
   * and delete; everybody else gets clone.
   */
  isOwner: boolean;
  /**
   * Whether the viewer is signed in at all. FALSE DOES NOT HIDE THE CONTROL — it becomes an
   * invitation to sign in, because a hidden button teaches nothing about what an account is
   * for. The same decision `ArtistActions` records.
   */
  canWrite: boolean;
  /**
   * `list.isPublic`. A private list 404s for everybody but its owner, so for a non-owner this
   * is always true in practice; it is still checked, because the clone button must not exist
   * on a surface where the action would refuse it.
   */
  isPublic: boolean;
  /** Where to send the browser after a successful delete. The list itself is gone by then. */
  afterDeleteHref?: string;
  /** `?next=` for the sign-in invitation. A path inside Deadwax; the login route validates it. */
  signInNext?: string;
  className?: string;
};

export function ListActions({
  listId,
  title,
  isOwner,
  canWrite,
  isPublic,
  afterDeleteHref = "/lists",
  signInNext,
  className,
}: ListActionsProps) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [armed, setArmed] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), DISARM_MS);
    // Covers both cases: unmount while armed, and a re-arm before the previous timer fired.
    return () => window.clearTimeout(timer);
  }, [armed]);

  function clone() {
    setError(null);
    startTransition(async () => {
      const result = await cloneList({ listId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // The action returns the new list's own slug — `listSlug(title, newId)` — so the push
      // lands on a canonical URL rather than on `/list/<id>`, which is legal but is not the
      // address anybody would copy.
      router.push(`/list/${result.data.slug}`);
      router.refresh();
    });
  }

  function remove() {
    if (!armed) {
      setError(null);
      setArmed(true);
      return;
    }

    setArmed(false);
    startTransition(async () => {
      const result = await deleteList({ listId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      /**
       * `push` THEN `refresh`, NOT `replace`. The deleted list's URL is now a 404, and leaving
       * it in the history as the entry the back button returns to is worse than leaving the
       * push: a member who presses back expects the page they came FROM, which is what the
       * pushed navigation preserves.
       */
      router.push(afterDeleteHref);
      router.refresh();
    });
  }

  return (
    <div className={cn("flex flex-col items-start gap-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {isOwner ? (
          <>
            {/*
              A LINK, NOT A BUTTON THAT NAVIGATES. `/list/[slug]/edit` is a real address, so
              this keeps middle-click, copy-link and prefetch — and the slug is recomputed from
              the title because the URL grammar keys on the trailing id and ignores everything
              in front of it.
            */}
            <Button asChild variant="secondary" size="sm">
              <Link href={`/list/${listSlug(title, listId)}/edit`}>
                <Pencil aria-hidden="true" />
                Edit list
              </Link>
            </Button>

            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={remove}
              disabled={pending}
              // The armed state is ANNOUNCED, not only painted: the visible label shortens to
              // "Confirm", which on its own describes nothing, so the whole sentence lives here.
              aria-label={armed ? `Confirm delete: the list ${title}` : `Delete the list ${title}`}
              className={cn(armed && "border-rose bg-rose/30 text-paper")}
            >
              {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
              {armed ? "Confirm" : "Delete"}
              {/* The spinner is a still glyph under reduced motion, so the word is the only
                  thing left saying "working". */}
              {pending ? <span className="sr-only">Deleting</span> : null}
            </Button>
          </>
        ) : !isPublic ? null : canWrite ? (
          <Button type="button" variant="secondary" size="sm" onClick={clone} disabled={pending}>
            {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Copy aria-hidden="true" />}
            Save a copy
            {pending ? <span className="sr-only">Copying</span> : null}
          </Button>
        ) : (
          <Button asChild variant="secondary" size="sm">
            {/* A plain anchor, matching `ArtistActions`: this leaves the app's own router to
                pick up a new session on the way back. */}
            <a href={signInNext ? `/login?next=${encodeURIComponent(signInNext)}` : "/login"}>
              Sign in to save a copy
            </a>
          </Button>
        )}
      </div>

      {/* Clones are public whatever the source was — `cloneList` hard-codes it, because cloning
          is a publishing gesture. Said here, in front of the press, rather than discovered on
          the member's own profile afterwards. */}
      {!isOwner && isPublic && canWrite ? (
        <p className="font-mono text-[0.6875rem] tracking-wider text-faint">
          A copy lands on your profile as a public list.
        </p>
      ) : null}

      {/* After the controls, so a screen reader hears the control the failure belongs to first.
          Renders nothing at all for an absent message. */}
      <FormError message={error} />
    </div>
  );
}

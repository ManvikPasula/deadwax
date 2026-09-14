"use client";

/**
 * Delete one diary entry. TWO PRESSES, NOT A MODAL.
 *
 * THE FIRST PRESS ARMS IT, THE SECOND COMMITS, AND IT DISARMS ITSELF AFTER FOUR SECONDS — a
 * deleted log cannot be recovered. There is no undo anywhere in this application and no soft
 * delete column, so the gesture has to carry the whole weight of the confirmation.
 *
 * WHY NOT A DIALOG, which is the obvious alternative and is what the design system already
 * ships (components/ui/dialog.tsx):
 *
 *   - The control lives in a hover-revealed corner of a diary row, in a list of up to fifty.
 *     A dialog would take over the viewport, move focus out of the list, and on dismissal
 *     return it to a button that is invisible again — the reader loses their place in their
 *     own diary to delete one row of it.
 *   - An armed button is legible IN PLACE: the label changes from "Delete" to "Delete?" and
 *     the surface escalates, so the second press is on the same pixel as the first.
 *   - Arm/confirm degrades correctly. If the timer never fires the control is still just a
 *     button; if a dialog fails to mount, the delete is unreachable.
 *
 * THE SELF-DISARM IS THE SAFETY PROPERTY. An armed destructive control that stays armed is a
 * loaded control sitting under a mouse in a list the member is scrolling; four seconds is long
 * enough to aim deliberately and short enough that it cannot be forgotten. The timer is
 * cleared on unmount AND whenever the state changes, because a row that unmounts while armed
 * (the refresh below re-renders the list) would otherwise leave a `setState` scheduled against
 * a component that no longer exists.
 */

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { deleteLog } from "@/app/actions/logs";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/** Four seconds. Long enough to aim, short enough that it cannot be forgotten. */
const DISARM_MS = 4000;

export type DeleteLogButtonProps = {
  logId: number;
  /**
   * What is being deleted, for the accessible name: "Delete your entry for Kid A". REQUIRED,
   * because this is an icon-only control until it is armed and "Delete" alone, repeated fifty
   * times down a diary, tells a screen-reader user nothing about which row they are on.
   */
  label: string;
  className?: string;
};

export function DeleteLogButton({ logId, label, className }: DeleteLogButtonProps) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [armed, setArmed] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), DISARM_MS);
    // Cleanup covers both cases that matter: unmount while armed, and a re-arm before the
    // previous timer fired (which would otherwise disarm the new one early).
    return () => window.clearTimeout(timer);
  }, [armed]);

  function submit() {
    if (!armed) {
      setError(null);
      setArmed(true);
      return;
    }

    setArmed(false);
    startTransition(async () => {
      const result = await deleteLog({ logId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      /**
       * NOTHING IS ROLLED BACK HERE BECAUSE NOTHING WAS OPTIMISTIC. This button cannot remove
       * its own row — the row belongs to the feed above it, and the delete also moves the
       * member's lifetime counters, their heatmap cells, their year page and every aggregate
       * the album carries. An optimistic local hide would clear one of those and leave the
       * other five stating the old number until the next navigation, so the row survives for
       * the length of one server round trip and then the whole tree is honest at once.
       */
      router.refresh();
    });
  }

  return (
    <span className={cn("inline-flex flex-col items-end gap-1", className)}>
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={submit}
        disabled={pending}
        // The armed state is announced, not just painted: the label itself changes, so a
        // screen reader that re-reads the focused control hears the escalation.
        aria-label={armed ? `Confirm delete: ${label}` : `Delete ${label}`}
        className={cn(armed && "border-rose bg-rose/30 text-paper")}
      >
        <Trash2 />
        {armed ? "Confirm" : "Delete"}
      </Button>
      <FormError message={error} />
    </span>
  );
}

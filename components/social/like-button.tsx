"use client";

/**
 * The heart on a review or a list.
 *
 * THIS IS THE ONE OPTIMISTIC CONTROL IN THE APP THAT DELIBERATELY DOES NOT CALL
 * `router.refresh()`.
 *
 * Everywhere else a write changes something the component cannot see — an aggregate, a
 * histogram, a replay count, a badge, a feed — so re-rendering the server tree is the only
 * honest reconciliation. A like changes exactly two things: whether this viewer's heart is
 * filled, and the number beside it. Both are held here. Refreshing would re-fetch a whole
 * page of reviews (with their correlated like-count subqueries) to learn a number this
 * component already knows, and on the reviews page sorted by `popular` it would also RE-SORT
 * THE LIST UNDER THE READER'S CURSOR — the row they just hearted jumping position is a worse
 * outcome than a count that waits for the next navigation to be re-derived.
 *
 * The consequence is the reason the state machine below differs from every other optimistic
 * button here: ON SUCCESS THE OPTIMISTIC VALUE IS KEPT, not dropped. There is no refresh, so
 * the prop is stale from the moment the write lands; dropping the guess would snap the heart
 * back to its old state. It is dropped only on FAILURE, which is the rollback.
 */

import { Heart } from "lucide-react";
import * as React from "react";

import { toggleLike } from "@/app/actions/social";
import { FormError } from "@/components/ui/field";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

export type LikeButtonProps = {
  /** The two likeable containers. A comment cannot be liked. */
  targetType: "log" | "list";
  targetId: number;
  /** From `getLikedLogIds` (batched) or `hasLiked` (single). */
  liked: boolean;
  /** The correlated subquery count from the read that rendered this row. */
  count: number;
  /**
   * What is being liked, for the accessible name: "Like Nadia's review of Blue". The glyph
   * carries no text, so without this the control announces as "button".
   */
  label: string;
  className?: string;
};

export function LikeButton({ targetType, targetId, liked, count, label, className }: LikeButtonProps) {
  const [error, setError] = React.useState<string | null>(null);
  const [optimistic, setOptimistic] = React.useState<boolean | null>(null);
  const [pending, startTransition] = React.useTransition();

  const isLiked = optimistic ?? liked;
  /**
   * The same arithmetic shape the Desert Island button uses: the prop count already includes
   * this viewer's own like when `liked` is true, so the delta is only applied when the
   * optimistic answer actually DISAGREES with the prop. `Math.max(0, …)` is not needed — the
   * disagreement is at most one in either direction and a true prop count cannot be 0 while
   * `liked` is true.
   */
  const shown = count + (optimistic === null || optimistic === liked ? 0 : optimistic ? 1 : -1);

  function submit() {
    const next = !isLiked;
    setError(null);
    setOptimistic(next);

    startTransition(async () => {
      const result = await toggleLike({ targetType, targetId, like: next });
      if (!result.ok) {
        setError(result.error);
        setOptimistic(null); // back to the prop — see the docblock
        return;
      }
      // NO router.refresh(). Read the docblock before adding one.
    });
  }

  return (
    <span className={cn("inline-flex flex-col items-start gap-1", className)}>
      <button
        type="button"
        onClick={submit}
        disabled={pending}
        aria-pressed={isLiked}
        aria-label={isLiked ? `Unlike ${label}` : `Like ${label}`}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-card px-1.5 py-1",
          "font-mono text-[0.6875rem] tracking-wider tabular transition-colors",
          "disabled:pointer-events-none disabled:opacity-50",
          isLiked ? "text-rose hover:text-rose" : "text-faint hover:text-paper",
        )}
      >
        <Heart
          className="size-3.5 shrink-0"
          // `fill` rather than a second glyph: an outline and a solid heart are the same shape,
          // and swapping the component swaps the DOM node, which loses focus mid-toggle.
          fill={isLiked ? "currentColor" : "none"}
          aria-hidden="true"
        />
        {/*
          THE NUMBER IS THE TEXT EQUIVALENT OF THE FILL. A member who cannot see that the
          heart is solid still reads the count change, and `aria-pressed` states the toggle.
        */}
        <span>{formatCount(shown)}</span>
      </button>
      <FormError message={error} />
    </span>
  );
}

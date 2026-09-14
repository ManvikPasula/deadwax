"use client";

/**
 * Follow / unfollow one member.
 *
 * `"use client"` because of the three things this file does that a Server Component cannot:
 * hold the optimistic boolean, hold the failure message, and run a click handler.
 *
 * THE OPTIMISTIC STATE IS `boolean | null`, WHERE NULL MEANS "TRUST THE PROP".
 *
 * That is the whole rollback mechanism, and it is deliberately not `useState(following)`.
 * Every follower count, every "Following" badge and the network page's membership are
 * SERVER-RENDERED from the follow edge, so the honest reconciliation after a write is to
 * re-render the server tree — `router.refresh()` — and then let the incoming prop be the
 * truth again. A component holding its own copy of the answer would keep showing its guess
 * after the refresh had already corrected it, and the two would only agree by luck.
 *
 * Rejected alternative: `useOptimistic`. It resets when the transition ends, which is right
 * for a list that the server re-renders underneath you (see comment-thread.tsx, where it is
 * used for exactly that) but wrong here — the refresh and the transition do not end in a
 * guaranteed order, so the label can visibly flip back to "Follow" for a frame before the new
 * tree lands.
 */

import { UserCheck, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { toggleFollow } from "@/app/actions/social";
import { Button, type ButtonSize } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export type FollowButtonProps = {
  /** The member being followed. */
  userId: number;
  /** Their username, used to build the accessible name — "Follow nadia", not "Follow". */
  username: string;
  /** Server truth, from `isFollowing` / `viewerFollowSet`. */
  following: boolean;
  size?: ButtonSize;
  className?: string;
};

export function FollowButton({ userId, username, following, size = "md", className }: FollowButtonProps) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [optimistic, setOptimistic] = React.useState<boolean | null>(null);
  const [pending, startTransition] = React.useTransition();

  const isFollowing = optimistic ?? following;

  function submit() {
    const next = !isFollowing;
    setError(null);
    setOptimistic(next);

    startTransition(async () => {
      const result = await toggleFollow({ userId, follow: next });
      if (!result.ok) {
        setError(result.error);
        // ROLL BACK TO THE PROP, not to `!next`: between the click and the failure the server
        // tree may already have moved for another reason (a refresh from elsewhere on the
        // page), and `!next` would then invent a third answer neither side believes.
        setOptimistic(null);
        return;
      }
      // The follow edge feeds counters, the directory ordering and the feed itself, none of
      // which this component can see. Re-render the server tree and drop the guess.
      setOptimistic(null);
      router.refresh();
    });
  }

  return (
    <div className={cn("inline-flex flex-col items-start gap-1", className)}>
      <Button
        type="button"
        variant={isFollowing ? "outline" : "primary"}
        size={size}
        onClick={submit}
        disabled={pending}
        // `aria-pressed` states the toggle for assistive technology; the visible label already
        // changes, but the two channels are not the same channel.
        aria-pressed={isFollowing}
        aria-label={isFollowing ? `Unfollow ${username}` : `Follow ${username}`}
      >
        {isFollowing ? <UserCheck /> : <UserPlus />}
        {isFollowing ? "Following" : "Follow"}
      </Button>
      <FormError message={error} />
    </div>
  );
}

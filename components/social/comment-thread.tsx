"use client";

/**
 * The comment thread on a log or a list. FLAT — depth is exactly 1.
 *
 * `comments` has no `parent_id`, so there is no tree to walk, no indentation ladder and no
 * collapse control. That is a schema decision rather than a rendering shortcut: a threaded
 * discussion needs moderation tooling this product does not have, and a diary entry's replies
 * are a handful of sentences, not a forum.
 *
 * ORDERED ASCENDING — OLDEST FIRST — WHICH IS THE OPPOSITE OF EVERY OTHER READ IN THE APP.
 * `getLogComments` orders `asc(comments.createdAt)` and this component does not re-sort it:
 * a thread is read top to bottom like a conversation, whereas a feed is read newest first
 * like a diary. The composer is therefore at the BOTTOM, where the next message goes.
 *
 * `"use client"` is required three times over: `useOptimistic`, a controlled textarea, and a
 * submit handler.
 *
 * THE BOUND IS IMPORTED, NEVER RESTATED. `MAX_COMMENT_BODY` has to agree in three places —
 * the Zod schema on the server, the textarea's `maxLength`, and the counter's threshold — and
 * the schema's own comment says so. A literal `2000` here would be the fourth copy waiting to
 * disagree with the other three.
 */

import { MessageSquare, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import { addComment, deleteComment } from "@/app/actions/social";
import { Button } from "@/components/ui/button";
import { FieldHint, FormError, Label, Textarea } from "@/components/ui/field";
import { AvatarWithName } from "@/components/ui/avatar";
import { Eyebrow } from "@/components/ui/primitives";
import type { CommentEntry } from "@/lib/db/queries/logs";
import type { MemberSummary } from "@/lib/db/queries/users";
import { formatRelative, plural } from "@/lib/format";
import { MAX_COMMENT_BODY } from "@/lib/security/schemas";
import { cn } from "@/lib/utils";

/**
 * THE COUNTER APPEARS IN THE LAST 200 CHARACTERS, i.e. at 1,801 of 2,000.
 *
 * Derived from the imported bound rather than written as `1801`, because the pair only makes
 * sense together: raise the schema's cap and this threshold follows it automatically. A
 * counter that is always on is noise on a two-sentence reply — it turns a reply box into a
 * form with a quota — and one that appears only when the limit is in sight is the only time
 * the number is information.
 */
const COUNTER_AT = MAX_COMMENT_BODY - 199;

/** The optimistic sentinel. A real row's id is a `serial`, so it can never be negative. */
const PENDING_ID = -1;

type Optimistic = { kind: "add"; comment: CommentEntry } | { kind: "remove"; id: number };

export type CommentThreadProps = {
  /** The polymorphic container. A comment cannot be commented on. */
  target: { targetType: "log" | "list"; targetId: number };
  /** ASCENDING, straight from `getLogComments`. Not re-sorted here. */
  comments: CommentEntry[];
  /** The signed-in member, or null when signed out. Guests are members for this purpose. */
  viewer: MemberSummary | null;
  /**
   * The owner of the container — the log's author or the list's owner.
   *
   * THIS PROP IS WHAT MAKES CONTAINER-OWNER MODERATION REACHABLE. `deleteComment` has
   * authorised "the comment's author OR the container's owner" on the server all along, but
   * the television original only ever renders the control when the viewer is the author — so
   * a list owner could never remove a comment from their own list. A capability nobody can
   * use is indistinguishable from one that does not exist.
   */
  containerOwnerId: number | null;
  className?: string;
};

export function CommentThread({
  target,
  comments,
  viewer,
  containerOwnerId,
  className,
}: CommentThreadProps) {
  const router = useRouter();
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  /**
   * `useOptimistic` RATHER THAN `useState`, AND HERE IT IS THE RIGHT TOOL.
   *
   * The list is a prop that the server re-renders after every write, and `useOptimistic`
   * discards its overlay when the transition settles — which is exactly the required
   * behaviour: ROLL BACK TO THE PROP, never to a previous local copy. A `useState` mirror of
   * `comments` would have to be reconciled by hand on both the success and failure paths, and
   * the failure path is the one nobody tests.
   */
  const [rows, applyOptimistic] = React.useOptimistic(comments, (state, action: Optimistic) =>
    action.kind === "add"
      ? [...state, action.comment]
      : state.filter((comment) => comment.id !== action.id),
  );

  const counterId = `comment-counter-${target.targetType}-${target.targetId}`;
  const fieldId = `comment-body-${target.targetType}-${target.targetId}`;
  const remaining = MAX_COMMENT_BODY - body.length;
  const showCounter = body.length >= COUNTER_AT;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = body.trim();
    if (!text || !viewer) return;

    setError(null);
    // Cleared IMMEDIATELY and restored from this closure on failure. The textarea is not a
    // mirror of a prop, so "roll back to the prop" does not apply to it — the honest rollback
    // for a composer is to hand the member their own words back so the retry is one click.
    setBody("");

    startTransition(async () => {
      applyOptimistic({
        kind: "add",
        comment: {
          id: PENDING_ID,
          body: text,
          // A placeholder the pending row never renders — see `CommentRow`, which shows
          // "Posting…" rather than a relative time for the sentinel id. Sending `new Date()`
          // and rendering it would print "just now" for a row that may never be saved.
          createdAt: new Date(),
          author: viewer,
        },
      });

      const result = await addComment({ ...target, body: text });
      if (!result.ok) {
        setError(result.error);
        setBody(text);
        return; // the overlay is dropped when this transition ends
      }
      router.refresh();
    });
  }

  function remove(commentId: number) {
    setError(null);
    startTransition(async () => {
      applyOptimistic({ kind: "remove", id: commentId });
      const result = await deleteComment({ commentId });
      if (!result.ok) {
        setError(result.error);
        return; // the row reappears when the overlay is dropped
      }
      router.refresh();
    });
  }

  return (
    <section className={cn("space-y-4", className)} aria-labelledby={`${fieldId}-heading`}>
      <h2 id={`${fieldId}-heading`} className="section-rule">
        <Eyebrow>{rows.length === 0 ? "Replies" : plural(rows.length, "reply", "replies")}</Eyebrow>
      </h2>

      {rows.length === 0 ? (
        <p className="text-sm text-faint">No replies yet.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((comment) => (
            <CommentRow
              key={comment.id === PENDING_ID ? "pending" : comment.id}
              comment={comment}
              // THE AUTHOR **OR** THE CONTAINER'S OWNER. Both branches exist server-side; the
              // second one is unreachable in the original's UI.
              canDelete={
                viewer !== null &&
                comment.id !== PENDING_ID &&
                (viewer.id === comment.author.id || viewer.id === containerOwnerId)
              }
              pending={pending}
              onDelete={remove}
            />
          ))}
        </ul>
      )}

      {viewer === null ? (
        <p className="text-sm text-muted">
          <Link href="/login" className="text-amber underline underline-offset-4">
            Sign in
          </Link>{" "}
          to reply.
        </p>
      ) : viewer.isGuest ? (
        // Commenting is one of exactly three things a guest cannot do, and all three involve
        // another person. The refusal is the reason to sign up, so it is rendered as the offer
        // rather than as an error after a wasted round trip.
        <p className="text-sm text-muted">
          <Link href="/signup" className="text-amber underline underline-offset-4">
            Finish your account
          </Link>{" "}
          to reply — guest sessions can log and rate, but not talk to other members yet.
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-2">
          <Label htmlFor={fieldId} className="sr-only">
            Write a reply
          </Label>
          <Textarea
            id={fieldId}
            name="body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            // The SAME constant the Zod schema uses. See the module docblock.
            maxLength={MAX_COMMENT_BODY}
            placeholder="Write a reply…"
            disabled={pending}
            aria-describedby={showCounter ? counterId : undefined}
            className="min-h-20"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/*
              NOT a live region. `aria-live` here would announce a fresh character count on
              every keystroke for the last two hundred characters of a reply, which is worse
              than silence; `aria-describedby` means it is read when the field takes focus and
              whenever the description changes identity.
            */}
            {showCounter ? (
              <FieldHint id={counterId} className={cn("tabular", remaining <= 0 && "text-rose")}>
                {remaining} characters left of {MAX_COMMENT_BODY}
              </FieldHint>
            ) : (
              <span />
            )}
            <Button type="submit" variant="secondary" size="sm" disabled={pending || body.trim().length === 0}>
              <MessageSquare />
              Reply
            </Button>
          </div>
          <FormError message={error} />
        </form>
      )}
    </section>
  );
}

function CommentRow({
  comment,
  canDelete,
  pending,
  onDelete,
}: {
  comment: CommentEntry;
  canDelete: boolean;
  pending: boolean;
  onDelete: (commentId: number) => void;
}) {
  const isPending = comment.id === PENDING_ID;
  const name = comment.author.displayName ?? comment.author.username;

  return (
    <li className={cn("card group/comment p-3", isPending && "opacity-60")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <AvatarWithName
          username={comment.author.username}
          displayName={comment.author.displayName}
          seed={comment.author.avatarSeed}
          isGuest={comment.author.isGuest}
          size="xs"
        >
          {/*
            NO PROFILE LINK ON THE PENDING ROW. The row is not saved yet, so a link out of it
            invites a navigation that discards the write in flight — and the id it would need
            for anything else does not exist.
          */}
          {isPending ? (
            <span className="text-sm text-paper">{name}</span>
          ) : (
            <Link href={`/@${comment.author.username}`} className="text-sm text-paper transition-colors hover:text-amber">
              {name}
            </Link>
          )}
        </AvatarWithName>

        <div className="flex items-center gap-2">
          {isPending ? (
            // "Posting…" rather than a timestamp: an unsaved row has no `created_at`, and
            // "just now" would be a fabricated one.
            <span className="font-mono text-[0.6875rem] tracking-wider text-faint">Posting…</span>
          ) : (
            <time dateTime={comment.createdAt.toISOString()} className="font-mono text-[0.6875rem] tabular text-faint">
              {formatRelative(comment.createdAt)}
            </time>
          )}

          {canDelete ? (
            <span className="opacity-0 transition-opacity group-hover/comment:opacity-100 focus-within:opacity-100">
              {/*
                ONE PRESS, unlike the two-press arm/confirm on a log delete, and the difference
                is what is actually lost. A deleted log destroys a rating, a review, tags, a
                diary date and a replay flag that cannot be reconstructed; a deleted comment
                destroys a sentence the member can retype. Arming every row of a thread would
                also put a live destructive state on a list the reader is scrolling.
                Rejected alternative: the same arm/confirm as DeleteLogButton, for consistency.
              */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => onDelete(comment.id)}
                aria-label={`Delete ${name}'s reply`}
                className="text-faint hover:text-rose"
              >
                <Trash2 />
              </Button>
            </span>
          ) : null}
        </div>
      </div>

      {/* Escaped children, never `dangerouslySetInnerHTML`. There is no markdown in this app. */}
      <p className="mt-2 whitespace-pre-line text-[0.9375rem] leading-relaxed text-muted">{comment.body}</p>
    </li>
  );
}

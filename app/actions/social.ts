"use server";

/**
 * The social layer's four writes: follow, like, comment, un-comment.
 *
 * Nothing here denormalises a counter. Every follower count, like count and comment count in
 * the application is a correlated subquery in the read that renders it (see
 * `lib/db/queries/users.ts` and `lib/db/queries/lists.ts`), so there is no counter for these
 * actions to keep in step and no counter that can drift. The cost is one subquery per rendered
 * row; the benefit is that a failed write cannot leave a visible lie behind.
 *
 * THIS MODULE IS A `"use server"` FILE, WHICH MEANS EVERY EXPORT IS A PUBLIC HTTP ENDPOINT.
 * That is why `assertVisibleTarget`, `containerOwnerId` and `revalidateSocialTarget` are not
 * exported: an exported helper would be callable directly, without the `guard()` that provides
 * the rate limit and the verification gate. An internal helper in one of these files is
 * internal *because* it is unexported, not merely by convention.
 */

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ForbiddenError, requireMember, requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getFollowTarget } from "@/lib/db/queries/users";
import { type SocialTargetType, comments, follows, likes, lists, logs } from "@/lib/db/schema";
import {
  commentBody,
  commentIdSchema,
  listIdSchema,
  logIdSchema,
  socialTargetSchema,
  userIdSchema,
} from "@/lib/security/schemas";

import { GENERIC_FAILURE, type ActionResult, fail, guard, ok } from "./result";

/* ========================================================================== *
 * INPUT SCHEMAS
 * ========================================================================== */

/**
 * The polymorphic social target, as a DISCRIMINATED UNION over the two per-tier id schemas
 * rather than as `{ targetType, targetId: z.int().min(1).max(MAX_DB_INT) }`.
 *
 * The bound would have been a seventh copy of a rule that already exists six times in
 * `lib/security/schemas.ts`, and copies drifting apart is the failure this project has already
 * paid for twice (I-25 / SEC-04: sign-up and sign-in each had their own password schema, and
 * the stricter one created accounts that could not then be signed into). Reusing `logIdSchema`
 * and `listIdSchema` also makes the refusal name the right thing — "Unknown entry." for a log,
 * "Unknown list." for a list — instead of a generic "Unknown target.".
 *
 * The two literals are the same two members as `socialTargetSchema`; `assertVisibleTarget`'s
 * exhaustive `switch` is what makes a third member a compile error rather than a silent
 * fall-through to "existence is enough".
 */
const socialTarget = z.discriminatedUnion("targetType", [
  z.object({ targetType: z.literal("log"), targetId: logIdSchema }),
  z.object({ targetType: z.literal("list"), targetId: listIdSchema }),
]);

const followInput = z.object({ userId: userIdSchema, follow: z.boolean() });

/**
 * `like` and `body` are intersected onto the target rather than repeated in each arm of the
 * union, so the shared field is declared once per action.
 */
const likeInput = socialTarget.and(z.object({ like: z.boolean() }));
const commentInput = socialTarget.and(z.object({ body: commentBody }));
const deleteCommentInput = z.object({ commentId: commentIdSchema });

export type ToggleFollowInput = z.infer<typeof followInput>;
export type ToggleLikeInput = z.infer<typeof likeInput>;
export type AddCommentInput = z.infer<typeof commentInput>;
export type DeleteCommentInput = z.infer<typeof deleteCommentInput>;

/* ========================================================================== *
 * SHARED AUTHORIZATION — INVARIANT I-16, SOURCE FINDING SEC-03
 * ========================================================================== */

/**
 * THE ONE HELPER BOTH `toggleLike` AND `addComment` CALL, AND IT TREATS THE TWO TARGET TYPES
 * ASYMMETRICALLY ON PURPOSE.
 *
 *   log:  EXISTENCE ONLY. Logs have no privacy flag — every log is public the moment it is
 *         written, so "does the row exist" is the whole question.
 *   list: MUST EXIST **AND** BE `isPublic || userId === viewerId`. A list carries a privacy
 *         flag, so existence and visibility are two different questions.
 *
 * "EXISTENCE AND VISIBILITY TREATED AS THE SAME QUESTION" WAS THE ROOT CAUSE OF SEC-03: the
 * original checked only that the row was there, so any member could like — and comment on — a
 * stranger's private list, and the comment then appeared on a surface its author could not
 * read. The fix is not a second check bolted onto each action; it is one helper that both
 * writes must pass through, because the next write into a container will be written by
 * somebody who has not read this paragraph.
 *
 * IF PRIVATE LOGS ARE EVER ADDED, THIS HELPER IS THE SINGLE PLACE THAT MUST LEARN ABOUT IT.
 * The `log` branch below becomes the `list` branch — one row read, one flag, one owner
 * comparison — and every social write inherits the rule with no other edit anywhere. Adding
 * the flag to `logs` without editing this function is the whole of SEC-03 again.
 *
 * IT THROWS RATHER THAN RETURNING A RESULT, and `ForbiddenError` is the class even when the
 * cause is a missing row, because that is precisely the point of I-16: from a writer's side,
 * "it is not there" and "you may not write there" are one refusal. `guard()` converts this
 * class into its own member-visible message, so the string below is what the member reads.
 *
 * NOTE THE SECOND, SMALLER ASYMMETRY: the `list` branch returns ONE message for both "gone"
 * and "private", while `app/actions/lists.ts` deliberately distinguishes them. The difference
 * is who can call. A list mutation is owner-scoped, so its caller either owns the id or learns
 * nothing they could not learn from the public listings; this helper is reachable by any
 * member for any id, so distinguishing the two would make it a private-list existence oracle
 * answerable in bulk.
 */
async function assertVisibleTarget(
  targetType: SocialTargetType,
  targetId: number,
  viewerId: number,
): Promise<void> {
  switch (targetType) {
    case "log": {
      // Projected to the id alone. Widening this select would invite a caller to trust the
      // returned row for a decision that belongs here, which is how the next SEC-03 starts.
      const row = await db.query.logs.findFirst({ where: eq(logs.id, targetId), columns: { id: true } });
      if (!row) throw new ForbiddenError("That entry no longer exists.");
      return;
    }
    case "list": {
      const row = await db.query.lists.findFirst({
        where: eq(lists.id, targetId),
        columns: { userId: true, isPublic: true },
      });
      // The owner is compared against the SESSION id, which is what `viewerId` must always be.
      if (!row || (!row.isPublic && row.userId !== viewerId)) {
        throw new ForbiddenError("That list is not available.");
      }
      return;
    }
    default: {
      /**
       * Exhaustiveness, and it is the enforcement behind the paragraph above. A third member
       * added to `SocialTargetType` stops this file compiling until it is given an explicit
       * visibility rule here, rather than inheriting the `log` branch's "existence is enough"
       * by omission. A `default: return` would have been the silent version of SEC-03.
       */
      const unreachable: never = targetType;
      throw new Error(`unhandled social target type ${String(unreachable)}`);
    }
  }
}

/**
 * The owner of the container a comment sits on — the log's author or the list's owner.
 *
 * Separate from `assertVisibleTarget` because it answers a different question and is needed on
 * a path (`deleteComment`) where visibility is not the issue: a comment on a container you own
 * is yours to remove whether or not the container is public.
 */
async function containerOwnerId(targetType: SocialTargetType, targetId: number): Promise<number | null> {
  if (targetType === "log") {
    const row = await db.query.logs.findFirst({ where: eq(logs.id, targetId), columns: { userId: true } });
    return row?.userId ?? null;
  }

  const row = await db.query.lists.findFirst({ where: eq(lists.id, targetId), columns: { userId: true } });
  return row?.userId ?? null;
}

/**
 * Revalidation for a write into a container, and the two branches take different argument
 * shapes for a real reason.
 *
 * A LOG'S URL IS `/log/17` — the route takes a bare id, so the concrete path is available and
 * exact. A LIST'S URL IS `/list/<slug>-<id>`, and `lists.slug` is regenerated from the title
 * on every update, so the concrete path is not something this action can know; the route
 * pattern with the `"layout"` type argument is the only correct argument. The source ships the
 * opposite mistake in both directions — an interpolated `/show/${id}` that matches no rendered
 * route, and a `/@[username]` pattern that matches nothing because the `@` is part of the
 * segment value — and neither is carried here.
 *
 * `revalidatePath("/")` is also deliberately NOT called, which the source does on every social
 * write. The home page declares `revalidate = 0`, so there is no cache entry to bust: the call
 * would be ceremony that reads as protection.
 */
function revalidateSocialTarget(targetType: SocialTargetType, targetId: number): void {
  if (targetType === "log") {
    revalidatePath(`/log/${targetId}`);
    return;
  }
  revalidatePath("/list/[slug]", "layout");
}

/* ========================================================================== *
 * THE FOLLOW GRAPH
 * ========================================================================== */

/**
 * Follow or unfollow a member. Both directions are idempotent.
 *
 * `insert().onConflictDoNothing()` rather than a read-then-insert, because the composite
 * primary key on `(follower_id, followee_id)` already makes a duplicate edge impossible and a
 * unique index cannot lose a race that a read-then-write can (the same reasoning as
 * `users_username_lower_uq`, I-26). The delete is unconditional for the same reason: removing
 * an edge that is not there is a no-op, not an error, so a double-click on a stale button
 * reports success rather than a mystery.
 *
 * BOTH GAPS THE SOURCE LEAVES OPEN ARE CLOSED HERE, and both need the row rather than the id,
 * which is why `getFollowTarget` exists as a read:
 *
 *   1. THE FOLLOWEE MUST EXIST. Without this check a follow of a deleted member reaches the
 *      database as a foreign-key violation, which `guard()` flattens into "Something went
 *      wrong. Try again." — so the member retries a button that can never work, and the log
 *      line says only that something threw. With it, the refusal names the cause.
 *   2. THE FOLLOWEE MUST NOT BE A GUEST. A guest has no public surface anywhere else in the
 *      application — every public aggregate filters `users.is_guest = false` (I-12) — so a
 *      followable guest would be a member you can subscribe to, whose entries then arrive in
 *      your feed from a profile that does not render.
 *
 * The returned `following` is the state the caller should settle on, so an optimistic toggle
 * has something to reconcile against rather than assuming its own guess held.
 */
export async function toggleFollow(input: ToggleFollowInput): Promise<ActionResult<{ following: boolean }>> {
  return guard("toggleFollow", async () => {
    const user = await requireMember("follow other members");

    const parsed = followInput.safeParse(input);
    // The flat string, never `parsed.error`: validation detail is not leaked to a caller.
    if (!parsed.success) return fail("That member does not exist.");
    const { userId, follow } = parsed.data;

    // BEFORE the existence read, because it costs no query and because the honest refusal for
    // yourself is not "that member does not exist" — you are right there.
    if (userId === user.id) return fail("You cannot follow yourself.");

    const target = await getFollowTarget(userId);
    if (!target) return fail("That member does not exist.");
    if (target.isGuest) return fail("That account is a guest and cannot be followed yet.");

    if (follow) {
      await db.insert(follows).values({ followerId: user.id, followeeId: userId }).onConflictDoNothing();
    } else {
      await db.delete(follows).where(and(eq(follows.followerId, user.id), eq(follows.followeeId, userId)));
    }

    // CONCRETE INTERPOLATED PATHS, not the `/@[username]` pattern the source passes — the `@`
    // belongs to the segment *value*, so the pattern matches no route. Both counters move, so
    // both profiles are revalidated. Interpolating a username into a path argument is safe
    // only because `usernameSchema` is an allowlist of `[a-zA-Z0-9_]`; the day that becomes a
    // denylist, this line becomes a path-injection.
    revalidatePath(`/@${target.username}`, "layout");
    revalidatePath(`/@${user.username}`, "layout");

    return ok({ following: follow });
  });
}

/* ========================================================================== *
 * LIKES
 * ========================================================================== */

/**
 * Heart a review or a list, or take the heart back.
 *
 * THE COMPOSITE PRIMARY KEY `(user_id, target_type, target_id)` IS THE ENTIRE DEDUPE
 * MECHANISM. There is no "have they already liked this" read before the insert, because the
 * index answers it atomically and a read cannot.
 *
 * COUNTS ARE NEVER DENORMALISED. Nothing is incremented here; `listLikeCountSql` and its log
 * equivalent are correlated subqueries in the reads, so the number on the page is always the
 * number of rows in this table.
 *
 * THERE IS NO SELF-LIKE PREVENTION, and that is inherited deliberately: the source has none,
 * an author hearting their own review is a normal gesture on this kind of site, and the
 * alternative needs the container's owner — a second read on the hot path — to forbid
 * something nobody has complained about. If it is ever added, it belongs beside
 * `assertVisibleTarget` rather than inside this action, because `addComment` would want the
 * same rule and a copy is how the two would drift.
 *
 * `requireMember`, so a guest is refused with the conversion offer. Liking is one of exactly
 * three things guests cannot do (follow, like, comment) and all three involve another person,
 * which is the point: the restriction is the reason to sign up.
 */
export async function toggleLike(input: ToggleLikeInput): Promise<ActionResult<{ liked: boolean }>> {
  return guard("toggleLike", async () => {
    const user = await requireMember("like a review or a list");

    const parsed = likeInput.safeParse(input);
    if (!parsed.success) return fail("That is not something you can like.");
    const { targetType, targetId, like } = parsed.data;

    await assertVisibleTarget(targetType, targetId, user.id);

    if (like) {
      await db
        .insert(likes)
        .values({ userId: user.id, targetType, targetId })
        .onConflictDoNothing();
    } else {
      await db
        .delete(likes)
        .where(and(eq(likes.userId, user.id), eq(likes.targetType, targetType), eq(likes.targetId, targetId)));
    }

    revalidateSocialTarget(targetType, targetId);

    return ok({ liked: like });
  });
}

/* ========================================================================== *
 * COMMENTS
 * ========================================================================== */

/**
 * One comment on a log or a list. Flat — `comments` has no `parent_id`, so depth is exactly 1
 * and there is no thread to walk.
 *
 * The body is bounded by `commentBody` from `lib/security/schemas.ts`, which trims, refuses an
 * empty string and caps at `MAX_COMMENT_BODY`. That constant is exported as a number precisely
 * so the textarea's `maxLength` and the character counter read it instead of hard-coding 2000
 * beside a schema that says 2000; do not restate the bound here.
 */
export async function addComment(input: AddCommentInput): Promise<ActionResult<{ commentId: number }>> {
  return guard("addComment", async () => {
    const user = await requireMember("reply to a review");

    const parsed = commentInput.safeParse(input);
    if (!parsed.success) return fail("That comment does not look right.");
    const { targetType, targetId, body } = parsed.data;

    await assertVisibleTarget(targetType, targetId, user.id);

    const [row] = await db
      .insert(comments)
      .values({ userId: user.id, targetType, targetId, body })
      .returning({ id: comments.id });

    // `returning()` on a single-row insert cannot come back empty, but the array type says it
    // can, and a non-null assertion here would be the one place in the file that lies.
    if (!row) return fail(GENERIC_FAILURE);

    revalidateSocialTarget(targetType, targetId);

    return ok({ commentId: row.id });
  });
}

/**
 * Remove a comment — THE AUTHOR'S OWN, OR ANY COMMENT ON A CONTAINER YOU OWN.
 *
 * THIS FIXES A NAMED GATE ASYMMETRY IN THE SOURCE. There, `addComment` calls `requireMember`
 * while `deleteComment` calls `requireUser` and is verification-exempt, and the only ownership
 * test is a comparison the UI never exercises. Two consequences shipped: A GUEST COULD DELETE
 * A COMMENT THEY COULD NEVER HAVE POSTED, and with `REQUIRE_EMAIL_VERIFICATION` on an
 * unverified member could delete but not post.
 *
 * The fix is NOT to raise the gate to `requireMember`. `requireUser` is kept on purpose, and
 * the authorization is what changed:
 *
 *   - A guest CAN own a list (`createList` is `requireUser`), so a guest can legitimately be
 *     the moderator of a container. Refusing guests here would leave a guest's own list with
 *     comments they cannot remove, on a surface that is theirs.
 *   - With the author-or-owner test in place, a guest who never posted has nothing to delete,
 *     which is what the source was trying and failing to express.
 *   - `deleteComment` stays in `VERIFICATION_EXEMPT` for the same reason `deleteLog` does: with
 *     this check, every deletion it permits is self-scoped — your words, or words on your
 *     container — and a self-scoped removal should not be held hostage to slow mail. Nothing
 *     it can now reach publishes.
 *
 * CONTAINER-OWNER MODERATION IS REACHABLE HERE. In the source the same capability exists
 * server-side but the component only renders the trash control when `viewerId === author.id`,
 * so a list owner could never actually use it. The control must render for the container owner
 * too, or this branch is dead code that reads like a feature.
 *
 * Two distinct messages, as in the list mutations: a comment on a public log or list is
 * publicly readable anyway, so "gone" versus "not yours" reveals nothing a reader could not
 * already see.
 */
export async function deleteComment(input: DeleteCommentInput): Promise<ActionResult> {
  return guard("deleteComment", async () => {
    const user = await requireUser();

    const parsed = deleteCommentInput.safeParse(input);
    if (!parsed.success) return fail("That comment no longer exists.");
    const { commentId } = parsed.data;

    const comment = await db.query.comments.findFirst({ where: eq(comments.id, commentId) });
    if (!comment) return fail("That comment no longer exists.");

    /**
     * `comments.target_type` is a `varchar(8)` with no check constraint (there are no enums and
     * no check constraints anywhere in this schema), so the stored value is `string` as far as
     * the type system is concerned. It is narrowed through the SAME enum the write path uses
     * rather than cast, so a row written by some future bug refuses here instead of being
     * silently treated as a log — which would hand its container-owner check to the wrong
     * table and could authorise the wrong person.
     */
    const container = socialTargetSchema.safeParse(comment.targetType);
    if (!container.success) {
      console.error("[deleteComment] comment with an unknown target_type", {
        commentId,
        targetType: comment.targetType,
      });
      return fail(GENERIC_FAILURE);
    }

    // The author short-circuits, so the common case costs no second read. Only a moderation
    // attempt pays for the container lookup.
    if (comment.userId !== user.id) {
      const ownerId = await containerOwnerId(container.data, comment.targetId);
      if (ownerId !== user.id) return fail("That is not your comment.");
    }

    await db.delete(comments).where(eq(comments.id, commentId));

    revalidateSocialTarget(container.data, comment.targetId);

    return ok();
  });
}

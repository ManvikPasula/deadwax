"use server";

/**
 * The whole of a member's editable identity: display name, bio, avatar seed, wantlist privacy.
 *
 * FOUR COLUMNS, AND THE LIST IS THE SECURITY BOUNDARY. What is NOT here matters more than what
 * is:
 *
 *   - `username` IS PERMANENT. There is no rename path anywhere in the application, and that
 *     is a decision rather than an omission. A username is a URL (`/@nadia`), it is compared
 *     case-insensitively through a functional unique index, and it is the handle other members
 *     learned. Renaming would orphan every link, free the old handle for somebody else to
 *     impersonate, and turn `revalidatePath("/@…")` into a call that has to know two names.
 *   - `email` IS NOT EDITABLE HERE. Changing an address has to re-verify it, retire the
 *     outstanding tokens and survive a collision with an existing account (I-27); that is a
 *     flow, not a field, and putting it in this form would let a member move their address
 *     without re-verifying.
 *   - `role` AND `plan` ARE UNREACHABLE. See the comment on the patch below.
 *
 * `import "server-only"` is absent on purpose: `"use server"` already makes this a server
 * module, and the two directives are not additive.
 */

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { avatarSeedSchema, bioSchema, displayNameSchema } from "@/lib/security/schemas";

import { type ActionResult, fail, guard, ok } from "./result";

/**
 * Every field optional, because this action is reached from more than one control: the settings
 * form posts all four, the avatar picker posts one, and the wantlist privacy switch posts one
 * boolean. PATCH SEMANTICS (I-1 / SEC-01) are what make that safe — an absent field leaves its
 * column alone, so the avatar picker cannot blank a bio it never rendered.
 *
 * Note what the schema does NOT accept, which is the first of two layers keeping this action
 * away from `role` and `plan`: `z.object` STRIPS UNKNOWN KEYS, so a caller who posts
 * `{ role: "admin" }` has it removed before any code here can see it. A field absent from the
 * schema cannot be smuggled in by a caller who sends it anyway.
 */
const updateProfileInput = z.object({
  displayName: displayNameSchema.optional(),
  bio: bioSchema.optional(),
  avatarSeed: avatarSeedSchema.optional(),
  wantlistPrivate: z.boolean().optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileInput>;

/**
 * Edit your own profile.
 *
 * GATED BY `requireUser`, NOT `requireMember`, so A GUEST CAN REACH IT. That is deliberate and
 * inherited: a guest is a real `users` row with a real profile page, and onboarding asks them
 * to pick an avatar and a name before they have an account. Guests are refused on exactly
 * three things — follow, like, comment — and all three involve another person. This involves
 * nobody.
 *
 * VERIFICATION-EXEMPT (`VERIFICATION_EXEMPT` in ./result), for the reason that defines that
 * group: this is a self-scoped edit whose effects nobody else can see, and somebody who cannot
 * receive our confirmation mail must still be able to fix their own bio. Nothing here
 * publishes.
 *
 * `requireUser` still re-reads the account row (I-17), which is the point of the rung: a
 * stateless JWT keeps asserting an identity for up to fourteen days after the row behind it is
 * gone, and a write against a deleted account would otherwise succeed against nothing or
 * revalidate a stranger's path.
 */
export async function updateProfile(input: UpdateProfileInput): Promise<ActionResult> {
  return guard("updateProfile", async () => {
    const user = await requireUser();

    const parsed = updateProfileInput.safeParse(input);
    // The flat human string, never `parsed.error` — validation detail is not leaked. The one
    // exception in the application is the admin ad form, because an admin is filling it in.
    if (!parsed.success) return fail("That does not look right.");
    const { displayName, bio, avatarSeed, wantlistPrivate } = parsed.data;

    /**
     * THE PATCH IS WRITTEN OUT FIELD BY FIELD, WITH AN EXPLICIT TYPE, AND IT MUST STAY THAT WAY.
     *
     * This is the second and stronger layer of the `role`/`plan` guarantee. A spread —
     * `.set({ ...parsed.data })` — would compile, would pass every test that exercises the four
     * fields, and would turn any future widening of the schema into an unreviewed write path.
     * Naming the four keys means adding a fifth is an edit somebody has to make on purpose, on
     * a line sitting directly under this paragraph.
     *
     * `tests/no-escalation.test.ts` ASSERTS AT THE SOURCE LEVEL that only
     * `app/actions/admin.ts` and `scripts/grant-admin.ts` may write `role` or `plan`, so a
     * stray `.set({ role: … })` anywhere in this file fails a test rather than shipping
     * quietly. Privilege escalation has to be impossible by construction, not merely
     * unimplemented (I-22).
     *
     * `users` HAS NO `updatedAt` COLUMN, so unlike every other patch in the application this
     * one can legitimately be empty.
     */
    const patch: {
      displayName?: string | null;
      bio?: string | null;
      avatarSeed?: string;
      wantlistPrivate?: boolean;
    } = {};

    // A trimmed-empty display name becomes SQL NULL rather than "", because every surface
    // renders `displayName ?? username` and an empty string is not null — it would render as a
    // nameless member rather than falling back to the handle.
    if (displayName !== undefined) patch.displayName = displayName.length > 0 ? displayName : null;
    if (bio !== undefined) patch.bio = bio.length > 0 ? bio : null;
    // No blank branch: `avatarSeedSchema` has `min(1)` because the seed IS the avatar — it is
    // interpolated into a CSS gradient, so an empty one is a missing image, not a default.
    if (avatarSeed !== undefined) patch.avatarSeed = avatarSeed;
    if (wantlistPrivate !== undefined) patch.wantlistPrivate = wantlistPrivate;

    // Drizzle throws on `.set({})` ("No values to set"), so a form that posted nothing has to
    // return before the update rather than after it. Reported as success because nothing
    // failed: the caller asked for no changes and got none.
    if (Object.keys(patch).length === 0) return ok();

    await db.update(users).set(patch).where(eq(users.id, user.id));

    /**
     * The profile subtree, by interpolated path rather than by route pattern, because the
     * username is in the session — and interpolating it is safe only because
     * `usernameSchema` is an ALLOWLIST of `[a-zA-Z0-9_]`. `"layout"` because the display name
     * and the avatar appear in the header of every tab below `/@name`, and because
     * `wantlistPrivate` decides whether `/@name/wantlist` renders at all.
     *
     * NOT `revalidatePath("/")`: the home page declares `revalidate = 0`, so there is no cache
     * entry to bust.
     *
     * KNOWN LAG, AND IT IS NOT FIXABLE FROM HERE: the header's avatar and name come from the
     * SESSION TOKEN (`SessionUser.avatarSeed`), which is a presentation-only copy minted at
     * sign-in and not re-read per request (I-18). A changed seed therefore reaches every
     * server-rendered surface immediately and the token's copy on the next rotation. Whoever
     * owns the shell should read the header's identity from the row, or the session callback
     * should refresh it, but neither belongs in this action.
     */
    revalidatePath(`/@${user.username}`, "layout");

    return ok();
  });
}

"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { type ActionResult, fail, guard, ok } from "@/app/actions/result";
import { requireAdmin } from "@/lib/auth/admin";
import { issuePasswordReset, passwordResetUrl } from "@/lib/auth/password-reset";
import { db } from "@/lib/db";
import { findAccountForAdmin, recordAction } from "@/lib/db/queries/admin";
import { albums, artists, users } from "@/lib/db/schema";
import { type EmailVia, sendAdminPasswordResetEmail } from "@/lib/email";
import { ensureAlbum } from "@/lib/ingest/albums";
import { TAGS } from "@/lib/providers/deezer/client";
import { albumIdSchema, userIdSchema } from "@/lib/security/schemas";
import { PASSWORD_RESET_TTL_MINUTES } from "@/lib/security/tokens";

/**
 * The operator panel's mutations. Four actions, one shape.
 *
 * EVERY ACTION CALLS `requireAdmin()` AS ITS FIRST STATEMENT INSIDE `guard()`, BEFORE PARSING
 * ANYTHING. A Server Action is a POST endpoint with a generated name, so a forged invocation
 * carrying a valid member session reaches this code — and it must be refused before the input
 * is examined, before a row is read, and before any message that distinguishes "malformed" from
 * "not allowed" can be returned. Parsing first would leak the input contract of the admin panel
 * to any signed-in member willing to guess the action id.
 *
 * THESE ARE IN `VERIFICATION_EXEMPT` (app/actions/result.ts) because the email-verification
 * check would only add a way for an operator to lock themselves out of the panel: an admin's
 * address is verified by the operator who granted the role, `requireAdmin()` is a strictly
 * stronger gate, and `npm run admin:grant` already sets `email_verified_at` for exactly this
 * reason. THEY ARE NOT EXEMPT FROM THE RATE LIMITER, which `guard()` consumes unconditionally —
 * so a bulk moderation script is capped at 120 writes a minute like everything else.
 *
 * NO ACTION HERE WRITES `users.role`. There is no member-facing path to that column anywhere in
 * the codebase, and `tests/no-escalation.test.ts` asserts it at the source level. Privilege
 * escalation has to be impossible by construction rather than merely unimplemented, which is
 * why granting is a CLI (`scripts/grant-admin.ts`) and not a button.
 */

/* -------------------------------------------------------------------------- */
/* The shared account target, and the staleness rule                          */
/* -------------------------------------------------------------------------- */

/**
 * THE `expectedUsername` STALENESS CHECK — the shape all three account actions share.
 *
 * Echoed back from the row the admin was looking at, and compared against the database before
 * acting, so a stale table or a swapped id cannot delete the wrong account. THE ID ALONE IS NOT
 * ENOUGH: an operator reading a list that was rendered four minutes ago, on a page whose search
 * has since been re-run, is pointing at a position on a screen and not at a row.
 *
 * IT IS NOT `usernameSchema`, AND THAT IS DELIBERATE RATHER THAN AN OVERSIGHT. `usernameSchema`
 * in lib/security/schemas.ts is the rule for CREATING a username — three characters minimum, an
 * allowlist, the reserved-name and `guest_` refusals. This field is an ECHO of a value that is
 * already in the database, including the `guest_…` names those refinements exist to forbid, so
 * validating it with the creation rule would make every guest account undeletable. `min(1)`
 * and `max(32)` — the column width — is the whole rule: the comparison against the row is what
 * actually decides anything.
 */
const accountTarget = z.object({
  userId: userIdSchema,
  expectedUsername: z.string().min(1).max(32),
});

/**
 * A parse failure says nothing. Deliberately uninformative, and the opposite of the rule in
 * app/actions/ads.ts, which surfaces the Zod message — because that is a form an admin is
 * filling in, and these three take values the interface generated. Nobody legitimate ever sees
 * this string, so it has no work to do beyond refusing.
 */
const MALFORMED = "That request does not look right.";

/**
 * TWO DISTINCT MESSAGES, because they mean two different things to the person reading them.
 * "Gone" is finished business; "changed" is an instruction to reload and look again. Collapsing
 * them into one would make an operator retry an action that can never succeed.
 */
const ACCOUNT_MISSING = "That account no longer exists.";
const ACCOUNT_CHANGED = "That account has changed since the list was loaded. Reload and try again.";

/**
 * THE COMPARISON IS CASE-SENSITIVE, and that matters here specifically.
 *
 * Usernames are stored case-preserving behind FUNCTIONAL unique indexes on `lower(username)`
 * (I-26), so `Bob` and `bob` cannot both exist — but the row holds whichever one was typed at
 * sign-up. A case-insensitive comparison would therefore accept an echo that does not match the
 * row it came from, which is precisely the class of mismatch this check exists to catch. If the
 * echoed value differs from the column in any way at all, the admin was not looking at this row.
 */
function usernameMatches(row: { username: string }, expected: string): boolean {
  return row.username === expected;
}

/* -------------------------------------------------------------------------- */
/* setAccountPlan                                                             */
/* -------------------------------------------------------------------------- */

/** free | pro. There is no billing; the plan is operator-set. */
const planSchema = z.enum(["free", "pro"]);
export type AccountPlan = z.infer<typeof planSchema>;

/**
 * THE ONLY WRITER OF `users.plan` ANYWHERE IN THE CODEBASE.
 *
 * The plan buys one thing — no house ads — and that exemption is read from this column on every
 * serve and never from the session token (I-18), because a plan is exactly the kind of thing a
 * client would like to assert about itself. Together those two facts mean an operator toggling
 * this row is the entire monetisation mechanism, and there is nothing else to keep in sync.
 *
 * AN IDEMPOTENT NO-OP AT THE CURRENT VALUE WRITES NO AUDIT ROW. The log records state CHANGES,
 * not attempts: three clicks on "make pro" for somebody who is already pro should leave one
 * entry in the history, or the history stops being a list of what happened and becomes a list
 * of what was pressed. It still returns success, because from the operator's point of view the
 * account is in the state they asked for.
 *
 * `planUpdatedAt` USES SERVER-SIDE `now()` rather than `new Date()`. The audit row's own
 * `created_at` defaults to the database clock, and two timestamps written in one transaction
 * that disagree by a serverless instance's clock skew are worse than no timestamp at all.
 */
export async function setAccountPlan(input: {
  userId: number;
  expectedUsername: string;
  plan: string;
}): Promise<ActionResult<{ plan: AccountPlan }>> {
  return guard("setAccountPlan", async () => {
    const admin = await requireAdmin();

    const parsed = accountTarget.extend({ plan: planSchema }).safeParse(input);
    if (!parsed.success) return fail(MALFORMED);
    const { userId, expectedUsername, plan } = parsed.data;

    const account = await findAccountForAdmin(userId);
    if (!account) return fail(ACCOUNT_MISSING);
    if (!usernameMatches(account, expectedUsername)) return fail(ACCOUNT_CHANGED);

    // The no-op. Before the transaction, so nothing is opened and nothing is logged.
    if (account.plan === plan) return ok({ plan });

    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ plan, planUpdatedAt: sql`now()` })
        .where(eq(users.id, account.id));

      await recordAction(tx, {
        actor: admin,
        action: "plan.set",
        targetId: account.id,
        targetUsername: account.username,
        detail: `${account.plan} -> ${plan}`,
      });
    });

    /**
     * A GRADED CONSOLE SIDE CHANNEL, IN ADDITION TO THE DATABASE ROW. `info` for a plan change,
     * `warn` for a deletion below — so an operator scanning hosted logs sees the destructive
     * one without a filter.
     *
     * THESE LINES CONTAIN USERNAMES AND ARE NOT COVERED BY `safeErrorDetail`'s scrubbing. That
     * is a deliberate, narrow exception: hosted logs are readable by anyone with project
     * access, and a username is already public on every page the member has touched. No email
     * address, no id-to-address mapping and no plan history goes here.
     */
    console.info("[admin:plan]", { actor: admin.username, target: account.username, plan });

    revalidatePath("/admin");
    return ok({ plan });
  });
}

/* -------------------------------------------------------------------------- */
/* deleteAccount                                                              */
/* -------------------------------------------------------------------------- */

/**
 * THE CHECKS RUN IN A STRICT ORDER AND THE ORDER IS THE DESIGN.
 *
 *  1. SELF-DELETE, REFUSED BEFORE THE DATABASE IS READ. Deleting yourself would remove the only
 *     way back into this panel — the grant mechanism is a CLI with database credentials, so an
 *     operator who deleted their own account would need shell access to recover. Refusing
 *     before the read means the refusal cannot depend on anything that might have changed.
 *  2. EXISTENCE, so the message is "gone" rather than "changed".
 *  3. THE USERNAME ECHO, so a stale list cannot delete the wrong row.
 *  4. `role === "admin"`, REFUSED. Another admin has to be demoted first — deliberate friction,
 *     so one compromised admin session cannot remove the others. And since demotion needs
 *     database credentials, DELETING AN ADMIN IS A TWO-KEY OPERATION: the panel can do it only
 *     after somebody with shell access has agreed to it.
 *
 * Then ONE TRANSACTION, AUDIT ROW FIRST.
 *
 * The ordering inside the transaction is not cosmetic. `admin_audit_log.actor_id` and
 * `target_id` are plain integers with NO foreign keys, precisely so a record outlives the row it
 * is about — and writing the audit row before the delete keeps that independence from being
 * accidental. If somebody later adds `references(() => users.id)` to `target_id`, this insert
 * fails loudly at review time instead of silently cascading away the record of every deletion
 * ever performed.
 *
 * The cascade itself is declared in the schema: logs, log_tags, wantlist, favorites,
 * desert_island, follows (both directions), lists, list_items, likes, comments and the two
 * token tables all go with the row. The confirmation copy in the panel enumerates them,
 * because "delete account" and "delete four thousand diary entries" are the same button.
 */
export async function deleteAccount(input: {
  userId: number;
  expectedUsername: string;
}): Promise<ActionResult> {
  return guard("deleteAccount", async () => {
    const admin = await requireAdmin();

    const parsed = accountTarget.safeParse(input);
    if (!parsed.success) return fail(MALFORMED);
    const { userId, expectedUsername } = parsed.data;

    // 1. Before the read, and it is the only check that can be.
    if (userId === admin.id) {
      return fail("You cannot delete your own account from here. Deleting yourself would remove the only way back into this panel.");
    }

    const account = await findAccountForAdmin(userId);
    if (!account) return fail(ACCOUNT_MISSING);
    if (!usernameMatches(account, expectedUsername)) return fail(ACCOUNT_CHANGED);

    if (account.role === "admin") {
      return fail("That account is an administrator. Another admin has to be demoted first — run the grant script with --revoke.");
    }

    await db.transaction(async (tx) => {
      await recordAction(tx, {
        actor: admin,
        action: "account.delete",
        targetId: account.id,
        targetUsername: account.username,
        detail: account.isGuest ? "guest account" : "member account",
      });

      await tx.delete(users).where(eq(users.id, account.id));
    });

    console.warn("[admin:delete]", { actor: admin.username, target: account.username });

    revalidatePath("/admin");
    // The members directory lists accounts and is the one public surface a deletion changes
    // visibly. Everything else — profiles, feeds, aggregates — is a dynamic render.
    revalidatePath("/members");
    return ok();
  });
}

/* -------------------------------------------------------------------------- */
/* sendAccountPasswordReset                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Sends the member a reset link. THREE STATED PROPERTIES, and each one is a refusal to build
 * something that would have been easier.
 *
 *  1. THE ADDRESS IS READ FROM THE DATABASE. It is never a parameter, so THIS CANNOT BE TURNED
 *     INTO A RELAY: there is no input in which an attacker with an admin session — or a bug —
 *     could name a recipient, so the endpoint can only ever mail an existing member.
 *  2. THE RESET DOES NOT CHANGE THE PASSWORD. It issues a single-use link to the member's own
 *     mailbox. An admin using this therefore cannot take over an account without also holding
 *     that mailbox, which is why there is no "set a new password for this member" button
 *     anywhere in the panel and why adding one would be a much larger decision than it looks.
 *  3. IT IS AUDITED BEFORE THE MAIL IS ATTEMPTED, so a failed send still leaves a record. The
 *     effect here is an email, and an email has no transaction — so the audit row is committed
 *     on its own, first. The rejected alternative (audit after a successful send) loses the
 *     record in exactly the case where somebody later needs it: the reset that did not arrive.
 *
 * ONE CLICK, NO ARM/CONFIRM. Sending a reset does not change the password, so one click is the
 * right amount of friction; the arm-and-confirm dance belongs on `deleteAccount`.
 *
 * IT REPORTS `delivered` AND `via` HONESTLY. With no provider key configured the link is
 * written to the server log instead, and an admin telling somebody "check your email" needs to
 * know that it will not arrive. `lib/email` returns `delivered: true` for `via: "log"` as well
 * — that flag means "the transport did its job", not "it is in their inbox" — so the panel
 * shows the transport, not a receipt.
 *
 * GUESTS ARE REFUSED, which is a DEADWAX ADDITION rather than a port. A guest's address is
 * `guest_…@guest.invalid`, on an RFC 2606 reserved TLD that can never receive mail, and the
 * guest has no password to reset in the first place. The source would happily "send" it and
 * report success. This is the same shipped defect `assertEmailVerified` guards against at the
 * other end — the banner that asked guests to confirm an unconfirmable address — and the fix
 * belongs in the same place: the action, not the button.
 */
export async function sendAccountPasswordReset(input: {
  userId: number;
  expectedUsername: string;
}): Promise<ActionResult<{ delivered: boolean; via: EmailVia }>> {
  return guard("sendAccountPasswordReset", async () => {
    const admin = await requireAdmin();

    const parsed = accountTarget.safeParse(input);
    if (!parsed.success) return fail(MALFORMED);
    const { userId, expectedUsername } = parsed.data;

    const account = await findAccountForAdmin(userId);
    if (!account) return fail(ACCOUNT_MISSING);
    if (!usernameMatches(account, expectedUsername)) return fail(ACCOUNT_CHANGED);

    if (account.isGuest) {
      return fail("That is a guest account. It has no password and no address that can receive mail.");
    }

    // The record first. See property 3 above.
    await db.transaction(async (tx) => {
      await recordAction(tx, {
        actor: admin,
        action: "account.password_reset",
        targetId: account.id,
        targetUsername: account.username,
        detail: "reset link requested by an administrator",
      });
    });

    /**
     * Issued after the audit row and before the mail. `issuePasswordReset` retires every
     * outstanding token for this account in the same transaction as the insert (I-27), so a
     * second click invalidates the first link rather than leaving two live ones in a mailbox.
     *
     * THE MAIL GOES TO `issued.email`, NOT TO `account.email`, AND THE DIFFERENCE IS THE WHOLE
     * OF PROPERTY 1. It takes an id and reads the address off the row inside its own
     * transaction, so the address the token is BOUND to is the address that receives it. The
     * two values will normally be the same string — `account.email` also came from the row —
     * but "normally" is not a property: a change of address committed between the two reads
     * would otherwise produce a link that `redeemPasswordReset` refuses on its mismatch check,
     * and the member would be told nothing except that their reset does not work.
     *
     * The URL comes from `passwordResetUrl` rather than being assembled here, so this action
     * and the member's own reset request cannot send links to two different routes.
     */
    const issued = await issuePasswordReset(account.id);

    const result = await sendAdminPasswordResetEmail({
      to: issued.email,
      username: account.username,
      url: passwordResetUrl(issued.token),
      ttlMinutes: PASSWORD_RESET_TTL_MINUTES,
    });

    console.info("[admin:reset]", { actor: admin.username, target: account.username, via: result.via });

    revalidatePath("/admin");
    return ok({ delivered: result.delivered, via: result.via });
  });
}

/* -------------------------------------------------------------------------- */
/* resyncAlbum                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Forces a record back through the ingest path. NEW IN DEADWAX, AND IT EXISTS FOR A STRUCTURAL
 * REASON RATHER THAN AN OPERATIONAL ONE.
 *
 * The source declares a tag namespace and then never calls `revalidateTag` from anywhere, so
 * TTL expiry is its only invalidation: a provider that corrected a tracklist, a cover or a
 * release date is invisible for up to thirty days — which is the deliberate TTL on album detail,
 * because a released tracklist is immutable, and is exactly wrong when it turns out not to have
 * been. THIS ACTION IS WHAT MAKES `TAGS` LIVE. Without a caller, the tags are documentation.
 *
 * THREE STEPS, IN THIS ORDER:
 *
 *  1. `revalidateTag` on the album tag AND the artist tag. Both, because `ensureAlbum` reads
 *     the album detail and the artist stub, and a refreshed album hanging off a stale artist is
 *     half a resync.
 *  2. Clear the mirror's freshness stamps. `synced_at` is NOT NULL, so it is set to the EPOCH
 *     SENTINEL — which is not a trick: `isStale()` in lib/ingest/albums.ts tests for
 *     `getTime() === 0` explicitly, because every album-summary mapper already writes it to
 *     mean "mirrored but never filled". `tracks_synced_at` and `mb_synced_at` are nullable and
 *     are cleared outright, so the tracklist comes from the dedicated endpoint again and
 *     MusicBrainz enrichment re-runs instead of being skipped by its own 30-day stamp.
 *  3. Re-run `ensureAlbum`.
 *
 * KNOW WHAT STEP 3 ACTUALLY GUARANTEES, because the honest answer is "less than it looks".
 * `revalidateTag` queues the purge onto the request's work store and it is applied when the
 * action returns — so the `ensureAlbum` call below still sees the cached provider payload. The
 * immediate run therefore repairs the MIRROR and every derived column from whatever the HTTP
 * cache holds; the NEXT view, finding an expired tag and an epoch `synced_at`, is the one
 * guaranteed to come from the provider. Both steps are needed, and that is why this is not
 * simply "call revalidateTag and let the page do the rest".
 *
 * `ensureAlbum` RUNS OUTSIDE THE TRANSACTION, and must. It is a non-transactional multi-step
 * write path that makes several provider HTTP requests (album detail, tracklist, two
 * MusicBrainz calls), and holding a transaction open across a network round trip on a
 * five-connection pool is how a resync takes the whole application down.
 */
export async function resyncAlbum(input: { albumId: number }): Promise<ActionResult<{ title: string }>> {
  return guard("resyncAlbum", async () => {
    const admin = await requireAdmin();

    const parsed = z.object({ albumId: albumIdSchema }).safeParse(input);
    if (!parsed.success) return fail(MALFORMED);

    const rows = await db
      .select({
        id: albums.id,
        title: albums.title,
        deezerId: albums.deezerId,
        artistId: artists.id,
        artistName: artists.name,
        artistDeezerId: artists.deezerId,
      })
      .from(albums)
      .innerJoin(artists, eq(artists.id, albums.artistId))
      .where(eq(albums.id, parsed.data.albumId))
      .limit(1);

    const album = rows[0];
    if (!album) return fail("That record is not in the catalogue.");

    // 1. The tag namespace, used. The second argument is required in Next 16 — the one-argument
    //    form is deprecated, and `updateTag` is its immediate-expiration sibling, which behaves
    //    identically here because both defer the purge to the end of the action.
    revalidateTag(TAGS.album(album.deezerId), "max");
    revalidateTag(TAGS.artist(album.artistDeezerId), "max");

    // 2. The freshness stamps and the audit row, together, so a resync that is recorded is a
    //    resync whose mirror was actually invalidated.
    await db.transaction(async (tx) => {
      await tx
        .update(albums)
        .set({ synced_at: sql`to_timestamp(0)`, tracksSyncedAt: null, mbSyncedAt: null })
        .where(eq(albums.id, album.id));

      await recordAction(tx, {
        actor: admin,
        action: "album.resync",
        targetId: album.id,
        // Not a username. The column is a `varchar(32)` and an album title is `varchar(300)`,
        // so the identity goes in `detail` and this stays null rather than being silently
        // truncated to something unrecognisable.
        targetUsername: null,
        detail: `${album.artistName} — ${album.title}`,
      });
    });

    // 3. Best-effort immediate refresh. Its own failure path already swallows provider errors
    //    and serves the mirror, so there is nothing to catch here.
    await ensureAlbum(album.deezerId);

    console.info("[admin:resync]", { actor: admin.username, albumId: album.id, deezerId: album.deezerId });

    // `"layout"` is required for a dynamic route segment; without it the call warns and has no
    // effect, which is the quietest possible way for an invalidation to do nothing.
    revalidatePath("/album/[slug]", "layout");
    revalidatePath("/artist/[slug]", "layout");
    revalidatePath("/admin");
    return ok({ title: album.title });
  });
}

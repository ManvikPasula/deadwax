"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { type ActionResult, fail, guard, ok } from "@/app/actions/result";
import { genreKey } from "@/lib/ads/plan";
import { requireAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { recordAction } from "@/lib/db/queries/admin";
import { ads } from "@/lib/db/schema";
import { MAX_DB_INT } from "@/lib/slug";

/**
 * The house-ad authoring actions: create, switch on and off, reweight, archive.
 *
 * Same three properties as app/actions/admin.ts — `requireAdmin()` as the first statement
 * inside `guard()`, before any parsing; `VERIFICATION_EXEMPT` but still rate limited; no writer
 * of `users.role` or `users.plan` anywhere in the file — plus one difference, stated here
 * because it is the only place in the application where it is true:
 *
 * THIS FILE SURFACES THE ZOD MESSAGE RATHER THAN A FLAT REFUSAL, BECAUSE IT IS A FORM AN ADMIN
 * IS FILLING IN. Everywhere else a parse failure means a forged or stale call and the answer is
 * the deliberately uninformative "That request does not look right." — telling a caller which
 * field they got wrong is telling them the input contract. Here the caller is an operator typing
 * a headline into a textarea, and "That body is too long. The limit is 240 characters." is the
 * difference between a usable panel and one that refuses without saying why. Nothing in these
 * messages describes anything a member could not see on the finished card.
 *
 * `recordAction(tx, ...)` IS THE SAME TRANSACTIONAL HELPER app/actions/admin.ts USES, and that
 * is a deliberate fix rather than a coincidence. The source brief has a separate,
 * non-transactional local `audit()` in its ads actions that runs AFTER the mutation with null
 * target fields — so a status change that committed and then failed to log left no trace, and
 * the rows it did write could not say which ad they were about. One helper, inside the
 * transaction that applies the effect, with the ad id in `targetId`.
 */

/* -------------------------------------------------------------------------- */
/* The form                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * EVERY BOUND BELOW IS A COLUMN WIDTH, so an insert cannot fail on length. Same rule as
 * lib/security/schemas.ts: a bound with no reason next to it is a bound somebody will change.
 *
 *   headline      varchar(120)
 *   body          varchar(240)
 *   cta_label     varchar(40)
 *   creator_name  varchar(120)
 *   label         varchar(120)
 *   project_kind  varchar(12)   -- 'mixtape' is the longest legal value, at 7
 *   weight        smallint      -- 1..100 by convention, not by constraint
 */
const headlineSchema = z
  .string()
  .trim()
  .min(1, "Give the ad a headline.")
  .max(120, "That headline is too long. The limit is 120 characters.");

const bodySchema = z
  .string()
  .trim()
  .min(1, "Write a line of copy.")
  .max(240, "That body is too long. The limit is 240 characters.");

const ctaSchema = z
  .string()
  .trim()
  .min(1, "The button needs a label.")
  .max(40, "That button label is too long. The limit is 40 characters.");

/**
 * `ads.target_url` is `text`, so this bound is a product decision rather than a column width:
 * 2,000 characters is inside every browser's practical URL limit, and anything longer is a
 * tracking payload rather than a link.
 *
 * THE SCHEME ALLOWLIST IS THE SAME RULE `clickTarget` RE-TESTS ON THE WAY OUT, and having it in
 * both places is the point: this one stops an operator pasting a `javascript:` or `data:` URL
 * into the form, and that one stops such a value becoming a redirect if it ever reaches the
 * column by some other route — a migration, a psql session, a future import. Neither check
 * makes the other redundant, because they defend different entry points.
 */
const targetUrlSchema = z
  .string()
  .trim()
  .min(1, "Where should the button go?")
  .max(2_000, "That link is too long.")
  .regex(/^https?:\/\//i, "Links have to start with http:// or https://");

/**
 * Normalised with `genreKey` — THE SAME FUNCTION `adScore` USES AT MATCH TIME. The affinity
 * comparison lowercases both sides, so normalising here changes no behaviour today; it is here
 * so the stored value is the value that gets compared, and so a future operator reading the row
 * in psql sees what the matcher sees. Importing the function rather than writing
 * `.toLowerCase()` is what keeps that true if the normalisation ever gains a rule.
 *
 * Eight keys is generous. The vocabulary the match runs against is Deezer's coarse set of 28
 * names, so an ad tagged with eight of them is claiming to be a third of all music and the
 * doubling stops meaning anything.
 */
const genresSchema = z
  .array(z.string().trim().max(40, "That genre name is too long.").transform(genreKey))
  .max(8, "At most 8 genres.")
  .transform((values) => [...new Set(values.filter((value) => value.length > 0))]);

const weightSchema = z
  .int()
  .min(1, "Weight is between 1 and 100.")
  .max(100, "Weight is between 1 and 100.");

const adIdSchema = z.int().min(1, "Unknown ad.").max(MAX_DB_INT, "Unknown ad.");

/**
 * A schedule bound, or nothing.
 *
 * THE TIMEZONE HAZARD IS REAL AND IS WRITTEN DOWN RATHER THAN GUARDED. A `datetime-local` input
 * yields `"2026-01-31T18:00"` with no zone, and `Date.parse` resolves a bare local form in the
 * SERVER's zone — UTC on Vercel, something else on a developer's laptop. The panel therefore
 * submits `toISOString()`, and this schema accepts the naive form too rather than refusing an
 * operator's paste; the cost is a window that can be off by the developer's UTC offset in local
 * development only. Rejecting anything without an explicit offset was the alternative, and it
 * trades a local-only inaccuracy for a form that refuses the value the browser's own date
 * picker produces.
 *
 * The empty string is mapped to `undefined` before parsing, because a cleared form field is an
 * empty string and `undefined` is what "leave this column NULL" means (I-1).
 */
const scheduleSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .union([z.string().trim().max(40), z.date()])
    .refine((value) => !Number.isNaN(new Date(value).getTime()), "That is not a date and time.")
    .transform((value) => new Date(value))
    .optional(),
);

/**
 * NOTE WHAT IS NOT IN THIS SCHEMA: `status`, `impressions`, `clicks`, `created_by`.
 *
 * `z.object` strips unknown keys, so a caller that posts `status: "active"` has it discarded
 * rather than honoured — which is what makes the hardcoded `"draft"` in `createAd` a guarantee
 * and not a default. The counters and the author are server-side facts.
 */
const createAdSchema = z
  .object({
    kind: z.enum(["general", "indie"]),
    slot: z.enum(["feed", "sidebar", "any"]),
    headline: headlineSchema,
    body: bodySchema,
    ctaLabel: ctaSchema,
    targetUrl: targetUrlSchema,
    creatorName: z.string().trim().max(120, "That name is too long.").optional(),
    projectKind: z.enum(["single", "ep", "lp", "mixtape"]).optional(),
    label: z.string().trim().max(120, "That label name is too long.").optional(),
    genres: genresSchema.optional(),
    weight: weightSchema.optional(),
    startsAt: scheduleSchema,
    endsAt: scheduleSchema,
  })
  /**
   * AN INDIE PLACEMENT WITHOUT A CREDIT IS JUST AN AD WITH A BLUE BORDER.
   *
   * The indie spotlight is a third of all impressions given away on the promise that it is used
   * to name somebody. An indie row with no `creator_name` renders the same card as a general
   * one while drawing from the reserved pool, which is the reservation being spent on nothing —
   * and it is invisible, because the card looks fine.
   */
  .refine((value) => value.kind !== "indie" || (value.creatorName ?? "").length > 0, {
    message: "An indie placement needs a credit — the artist or label being spotlighted.",
    path: ["creatorName"],
  })
  /**
   * A zero-length or reversed window can never serve, because eligibility is half-open
   * (`starts_at <= now < ends_at`). Refusing it here is the difference between an operator
   * being told and an operator watching an active ad report zero impressions for a week.
   */
  .refine((value) => !value.startsAt || !value.endsAt || value.endsAt > value.startsAt, {
    message: "The end has to be after the start, or the ad can never run.",
    path: ["endsAt"],
  });

export type CreateAdInput = z.input<typeof createAdSchema>;

/** The one place a Zod message reaches a member-visible string. See the module docblock. */
function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That request does not look right.";
}

const AD_MISSING = "That ad no longer exists.";

/** Every mutation here changes what /admin/ads shows and what /spotlight can render. */
function revalidateAdSurfaces(): void {
  revalidatePath("/admin/ads");
  // /spotlight is the one route whose entire body is ad inventory. Everything else serves ads
  // from an uncached read on a dynamic render, so nothing else needs invalidating.
  revalidatePath("/spotlight");
}

/* -------------------------------------------------------------------------- */
/* createAd                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Creates an ad. `status: "draft"` IS HARDCODED.
 *
 * Nothing goes live by being created. An operator writes the copy, reads the card, and then
 * switches it on with `setAdStatus` — which is what makes "draft" a real state rather than a
 * label, and what makes a half-written headline impossible to ship by pressing Save. The status
 * field is not in the schema at all, so a caller who sends one has it stripped.
 */
export async function createAd(input: CreateAdInput): Promise<ActionResult<{ adId: number }>> {
  return guard("createAd", async () => {
    const admin = await requireAdmin();

    const parsed = createAdSchema.safeParse(input);
    if (!parsed.success) return fail(firstIssue(parsed.error));
    const form = parsed.data;

    const adId = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(ads)
        .values({
          kind: form.kind,
          slot: form.slot,
          status: "draft",
          headline: form.headline,
          body: form.body,
          ctaLabel: form.ctaLabel,
          targetUrl: form.targetUrl,
          // `?? null` rather than leaving it undefined: these are nullable columns and an
          // omitted optional field means "leave it NULL", which is what null says explicitly.
          creatorName: form.creatorName ?? null,
          projectKind: form.projectKind ?? null,
          label: form.label ?? null,
          genres: form.genres ?? [],
          weight: form.weight ?? 1,
          startsAt: form.startsAt ?? null,
          endsAt: form.endsAt ?? null,
          createdBy: admin.id,
        })
        .returning({ id: ads.id });

      // Cannot happen for a single-row INSERT ... RETURNING, and throwing rather than writing
      // an audit row with a null target is the right failure: the transaction rolls back and
      // `guard()` reports it, instead of leaving a record of an ad that does not exist.
      if (!inserted) throw new Error("ad insert returned no row");

      await recordAction(tx, {
        actor: admin,
        action: "ad.create",
        targetId: inserted.id,
        targetUsername: null,
        detail: `${form.kind}: ${form.headline}`,
      });

      return inserted.id;
    });

    revalidateAdSurfaces();
    return ok({ adId });
  });
}

/* -------------------------------------------------------------------------- */
/* setAdStatus                                                                */
/* -------------------------------------------------------------------------- */

/**
 * draft | active | paused. `archived` IS NOT REACHABLE FROM HERE — `archiveAd` owns it.
 *
 * Two reasons. Archiving is one-way, so it deserves its own confirmation and its own audit
 * verb rather than hiding inside a dropdown next to "pause"; and keeping it out of this enum
 * means no client payload can reach the terminal state through the ordinary status control.
 */
const settableStatusSchema = z.enum(["draft", "active", "paused"]);

export async function setAdStatus(input: { adId: number; status: string }): Promise<ActionResult> {
  return guard("setAdStatus", async () => {
    const admin = await requireAdmin();

    const parsed = z.object({ adId: adIdSchema, status: settableStatusSchema }).safeParse(input);
    if (!parsed.success) return fail(firstIssue(parsed.error));
    const { adId, status } = parsed.data;

    const rows = await db
      .select({ id: ads.id, status: ads.status, kind: ads.kind, creatorName: ads.creatorName, headline: ads.headline })
      .from(ads)
      .where(eq(ads.id, adId))
      .limit(1);

    const ad = rows[0];
    if (!ad) return fail(AD_MISSING);

    // ARCHIVED IS TERMINAL. Reviving a campaign would silently resume counting against the
    // per-day rows that were declared final when it was archived, so the honest answer is a
    // new row.
    if (ad.status === "archived") {
      return fail("That ad is archived. Archiving is final — create a new ad instead.");
    }

    // The idempotent no-op, before the transaction. No audit row: the log records state
    // CHANGES, not clicks.
    if (ad.status === status) return ok();

    /**
     * THE CREDIT RULE IS RE-CHECKED AT ACTIVATION, not only at creation.
     *
     * `createAd` refuses an indie row with no `creator_name`, but rows predating that rule, or
     * written by a seed or a migration, are not covered by it — and activation is the moment
     * the reservation actually starts being spent. Refusing here means the invariant holds for
     * every ad that has ever served, not only for every ad that was created through the form.
     */
    if (status === "active" && ad.kind === "indie" && !ad.creatorName) {
      return fail("That indie placement has no credit. Add the artist or label before activating it.");
    }

    await db.transaction(async (tx) => {
      await tx.update(ads).set({ status, updatedAt: sql`now()` }).where(eq(ads.id, ad.id));

      await recordAction(tx, {
        actor: admin,
        action: "ad.status",
        targetId: ad.id,
        targetUsername: null,
        detail: `${ad.status} -> ${status}: ${ad.headline}`,
      });
    });

    revalidateAdSurfaces();
    return ok();
  });
}

/* -------------------------------------------------------------------------- */
/* setAdWeight                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 1..100, and the range is a convention rather than a constraint — `ads.weight` is a plain
 * `smallint` (the schema has no check constraints by design), so this action is the only thing
 * enforcing it.
 *
 * The number is relative, not a percentage: an ad at 40 beside one at 20 is drawn twice as
 * often in `pickAd`'s cumulative walk, and a genre match doubles whatever is stored. The panel
 * says so in prose, because an operator who reads it as "40% of impressions" will set three
 * ads to 40 and then report the system as broken.
 */
export async function setAdWeight(input: { adId: number; weight: number }): Promise<ActionResult> {
  return guard("setAdWeight", async () => {
    const admin = await requireAdmin();

    const parsed = z.object({ adId: adIdSchema, weight: weightSchema }).safeParse(input);
    if (!parsed.success) return fail(firstIssue(parsed.error));
    const { adId, weight } = parsed.data;

    const rows = await db
      .select({ id: ads.id, weight: ads.weight, status: ads.status, headline: ads.headline })
      .from(ads)
      .where(eq(ads.id, adId))
      .limit(1);

    const ad = rows[0];
    if (!ad) return fail(AD_MISSING);
    if (ad.status === "archived") {
      return fail("That ad is archived. Its numbers are final, so its weight no longer does anything.");
    }
    if (ad.weight === weight) return ok();

    await db.transaction(async (tx) => {
      await tx.update(ads).set({ weight, updatedAt: sql`now()` }).where(eq(ads.id, ad.id));

      await recordAction(tx, {
        actor: admin,
        action: "ad.weight",
        targetId: ad.id,
        targetUsername: null,
        detail: `${ad.weight} -> ${weight}: ${ad.headline}`,
      });
    });

    revalidateAdSurfaces();
    return ok();
  });
}

/* -------------------------------------------------------------------------- */
/* archiveAd                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * ARCHIVE, NEVER DELETE. There is no `deleteAd` in this file and there should never be one.
 *
 * `ad_stats.ad_id` cascades on delete, so removing the row would take its entire per-day curve
 * with it. THE PER-DAY COUNTERS ARE THE RECORD OF WHAT RAN — so an advertiser asking "what did
 * we get" a month later would be told, truthfully as far as the database knows, that nothing
 * ever ran at all. That is not a data-loss inconvenience; it is the system lying about work it
 * performed.
 *
 * Archiving is also what makes `recordAdEvent` a no-op for the row: the `status <> 'archived'`
 * predicate lives inside its UPDATE, and because the stats INSERT selects from that CTE, an
 * archived ad increments nothing at all. So the curve is frozen rather than merely stopped.
 *
 * Already-archived is an idempotent success with no audit row, the same rule as everywhere
 * else here.
 */
export async function archiveAd(input: { adId: number }): Promise<ActionResult> {
  return guard("archiveAd", async () => {
    const admin = await requireAdmin();

    const parsed = z.object({ adId: adIdSchema }).safeParse(input);
    if (!parsed.success) return fail(firstIssue(parsed.error));

    const rows = await db
      .select({ id: ads.id, status: ads.status, headline: ads.headline, impressions: ads.impressions, clicks: ads.clicks })
      .from(ads)
      .where(eq(ads.id, parsed.data.adId))
      .limit(1);

    const ad = rows[0];
    if (!ad) return fail(AD_MISSING);
    if (ad.status === "archived") return ok();

    await db.transaction(async (tx) => {
      await tx.update(ads).set({ status: "archived", updatedAt: sql`now()` }).where(eq(ads.id, ad.id));

      await recordAction(tx, {
        actor: admin,
        action: "ad.archive",
        targetId: ad.id,
        targetUsername: null,
        // The final numbers go in the audit row, so the log alone answers "what did this
        // campaign do" even if somebody later runs the delete this action exists to avoid.
        detail: `${ad.impressions} impressions, ${ad.clicks} clicks: ${ad.headline}`,
      });
    });

    console.info("[admin:ad-archive]", { actor: admin.username, adId: ad.id });

    revalidateAdSurfaces();
    return ok();
  });
}

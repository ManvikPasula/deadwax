import "server-only";

import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { getRatedAlbumsForTaste } from "@/lib/db/queries/albums";
import { ads, users } from "@/lib/db/schema";
import { buildTasteProfile } from "@/lib/taste/profile";

import {
  type AdCandidate,
  type AdPlacement,
  type PlannedAd,
  MAX_ADS_PER_PAGE,
  genreKey,
  planPage,
} from "./plan";

/**
 * House ads — the serving layer: eligibility, the Pro exemption, the page seed and affinity.
 *
 * The split from `lib/ads/plan.ts` is the layering doctrine applied to a subsystem that would
 * otherwise be untestable: everything that reads a clock, a session or a table is here, and
 * everything with a rule worth proving is next door and pure.
 *
 * FREQUENCY CAPPING IS FOUR STRUCTURAL MECHANISMS AND NOT A COOKIE:
 *
 *   1. the hard per-page ceiling of two (`MAX_ADS_PER_PAGE`);
 *   2. no repeat within a page (`planPage`'s `placed` set);
 *   3. hourly seed rotation (`pageSeed`);
 *   4. per-page keying, so a member moving between records is not shown the same unit every
 *      time (`AD_PAGE_KEY`).
 *
 * There is no per-member impression cap and no counter in browser storage, and the reason is
 * stated rather than hidden: THE COUNTERS ARE REPORTING, NOT BILLING. Nobody is invoiced from
 * `ad_stats`, so the worst outcome of a loose cap is a slightly generous number in a report —
 * and a cookie that tracked how many ads a person had seen would be the first piece of
 * cross-page behavioural state in the product, which is a much larger thing to own than an
 * imprecise impression figure.
 *
 * NOTE ON SELF-GATING: `lib/db/queries/ads.ts` refuses every admin read without
 * `requireAdmin()` (I-20). The candidate query in THIS file deliberately does not, because it
 * serves signed-out visitors — which is exactly why it lives here and not there, and why its
 * projection carries no counters, no status and no `created_by`.
 */

/**
 * How many eligible rows the planner may consider.
 *
 * Fifty is not a performance guess: two slots draw from this pool, so anything past the first
 * few dozen rows changes a weighted walk by less than the weights themselves do, and the cap
 * is what stops one enthusiastic seeding run from turning every page render into a scan of
 * thousands of rows that are then thrown away. If an operator ever runs more than fifty
 * simultaneous campaigns, the honest fix is scheduling (`starts_at` / `ends_at`), not a bigger
 * number here.
 */
const CANDIDATE_LIMIT = 50;

/**
 * The affinity gate. Fewer than five rated albums and the bonus is skipped entirely.
 *
 * Five rather than the source's three because the affinity is computed over `albums.genres`,
 * which is Deezer's COARSE vocabulary of 28 names — so three records can easily produce one
 * genre with a single supporting rating and a large lean, and the doubling would then be
 * driven by an accident. Below the gate nothing is lost: the member simply gets an unweighted
 * draw, which is what a signed-out visitor gets too.
 */
const MIN_RATED_FOR_AFFINITY = 5;

/** Top five genre keys. The profile's affinity list is already sorted descending by lean. */
const AFFINITY_KEYS = 5;

/** One hour, in milliseconds. The seed's rotation period. */
const SEED_BUCKET_MS = 3_600_000;

/**
 * The page keys, declared once.
 *
 * Same shape and same reason as `TAGS` in lib/providers/deezer/client.ts: the key is part of
 * the seed, so a page that spells it `"album-12"` on one route and `"album:12"` on another has
 * silently created two rotations for one surface. A member navigating between them would see
 * the shelf reshuffle, which is the one thing the deterministic seed exists to prevent.
 */
export const AD_PAGE_KEY = {
  home: "home",
  feed: "feed",
  spotlight: "spotlight",
  album: (albumId: number | string) => `album:${albumId}`,
  artist: (artistId: number | string) => `artist:${artistId}`,
  member: (username: string) => `member:${username}`,
} as const;

export { MAX_ADS_PER_PAGE };
export type { AdCandidate, AdPlacement, PlannedAd };

/**
 * THE PRO EXEMPTION, READ FROM THE `users` TABLE ON EVERY SERVE AND NEVER FROM THE SESSION
 * TOKEN (I-18).
 *
 * A plan is exactly the kind of thing a client would like to assert about itself, and
 * `SessionUser` has no `plan` field for that reason. Putting it in the JWT would save this one
 * indexed lookup and would mean a member downgraded — or a forged token — kept an ad-free site
 * for up to fourteen days.
 *
 * SIGNED-OUT VISITORS SEE ADS, and so do guests: a guest is a `users` row with the default
 * `plan = 'free'`, so no special case is needed and none should be added.
 *
 * A MISSING ROW RETURNS TRUE. `undefined !== "pro"` is the honest answer for a token whose
 * account has been deleted: the safe default for an authorization question is "no privilege",
 * and the privilege here is the exemption.
 */
export async function adsEnabledFor(viewerId: number | null | undefined): Promise<boolean> {
  if (!viewerId) return true;

  const account = await db.query.users.findFirst({
    where: eq(users.id, viewerId),
    columns: { plan: true },
  });

  return account?.plan !== "pro";
}

/**
 * `"<who>:<which page>:<hour bucket>"`.
 *
 * Three components, each doing a job:
 *   - WHO. The viewer id, or the literal "anon" — two visitors do not see the same rotation,
 *     so no single ad dominates the surface for everybody at once.
 *   - WHICH PAGE. So a member moving between records is not shown the same unit every time.
 *   - AN HOUR BUCKET. Stable across reloads within the hour, rotating hourly.
 *
 * THE HOUR BUCKET IS THE THIRD CAPPING MECHANISM AND THE ONE THAT IS EASY TO BREAK. Replacing
 * `Math.floor(Date.now() / 3_600_000)` with `Date.now()` reshuffles the page on every request,
 * which destroys both properties this seed exists for: a member scrolling back up finds a
 * different advertiser in the slot they just passed, and the impression count becomes a count
 * of reloads.
 *
 * `now` is a parameter so the rotation can be tested without waiting an hour. It is never
 * passed in production.
 */
export function pageSeed(
  viewerId: number | null | undefined,
  pageKey: string,
  now: number = Date.now(),
): string {
  const hour = Math.floor(now / SEED_BUCKET_MS);
  return `${viewerId ?? "anon"}:${pageKey}:${hour}`;
}

/**
 * THE ELIGIBILITY WINDOW IS HALF-OPEN: `starts_at <= now < ends_at`.
 *
 * Closed at the start and open at the end, so an ad scheduled to end at midnight is gone at
 * midnight rather than serving one last impression for the whole final second. `>=` on the end
 * would also make `starts_at === ends_at` — a fat-fingered zero-length campaign — serve
 * forever at that instant, which is a strange thing to be possible.
 *
 * A NULL bound means "unbounded", which is why both halves are `IS NULL OR ...`: the columns
 * are nullable and an ad with no schedule is the common case. `or()` is drizzle's, not a raw
 * fragment, so the operator precedence is parenthesised for us — the hand-written version of
 * this predicate is precisely the I-13 defect, where `A AND B OR C` bound tighter than
 * intended and made every guest findable.
 *
 * Only `status = 'active'` loads. Draft, paused and archived rows are never candidates, which
 * is what makes "paused" a real control rather than a label.
 */
export async function fetchAdCandidates(
  placement: AdPlacement,
  now: Date = new Date(),
): Promise<AdCandidate[]> {
  const rows = await db
    .select({
      id: ads.id,
      kind: ads.kind,
      slot: ads.slot,
      headline: ads.headline,
      body: ads.body,
      ctaLabel: ads.ctaLabel,
      creatorName: ads.creatorName,
      projectKind: ads.projectKind,
      label: ads.label,
      genres: ads.genres,
      weight: ads.weight,
    })
    .from(ads)
    .where(
      and(
        eq(ads.status, "active"),
        or(isNull(ads.startsAt), lte(ads.startsAt, now)),
        or(isNull(ads.endsAt), gt(ads.endsAt, now)),
      ),
    )
    // Ascending by id, matching the sort `pickAd` applies anyway. Both exist: this one keeps
    // the LIMIT deterministic (which fifty rows), and that one keeps the walk deterministic
    // (which row the cursor lands on) even if this clause is ever dropped.
    .orderBy(asc(ads.id))
    .limit(CANDIDATE_LIMIT);

  // The placement filter is applied in `pickAd` rather than in SQL, because `ads.slot = 'any'`
  // rows are eligible everywhere and one pool serves both placements on a page that has both.
  return rows.map(toCandidate);
}

/**
 * ROW -> CANDIDATE, DEFENSIVELY.
 *
 * `ads.kind` and `ads.slot` are `varchar` with no check constraint (the schema has no enums by
 * design), so the honest type of what comes back is `string`. Anything unrecognised DEGRADES
 * rather than throwing: an ad row written by a future migration, a hand-edited value, a typo
 * from a psql session, none of those should be able to take down every page that renders a
 * shelf.
 *
 * THE DIRECTION OF EACH DEFAULT IS CHOSEN, NOT INCIDENTAL:
 *   - an unrecognised KIND becomes 'general', so a mystery value cannot claim a slice of the
 *     indie reservation that was promised to an independent artist;
 *   - an unrecognised SLOT becomes 'any', which is the column default and the more permissive
 *     answer. The failure mode is an ad appearing in both placements rather than in neither,
 *     and an operator who created a row plainly wanted it to run.
 *
 * `genres` is re-checked because the column is `jsonb`: the `$type<string[]>()` annotation is a
 * compile-time assertion about a value Postgres will hand back as whatever is stored, and a
 * non-array there would make `.some()` throw inside a render.
 */
function toCandidate(row: {
  id: number;
  kind: string;
  slot: string;
  headline: string;
  body: string;
  ctaLabel: string;
  creatorName: string | null;
  projectKind: string | null;
  label: string | null;
  genres: string[] | null;
  weight: number;
}): AdCandidate {
  return {
    id: row.id,
    kind: row.kind === "indie" ? "indie" : "general",
    slot: row.slot === "feed" ? "feed" : row.slot === "sidebar" ? "sidebar" : "any",
    headline: row.headline,
    body: row.body,
    ctaLabel: row.ctaLabel,
    creatorName: row.creatorName,
    projectKind: row.projectKind,
    label: row.label,
    genres: Array.isArray(row.genres) ? row.genres.filter((genre) => typeof genre === "string") : [],
    weight: row.weight,
  };
}

/**
 * The member's top genre keys, or an empty array.
 *
 * AFFINITY REUSES THE TASTE MODEL RATHER THAN BUILDING A SECOND BEHAVIOURAL PROFILE: the
 * affinity that decides which EP to show somebody is the same affinity that decides what to
 * recommend them. A parallel profile would be a second thing to keep correct, a second thing
 * to explain in the privacy note, and — worse — a second definition of "what this member
 * likes" that could disagree with the one on /for-you.
 *
 * THREE RULES, EACH WITH A REASON:
 *   - at least `MIN_RATED_FOR_AFFINITY` rated albums, or there is no signal to weight with;
 *   - POSITIVE LEAN ONLY. A negative lean says "they dislike this", and there is no
 *     corresponding halving: the score has a bonus and no penalty, so feeding a negative key
 *     in would double the weight of exactly the ads the member is least interested in. The
 *     profile's affinity list is sorted descending by lean, so filtering then slicing takes
 *     the top five that are actually positive rather than the top five of anything;
 *   - the whole thing is wrapped, and THE FAILURE MODE IS AN ABSENT BONUS, NEVER A FAILED
 *     PAGE. This is the heaviest read on the serving path and it is decorative: it changes
 *     which house ad appears. A recommender change, a migration mid-deploy or a slow query
 *     must not be able to 500 the home page over it.
 */
export async function genreAffinityKeys(viewerId: number | null | undefined): Promise<string[]> {
  if (!viewerId) return [];

  try {
    const rated = await getRatedAlbumsForTaste(viewerId);
    if (rated.length < MIN_RATED_FOR_AFFINITY) return [];

    const profile = buildTasteProfile(rated);

    return profile.genres
      .filter((entry) => entry.lean > 0)
      .slice(0, AFFINITY_KEYS)
      .map((entry) => genreKey(entry.key))
      .filter((key) => key.length > 0);
  } catch (error) {
    // Logged, not surfaced. `console.warn` rather than `console.error` because nothing is
    // broken for the member: they got an unweighted draw.
    console.warn("[ads] affinity unavailable, serving without the genre bonus —", error instanceof Error ? error.message : error);
    return [];
  }
}

export type ServeAdsOptions = {
  /** From the SESSION, never from a route parameter or a form field. */
  viewerId: number | null | undefined;
  /** One of `AD_PAGE_KEY`. Part of the seed. */
  pageKey: string;
  placement: AdPlacement;
  /** How many units this surface has room for. Clamped to `MAX_ADS_PER_PAGE`. */
  slotCount: number;
};

/**
 * The one entry point a page calls.
 *
 * THE ORDER OF THE FOUR STEPS IS THE DESIGN:
 *
 *  1. An empty surface returns before any query. A layout that asks for zero units costs
 *     nothing.
 *  2. THE PRO EXEMPTION IS ENFORCED AT THE POINT OF FETCH, so for a Pro member NO CANDIDATE
 *     QUERY RUNS AT ALL. Not a rendered slot hidden with CSS, not a filtered array — the ad
 *     inventory is never read, never reaches the RSC payload, and never appears in the
 *     network tab of somebody who paid not to see it. "Hide it in the component" would leave
 *     every headline in the page source.
 *  3. An empty shelf returns before the affinity read. There is no point computing a
 *     weighting bonus for a pool of zero, and this is the common case on a new deployment.
 *  4. Affinity, then the pure planner.
 */
export async function serveAds(options: ServeAdsOptions): Promise<PlannedAd[]> {
  const { viewerId, pageKey, placement } = options;
  const slotCount = Math.min(Math.max(0, Math.floor(options.slotCount) || 0), MAX_ADS_PER_PAGE);
  if (slotCount === 0) return [];

  if (!(await adsEnabledFor(viewerId))) return [];

  const candidates = await fetchAdCandidates(placement);
  if (candidates.length === 0) return [];

  const genreKeys = await genreAffinityKeys(viewerId);

  return planPage({
    candidates,
    seed: pageSeed(viewerId, pageKey),
    slotCount,
    placement,
    genreKeys,
  });
}

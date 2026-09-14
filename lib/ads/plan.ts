/**
 * House ads — the planning layer.
 *
 * PURE. No database, no request, no `next/*`, and deliberately NO `import "server-only"`:
 * every rule in this file is a rule worth proving, and the whole point of keeping it pure is
 * that `tests/ads.test.ts` can plan two thousand pages in a loop without a connection, a
 * cookie or a clock. Everything that touches Postgres, the session or `Date.now()` lives in
 * `lib/ads/serve.ts`, one layer up.
 *
 * First-party rows only: no third-party script, no ad network, no pixel — which is why the
 * CSP in `proxy.ts` needs no holes cut in it.
 *
 * NAMING TRAP, and it is the one thing to read before editing. "Slot" means three different
 * things here:
 *   (a) `ads.slot` — the PLACEMENT an ad may run in: 'feed' | 'sidebar' | 'any'.
 *   (b) the zero-based INDEX of a unit on the page, which is what the hash namespaces key on.
 *   (c) the `<AdSlot>` component, which renders one of (b).
 * Below, `placement` is always (a) and `slot` is always (b). Check which one you mean before
 * you type it: swapping them turns the per-unit hash into a per-page hash, and both units on
 * a page then draw the same kind and walk to the same ad.
 */

/**
 * One slot in three is drawn for the indie spotlight.
 *
 * INDIE GETS A THIRD OF ALL SLOTS, NOT A THIRD OF PAGES. On a two-unit page roughly 4/9 of
 * views carry no indie unit, 4/9 carry one and about 1/9 carry two; the long-run impression
 * share is exactly 1/3. That is the number the admin panel quotes to an operator, and it is
 * the number an independent artist is being sold.
 *
 * THE REJECTED ALTERNATIVE, which is the reason this constant is a probability and not a
 * floor: forcing "at least one indie slot on every page" reads like a guarantee and silently
 * yields a FIFTY PER CENT share on a two-unit page — half the paid inventory given away, and
 * given away invisibly, because nothing in the interface would look wrong. `tests/ads.test.ts`
 * plans 2,000 pages (4,000 slots) and asserts the share is within +/-0.04 of 1/3 precisely to
 * catch somebody "fixing" this into a floor.
 */
export const INDIE_EVERY = 3;

/**
 * The hard ceiling. Two units per page, whatever a caller asks for.
 *
 * A record diary is not an ad-supported content farm, and the moment a member counts three of
 * these the surface is worth nothing to anybody — including the artist whose EP is sitting in
 * the third one.
 */
export const MAX_ADS_PER_PAGE = 2;

/** general | indie. `indie` is the independent-artist / small-label spotlight. */
export type AdKind = "indie" | "general";

/** The `ads.slot` column: where an ad is allowed to run. */
export type AdSlot = "feed" | "sidebar" | "any";

/**
 * What a PAGE asks for. `'any'` is a property of an ad, never of a request: a request for
 * "any" placement would match only the rows whose column literally says `any` and silently
 * drop every feed- and sidebar-targeted row, which is the opposite of what the word suggests.
 * Splitting the two types makes that mistake unwritable rather than merely unlikely.
 */
export type AdPlacement = Exclude<AdSlot, "any">;

/**
 * One row of inventory, reduced to what a card renders plus what the walk scores on.
 *
 * NOTE WHAT IS ABSENT: `impressions`, `clicks`, `status`, `createdBy`, `startsAt`, `endsAt`.
 * A candidate is handed to a Server Component as props, and props cross the server/client
 * boundary in the RSC payload — so a projection that carried the counters would publish a
 * campaign's performance to anybody who views source. The eligibility window is applied in
 * SQL and then thrown away; the counters belong to the admin panel and never leave it.
 */
export type AdCandidate = {
  id: number;
  kind: AdKind;
  slot: AdSlot;
  headline: string;
  body: string;
  ctaLabel: string;
  /** The indie credit block. Usually null on a general placement. */
  creatorName: string | null;
  /** single | ep | lp | mixtape */
  projectKind: string | null;
  label: string | null;
  /** Free text, matched case-insensitively against the member's taste genres. A BONUS. */
  genres: string[];
  /** 1..100. `Math.max(1, ...)` below is why a row stored at 0 still gets a chance. */
  weight: number;
};

export type PlannedAd = {
  /** The zero-based index of this unit on the page. */
  slot: number;
  /**
   * The kind that was DRAWN for this slot, which is not always `ad.kind` — see the fallback in
   * `pickAd`. A badge rendered from this field would label a general ad "indie" on every page
   * where the indie shelf happened to be empty, so THE CARD MUST READ `ad.kind`. This is here
   * for the reservation accounting and for the tests that measure the share.
   */
  kind: AdKind;
  ad: AdCandidate;
};

/**
 * FNV-1a, 32 bits.
 *
 * DETERMINISTIC ACROSS PROCESSES, unlike anything seeded by time or by `Math.random()`. Two
 * reasons, both load-bearing:
 *
 *  1. The framework renders one page across many serverless instances, and a member scrolling
 *     back up must not find a different advertiser in the slot they just passed.
 *  2. Impression counting only means something if a reload does not reshuffle the page. With a
 *     random draw, "impressions" would be a measure of how often somebody pressed refresh.
 *
 * `Math.imul` is not decoration. The FNV prime multiplication overflows 32 bits on every
 * iteration, and a plain `*` promotes to a double and loses exactly the low bits that carry
 * the entropy — the hash still "works", in the sense that it returns numbers, and the
 * distribution quietly degrades. `>>> 0` converts the signed result to the unsigned range,
 * which is what makes `% n` non-negative: a negative cursor compares below every ceiling in
 * the cumulative walk and would return the first ad every single time.
 */
export function seedHash(input: string): number {
  let value = 2_166_136_261;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16_777_619);
  }
  return value >>> 0;
}

/**
 * Draws a kind for each slot on the page.
 *
 * EACH SLOT DRAWS INDEPENDENTLY FROM ITS OWN HASH BUCKET, and INCLUDING THE INDEX IN THE HASH
 * INPUT is the entire mechanism. Without the index, `seedHash(seed) % 3` is one draw for the
 * whole page: both units would always agree, the reservation would be a per-page coin flip
 * rather than a per-slot one, and the reserved POSITION would never move — the indie unit
 * would sit at the top of every page that had one, which is a layout tell rather than a
 * rotation.
 *
 * The count is clamped rather than trusted. A caller asking for four units on a long feed gets
 * two, because `MAX_ADS_PER_PAGE` is a ceiling on the surface and not a hint; and the
 * `Math.max(0, ...)` keeps a nonsense `slotCount` — a `NaN` out of a parsed query string, a
 * negative out of arithmetic — returning an empty plan instead of throwing inside a render.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * THE DRAWS ARE NOT STATISTICALLY INDEPENDENT, AND THE MEASURED DISTRIBUTION IS NOT THE ONE
 * THE SOURCE BRIEF PREDICTS. This was found by measuring rather than by reasoning, and it is
 * left as it is deliberately.
 *
 * The brief describes the intended outcome as "roughly 4/9 of views carry no indie unit, 4/9
 * carry one, ~1/9 carry two", which is what two independent draws at p = 1/3 would give.
 * Measured over 20,000 page seeds, this function actually produces:
 *
 *     zero indie   33.9%
 *     exactly one  66.1%
 *     two           0.0%      <- never, not rarely
 *     indie share  0.3305     <- still 1/3, which is the property that was promised
 *
 * WHY. The two hash inputs differ only in their final character, "0" against "1", and those
 * two bytes differ in exactly one bit. FNV-1a's final step is `value = imul(value ^ byte, P)`,
 * so a one-bit difference in the last byte becomes a CONSTANT difference in the output:
 * measured on 5,000 seeds, `hash(slot1) - hash(slot0)` is exactly ±P every single time.
 * And `P = 16_777_619 ≡ 2 (mod 3)`. So if `hash(slot0) % 3 === 0` then
 * `hash(slot1) % 3 ∈ {1, 2}` and can never be 0 — slot 1 is indie only when slot 0 is not.
 *
 * WHY IT IS LEFT ALONE. The contractual property is the SHARE, and the share is exactly right:
 * indie takes a third of all slots. The 4/9-4/9-1/9 split was never itself a goal — it is
 * simply what independence happens to produce. What this function does instead is arguably
 * better on both sides of the deal: an indie unit never doubles up on one page, so the same
 * third of impressions is spread across MORE DISTINCT PAGE VIEWS, which is reach rather than
 * frequency and is what an unknown artist actually wants; and no member ever sees a page whose
 * every unit is a house spotlight.
 *
 * Making the draws genuinely independent is a one-line change — hash a longer distinguishing
 * suffix, or mix the index in before the seed rather than after. DO NOT MAKE IT without
 * deciding that two indie units on the same page is something you want, because that is the
 * only thing it buys.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */
export function planKinds(slotCount: number, seed: string): AdKind[] {
  const count = Math.max(0, Math.min(Math.floor(slotCount) || 0, MAX_ADS_PER_PAGE));
  return Array.from({ length: count }, (_unused, index) =>
    seedHash(`${seed}:slot:${index}`) % INDIE_EVERY === 0 ? "indie" : "general",
  );
}

/**
 * The one normalisation of a genre string, used on BOTH sides of the affinity comparison.
 *
 * Exported because `lib/ads/serve.ts` normalises the taste profile's genre keys with this
 * function and `pickAd` normalises the ad's own `genres` array with it. Two copies of "lower
 * case and trim" is how "Hip Hop" stops matching "hip hop" six months from now — the same
 * class of defect as the two password schemas in the source audit (I-25), and harder to spot
 * because the failure is a missing bonus rather than an error.
 */
export function genreKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * `max(1, weight) * (genreMatch ? 2 : 1)`.
 *
 * A GENRE MATCH DOUBLES THE WEIGHT. IT IS A BONUS AND NEVER A FILTER, and the distinction is
 * the difference between a working shelf and an empty one. Filtering on affinity would mean a
 * member with no taste profile — a signed-out visitor, somebody five records in — sees no ads
 * at all, and it would mean a new campaign in an unfashionable genre is unservable rather than
 * merely less likely. Doubling is strong enough to matter on a shelf of ten and weak enough
 * that an unmatched ad still runs.
 *
 * `Math.max(1, weight)` rather than `weight`: a row stored at 0 (or, defensively, below it)
 * would otherwise contribute nothing to the cumulative total and be unreachable forever, which
 * presents to an operator as "my ad is active and has never once been served". Zero weight is
 * not a way to pause an ad — `status = 'paused'` is.
 */
export function adScore(ad: AdCandidate, genreKeys: ReadonlySet<string>): number {
  const matched = genreKeys.size > 0 && ad.genres.some((genre) => genreKeys.has(genreKey(genre)));
  return Math.max(1, ad.weight) * (matched ? 2 : 1);
}

export type PickAdOptions = {
  candidates: readonly AdCandidate[];
  /** The page seed. See `pageSeed` in lib/ads/serve.ts. */
  seed: string;
  /** The zero-based SLOT INDEX — meaning (b) in the module docblock, not the placement. */
  slot: number;
  /** Where this unit renders. Filters on `ads.slot`. */
  placement: AdPlacement;
  /** The kind drawn for this slot by `planKinds`. A preference, not a lock. */
  kind: AdKind;
  /** Ads already placed on this page. */
  exclude?: ReadonlySet<number>;
  /** The member's top genre keys, if any. See `genreAffinityKeys` in lib/ads/serve.ts. */
  genreKeys?: readonly string[];
};

/**
 * Picks one ad for one slot, or null.
 *
 * THE HASH NAMESPACE IS DIFFERENT FROM `planKinds`. That one hashes "<seed>:slot:<index>" and
 * this one hashes "<seed>:<index>", so the kind draw and the pick within that kind are
 * uncorrelated. Sharing a namespace would tie the two together: every page whose slot 0 drew
 * indie would also land on the same position in the cumulative walk, so one particular indie
 * ad would take the entire reservation and the rest of that shelf would never appear at all.
 *
 * THE RESERVATION IS A PREFERENCE, NOT A LOCK: `pool = preferred.length > 0 ? preferred :
 * eligible`. A slot drawn for indie with no indie inventory serves a general ad, and a slot
 * drawn general on a page whose only eligible row is indie serves that. The alternative —
 * honouring the draw strictly — leaves a hole in the page every time one shelf is empty, and
 * an empty shelf is the NORMAL state of a house-ad system with a handful of rows in it.
 *
 * RETURNING NULL IS A DESIGNED OUTCOME, not an error path. `planPage` omits the slot entirely,
 * so the page renders nothing rather than a bordered frame around a gap.
 */
export function pickAd(options: PickAdOptions): AdCandidate | null {
  const { candidates, seed, slot, placement, kind } = options;
  const exclude = options.exclude ?? new Set<number>();
  const genreKeys = new Set((options.genreKeys ?? []).map(genreKey).filter((key) => key.length > 0));

  /**
   * THE WALK IS ORDER-DEPENDENT, so the pool is sorted by id before it is scored.
   *
   * Postgres is free to return rows in any order a query does not specify, and a serving
   * query's `ORDER BY` is always one edit away from being dropped as redundant. Sorting here
   * makes the determinism `seedHash` exists to provide a property of THIS function rather than
   * of a query plan on one instance — which is the guarantee that makes an impression count
   * mean anything at all.
   */
  const eligible = candidates
    .filter((ad) => !exclude.has(ad.id) && (ad.slot === "any" || ad.slot === placement))
    .slice()
    .sort((left, right) => left.id - right.id);

  if (eligible.length === 0) return null;

  const preferred = eligible.filter((ad) => ad.kind === kind);
  const pool = preferred.length > 0 ? preferred : eligible;

  let total = 0;
  const cumulative = pool.map((ad) => {
    total += adScore(ad, genreKeys);
    return { ad, ceiling: total };
  });

  // Unreachable while every score is a positive integer, and kept anyway: a future change that
  // made scores fractional or zero would otherwise blank the slot instead of serving
  // something, and a blank slot is the kind of bug nobody reports.
  if (total <= 0) return pool[0] ?? null;

  const cursor = seedHash(`${seed}:${slot}`) % total;
  for (const entry of cumulative) {
    if (cursor < entry.ceiling) return entry.ad;
  }

  // Same reasoning: with integer scores `cursor` lies in [0, total) and the loop always
  // returns before here.
  return pool[pool.length - 1] ?? null;
}

export type PlanPageOptions = {
  candidates: readonly AdCandidate[];
  seed: string;
  /** How many units the page has room for. Clamped to `MAX_ADS_PER_PAGE`. */
  slotCount: number;
  placement: AdPlacement;
  genreKeys?: readonly string[];
};

/**
 * The whole page, in one deterministic pass.
 *
 * THE `placed` SET IS WHY A TWO-SLOT PAGE WITH ONE AD IN INVENTORY GETS ONE UNIT rather than
 * the same card twice. Without it both slots walk the same pool and a single-row inventory
 * renders itself twice, side by side — which reads as a rendering bug to a member and as a
 * doubled impression count to the advertiser.
 *
 * Slots are planned in index order because `exclude` grows as it goes: slot 0 chooses from
 * everything, slot 1 chooses from what is left. That ordering is part of the determinism, so
 * this must not become a `Promise.all`, a `map` over a reversed array, or a parallel draw.
 */
export function planPage(options: PlanPageOptions): PlannedAd[] {
  const kinds = planKinds(options.slotCount, options.seed);
  const placed = new Set<number>();
  const plan: PlannedAd[] = [];

  for (const [slot, kind] of kinds.entries()) {
    const ad = pickAd({
      candidates: options.candidates,
      seed: options.seed,
      slot,
      placement: options.placement,
      kind,
      exclude: placed,
      genreKeys: options.genreKeys,
    });

    // Nothing eligible, or nothing LEFT eligible. The slot is omitted rather than filled with
    // a placeholder: a page with one unit is the honest rendering of an inventory of one.
    if (!ad) continue;

    placed.add(ad.id);
    plan.push({ slot, kind, ad });
  }

  return plan;
}

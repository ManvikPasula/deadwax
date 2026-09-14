import { describe, expect, it } from "vitest";

import {
  INDIE_EVERY,
  MAX_ADS_PER_PAGE,
  type AdCandidate,
  adScore,
  genreKey,
  pickAd,
  planKinds,
  planPage,
  seedHash,
} from "@/lib/ads/plan";

/**
 * The house-ad planner. PURE, so it is testable at the only scale that actually proves
 * anything about a probabilistic reservation: thousands of pages.
 */

function candidate(overrides: Partial<AdCandidate> & { id: number }): AdCandidate {
  return {
    kind: "general",
    slot: "any",
    headline: `Headline ${overrides.id}`,
    body: "A line of copy.",
    ctaLabel: "Listen",
    targetUrl: `https://example.com/${overrides.id}`,
    creatorName: null,
    projectKind: null,
    label: null,
    genres: [],
    weight: 1,
    ...overrides,
  } as AdCandidate;
}

describe("seedHash", () => {
  it("is deterministic across calls, unlike anything seeded by time", () => {
    // That matters because the framework renders across many serverless instances, AND because
    // impression counting only means something if a reload does not reshuffle the page.
    expect(seedHash("abc")).toBe(seedHash("abc"));
    expect(seedHash("abc")).not.toBe(seedHash("abd"));
  });

  it("returns an unsigned 32-bit integer", () => {
    for (const input of ["", "a", "a longer string with spaces", "🎵"]) {
      const value = seedHash(input);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("planKinds", () => {
  it("never plans more units than the per-page ceiling", () => {
    // "A record diary is not an ad-supported content farm, and the moment a member counts three
    // of these the surface is worth nothing to anybody — including the artist whose EP is
    // sitting in the third one."
    expect(planKinds(99, "seed").length).toBe(MAX_ADS_PER_PAGE);
    expect(planKinds(1, "seed").length).toBe(1);
    expect(planKinds(0, "seed").length).toBe(0);
  });

  it("draws slot 0 and slot 1 independently, because the INDEX is in the hash input", () => {
    /**
     * If the index were not hashed in, both slots would draw the same kind from the same page
     * seed — so a page would carry either two indie units or none, and the RESERVED POSITION
     * would never vary between pages.
     */
    let differed = 0;
    for (let page = 0; page < 200; page += 1) {
      const kinds = planKinds(2, `member:page:${page}`);
      if (kinds[0] !== kinds[1]) differed += 1;
    }
    expect(differed).toBeGreaterThan(20);
  });

  it("is stable for one seed and rotates with it", () => {
    expect(planKinds(2, "same")).toEqual(planKinds(2, "same"));
  });
});

describe("the one-third indie reservation", () => {
  /**
   * THE ASSERTION THIS FILE EXISTS FOR, and the bug it exists to catch is named below.
   *
   * Indie gets a third of all SLOTS, not a third of PAGES, and not one guaranteed unit per
   * page. On a two-unit page roughly 4/9 of views carry no indie unit, 4/9 carry one and ~1/9
   * carry two; the long-run impression share is exactly 1/3.
   *
   * THE REJECTED ALTERNATIVE: forcing "at least one indie slot on every page" READS LIKE A
   * FLOOR AND SILENTLY YIELDS A 50% SHARE on a two-unit page — half the paid inventory given
   * away. That version would pass any test that merely checked "indie appears sometimes", which
   * is why this one measures the share over 2,000 pages instead.
   */
  it("gives indie a third of all SLOTS, within ±0.04 over 2,000 pages", () => {
    const pages = 2_000;
    let indie = 0;
    let slots = 0;

    for (let page = 0; page < pages; page += 1) {
      for (const kind of planKinds(MAX_ADS_PER_PAGE, `viewer:home:${page}`)) {
        slots += 1;
        if (kind === "indie") indie += 1;
      }
    }

    expect(slots).toBe(pages * MAX_ADS_PER_PAGE);
    const share = indie / slots;
    expect(share).toBeGreaterThan(1 / INDIE_EVERY - 0.04);
    expect(share).toBeLessThan(1 / INDIE_EVERY + 0.04);
  });

  it("is NOT a floor of one indie unit per page — a third of pages carry none", () => {
    // The direct statement of the rejected alternative. If this ever fails, somebody has
    // "improved" the reservation into a guarantee and halved the general inventory.
    let pagesWithNoIndie = 0;
    for (let page = 0; page < 500; page += 1) {
      if (!planKinds(2, `v:home:${page}`).includes("indie")) pagesWithNoIndie += 1;
    }
    expect(pagesWithNoIndie).toBeGreaterThan(100);
  });

  it("never puts two indie units on one page — measured, and NOT what independence would give", () => {
    /**
     * THE ASSERTION THAT RECORDS A MEASURED SURPRISE, so that a future "fix" has to argue with
     * it rather than around it.
     *
     * The source brief predicts ~1/9 of two-slot pages carrying two indie units, which is what
     * two independent draws at p = 1/3 produce. This implementation produces ZERO — not rarely,
     * never — and the share is still exactly 1/3. The mechanism is in the `planKinds` docblock:
     * the two hash inputs differ in one bit, FNV-1a's final multiply turns that into a constant
     * ±P offset in the output, and P ≡ 2 (mod 3), so the two residues can never both be 0.
     *
     * It is kept because the contractual property is the SHARE, and because spreading the same
     * third of impressions across more distinct page views is reach rather than frequency —
     * which is what an unknown artist wants. If this test ever fails, somebody has made the
     * draws independent; that is a product decision about whether a page may be all house ads,
     * not a bug fix.
     */
    let pagesWithTwo = 0;
    for (let page = 0; page < 5_000; page += 1) {
      if (planKinds(2, `v:home:${page}`).every((kind) => kind === "indie")) pagesWithTwo += 1;
    }
    expect(pagesWithTwo).toBe(0);
  });

  it("keeps the share at a third even though the draws are anti-correlated", () => {
    // The property that actually matters, restated against the real distribution: two thirds of
    // pages carry exactly one indie unit and one third carry none, which averages to 1/3 of
    // slots.
    let exactlyOne = 0;
    let none = 0;
    const pages = 5_000;
    for (let page = 0; page < pages; page += 1) {
      const count = planKinds(2, `v:home:${page}`).filter((kind) => kind === "indie").length;
      if (count === 1) exactlyOne += 1;
      if (count === 0) none += 1;
    }
    expect(exactlyOne + none).toBe(pages);
    const share = exactlyOne / (pages * 2);
    expect(share).toBeGreaterThan(1 / INDIE_EVERY - 0.04);
    expect(share).toBeLessThan(1 / INDIE_EVERY + 0.04);
  });
});

describe("pickAd", () => {
  const pool = [
    candidate({ id: 1, kind: "general" }),
    candidate({ id: 2, kind: "general" }),
    candidate({ id: 3, kind: "indie", creatorName: "Someone", projectKind: "ep" }),
  ];

  it("prefers the drawn kind when that shelf has inventory", () => {
    const picked = pickAd({ candidates: pool, seed: "s", slot: 0, placement: "feed", kind: "indie" });
    expect(picked?.kind).toBe("indie");
  });

  it("falls back rather than leaving a hole — the reservation is a PREFERENCE, not a lock", () => {
    /**
     * "A slot drawn for indie with no indie inventory serves a general ad... The alternative —
     * honouring the draw strictly — leaves a hole in the page every time one shelf is empty, and
     * AN EMPTY SHELF IS THE NORMAL STATE of a house-ad system with a handful of rows in it."
     */
    const generalOnly = pool.filter((ad) => ad.kind === "general");
    const picked = pickAd({ candidates: generalOnly, seed: "s", slot: 0, placement: "feed", kind: "indie" });
    expect(picked?.kind).toBe("general");

    const indieOnly = pool.filter((ad) => ad.kind === "indie");
    expect(pickAd({ candidates: indieOnly, seed: "s", slot: 0, placement: "feed", kind: "general" })?.kind).toBe(
      "indie",
    );
  });

  it("returns null when nothing is eligible, which is a designed outcome", () => {
    // planPage omits the slot entirely, so the page renders nothing rather than a bordered
    // frame around a gap.
    expect(pickAd({ candidates: [], seed: "s", slot: 0, placement: "feed", kind: "general" })).toBeNull();
  });

  it("filters on placement, honouring slot: any", () => {
    const feedOnly = [candidate({ id: 10, slot: "feed" })];
    expect(pickAd({ candidates: feedOnly, seed: "s", slot: 0, placement: "feed", kind: "general" })?.id).toBe(10);
    expect(pickAd({ candidates: feedOnly, seed: "s", slot: 0, placement: "sidebar", kind: "general" })).toBeNull();

    const anywhere = [candidate({ id: 11, slot: "any" })];
    expect(pickAd({ candidates: anywhere, seed: "s", slot: 0, placement: "sidebar", kind: "general" })?.id).toBe(11);
  });

  it("honours the exclusion set", () => {
    const picked = pickAd({
      candidates: [candidate({ id: 1 })],
      seed: "s",
      slot: 0,
      placement: "feed",
      kind: "general",
      exclude: new Set([1]),
    });
    expect(picked).toBeNull();
  });

  it("uses a DIFFERENT hash namespace from planKinds", () => {
    /**
     * Sharing a namespace would tie the kind draw to the position in the cumulative walk: every
     * page whose slot 0 drew indie would land on the same position, so ONE indie ad would take
     * the entire reservation and the rest of that shelf would never appear at all.
     *
     * Measured as coverage: over many seeds, a three-ad shelf must actually serve all three.
     */
    const shelf = [candidate({ id: 1 }), candidate({ id: 2 }), candidate({ id: 3 })];
    const served = new Set<number>();
    for (let page = 0; page < 300; page += 1) {
      const picked = pickAd({ candidates: shelf, seed: `v:home:${page}`, slot: 0, placement: "feed", kind: "general" });
      if (picked) served.add(picked.id);
    }
    expect(served.size).toBe(3);
  });

  it("is deterministic for one seed and slot", () => {
    const once = pickAd({ candidates: pool, seed: "fixed", slot: 0, placement: "feed", kind: "general" });
    const twice = pickAd({ candidates: pool, seed: "fixed", slot: 0, placement: "feed", kind: "general" });
    expect(once?.id).toBe(twice?.id);
  });
});

describe("adScore — the genre match is a BONUS, never a filter", () => {
  it("doubles the weight on a match", () => {
    const ad = candidate({ id: 1, weight: 5, genres: ["Electro"] });
    expect(adScore(ad, new Set([genreKey("electro")]))).toBe(10);
    expect(adScore(ad, new Set([genreKey("jazz")]))).toBe(5);
  });

  it("still gives a non-matching ad a real chance, because a bonus is not a gate", () => {
    // A filter would mean a member whose taste profile happens to match nothing sees no ads at
    // all, and an advertiser with an unpopular genre tag gets zero delivery.
    const ad = candidate({ id: 1, weight: 3, genres: ["Metal"] });
    expect(adScore(ad, new Set([genreKey("pop")]))).toBeGreaterThan(0);
  });

  it("gives a row stored at zero weight a chance rather than silencing it", () => {
    // `Math.max(1, weight)` — a weight of 0 is almost certainly an operator slip, and silently
    // never serving the ad is a worse answer than serving it rarely.
    expect(adScore(candidate({ id: 1, weight: 0 }), new Set())).toBeGreaterThan(0);
  });

  it("matches genres case-insensitively", () => {
    const ad = candidate({ id: 1, weight: 1, genres: ["Rap/Hip Hop"] });
    expect(adScore(ad, new Set([genreKey("RAP/HIP HOP")]))).toBe(2);
  });
});

describe("planPage", () => {
  it("never renders the same card twice on one page", () => {
    /**
     * THE `placed` SET. Without it both slots walk the same pool and a single-row inventory
     * renders itself twice side by side — "which reads as a rendering bug to a member and as a
     * doubled impression count to the advertiser."
     */
    const one = [candidate({ id: 1 })];
    const plan = planPage({ candidates: one, seed: "s", slotCount: 2, placement: "feed" });
    expect(plan.length).toBe(1);
  });

  it("fills both slots when there is inventory for both", () => {
    const two = [candidate({ id: 1 }), candidate({ id: 2 })];
    const plan = planPage({ candidates: two, seed: "s", slotCount: 2, placement: "feed" });
    expect(plan.length).toBe(2);
    expect(new Set(plan.map((entry) => entry.ad.id)).size).toBe(2);
  });

  it("omits a slot entirely rather than emitting an empty frame", () => {
    expect(planPage({ candidates: [], seed: "s", slotCount: 2, placement: "feed" })).toEqual([]);
  });

  it("reports the DRAWN kind separately from the served ad's kind", () => {
    /**
     * These differ whenever the fallback fires, and the distinction is load-bearing for the UI:
     * "a badge rendered from this field would label a general ad 'indie' on every page where the
     * indie shelf happened to be empty, so THE CARD MUST READ `ad.kind`."
     */
    const generalOnly = [candidate({ id: 1, kind: "general" }), candidate({ id: 2, kind: "general" })];
    const plans = Array.from({ length: 60 }, (_, page) =>
      planPage({ candidates: generalOnly, seed: `v:home:${page}`, slotCount: 2, placement: "feed" }),
    ).flat();
    // Some slots were drawn indie...
    expect(plans.some((entry) => entry.kind === "indie")).toBe(true);
    // ...and every served ad is nonetheless general, because that is all there was.
    expect(plans.every((entry) => entry.ad.kind === "general")).toBe(true);
  });

  it("is stable across repeated renders of the same page", () => {
    // Impression counting only means something if a reload does not reshuffle the page.
    const pool = [candidate({ id: 1 }), candidate({ id: 2 }), candidate({ id: 3 })];
    const a = planPage({ candidates: pool, seed: "v:album:42:9999", slotCount: 2, placement: "sidebar" });
    const b = planPage({ candidates: pool, seed: "v:album:42:9999", slotCount: 2, placement: "sidebar" });
    expect(a.map((entry) => entry.ad.id)).toEqual(b.map((entry) => entry.ad.id));
  });
});

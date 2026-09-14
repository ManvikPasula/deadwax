import { describe, expect, it } from "vitest";

import {
  DISC_MAX,
  MAX_DB_INT,
  TRACK_MAX,
  albumSlug,
  artistSlug,
  parseBoundedInt,
  parseIdSlug,
  parsePage,
  parseTrackLocator,
  slugify,
  trackLocator,
} from "@/lib/slug";

describe("slugify", () => {
  it("deletes apostrophes outright rather than turning them into hyphens", () => {
    // "It's Only Rock 'n Roll" must not become "it-s-only-rock-n-roll".
    expect(slugify("It's Only Rock 'n Roll")).toBe("its-only-rock-n-roll");
    expect(slugify("Don’t Stop")).toBe("dont-stop");
  });

  it("strips combining marks so accented titles produce ASCII slugs", () => {
    expect(slugify("Björk")).toBe("bjork");
    expect(slugify("Café Bleu")).toBe("cafe-bleu");
  });

  it("collapses every other non-alphanumeric run to a single hyphen", () => {
    expect(slugify("!!! (Chk Chk Chk)")).toBe("chk-chk-chk");
    expect(slugify("Music Has The Right To Children")).toBe("music-has-the-right-to-children");
  });

  it("falls back to a literal rather than returning an empty slug", () => {
    // An empty slug would produce the URL "/album/-42", which parses but reads as broken.
    expect(slugify("日本語")).toBe("album");
    expect(slugify("...", "artist")).toBe("artist");
    expect(slugify("%%%")).toBe("album");
  });

  it("caps at 80 characters and trims again, because the slice can land mid-hyphen", () => {
    const slug = slugify(`${"a".repeat(78)} bbbb`);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("does not deduplicate: two records with one title share a slug and differ by id", () => {
    // There is no collision handling and no unique constraint on slug, by design — the
    // trailing id is the key.
    expect(slugify("Greatest Hits")).toBe(slugify("Greatest Hits"));
    expect(albumSlug("Greatest Hits", 11)).toBe("greatest-hits-11");
    expect(albumSlug("Greatest Hits", 12)).toBe("greatest-hits-12");
  });

  it("uses the right fallback word per entity", () => {
    expect(albumSlug("日本語", 5)).toBe("album-5");
    expect(artistSlug("日本語", 5)).toBe("artist-5");
  });
});

describe("parseIdSlug", () => {
  it("reads the trailing id and ignores everything in front of it", () => {
    // This is what keeps old URLs working after a retitle: the prefix is decoration.
    expect(parseIdSlug("kid-a-42")).toBe(42);
    expect(parseIdSlug("something-else-entirely-42")).toBe(42);
    expect(parseIdSlug("42")).toBe(42);
  });

  it("rejects a segment longer than ten digits BEFORE calling Number()", () => {
    // The order of the guards matters: a 30-digit segment must not be allowed to round to
    // something that looks valid.
    expect(parseIdSlug("album-99999999999999999999999999999")).toBeNull();
  });

  it("rejects an id above the Postgres integer ceiling — a 500 where a 404 belongs", () => {
    // The real production failure this fixes: /show/breaking-bad-9999999999 raised
    // "value out of range for type integer".
    expect(parseIdSlug("album-9999999999")).toBeNull();
    expect(parseIdSlug(`album-${MAX_DB_INT}`)).toBe(MAX_DB_INT);
    expect(parseIdSlug(`album-${MAX_DB_INT + 1}`)).toBeNull();
  });

  it("cannot produce a negative id, because the separator is itself a hyphen", () => {
    // A deliberate quirk worth pinning: "album--4" is 4, not -4.
    expect(parseIdSlug("album--4")).toBe(4);
  });

  it("rejects zero, empty, non-numeric tails and nullish input", () => {
    expect(parseIdSlug("album-0")).toBeNull();
    expect(parseIdSlug("album-")).toBeNull();
    expect(parseIdSlug("album")).toBeNull();
    expect(parseIdSlug("")).toBeNull();
    expect(parseIdSlug(null)).toBeNull();
    expect(parseIdSlug(undefined)).toBeNull();
  });
});

describe("parseBoundedInt", () => {
  it("returns null rather than clamping, so the caller can 404", () => {
    // Silently clamping an out-of-range id to a valid one renders somebody else's page.
    expect(parseBoundedInt("9999", { min: 1, max: 100 })).toBeNull();
    expect(parseBoundedInt("50", { min: 1, max: 100 })).toBe(50);
  });

  it("rejects every shape that is not one to ten plain digits", () => {
    for (const value of ["1e30", "0x10", " 5 ", "-1", "1.5", "+3", "", "abc", "5abc"]) {
      expect(parseBoundedInt(value, { min: 0, max: 1_000_000 })).toBeNull();
    }
  });

  it("accepts zero when the minimum allows it, because a pregap track is numbered 0", () => {
    expect(parseBoundedInt("0", { min: 0, max: 500 })).toBe(0);
    expect(parseBoundedInt("0", { min: 1, max: 500 })).toBeNull();
  });
});

describe("parsePage", () => {
  it("is the single exception to return-null: it clamps, because a silly ?page= should not break a link", () => {
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-3")).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("3")).toBe(3);
  });

  it("clamps 1e30 rather than letting it reach SQL OFFSET as the string 5e+31", () => {
    expect(parsePage("1e30")).toBe(1);
  });

  it("clamps to the supplied ceiling", () => {
    expect(parsePage("9999", 500)).toBe(500);
  });
});

describe("parseTrackLocator / trackLocator", () => {
  /**
   * The television original's episodeCode ("S03E07") has no music counterpart and, notably,
   * no test. This pair is its replacement and is tested in both directions.
   */
  it("reads a bare number as disc 1", () => {
    expect(parseTrackLocator("7")).toEqual({ disc: 1, track: 7 });
  });

  it("reads disc-track for a multi-disc release", () => {
    // The Wall is genuinely 13 + 13, so this dimension is real and not decorative.
    expect(parseTrackLocator("2-5")).toEqual({ disc: 2, track: 5 });
  });

  it("accepts track 0, because a pregap or hidden track is legitimately numbered 0", () => {
    expect(parseTrackLocator("0")).toEqual({ disc: 1, track: 0 });
    expect(parseTrackLocator("1-0")).toEqual({ disc: 1, track: 0 });
  });

  it("rejects every malformed shape", () => {
    for (const value of ["", "-5", "2-", "2-5-1", "1e3", "01a", " 3", "a-b", "2--5"]) {
      expect(parseTrackLocator(value)).toBeNull();
    }
    expect(parseTrackLocator(null)).toBeNull();
  });

  it("rejects discs and tracks beyond their bounds", () => {
    expect(parseTrackLocator(`${DISC_MAX + 1}-1`)).toBeNull();
    expect(parseTrackLocator(`1-${TRACK_MAX + 1}`)).toBeNull();
    expect(parseTrackLocator(`${DISC_MAX}-${TRACK_MAX}`)).toEqual({ disc: DISC_MAX, track: TRACK_MAX });
  });

  it("omits the disc prefix on a single-disc album, because there the disc number is noise", () => {
    expect(trackLocator({ disc: 1, track: 7, discCount: 1 })).toBe("7");
    expect(trackLocator({ disc: 2, track: 5, discCount: 2 })).toBe("2-5");
  });

  it("zero-pads for display so a tracklist's numbers align in a tabular column", () => {
    expect(trackLocator({ disc: 1, track: 7, discCount: 1, pad: true })).toBe("07");
    expect(trackLocator({ disc: 2, track: 5, discCount: 2, pad: true })).toBe("2-05");
  });

  it("round-trips: every formatted locator parses back to what produced it", () => {
    for (const discCount of [1, 2, 3]) {
      for (const disc of [1, 2, 3].slice(0, discCount)) {
        for (const track of [0, 1, 9, 10, 99]) {
          const formatted = trackLocator({ disc, track, discCount });
          const parsed = parseTrackLocator(formatted);
          expect(parsed).not.toBeNull();
          expect(parsed!.track).toBe(track);
          // A single-disc album formats without the prefix, so it parses back as disc 1.
          expect(parsed!.disc).toBe(discCount > 1 ? disc : 1);
        }
      }
    }
  });
});

import { describe, expect, it } from "vitest";

import {
  CALENDAR_DATE_FLOOR,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  PASSWORD_MAX_BYTES,
  POSTGRES_DATE_LITERALS,
  albumIdSchema,
  artistIdSchema,
  calendarDate,
  calendarDateCeiling,
  commentBody,
  discNumberSchema,
  passwordByteLength,
  passwordSchema,
  reviewBody,
  signInSchema,
  tagList,
  targetTypeOf,
  trackNumberSchema,
  usernameSchema,
} from "@/lib/security/schemas";
import { MAX_DB_INT } from "@/lib/slug";
import { RESERVED_USERNAMES } from "@/lib/username";

/**
 * The shared validation library.
 *
 * "Validation lives here rather than beside each action so there is one definition per rule
 * instead of one per caller. **Two of the defects found in audit came from copies drifting
 * apart.**" Every bound below is one rule with one home, and most of them are here because
 * the rule was once expressed twice.
 */

describe("usernameSchema — an allowlist, not a denylist", () => {
  it("accepts the allowed character set", () => {
    for (const value of ["abc", "Runout_Groove", "a_1", "x".repeat(24)]) {
      expect(usernameSchema.safeParse(value).success).toBe(true);
    }
  });

  it("rejects anything outside it", () => {
    // "Anything outside this set cannot appear in a URL segment, a revalidation path, or a
    // filename." Profiles live at /@name, so a username is also a URL segment.
    for (const value of ["ab", "x".repeat(25), "has space", "dash-ed", "dot.ted", "emoji🎵", "sla/sh", "per%cent", ""]) {
      expect(usernameSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects every reserved name, case-insensitively", () => {
    for (const reserved of RESERVED_USERNAMES) {
      expect(usernameSchema.safeParse(reserved).success).toBe(false);
      expect(usernameSchema.safeParse(reserved.toUpperCase()).success).toBe(false);
    }
  });

  it("reserves the route words this app actually has, not television's", () => {
    // RESERVED_USERNAMES is regenerated from the route tree. A name that collides with a route
    // segment makes one member's profile unreachable.
    for (const word of ["album", "albums", "artist", "artists", "track", "tracks", "deadwax", "log", "spotlight"]) {
      expect(RESERVED_USERNAMES.has(word)).toBe(true);
    }
  });

  it("rejects the guest_ prefix", () => {
    /**
     * "Without this a member could register `guest_ab12cd34` and be taken for one, or shadow a
     * real guest's name in a way that makes the two hard to tell apart in the admin panel."
     */
    expect(usernameSchema.safeParse("guest_ab12cd34").success).toBe(false);
    expect(usernameSchema.safeParse("GUEST_ab12cd34").success).toBe(false);
    // But a name that merely contains it is fine.
    expect(usernameSchema.safeParse("myguest_pass").success).toBe(true);
  });
});

describe("passwordSchema — bounded in BYTES, not characters", () => {
  it("counts bytes, not code units", () => {
    // The measurement that made this a HIGH finding: "é" is one character and two bytes.
    expect(passwordByteLength("a".repeat(72))).toBe(72);
    expect(passwordByteLength("é".repeat(72))).toBe(144);
  });

  it("rejects a 72-CHARACTER password that is over 72 BYTES", () => {
    /**
     * THE DEFECT THIS EXISTS FOR. bcrypt truncates at 72 bytes, so `"é".repeat(72)` — 72
     * characters, 144 bytes — would have its first 36 characters accepted as the whole
     * password. Measuring a limit in a different unit from the limit it enforces.
     */
    const overLong = "é".repeat(72);
    expect(overLong.length).toBe(72);
    expect(passwordByteLength(overLong)).toBeGreaterThan(PASSWORD_MAX_BYTES);
    expect(passwordSchema.safeParse(overLong).success).toBe(false);
  });

  it("accepts a multi-byte password that fits in the byte budget", () => {
    const fits = "é".repeat(36); // 36 characters, 72 bytes
    expect(passwordByteLength(fits)).toBe(PASSWORD_MAX_BYTES);
    expect(passwordSchema.safeParse(fits).success).toBe(true);
  });

  it("enforces a minimum length and a cheap megabyte guard", () => {
    expect(passwordSchema.safeParse("short").success).toBe(false);
    // "A cheap guard so a megabyte string is rejected before it is encoded."
    expect(passwordSchema.safeParse("a".repeat(401)).success).toBe(false);
  });

  it("sign-in accepts a single character, so an old password still works", () => {
    /**
     * `signInSchema.password` deliberately uses min(1): "a member whose password predates the
     * rule must still be able to sign in." Applying the sign-up minimum here is what created
     * accounts that could never be signed into — the same rule expressed twice, differently.
     */
    expect(signInSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
  });

  it("sign-in's over-length message is the GENERIC auth failure, not a length explanation", () => {
    // A length-specific message on the sign-in path tells an attacker something about the
    // stored password.
    const result = signInSchema.safeParse({ email: "a@b.co", password: "é".repeat(72) });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message).join(" ");
      expect(messages).not.toMatch(/72|byte|character|long/i);
    }
  });
});

describe("calendarDate — five layers, and the third is the one that matters", () => {
  const today = new Date();

  it("1. rejects anything that is not the YYYY-MM-DD shape", () => {
    for (const value of ["", "2026", "2026-01", "26-01-01", "2026/01/01", "01-01-2026", "2026-1-1", "20260101"]) {
      expect(calendarDate.safeParse(value).success).toBe(false);
    }
  });

  it("trims rather than rejecting, and stores the trimmed value", () => {
    /**
     * `.trim()` runs BEFORE the shape check, which is normalisation rather than laxity: the
     * value that reaches the column is the trimmed one, so there is no gap between what was
     * validated and what was stored. That gap is the shape of the tag-length defect elsewhere
     * in this file, and it is worth asserting that it does not exist here.
     *
     * Note that partial precision is rejected here even though `nullableDate` in the provider
     * mapper ACCEPTS it. The two are different rules for different inputs and the difference is
     * deliberate: a provider's "1969" is a true and useful answer about a release, whereas a
     * member's diary date comes from an `<input type="date">` and a silently widened "2026" ->
     * "2026-01-01" would put a listen on a day they did not choose.
     */
    const result = calendarDate.safeParse(" 2026-01-01 ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("2026-01-01");
  });

  it("2. rejects a shape-valid non-date, via the round-trip check", () => {
    // 2026-02-30 matches the regex and is not a date. Only re-serialising a parsed Date catches
    // it.
    for (const value of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-01-32"]) {
      expect(calendarDate.safeParse(value).success).toBe(false);
    }
  });

  it("3. REJECTS THE POSTGRES DATE LITERALS", () => {
    /**
     * THE WHOLE REASON THIS SCHEMA IS NOT A REGEX. Postgres accepts `infinity`, `-infinity`,
     * `now`, `today` and `epoch` as valid DATE values, and ONE STORED `infinity` MADE
     * `EXTRACT(YEAR FROM listened_on)` THROW ON A MEMBER'S PUBLIC DIARY AND YEAR PAGES FOR
     * EVERY VISITOR, PERMANENTLY, WITH NO WAY TO UNDO IT FROM THE INTERFACE.
     *
     * The root cause was named as duplicated validation: "a validated schema in one action and
     * an unvalidated one in another."
     */
    for (const literal of POSTGRES_DATE_LITERALS) {
      expect(calendarDate.safeParse(literal).success).toBe(false);
      expect(calendarDate.safeParse(literal.toUpperCase()).success).toBe(false);
    }
    expect(POSTGRES_DATE_LITERALS.has("infinity")).toBe(true);
    expect(POSTGRES_DATE_LITERALS.has("epoch")).toBe(true);
  });

  it("4. rejects a date before recorded music", () => {
    expect(calendarDate.safeParse("1899-12-31").success).toBe(false);
    expect(calendarDate.safeParse(CALENDAR_DATE_FLOOR).success).toBe(true);
  });

  it("5. allows the member's own today even when UTC disagrees — the timezone fix", () => {
    /**
     * The upper bound is UTC today PLUS ONE DAY, not UTC today.
     *
     * The source computes every date as a UTC ISO slice on both client and server, so a member
     * in UTC+13 logging at 09:00 local is told "You cannot log something you have not heard
     * yet" about a record they played this morning. One day of slack covers every real offset
     * without letting a date a fortnight out be stored.
     */
    const ceiling = calendarDateCeiling(today);
    expect(calendarDate.safeParse(ceiling).success).toBe(true);

    const utcToday = today.toISOString().slice(0, 10);
    expect(calendarDate.safeParse(utcToday).success).toBe(true);

    const farFuture = new Date(today.getTime() + 14 * 86_400_000).toISOString().slice(0, 10);
    expect(calendarDate.safeParse(farFuture).success).toBe(false);
  });
});

describe("tagList — normalise BEFORE measuring", () => {
  it("caps the number of tags", () => {
    expect(tagList.safeParse(Array.from({ length: MAX_TAGS }, (_, i) => `tag${i}`)).success).toBe(true);
    expect(tagList.safeParse(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `tag${i}`)).success).toBe(false);
  });

  it("lowercases and trims, and the ORDER OF THOSE TWO STEPS AGAINST THE LENGTH CHECK MATTERS", () => {
    /**
     * THE DEFECT: 'İ' (U+0130, capital I with a dot above) LOWERCASES TO TWO CODE UNITS. So a
     * 17-character tag became a 33-character value and overflowed `varchar(32)` AT INSERT TIME
     * — long after validation had passed it.
     *
     * REVERSING THE ORDER REINTRODUCES THE BUG. Measuring first and normalising second means
     * the stored value can be longer than the value that was checked.
     */
    const dotted = "İ".repeat(17);
    expect(dotted.length).toBe(17);
    expect(dotted.toLowerCase().length).toBeGreaterThan(MAX_TAG_LENGTH);
    expect(tagList.safeParse([dotted]).success).toBe(false);
  });

  it("normalises case so two spellings of one tag are one tag", () => {
    const result = tagList.safeParse([" Late Night ", "LATE NIGHT"]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.every((tag) => tag === tag.trim().toLowerCase())).toBe(true);
    }
  });

  it("rejects an empty tag rather than storing one", () => {
    expect(tagList.safeParse([""]).success).toBe(false);
    expect(tagList.safeParse(["   "]).success).toBe(false);
  });
});

describe("body bounds", () => {
  it("bounds a review generously but finitely", () => {
    // "Long enough for an essay, bounded so one row cannot be a megabyte."
    expect(reviewBody.safeParse("a".repeat(20_000)).success).toBe(true);
    expect(reviewBody.safeParse("a".repeat(20_001)).success).toBe(false);
  });

  it("bounds a comment, and the bound is exported so it stays in sync in three places", () => {
    // The schema, the textarea maxLength and the character counter must all read one constant.
    expect(commentBody.safeParse("a".repeat(2_000)).success).toBe(true);
    expect(commentBody.safeParse("a".repeat(2_001)).success).toBe(false);
  });
});

describe("id and ordinal bounds", () => {
  it("bounds ids at the Postgres integer ceiling", () => {
    // An id above int4 range raises "value out of range for type integer" — a 500 where a 404
    // belongs.
    expect(albumIdSchema.safeParse(MAX_DB_INT).success).toBe(true);
    expect(albumIdSchema.safeParse(MAX_DB_INT + 1).success).toBe(false);
    expect(albumIdSchema.safeParse(0).success).toBe(false);
    expect(albumIdSchema.safeParse(-1).success).toBe(false);
    expect(artistIdSchema.safeParse(1.5).success).toBe(false);
  });

  it("allows disc and track number ZERO, because a pregap track is legitimately 0", () => {
    // The one place a music ordinal differs from a television one: min is 0, not 1.
    expect(discNumberSchema.safeParse(0).success).toBe(true);
    expect(trackNumberSchema.safeParse(0).success).toBe(true);
    expect(trackNumberSchema.safeParse(-1).success).toBe(false);
  });

  it("bounds disc and track above", () => {
    expect(discNumberSchema.safeParse(51).success).toBe(false);
    expect(trackNumberSchema.safeParse(501).success).toBe(false);
  });
});

describe("targetTypeOf — DERIVED, never accepted from a client", () => {
  it("narrows from the fields that are present", () => {
    expect(targetTypeOf({ artistId: 1 })).toBe("artist");
    expect(targetTypeOf({ artistId: 1, albumId: 2 })).toBe("album");
    expect(targetTypeOf({ artistId: 1, albumId: 2, discNumber: 1, trackNumber: 3 })).toBe("track");
  });

  it("treats a track number as decisive even at zero", () => {
    // `trackNumber !== undefined`, not truthiness — a pregap track is numbered 0, and a
    // truthiness check would classify it as an album log.
    expect(targetTypeOf({ artistId: 1, albumId: 2, discNumber: 1, trackNumber: 0 })).toBe("track");
  });

  it("cannot be told what it is", () => {
    // The client has no field it can set to make this return something else, which is what
    // makes the target_type column trustworthy without a CHECK constraint behind it.
    expect(targetTypeOf({ artistId: 1, albumId: undefined, trackNumber: undefined })).toBe("artist");
  });
});

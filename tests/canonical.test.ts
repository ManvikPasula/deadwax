import { describe, expect, it } from "vitest";

import { albumIdentities,
  albumIdentity, isActiveArtist, isCanonicalRelease, stripSuffixes } from "@/lib/canonical";

/**
 * The "specials" exclusion. Television's non-canonical items are season 0, detectable with
 * `season_number > 0`; music has no numeric sentinel, and the brief warns this is HARDER
 * rather than easier. These tests are the filter's specification.
 *
 * The failure mode being guarded against is silent: a deluxe edition's bonus tracks
 * substituting for real ones and marking a discography complete, or a greatest-hits package
 * taking a row in a career-arc grid.
 */

describe("isCanonicalRelease", () => {
  it("accepts a plain studio album", () => {
    expect(isCanonicalRelease({ recordType: "album", title: "Kid A" })).toBe(true);
    expect(isCanonicalRelease({ recordType: "album", title: "Discovery" })).toBe(true);
  });

  it("rejects non-album record types", () => {
    expect(isCanonicalRelease({ recordType: "single", title: "One More Time" })).toBe(false);
    expect(isCanonicalRelease({ recordType: "ep", title: "Airbag / How Am I Driving?" })).toBe(false);
    expect(isCanonicalRelease({ recordType: "compilation", title: "Greatest Hits" })).toBe(false);
  });

  it("rejects a MusicBrainz secondary type that disqualifies it", () => {
    for (const type of ["Live", "Remix", "Compilation", "Soundtrack", "DJ-mix", "Demo"]) {
      expect(
        isCanonicalRelease({
          recordType: "album",
          primaryType: "Album",
          secondaryTypes: [type],
          title: "Something",
          musicbrainzKnown: true,
        }),
      ).toBe(false);
    }
  });

  it("rejects a release that is a DIFFERENT KIND OF THING from the studio album", () => {
    // The last resort, and it only runs when there is nothing better.
    for (const title of [
      "Abbey Road (Super Deluxe)",
      "Nevermind (30th Anniversary Super Deluxe)",
      "The Velvet Underground & Nico (45th Anniversary / Super Deluxe Edition)",
      "Homogenic (Live)",
      "Live at Wembley",
      "MTV Unplugged in New York",
      "Kid A (Karaoke Version)",
      "The Complete Recordings",
      "Greatest Hits",
      "Abbey Road (Originally Performed by The Beatles)",
      "Loveless [Demos]",
    ]) {
      expect(isCanonicalRelease({ recordType: "album", title })).toBe(false);
    }
  });

  it("ACCEPTS a plain remaster or anniversary reissue, because on a streaming catalogue it is often the only edition", () => {
    /**
     * The correction that resolving forty real records against the live catalogue forced.
     * The only edition Deezer stocks of several canonical albums is the remaster, and a
     * remaster of a studio album IS the studio album — same work, same tracklist, same running
     * order. Rejecting it does not exclude a duplicate, it excludes THE ALBUM, and the
     * artist's discography grid loses a row it should have.
     *
     * Duplicate editions are albumIdentity()'s job, not this function's: canonicality asks
     * "is this a studio album?", deduplication asks "have we already got this one?".
     */
    for (const title of [
      "Nevermind (Remastered)",
      "Abbey Road (Remastered)",
      "London Calling (Remastered)",
      "Trans-Europe Express (2009 Remaster)",
      "Daydream Nation (Remastered Original Album)",
      "OK Computer - 2017 Remaster",
      "Rumours (Expanded Edition)",
      "The Bends (Collector's Edition)",
      "Discovery [Bonus Track Version]",
    ]) {
      expect(isCanonicalRelease({ recordType: "album", title })).toBe(true);
    }
  });

  it("TRUSTS MusicBrainz over the title regex when MusicBrainz has spoken", () => {
    /**
     * This is the important asymmetry. MusicBrainz's editors have already made this judgement,
     * and a regex second-guessing them is how a legitimately-titled record gets thrown out.
     * When the provider says "Album, no secondary types", that answer wins.
     */
    expect(
      isCanonicalRelease({
        recordType: "album",
        primaryType: "Album",
        secondaryTypes: [],
        // A real title that the noise regex would otherwise reject on "Live".
        title: "Live Through This",
        musicbrainzKnown: true,
      }),
    ).toBe(true);
  });

  it("does not reject a title merely for containing a noise WORD out of suffix position", () => {
    // The regex is anchored to brackets, dash-tails and leading qualifiers on purpose, so
    // ordinary titles survive.
    for (const title of [
      "Deluxe",
      "Remaster",
      "The Bonus Round",
      "Instrumental Tourist",
      "Demolition Plot J-7",
      "Anniversary",
    ]) {
      expect(isCanonicalRelease({ recordType: "album", title })).toBe(true);
    }
  });

  it("defaults to canonical when record type is absent", () => {
    // An unknown record type must not silently exclude a record from its own discography.
    expect(isCanonicalRelease({ title: "Untitled" })).toBe(true);
  });
});

describe("stripSuffixes", () => {
  it("removes bracketed and dash-tailed qualifiers", () => {
    expect(stripSuffixes("Abbey Road (Super Deluxe)")).toBe("Abbey Road");
    expect(stripSuffixes("OK Computer - 2017 Remaster")).toBe("OK Computer");
    expect(stripSuffixes("Discovery [Bonus Track Version]")).toBe("Discovery");
    expect(stripSuffixes("Kid A")).toBe("Kid A");
  });
});

describe("albumIdentity — dedup must get stricter, not merely renamed", () => {
  /**
   * The brief's warning, and it is the thing most likely to be underestimated: in television
   * duplicates are occasional regional variants. In music the same album exists as original /
   * remaster / deluxe / 2CD / Japanese pressing / vinyl reissue, WITH DIFFERENT TITLES AND
   * DIFFERENT YEARS — so title+year would dedupe almost nothing.
   */
  it("prefers the MusicBrainz release-group mbid, which is authoritative", () => {
    const a = albumIdentity({ mbid: "e75c0549", artistName: "Radiohead", title: "Kid A" });
    const b = albumIdentity({ mbid: "e75c0549", artistName: "Radiohead", title: "Kid A (Remastered)" });
    expect(a).toBe(b);
  });

  it("collapses editions of one record when there is no mbid", () => {
    const original = albumIdentity({ artistName: "The Beatles", title: "Abbey Road" });
    for (const variant of [
      "Abbey Road (Super Deluxe)",
      "Abbey Road [2019 Mix]",
      "Abbey Road - Remastered",
    ]) {
      expect(albumIdentity({ artistName: "The Beatles", title: variant })).toBe(original);
    }
  });

  it("DELIBERATELY EXCLUDES THE YEAR, because the year is exactly what a reissue changes", () => {
    // A title+year identity would treat the 2017 OKNOTOK edition as a different record from
    // the 1997 original, which is how a recommendation list fills with remasters of albums
    // the listener already rated.
    const a = albumIdentity({ artistName: "Radiohead", title: "OK Computer" });
    const b = albumIdentity({ artistName: "Radiohead", title: "OK Computer (2017 Remaster)" });
    expect(a).toBe(b);
  });

  it("normalises punctuation, case, accents and ampersands", () => {
    const a = albumIdentity({ artistName: "Simon & Garfunkel", title: "Bookends" });
    const b = albumIdentity({ artistName: "simon and garfunkel", title: "BOOKENDS" });
    expect(a).toBe(b);
  });

  it("keeps genuinely different records apart", () => {
    expect(albumIdentity({ artistName: "Radiohead", title: "Kid A" })).not.toBe(
      albumIdentity({ artistName: "Radiohead", title: "Amnesiac" }),
    );
    // Two records with the same title by different artists are different records.
    expect(albumIdentity({ artistName: "Weezer", title: "Weezer" })).not.toBe(
      albumIdentity({ artistName: "Metallica", title: "Metallica" }),
    );
  });

  it("falls back to the artist id when no name is available, rather than colliding everything", () => {
    expect(albumIdentity({ artistId: 7, title: "Untitled" })).not.toBe(
      albumIdentity({ artistId: 8, title: "Untitled" }),
    );
  });
});

describe("isActiveArtist — the in_production analogue", () => {
  const now = new Date("2026-09-14T00:00:00Z");

  it("is active with a release inside eighteen months", () => {
    expect(isActiveArtist("2026-03-01", now)).toBe(true);
  });

  it("is inactive with nothing recent", () => {
    // This is the only thing choosing between the 1-day and 14-day artist refresh windows.
    expect(isActiveArtist("2001-03-07", now)).toBe(false);
  });

  it("treats a missing or unparseable date as inactive rather than as active", () => {
    // The cheaper failure: a wrongly-inactive artist refreshes fortnightly instead of daily,
    // whereas a wrongly-active one costs a provider request on every single view.
    expect(isActiveArtist(null, now)).toBe(false);
    expect(isActiveArtist(undefined, now)).toBe(false);
    expect(isActiveArtist("not a date", now)).toBe(false);
  });
});

describe("albumIdentities — the asymmetry that recommended records people had already rated", () => {
  /**
   * THE BUG THIS PINS, because it is invisible from either function alone.
   *
   * `albumIdentity` returns ONE key and prefers the mbid, which is right for a Map. It is wrong
   * for MATCHING two rows, because the preferred key is not a property of the record — it is a
   * property of how much we happen to know about the row. The same album with its mbid fetched
   * and without it produced two keys that could never compare equal.
   *
   * Measured consequence before the fix: six members had rated album 55 (`good kid, m.A.A.d
   * city`, mbid NULL) and not album 176 (the same record, mbid set), and /for-you offered 176
   * to all six, with a predicted star figure and a reason.
   */
  const withMbid = { mbid: "499c19c8-0dab-4824-884b-6191d145e95b", title: "good kid, m.A.A.d city", artistName: "Kendrick Lamar" };
  const withoutMbid = { mbid: null, title: "good kid, m.A.A.d city", artistName: "Kendrick Lamar" };

  it("EMITS A FORM THAT MATCHES ACROSS THE MBID BOUNDARY", () => {
    const known = albumIdentities(withMbid);
    const unknown = albumIdentities(withoutMbid);
    expect(known.some((identity) => unknown.includes(identity))).toBe(true);
  });

  it("still leads with the mbid, so the strongest claim remains the primary key", () => {
    expect(albumIdentities(withMbid)[0]).toBe("mb:499c19c8-0dab-4824-884b-6191d145e95b");
    expect(albumIdentity(withMbid)).toBe("mb:499c19c8-0dab-4824-884b-6191d145e95b");
  });

  it("emits exactly one form when there is no mbid, and it is the title form", () => {
    expect(albumIdentities(withoutMbid)).toEqual(["t:kendricklamar::goodkidmaadcity"]);
  });

  it("matches a reissue against the original across BOTH directions", () => {
    // The suffix is what `stripSuffixes` exists for, and the year is deliberately not in the key.
    const remaster = albumIdentities({ mbid: null, title: "good kid, m.A.A.d city (Deluxe)", artistName: "Kendrick Lamar" });
    expect(remaster.some((identity) => albumIdentities(withMbid).includes(identity))).toBe(true);
    expect(albumIdentities(withMbid).some((identity) => remaster.includes(identity))).toBe(true);
  });

  it("does NOT collapse two different records by the same artist", () => {
    // The accepted cost of the title form is a collision; this is the guard that it is rare.
    const other = albumIdentities({ mbid: null, title: "To Pimp a Butterfly", artistName: "Kendrick Lamar" });
    expect(other.some((identity) => albumIdentities(withoutMbid).includes(identity))).toBe(false);
  });

  it("falls back to the artist id when the name is absent, so two artists never merge", () => {
    const one = albumIdentities({ mbid: null, title: "Untitled", artistId: 7 });
    const two = albumIdentities({ mbid: null, title: "Untitled", artistId: 8 });
    expect(one.some((identity) => two.includes(identity))).toBe(false);
  });
});

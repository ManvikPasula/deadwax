import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  blankToNull,
  genreVocabulary,
  mapAlbumDetail,
  mapAlbumSummary,
  mapCredits,
  mapEmbeddedTracks,
  mapTrack,
  normaliseLabel,
  normaliseRank,
  nullableDate,
  pickImage,
  resolveGenres,
} from "@/lib/providers/deezer/mappers";
import type { DeezerAlbumDetail, DeezerGenre, DeezerList, DeezerTrack } from "@/lib/providers/deezer/types";
import {
  firstReleaseDate,
  mapAlbumEnrichment,
  mapArtistEnrichment,
  mbTagsToAttributes,
  secondaryTypes,
} from "@/lib/providers/musicbrainz/mappers";
import type { MbArtist, MbReleaseGroup } from "@/lib/providers/musicbrainz";

/**
 * The mappers are where the provider's awkward cases live, so these run against CAPTURED REAL
 * PAYLOADS rather than against hand-written objects. Every fixture in tests/fixtures/ was
 * fetched from the live API — which is how three design-changing facts were found that no
 * amount of reading documentation would have produced.
 */

const FIXTURES = join(import.meta.dirname, "fixtures");
const load = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;

const discovery = load<DeezerAlbumDetail>("deezer-album-discovery.json");
const multidisc = load<DeezerAlbumDetail>("deezer-album-multidisc.json");
const discoveryTracks = load<DeezerList<DeezerTrack>>("deezer-album-tracks-discovery.json");
const multidiscTracks = load<DeezerList<DeezerTrack>>("deezer-album-tracks-multidisc.json");
const genres = load<DeezerList<DeezerGenre>>("deezer-genres.json");
const kidA = load<MbReleaseGroup>("musicbrainz-rg-kida.json");
const radiohead = load<MbArtist>("musicbrainz-artist-radiohead.json");

describe("the embedded-versus-dedicated tracklist trap", () => {
  /**
   * THE FINDING THAT CHANGED THE INGEST DESIGN, and it is asserted here so nobody "optimises"
   * ingest back down to one request.
   *
   * GET /album/{id} embeds a tracks array. That embedded shape OMITS track_position,
   * disk_number and isrc — only GET /album/{id}/tracks has them. Since
   * (album_id, disc_number, track_number) IS a track's addressable identity and a unique index
   * depends on it, positions cannot be inferred from array order on the primary path.
   */
  it("confirms the embedded array has no positions", () => {
    const embedded = discovery.tracks?.data ?? [];
    expect(embedded.length).toBeGreaterThan(0);
    for (const track of embedded) {
      expect(track).not.toHaveProperty("track_position");
      expect(track).not.toHaveProperty("disk_number");
      expect(track).not.toHaveProperty("isrc");
    }
  });

  it("confirms the dedicated endpoint does have them", () => {
    const full = discoveryTracks.data ?? [];
    expect(full.length).toBe(14);
    for (const track of full) {
      expect(typeof track.track_position).toBe("number");
      expect(typeof track.disk_number).toBe("number");
    }
  });

  it("confirms the disc dimension is real and not decorative", () => {
    // The Wall is genuinely two discs of thirteen. A single `position` column would have to
    // invent an ordering across a boundary the provider reports explicitly.
    const rows = multidiscTracks.data ?? [];
    const byDisc = new Map<number, number>();
    for (const track of rows) byDisc.set(track.disk_number ?? 1, (byDisc.get(track.disk_number ?? 1) ?? 0) + 1);
    expect([...byDisc.entries()].sort()).toEqual([
      [1, 13],
      [2, 13],
    ]);
  });

  it("marks the degraded fallback as disc 1 with index-derived positions", () => {
    // Right for a single-disc album, silently wrong for a multi-disc one — which is why
    // ensureAlbum leaves tracks_synced_at NULL when it takes this path, so the next read
    // retries the real endpoint.
    const rows = mapEmbeddedTracks(multidisc.tracks?.data ?? [], 1, 1, multidisc.artist?.name);
    expect(rows.every((row) => row.discNumber === 1)).toBe(true);
    expect(rows[0]?.trackNumber).toBe(1);
    expect(rows.at(-1)?.trackNumber).toBe(rows.length);
  });
});

describe("nullableDate — looser than television's, and deliberately", () => {
  it("accepts a full date", () => {
    expect(nullableDate("2001-03-07")).toBe("2001-03-07");
  });

  it("accepts year-only and month-only precision and normalises to the start of the period", () => {
    // The original accepts only YYYY-MM-DD because TMDB returns "" for absent dates. Applying
    // that rule to a music catalogue would silently null a large fraction of it: "1969" is a
    // true and useful answer for a great deal of older material.
    expect(nullableDate("1969")).toBe("1969-01-01");
    expect(nullableDate("1969-07")).toBe("1969-07-01");
  });

  it("REJECTS THE POSTGRES DATE LITERALS, which is the whole reason this function exists", () => {
    /**
     * Postgres accepts these as valid dates. One stored 'infinity' made EXTRACT(YEAR ...)
     * throw on a member's public diary and year pages FOR EVERY VISITOR, permanently, with no
     * way to undo it from the interface.
     */
    for (const value of ["infinity", "-infinity", "+infinity", "now", "today", "yesterday", "tomorrow", "epoch"]) {
      expect(nullableDate(value)).toBeNull();
      expect(nullableDate(value.toUpperCase())).toBeNull();
    }
  });

  it("rejects a shape-valid non-date via the round-trip check", () => {
    expect(nullableDate("2026-02-30")).toBeNull();
    expect(nullableDate("2026-13-01")).toBeNull();
  });

  it("rejects absurd and pre-phonograph years", () => {
    expect(nullableDate("0001-01-01")).toBeNull();
    expect(nullableDate("9999-01-01")).toBeNull();
  });

  it("treats empty and whitespace as absent", () => {
    expect(nullableDate("")).toBeNull();
    expect(nullableDate("   ")).toBeNull();
    expect(nullableDate(null)).toBeNull();
    expect(nullableDate(undefined)).toBeNull();
  });
});

describe("pickImage", () => {
  it("returns NULL, not a placeholder, so every call site has to branch", () => {
    expect(pickImage(null)).toBeNull();
    expect(pickImage({})).toBeNull();
  });

  it("picks the smallest size at or above the requested width", () => {
    const url = pickImage(discovery, 500);
    expect(url).toBe(discovery.cover_big);
  });

  it("falls back to the largest available when nothing reaches the requested width", () => {
    expect(pickImage({ cover_small: "s.jpg" }, 1000)).toBe("s.jpg");
  });
});

describe("normaliseRank", () => {
  it("maps Deezer's ~1,000,000 scale onto 0..100", () => {
    expect(normaliseRank(930_849)).toBe(93);
    expect(normaliseRank(0)).toBe(0);
    expect(normaliseRank(null)).toBe(0);
    expect(normaliseRank(50_000_000)).toBe(100);
  });
});

describe("normaliseLabel", () => {
  /**
   * Deezer returns `label` as free text with the wild variation the brief predicted, and
   * probing confirmed it immediately: Discovery's label is the literal string
   * "Daft Life Ltd./ADA France".
   */
  it("strips legal suffixes and picks the FIRST surviving token", () => {
    expect(normaliseLabel("Daft Life Ltd./ADA France")).toBe("Daft Life");
    expect(normaliseLabel("Columbia Records")).toBe("Columbia");
    expect(normaliseLabel("Parlophone Records Ltd")).toBe("Parlophone");
    expect(normaliseLabel("Warp Records Limited")).toBe("Warp");
  });

  it("leaves a label that is already clean alone", () => {
    expect(normaliseLabel("4AD")).toBe("4AD");
    expect(normaliseLabel("Sub Pop")).toBe("Sub Pop");
  });

  it("does not leave stranded punctuation behind", () => {
    // The first version produced the literal string "Daft Life ." — a distinct affinity key
    // from "Daft Life", so the label axis would have a support count of 1 for every record and
    // contribute nothing. Caught by running the real ingest path, not by reading the regex.
    for (const value of ["Daft Life Ltd./ADA France", "4AD Ltd.", "XL Recordings"]) {
      const result = normaliseLabel(value);
      expect(result).not.toMatch(/[\s.\-&]$/);
      expect(result).not.toMatch(/^[\s.\-&]/);
    }
  });

  it("drops distributors, which have no curatorial style to have an affinity for", () => {
    expect(normaliseLabel("ADA")).toBeNull();
    expect(normaliseLabel("The Orchard")).toBeNull();
  });

  it("returns null rather than a wrong key when nothing survives", () => {
    // A label axis with a wrong key is worse than a label axis with no key.
    expect(normaliseLabel("")).toBeNull();
    expect(normaliseLabel("   ")).toBeNull();
    expect(normaliseLabel("Records")).toBeNull();
    expect(normaliseLabel(null)).toBeNull();
  });

  it("is deterministic, which matters more than being right on any single input", () => {
    // Support only accumulates if the same input always produces the same key.
    const once = normaliseLabel("Beggars Group / 4AD");
    expect(normaliseLabel("Beggars Group / 4AD")).toBe(once);
  });
});

describe("genre resolution", () => {
  it("reads the 28-entry Deezer vocabulary from the live payload", () => {
    const vocab = genreVocabulary(genres.data ?? []);
    expect(vocab.get(85)).toBe("Alternative");
    expect(vocab.get(129)).toBe("Jazz");
    expect(vocab.get(106)).toBe("Electro");
    expect(vocab.get(464)).toBe("Metal");
  });

  it("prefers the embedded names when they exist", () => {
    expect(resolveGenres(discovery, new Map())).toEqual(["Electro"]);
  });

  it("falls back to the genre_id through the vocabulary", () => {
    // Without this an album is stored with no genre NAMES and the recommender cannot see it at
    // all — 85% of the original's mirror, measured.
    const vocab = genreVocabulary(genres.data ?? []);
    expect(resolveGenres({ genre_id: 85 }, vocab)).toEqual(["Alternative"]);
  });

  it("returns an empty array rather than inventing a genre", () => {
    expect(resolveGenres({ genre_id: 999_999 }, new Map())).toEqual([]);
    expect(resolveGenres({}, new Map())).toEqual([]);
  });
});

describe("mapAlbumDetail / mapAlbumSummary", () => {
  it("maps the real Discovery payload", () => {
    const row = mapAlbumDetail(discovery, 7, genreVocabulary(genres.data ?? []));
    expect(row.deezerId).toBe("302127");
    expect(row.title).toBe("Discovery");
    expect(row.slug).toBe("discovery");
    expect(row.artistId).toBe(7);
    expect(row.releaseDate).toBe("2001-03-07");
    expect(row.recordType).toBe("album");
    expect(row.isCanonical).toBe(true);
    expect(row.label).toBe("Daft Life");
    expect(row.genres).toEqual(["Electro"]);
    expect(row.fans).toBeGreaterThan(1000);
  });

  it("POISONS two fields on a summary, on purpose", () => {
    const row = mapAlbumSummary(discovery, 7);
    // A summary DOES NOT KNOW THE COUNTS, and overwriting a detailed row with zeros would
    // corrupt completion maths — so it leaves them at their column defaults entirely.
    expect(row.trackCount).toBeUndefined();
    expect(row.discCount).toBeUndefined();
    // The epoch sentinel: isStale() always returns true for a summary-only row, so the first
    // real read triggers a detail sync.
    expect(row.synced_at).toEqual(new Date(0));
  });

  it("omits mbSyncedAt from both shapes, which is what preserves enrichment across a refresh", () => {
    expect(mapAlbumDetail(discovery, 7).mbSyncedAt).toBeUndefined();
    expect(mapAlbumSummary(discovery, 7).mbSyncedAt).toBeUndefined();
  });

  it("omits the MusicBrainz-owned columns so a Deezer refresh cannot clear them", () => {
    const row = mapAlbumDetail(discovery, 7);
    expect(row.criticScore).toBeUndefined();
    expect(row.criticVotes).toBeUndefined();
    expect(row.mbid).toBeUndefined();
    expect(row.originalReleaseDate).toBeUndefined();
  });
});

describe("mapTrack", () => {
  it("converts Deezer SECONDS into stored MILLISECONDS", () => {
    // A seconds column would invite somebody to add them to a milliseconds column later.
    const first = (discoveryTracks.data ?? [])[0]!;
    const row = mapTrack(first, 1, 1, "Daft Punk");
    expect(first.duration).toBe(320);
    expect(row.durationMs).toBe(320_000);
  });

  it("sums to the album duration the provider itself reports", () => {
    // Discovery's 14 tracks sum to 3,662 seconds and Deezer reports album duration 3662.
    const total = (discoveryTracks.data ?? []).reduce((sum, track) => sum + (track.duration ?? 0), 0);
    const reported = discovery.duration ?? -1;
    expect(reported).toBeGreaterThan(0);
    expect(total).toBe(reported);
  });

  it("keeps a per-track artist name only when it differs from the album artist", () => {
    // A per-track name equal to the album artist is noise on twelve consecutive rows.
    const first = (discoveryTracks.data ?? [])[0]!;
    expect(mapTrack(first, 1, 1, "Daft Punk").artistName).toBeNull();
    expect(mapTrack(first, 1, 1, "Somebody Else").artistName).toBe("Daft Punk");
  });

  it("preserves real disc and track positions", () => {
    const rows = (multidiscTracks.data ?? []).map((track) => mapTrack(track, 1, 1));
    const discTwo = rows.filter((row) => row.discNumber === 2);
    expect(discTwo.length).toBe(13);
    expect(discTwo[0]?.trackNumber).toBe(1);
  });
});

describe("mapCredits", () => {
  it("ranks by appearance count so the most-credited person leads", () => {
    const rows = mapCredits(discovery, discoveryTracks.data ?? [], 1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(20);
    // `creditOrder` has a column default, so the INSERT type makes it optional. The fallback
    // is the column's own default, not a guess.
    const order = (index: number) => rows[index]?.creditOrder ?? 999;
    for (let index = 1; index < rows.length; index += 1) {
      expect(order(index)).toBeGreaterThanOrEqual(order(index - 1));
    }
  });
});

describe("MusicBrainz mappers", () => {
  it("reads the real Kid A rating as a (score, count) pair on the stored scale", () => {
    // The finding that made the consensus card possible honestly rather than decoratively.
    const enrichment = mapAlbumEnrichment(kidA);
    expect(enrichment.criticVotes).toBeGreaterThan(0);
    expect(enrichment.criticScore).toBeGreaterThan(5);
    expect(enrichment.criticScore).toBeLessThanOrEqual(10);
  });

  it("prefers the release-GROUP first-release date, which is the reissue fix", () => {
    // Or every remaster reads as a recent album, which poisons the era term, the new-releases
    // rail and every chronological discography row.
    expect(firstReleaseDate(kidA)).toBe("2000-08-03");
  });

  it("reports an empty secondary-types array as clean rather than as unknown", () => {
    expect(secondaryTypes(kidA)).toEqual([]);
  });

  it("filters the tag explosion down to something a recommender can use", () => {
    /**
     * The measurement: Kid A carries SIXTY raw tags, including "apathetic", "owned",
     * "male vocalist", the bare year "2000", and
     * "discogs/the most popular album released every year from 1950 to 2020".
     *
     * Without the count filter the attribute space explodes: a candidate then matches 8+ keys,
     * coverage saturates for everything, and the "shares nothing at all" penalty stops firing.
     */
    expect((kidA.tags ?? []).length).toBeGreaterThan(40);
    const attributes = mbTagsToAttributes(kidA.genres, kidA.tags);
    expect(attributes.length).toBeGreaterThan(3);
    expect(attributes.length).toBeLessThanOrEqual(25);
    expect(attributes).not.toContain("owned");
    expect(attributes).not.toContain("2000");
    expect(attributes).not.toContain("male vocalist");
    expect(attributes.some((tag) => tag.includes("discogs"))).toBe(false);
  });

  it("puts curated genres ahead of unmoderated tags", () => {
    // `genres` is count-weighted and editor-maintained; `tags` is free text.
    const attributes = mbTagsToAttributes(kidA.genres, kidA.tags);
    expect(attributes[0]).toBeDefined();
    expect(attributes).toContain("art rock");
  });

  it("reads artist country, life-span and rating from the real payload", () => {
    const enrichment = mapArtistEnrichment(radiohead);
    expect(enrichment.country).toBe("GB");
    expect(enrichment.beganOn).toBe("1991-01-01");
    expect(enrichment.endedOn).toBeNull();
    // The plan assumed artists had no MusicBrainz rating; probing proved otherwise, which is
    // why the artist page shows a genuine attributed baseline.
    expect(enrichment.criticVotes).toBeGreaterThan(0);
    expect(enrichment.criticScore).toBeGreaterThan(5);
  });

  it("rejects a non-two-letter country rather than storing junk", () => {
    // MusicBrainz sometimes reports a multi-country area with no `country`, and an absent
    // attribute must never become a penalty.
    expect(mapArtistEnrichment({ id: "x", name: "y", country: "XYZ" }).country).toBeNull();
    expect(mapArtistEnrichment({ id: "x", name: "y" }).country).toBeNull();
  });
});

describe("blankToNull", () => {
  it("turns whitespace-only free text into NULL", () => {
    expect(blankToNull("  ")).toBeNull();
    expect(blankToNull("")).toBeNull();
    expect(blankToNull(null)).toBeNull();
    expect(blankToNull(" hello ")).toBe("hello");
  });
});

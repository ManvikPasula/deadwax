import {
  reliableAverage, affinities, leanFor, preferredCentre, confidenceFor, rankingScore,
  mergeAffinities, standardDeviation, pearson,
} from "@/lib/taste/shared";
import { buildTasteProfile } from "@/lib/taste/profile";
import { predictAlbumRating, type CandidateAlbum } from "@/lib/taste/recommend";
import { forecastTracks } from "@/lib/taste/tracks";
import type { RatedAlbumForTaste } from "@/lib/db/queries/albums";

const r2 = (n: number | null) => (n === null ? "null" : Math.round(n * 100) / 100);

console.log("reliableAverage(8.6,4)  =", r2(reliableAverage(8.6, 4)), "expect 7.15");
console.log("reliableAverage(8.6,300)=", r2(reliableAverage(8.6, 300)), "expect 8.41");
console.log("reliableAverage(3,5)    =", r2(reliableAverage(3, 5)), "expect 6.56");
console.log("reliableAverage(9,72)   =", r2(reliableAverage(9, 72)), "expect 8.29");
console.log("reliableAverage(9,4)    =", r2(reliableAverage(9, 4)), "expect 7.18");
console.log("reliableAverage(null,9) =", reliableAverage(null, 9), "expect null");

const aff = affinities(
  [
    { rating: 9, keys: [{ key: "rock", label: "Rock" }, { key: "jazz", label: "Jazz" }] },
    { rating: 5, keys: [{ key: "jazz", label: "Jazz" }] },
    { rating: 10, keys: [{ key: "rock", label: "Rock" }] },
  ],
  7,
);
console.log("affinities:", aff.map((a) => `${a.key} ${r2(a.lean)}/${a.support}`).join("  "));
console.log("descending?", aff[0]!.lean >= aff[aff.length - 1]!.lean);

console.log("leanFor rock+jazz:", r2(leanFor(["Rock", "rock", "JAZZ"], aff).lean), "matched", leanFor(["Rock", "rock", "JAZZ"], aff).matched.length, "expect 2 (deduped)");
console.log("preferredCentre flat:", preferredCentre([{ rating: 7, value: 1990 }, { rating: 7, value: 2000 }], 7), "expect null");
console.log("preferredCentre:", r2(preferredCentre([{ rating: 9, value: 1990 }, { rating: 5, value: 2020 }], 7)), "expect 1990");

// flat rater at 8/10 over 40 albums must NOT reach a usable confidence
console.log("confidence(40 albums, spread 0) =", confidenceFor({ sampleSize: 40, spread: 0 }, 6), "expect small");
console.log("confidence(40 albums, spread 2) =", confidenceFor({ sampleSize: 40, spread: 2 }, 6), "expect 0.9 cap");
console.log("rankingScore 0.55@7.5 =", r2(rankingScore({ meanRating: 6.5 }, { rating: 7.5, confidence: 0.55, reasons: [] })), "expect 7.05");
console.log("rankingScore 0.18@7.6 =", r2(rankingScore({ meanRating: 6.5 }, { rating: 7.6, confidence: 0.18, reasons: [] })), "expect 6.70");

console.log("sd([7,7,7]) =", standardDeviation([7, 7, 7]), "expect 0");
console.log("pearson 2 pairs =", pearson([[1, 2], [3, 4]]), "expect 0");
console.log("merge:", mergeAffinities(aff, [{ key: "rock", label: "rock", lean: -1, support: 3 }]).map((a) => `${a.key} ${r2(a.lean)}/${a.support}`).join("  "));

/* ---- a profile + prediction end to end ---- */
function album(over: Partial<RatedAlbumForTaste>): RatedAlbumForTaste {
  return {
    albumId: 1, rating: 8, ratingSource: "album", tracksRated: 0, artistId: 100,
    artistName: "A", genres: ["Rock"], tags: ["indie rock"], label: "4AD", year: 1995,
    meanTrackMs: 240_000, trackCount: 11, criticScore: 8, criticVotes: 50, country: "GB",
    ...over,
  };
}
const rated: RatedAlbumForTaste[] = [
  album({ albumId: 1, rating: 10, artistId: 1, artistName: "Radiohead", genres: ["Alternative"], tags: ["art rock"] }),
  album({ albumId: 2, rating: 9, artistId: 1, artistName: "Radiohead", genres: ["Alternative"], tags: ["art rock"] }),
  album({ albumId: 3, rating: 4, artistId: 2, artistName: "Coldplay", genres: ["Pop"], tags: [] }),
  album({ albumId: 4, rating: 6, artistId: 3, artistName: "Muse", genres: ["Rock"], tags: [] }),
  album({ albumId: 5, rating: 8, artistId: 4, artistName: "Portishead", genres: ["Alternative"], tags: ["trip hop"] }),
  album({ albumId: 6, rating: 7, artistId: 5, artistName: "Bjork", genres: ["Electro"], tags: [] }),
  album({ albumId: 7, rating: 9, artistId: 6, artistName: "Aphex Twin", genres: ["Electro"], tags: ["idm"] }),
  album({ albumId: 8, rating: 3, artistId: 7, artistName: "Nickelback", genres: ["Rock"], tags: [] }),
];
const p = buildTasteProfile(rated);
console.log("\nprofile: sample", p.sampleSize, "mean", r2(p.meanRating), "spread", r2(p.spread),
  "crowd", r2(p.crowdBaseline), "alignment", r2(p.consensusAlignment),
  "era", r2(p.eraCentre), "len", r2(p.trackLengthCentre), "count", r2(p.trackCountCentre));
console.log("genres:", p.genres.map((a) => `${a.key} ${r2(a.lean)}/${a.support}`).join("  "));
console.log("seenGenres (coarse only):", [...p.seenGenres].join(","));
console.log("tags disjoint from genres:", p.tags.map((a) => a.key).join(","));

function cand(over: Partial<CandidateAlbum>): CandidateAlbum {
  return {
    id: 50, deezerId: "50", mbid: null, title: "X", genres: ["Alternative"], tags: ["art rock"],
    artistId: 1, artistName: "Radiohead", artistCountry: "GB", label: "4AD", year: 1997,
    meanTrackMs: 250_000, trackCount: 12, criticScore: 9, criticVotes: 72, fans: 90_000,
    isCanonical: true, neighbourOf: null, ...over,
  };
}
const apt = predictAlbumRating(p, cand({}));
console.log("\napt candidate:", r2(apt.rating), apt.confidence, JSON.stringify(apt.reasons));
const withNeighbour = predictAlbumRating(p, cand({ neighbourOf: { artistId: 1, name: "Radiohead", rating: 10 } }));
console.log("with neighbour:", r2(withNeighbour.rating), JSON.stringify(withNeighbour.reasons));
console.log("neighbour raised it?", withNeighbour.rating > apt.rating);

// THE INVARIANT: a candidate cannot improve its score by describing itself less.
const rich = predictAlbumRating(p, cand({ genres: ["Alternative"], tags: ["art rock", "shoegaze", "britpop"] }));
const sparse = predictAlbumRating(p, cand({ genres: ["Alternative"], tags: [] }));
console.log("rich", r2(rich.rating), "sparse", r2(sparse.rating), "invariant holds?", rich.rating >= sparse.rating);

const nothing = predictAlbumRating(p, cand({ genres: ["Reggae"], tags: [], artistId: 999, artistName: "Z", label: null, criticScore: null }));
console.log("shares nothing:", r2(nothing.rating), JSON.stringify(nothing.reasons));

const noCritic = predictAlbumRating(p, cand({ criticScore: null, criticVotes: 0 }));
console.log("crowd term skipped when no critic score — differs from apt?", r2(noCritic.rating) !== r2(apt.rating));

/* ---- tracks ---- */
const f = forecastTracks(
  [
    { disc: 1, track: 1, criticScore: 8, viewerRating: 9 },
    { disc: 1, track: 2, criticScore: 6, viewerRating: null },
    { disc: 1, track: 3, criticScore: 10, viewerRating: null },
    { disc: 1, track: 4, criticScore: null, viewerRating: null },
  ],
  7,
);
console.log("\nforecast:", f?.map((t) => `${t.track}:${r2(t.rating)}${t.predicted ? "p" : "R"}@${r2(t.confidence)}`).join("  "));
console.log("real rating untouched?", f?.[0]!.rating === 9 && f?.[0]!.predicted === false && f?.[0]!.confidence === 1);
console.log("no anchor at all -> null:", forecastTracks([{ disc: 1, track: 1, criticScore: 5, viewerRating: null }], null));

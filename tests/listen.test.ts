import { describe, expect, it } from "vitest";

import { listenLinks, previewSource } from "@/lib/listen";

/**
 * The `watch_providers` port. The television original mirrors a per-show, per-region,
 * per-offer-type availability table; this is deterministic search deeplinks with zero API
 * calls, which is strictly better for this domain (nothing to sync, nothing to go stale, no
 * `market` parameter to thread, and no second provider relationship to keep).
 *
 * YouTube Music appears here rather than as the catalogue because it has no official metadata
 * API and the sanctioned YouTube Data API allows roughly 100 searches per day for an entire
 * platform. As a link target it is excellent — it is where a great many people actually listen.
 */

describe("listenLinks", () => {
  const base = { artist: "Daft Punk", title: "Discovery" };

  it("offers YouTube Music first among the searches", () => {
    const links = listenLinks(base);
    expect(links[0]?.service).toBe("youtube-music");
    expect(links[0]?.url).toContain("music.youtube.com/search?q=");
  });

  it("builds a valid absolute https URL for every service", () => {
    for (const link of listenLinks({ ...base, services: ["youtube-music", "spotify", "apple-music", "tidal", "deezer", "bandcamp"] })) {
      expect(() => new URL(link.url)).not.toThrow();
      expect(link.url.startsWith("https://")).toBe(true);
      expect(link.label.length).toBeGreaterThan(0);
    }
  });

  it("encodes the query so titles with spaces, ampersands and slashes cannot break the URL", () => {
    const links = listenLinks({ artist: "AC/DC", title: "Rock & Roll" });
    for (const link of links) {
      expect(() => new URL(link.url)).not.toThrow();
      // The raw characters must not survive into the URL unencoded.
      expect(link.url).not.toContain(" ");
    }
  });

  it("strips bracketed qualifiers, because the edition is what makes a search miss", () => {
    // "Abbey Road (Super Deluxe)" finds less than "Abbey Road" does on a service that stocks a
    // different edition.
    const links = listenLinks({ artist: "The Beatles", title: "Abbey Road (Super Deluxe)" });
    const query = new URL(links[0]!.url).searchParams.get("q");
    expect(query).toBe("The Beatles Abbey Road");
  });

  it("marks Deezer exact when a canonical link exists, and only then", () => {
    // Deezer is the catalogue, so it is the one service we can point at the record itself.
    const withLink = listenLinks({ ...base, deezerUrl: "https://www.deezer.com/album/302127", services: ["deezer"] });
    expect(withLink[0]?.exact).toBe(true);
    expect(withLink[0]?.url).toBe("https://www.deezer.com/album/302127");

    const withoutLink = listenLinks({ ...base, services: ["deezer"] });
    expect(withoutLink[0]?.exact).toBe(false);
    expect(withoutLink[0]?.url).toContain("/search/");
  });

  it("refuses a non-Deezer canonical link, so a poisoned column cannot become an outbound link", () => {
    // The stored value is re-validated before it is used, the same rule the ad click route
    // applies to its target URL.
    for (const hostile of [
      "javascript:alert(1)",
      "https://evil.example.com/album/1",
      "http://www.deezer.com/album/1",
      "//deezer.com/album/1",
    ]) {
      const links = listenLinks({ ...base, deezerUrl: hostile, services: ["deezer"] });
      expect(links[0]?.exact).toBe(false);
      expect(links[0]?.url.startsWith("https://www.deezer.com/search/")).toBe(true);
    }
  });

  it("honours the requested service list and order", () => {
    const links = listenLinks({ ...base, services: ["tidal", "spotify"] });
    expect(links.map((link) => link.service)).toEqual(["tidal", "spotify"]);
  });

  it("is deterministic — the same input always produces the same URLs", () => {
    expect(listenLinks(base)).toEqual(listenLinks(base));
  });
});

describe("previewSource", () => {
  it("accepts a Deezer preview host", () => {
    // This is the only media origin in the CSP: media-src https://cdnt-preview.dzcdn.net
    const url = "https://cdnt-preview.dzcdn.net/api/1/1/f/8/c/0/abc.mp3?hdnea=exp=1789378735";
    expect(previewSource(url)).toBe(url);
  });

  it("rejects anything that is not a Deezer CDN host", () => {
    // A stale or dead preview must read as "no preview", never as a fault — and never as a
    // way to point the audio element at an arbitrary origin.
    expect(previewSource("https://evil.example.com/a.mp3")).toBeNull();
    expect(previewSource("http://cdnt-preview.dzcdn.net/a.mp3")).toBeNull();
    expect(previewSource("javascript:alert(1)")).toBeNull();
    expect(previewSource(null)).toBeNull();
    expect(previewSource(undefined)).toBeNull();
    expect(previewSource("")).toBeNull();
  });
});

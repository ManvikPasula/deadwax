/**
 * "Listen on" links. PURE and CLIENT-SAFE — no `server-only`, no I/O, no credential.
 *
 * THIS IS THE `watch_providers` PORT, AND IT IS DELIBERATELY NOT A TABLE.
 *
 * The television original mirrors a `watch_providers` table per show, per region, per offer
 * type, filled by TMDB's `append_to_response` bundle. The brief notes that music has no
 * equivalent bundle and that the ingest fan-out would have to grow — per-service lookups or a
 * link aggregator (Odesli / song.link being the JustWatch analogue).
 *
 * That whole subsystem is replaced by deterministic search deeplinks, which is strictly better
 * here for four reasons:
 *
 *   1. ZERO API CALLS. No extra ingest fan-out, no extra outbound budget, no second provider
 *      relationship to keep.
 *   2. NOTHING GOES STALE. A mirrored availability row is wrong the moment a licensing deal
 *      changes; a search URL resolves against live catalogues every time it is clicked.
 *   3. NO `market` THREADING. Spotify's `market` parameter changes WHICH TRACKS AND ALBUMS ARE
 *      RETURNED, not just availability — the brief flags this as a trap that has to be
 *      threaded through detail and search calls. A search URL sidesteps it: the service
 *      resolves the visitor's own region.
 *   4. It is the honest shape of the claim. We are not asserting "this is available on
 *      YouTube Music in your country"; we are offering to look it up, which is what a link
 *      out of a diary should do.
 *
 * The cost, stated plainly: a link can land on a search results page rather than the record
 * itself, and for an obscure release it may find nothing. That is why Deezer's own CANONICAL
 * link is used where we have it (we always do, since Deezer is the catalogue) and the rest are
 * searches.
 *
 * YouTube Music appears here and not as the catalogue for the reason in docs/DECISIONS.md §0:
 * it has no official metadata API, and the sanctioned YouTube Data API allows roughly 100
 * searches per day for an entire platform. As a link target it is excellent — it is where a
 * great many people actually listen.
 */

export type ListenService = "youtube-music" | "spotify" | "apple-music" | "tidal" | "deezer" | "bandcamp";

export type ListenLink = {
  service: ListenService;
  label: string;
  url: string;
  /** True when the URL points at the exact record; false when it is a search. */
  exact: boolean;
};

const LABELS: Record<ListenService, string> = {
  "youtube-music": "YouTube Music",
  spotify: "Spotify",
  "apple-music": "Apple Music",
  tidal: "TIDAL",
  deezer: "Deezer",
  bandcamp: "Bandcamp",
};

/**
 * Query construction is shared so every service receives the same string.
 *
 * Bracketed qualifiers are stripped, because "Abbey Road (Super Deluxe)" finds less than
 * "Abbey Road" does on services that stock a different edition.
 */
function searchTerms(artist: string, title: string): string {
  const clean = (value: string) =>
    value
      .replace(/\s*[([{][^)\]}]*[)\]}]\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return `${clean(artist)} ${clean(title)}`.trim();
}

export function listenLinks({
  artist,
  title,
  deezerUrl,
  services = ["youtube-music", "spotify", "apple-music", "tidal", "deezer"],
}: {
  artist: string;
  title: string;
  /** Deezer's own canonical link, from the album or track payload. */
  deezerUrl?: string | null;
  services?: ListenService[];
}): ListenLink[] {
  const q = encodeURIComponent(searchTerms(artist, title));
  const links: ListenLink[] = [];

  for (const service of services) {
    switch (service) {
      case "youtube-music":
        links.push({ service, label: LABELS[service], url: `https://music.youtube.com/search?q=${q}`, exact: false });
        break;
      case "spotify":
        links.push({ service, label: LABELS[service], url: `https://open.spotify.com/search/${q}`, exact: false });
        break;
      case "apple-music":
        links.push({ service, label: LABELS[service], url: `https://music.apple.com/search?term=${q}`, exact: false });
        break;
      case "tidal":
        links.push({ service, label: LABELS[service], url: `https://listen.tidal.com/search?q=${q}`, exact: false });
        break;
      case "bandcamp":
        links.push({ service, label: LABELS[service], url: `https://bandcamp.com/search?q=${q}`, exact: false });
        break;
      case "deezer":
        // The only one we can point exactly, because Deezer is the catalogue.
        links.push(
          deezerUrl && /^https:\/\/(?:www\.)?deezer\.com\//i.test(deezerUrl)
            ? { service, label: LABELS[service], url: deezerUrl, exact: true }
            : { service, label: LABELS[service], url: `https://www.deezer.com/search/${q}`, exact: false },
        );
        break;
    }
  }

  return links;
}

/**
 * A 30-second preview, when Deezer supplies one.
 *
 * The URL is SIGNED AND EXPIRING (it carries an `exp=` query parameter), so it is refreshed on
 * every album sync and a stale one simply fails to play rather than erroring. The player
 * treats an absent or dead preview as "no preview", never as a fault — which is why
 * `media-src https://cdnt-preview.dzcdn.net` is the only media origin in the CSP and why the
 * button is not rendered at all when this returns null.
 */
export function previewSource(previewUrl: string | null | undefined): string | null {
  if (!previewUrl) return null;
  return /^https:\/\/[a-z0-9.-]*\.dzcdn\.net\//i.test(previewUrl) ? previewUrl : null;
}

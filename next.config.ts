import type { NextConfig } from "next";

/**
 * Four remote image origins, and no more.
 *
 * Every one of these was verified by request, not by documentation:
 *   - cdn-images.dzcdn.net    Deezer covers and artist pictures (56/250/500/1000 px)
 *   - e-cdns-images.dzcdn.net Deezer's legacy image host, still served in some payloads
 *   - coverartarchive.org     the Cover Art Archive fallback
 *   - *.archive.org           where Cover Art Archive 302-redirects. A `front-500` request
 *                             for Kid A's release group landed on
 *                             dn710905.ca.archive.org, so the wildcard is required — the
 *                             node is not stable.
 *
 * This list and the `img-src` directive in `proxy.ts` must move in lockstep. Adding a host
 * here without adding it there produces images that 200 from the CDN and are then blocked
 * by the browser, which presents as "the image is broken" rather than as a policy refusal.
 */
const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "cdn-images.dzcdn.net", pathname: "/**" },
      { protocol: "https", hostname: "e-cdns-images.dzcdn.net", pathname: "/**" },
      { protocol: "https", hostname: "coverartarchive.org", pathname: "/**" },
      { protocol: "https", hostname: "*.archive.org", pathname: "/**" },
    ],
  },
  // The provider clients and the ingest layer are server-only; nothing about them should be
  // traced into a client bundle. `serverExternalPackages` keeps the native/wasm database
  // drivers out of the bundler's way.
  serverExternalPackages: ["@electric-sql/pglite", "pg", "bcryptjs"],
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;

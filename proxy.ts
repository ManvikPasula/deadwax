import { NextResponse, type NextRequest } from "next/server";

/**
 * Browser hardening. Next 16 renamed Middleware to Proxy, so this file is `proxy.ts` and the
 * export is `proxy` — a file still called `middleware.ts` is silently not run.
 *
 * ================================================================================
 * WHAT THIS PROXY DOES NOT DO, AND IT IS LOAD-BEARING.
 *
 * It never calls `auth()`. It never reads a cookie. It never redirects. IT PROTECTS NO ROUTE.
 * There is no matcher on `/settings`, none on `/admin`, none on `/for-you`. Every
 * authorization decision in this application happens inside the page or inside the action:
 * `currentUser` / `requireUser` / `requireMember` / `requireAdmin`, plus queries that
 * self-gate.
 *
 * IF YOU PORT A MATCHER REGEX FROM ANOTHER PROJECT EXPECTING IT TO GATE ROUTES, YOU SHIP AN
 * UNPROTECTED APP. The matcher below exists only to decide which responses get headers, and
 * loosening or tightening it changes nothing about who can reach what.
 *
 * That is a deliberate design choice, not an omission. A proxy-level check runs on a request
 * shape rather than on a resolved page, so it cannot know which member owns the list being
 * edited; a check that cannot express the real rule is a check that has to be duplicated in
 * the page anyway, and a duplicated authorization rule is the defect this whole codebase is
 * organised against. It also cannot see a deleted account: these are stateless JWTs, so a
 * cookie decodes fine after the row behind it is gone (I-17) — only a database read can catch
 * that, and the proxy does not have one.
 * ================================================================================
 */

/**
 * A NONCE PER REQUEST. A reused nonce is the same as no nonce: `'strict-dynamic'` trusts any
 * script carrying it, so a value an attacker can learn once and replay is a value that lets
 * them inject a script forever.
 *
 * `randomUUID()` rather than `randomBytes`, because the proxy must stay dependency-free and
 * `crypto` is global on every runtime this can execute on. Hyphens stripped because a CSP
 * nonce is base64-shaped and hyphens are not in that alphabet — some parsers are forgiving
 * about it and there is no reason to find out which.
 */
function mintNonce(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * THIS LIST AND `next.config.ts`'s `remotePatterns` MUST MOVE IN LOCKSTEP.
 *
 * Adding a host to one and not the other produces an image that returns 200 from the CDN and
 * is then blocked by the browser, which presents to a member as "the image is broken" rather
 * than as a policy refusal — there is nothing in the network panel and nothing in the server
 * log, only a console warning nobody is looking at.
 *
 * `*.archive.org` IS REQUIRED AND IS NOT LAZINESS. The Cover Art Archive answers
 * `coverartarchive.org/release-group/<mbid>/front-500` with a 200 that 302-redirects to a
 * storage node; a verified request landed on `dn710905.ca.archive.org`. The node is chosen per
 * request and is not stable, so the wildcard is the only correct value. Both origins must be
 * present because the redirect is followed by the browser, which checks the policy against the
 * final URL as well as the first.
 */
const IMAGE_HOSTS = [
  "https://cdn-images.dzcdn.net",
  "https://e-cdns-images.dzcdn.net",
  "https://coverartarchive.org",
  "https://*.archive.org",
];

/** Deezer's 30-second preview mp3, and nothing else. This is the whole in-app play button. */
const MEDIA_HOSTS = ["https://cdnt-preview.dzcdn.net"];

/** Eight features, all denied. The app uses a camera, a microphone and a location never. */
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
].join(", ");

function contentSecurityPolicy(nonce: string, isDevelopment: boolean): string {
  return [
    "default-src 'self'",

    // `data:` for the inline SVG placeholders, `blob:` for the object URLs next/image creates.
    `img-src 'self' data: blob: ${IMAGE_HOSTS.join(" ")}`,
    `media-src 'self' ${MEDIA_HOSTS.join(" ")}`,

    // NO HOST HERE, and that is why the fonts must come through `next/font`: it self-hosts
    // them at build time. A `<link>` to a font CDN would need a hole cut in this line.
    "font-src 'self'",

    // No analytics, no tag manager, no chat widget, no error reporter — so nothing legitimate
    // ever talks to a third party. In development this also covers Turbopack's HMR socket:
    // CSP's `'self'` matches `ws:`/`wss:` on the document's own origin.
    "connect-src 'self'",

    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Two spellings of the same refusal, because `X-Frame-Options` is what older browsers
    // honour and `frame-ancestors` is what current ones do. `frame-src 'none'` is the other
    // direction: this app embeds nothing, so there is no iframe to allow.
    "frame-ancestors 'none'",
    "frame-src 'none'",

    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "upgrade-insecure-requests",

    /**
     * `'strict-dynamic'` is what makes the nonce worth minting: a nonced script may load
     * further scripts, which is how Next's own chunk loading works, while an injected
     * `<script src>` without the nonce cannot. `'self'` is kept as the CSP2 fallback for
     * browsers that ignore `'strict-dynamic'` — in CSP3 it is ignored in its presence.
     *
     * `'unsafe-eval'` IN DEVELOPMENT ONLY, because React Refresh and the dev bundler use
     * `eval` to install module updates. It is the one directive that differs between
     * environments, and it differs in the safe direction.
     */
    isDevelopment
      ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`
      : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,

    /**
     * `'unsafe-inline'` IS KEPT DELIBERATELY, and this is the one place the policy is looser
     * than it could be.
     *
     * The interface sets `style` ATTRIBUTES from computed values: heatmap cell colours from
     * `ratingColor`, avatar gradients from `avatar_seed`, meter widths from a percentage.
     * None of it is attacker-controlled — every one of those values is a number or an enum
     * produced by our own code — and none of it can be expressed as a class, because the set
     * of possible values is continuous.
     *
     * Removing it would break the signature view of the product and close no real attack
     * path: CSS injection needs an injection point, and the only way to reach these
     * attributes is through the same server components that compute them. Nonces do not help
     * either, since a nonce cannot be attached to a style attribute at all.
     */
    "style-src 'self' 'unsafe-inline'",
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = mintNonce();
  const isDevelopment = process.env.NODE_ENV !== "production";

  /**
   * THE NONCE GOES ON BOTH SIDES.
   *
   * On the forwarded REQUEST headers, because the layout reads it with `headers()` to put it
   * on the few `<script>` tags the app renders itself. On the RESPONSE, so it is inspectable
   * and so anything downstream that needs it does not have to re-derive it. Setting it on only
   * the response is the common mistake: the policy then names a nonce no script carries, and
   * every script is blocked.
   */
  const forwarded = new Headers(request.headers);
  forwarded.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: forwarded } });

  response.headers.set("x-nonce", nonce);
  response.headers.set("Content-Security-Policy", contentSecurityPolicy(nonce, isDevelopment));

  // Two years, subdomains included, preload-eligible. Browsers only record HSTS from an HTTPS
  // response, so sending it in local development is inert rather than wrong.
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  response.headers.set("X-Content-Type-Options", "nosniff");
  // Full URL to our own origin, bare origin cross-site. This is what keeps a password-reset
  // token out of a `Referer` header on an outbound link; the reset page additionally sets
  // `referrer: "no-referrer"` for itself, because one layer that can be misconfigured is not
  // enough for a bearer token in a URL.
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  response.headers.set("X-Frame-Options", "DENY");
  // Severs the `window.opener` link, so a page this app opens cannot navigate it. Cheap, and
  // the only reason it is not also `Cross-Origin-Embedder-Policy` is that COEP would block the
  // provider images above without a CORP header we do not control.
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");

  return response;
}

/**
 * DOCUMENTS ONLY, AND PREFETCHES SKIPPED.
 *
 * Every directive above applies to a document: a CSP on a JSON response governs nothing, and
 * a nonce on an image is noise. Running this on every asset request would cost a proxy
 * invocation each time for no benefit — on a page with thirty covers that is thirty
 * invocations to set headers nothing reads.
 *
 *   `source`  excludes the build output and any path that looks like a static file.
 *   `has`     keeps only requests that ask for HTML. RSC navigations send
 *             `Accept: text/x-component` and API calls send JSON, so both fall out here.
 *   `missing` drops prefetches. A prefetch renders no document, so its headers are discarded —
 *             and a nonce minted for a discarded response is a nonce nothing can use.
 *
 * Say it once more because the shape of this block invites the assumption: NOTHING HERE IS A
 * SECURITY BOUNDARY. Widening it adds headers to more responses; narrowing it adds them to
 * fewer. It grants and denies no access.
 */
export const config = {
  matcher: [
    {
      source:
        "/((?!api/|_next/static/|_next/image|_next/data/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|mp3|txt|xml|json|webmanifest)$).*)",
      has: [{ type: "header", key: "accept", value: ".*text/html.*" }],
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};

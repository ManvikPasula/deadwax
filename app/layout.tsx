/**
 * The root shell: skip link, header, guest strip, verify banner, main, footer.
 *
 * FONTS GO THROUGH `next/font`, WHICH IS A SECURITY DECISION AS WELL AS A PERFORMANCE ONE.
 * next/font downloads the files at build time and serves them from our own origin, so
 * `font-src 'self'` in the CSP (proxy.ts) needs no exception and there is no third-party
 * request on the critical path. Switching any of these three to a CDN link means editing the
 * CSP too, and the failure mode is invisible in development and total in production.
 *
 * Each family is assigned to a CSS variable rather than a class, because globals.css wraps
 * those same variable names with fallback stacks inside `@theme` — see the long comment there
 * about why the self-reference is not a cycle.
 *
 * ============================================================================
 * THE Z-INDEX LADDER — FIVE VALUES IN THE WHOLE APP. Nothing else may invent a rung.
 *
 *   z-10  the feed's sticky date headers        (components/social/activity-feed.tsx)
 *   z-50  the sticky site header                (components/nav/site-header.tsx)
 *   z-60  the film grain                        (app/globals.css, body::after)
 *   z-70  the dialog overlay                    (components/ui/dialog.tsx)
 *   z-80  dialog content and dropdown content   (components/ui/dialog.tsx, menu.tsx)
 *   z-90  the focused skip link                 (below)
 *
 * TWO OF THOSE ORDERINGS ARE DELIBERATE AND LOOK LIKE MISTAKES:
 *
 *   - THE GRAIN SITS OVER THE HEADER (60 > 50). The header is translucent
 *     (`bg-ink/85 backdrop-blur-md`), so if the grain stopped underneath it the header would
 *     be the one clean rectangle on an otherwise grained page, and the seam would be visible
 *     on every scroll.
 *   - THE SKIP LINK OUTRANKS EVERYTHING (90). It is the first thing a keyboard user reaches
 *     on the page, and a skip link that renders behind the header is a skip link that does
 *     not exist.
 * ============================================================================
 */

import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import type * as React from "react";

import "./globals.css";

import { GuestStrip } from "@/components/auth/guest-strip";
import { VerifyBanner } from "@/components/auth/verify-banner";
import { SiteFooter } from "@/components/nav/site-footer";
import { SiteHeader } from "@/components/nav/site-header";
import { env } from "@/lib/env";

/** Display, headlines only. Instrument Serif ships one weight, so `weight` is required. */
const display = Instrument_Serif({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
});

const sans = Geist({ subsets: ["latin"], display: "swap", variable: "--font-sans" });

/** Every label and every number in the interface. See §11.7 of docs/ARCHITECTURE.md. */
const mono = Geist_Mono({ subsets: ["latin"], display: "swap", variable: "--font-mono" });

/**
 * SET ONCE, AT THE ROOT, AND NEVER OVERRIDDEN.
 *
 * `title.template` means a page exports `metadata: { title: "Search" }` and gets
 * "Search · Deadwax" — so no page ever repeats the product name, and the separator can be
 * changed in one place. OpenGraph is declared here and nowhere else for the same reason: a
 * per-page copy would drift, and the pages most likely to be shared are the ones least
 * likely to be remembered when the copy changes.
 *
 * `metadataBase` is what makes the relative `url` below resolve. `env.siteUrl` is safe to
 * read at module scope: unlike the required getters it never throws, falling back through
 * AUTH_URL and the Vercel-provided host to http://localhost:3000.
 *
 * Token-bearing routes (/verify, /reset, /forgot) and the admin routes add their own
 * `robots: noindex` and `referrer: "no-referrer"`; those are the only metadata additions in
 * the app.
 */
export const metadata: Metadata = {
  metadataBase: new URL(env.siteUrl),
  title: {
    default: "Deadwax — a social diary for records",
    template: "%s · Deadwax",
  },
  description:
    "Rate and review albums, tracks and artists, keep a diary of what you played, and find records through people whose taste you already trust.",
  applicationName: "Deadwax",
  openGraph: {
    type: "website",
    siteName: "Deadwax",
    title: "Deadwax — a social diary for records",
    description:
      "Rate and review albums, tracks and artists, keep a diary of what you played, and find records through people whose taste you already trust.",
    url: "/",
    locale: "en_GB",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="min-h-dvh antialiased">
        {/*
          `sr-only` until focused, then a real, visible, amber-outlined control at z-90.
          `focus:fixed` rather than `focus:absolute`: the link must land in the viewport even
          when focus arrives after the page has been scrolled.
        */}
        <a
          href="#main"
          className="sr-only rounded-card focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-90 focus:border focus:border-line focus:bg-surface focus:px-3 focus:py-2 focus:font-mono focus:text-[0.6875rem] focus:uppercase focus:tracking-wider focus:text-paper"
        >
          Skip to content
        </a>

        {/*
          SiteHeader is an async Server Component that calls `currentUser()` directly, so the
          header re-reads the session on every navigation instead of hydrating a client auth
          context. GuestStrip and VerifyBanner are usually invisible — GuestStrip still mounts
          its client half when hidden, because that half owns the leaving warning.
        */}
        <SiteHeader />
        <GuestStrip />
        <VerifyBanner />

        <main id="main" className="mx-auto w-full max-w-7xl px-4 pb-24 pt-6 sm:px-6">
          {children}
        </main>

        <SiteFooter />
      </body>
    </html>
  );
}

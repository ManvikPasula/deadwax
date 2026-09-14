/**
 * The footer. A Server Component with no props, rendered once by app/layout.tsx.
 *
 * IT CARRIES TWO THINGS THE HEADER DELIBERATELY DOES NOT.
 *
 * 1. `/spotlight`. The indie spotlight is worth finding, but it is not one of the things
 *    somebody opens the app to do, and the header is reserved for those. A footer link plus an
 *    indexable route is the right weight for it.
 *
 * 2. THE PROVIDER ATTRIBUTION, WHICH IS A LICENCE OBLIGATION AND NOT DECORATION. Deezer's API
 *    terms and MusicBrainz's data licence both require naming and linking the source; cover
 *    art comes from the Cover Art Archive, which is credited for the same reason. Every
 *    album, artist, tracklist and sleeve in this product came from one of those three, all of
 *    them keyless and free, and the credit is the price. DO NOT MOVE THIS INTO A COLLAPSED
 *    SECTION, A TOOLTIP OR AN /about PAGE: it has to be on the page the data is on, which —
 *    since this footer is in the root layout — is every page.
 *
 * MusicBrainz data spans CC0 and CC BY-NC-SA depending on the field, so the wording says
 * exactly that rather than picking the friendlier one.
 */

import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { Eyebrow } from "@/components/ui/primitives";

const FOOTER_LINK = "rounded-card text-[0.8125rem] text-muted transition-colors hover:text-paper";

/** External credits open in place: a new tab is a decision that belongs to the reader. */
const CREDIT_LINK = "rounded-card text-paper underline decoration-line-bright underline-offset-2 hover:decoration-amber";

export function SiteFooter() {
  return (
    <footer className="border-t bg-surface/40">
      <div className="mx-auto grid w-full max-w-7xl gap-8 px-4 py-10 sm:grid-cols-2 sm:px-6 lg:grid-cols-4">
        <div className="space-y-3">
          <Logo />
          <p className="max-w-xs text-[0.8125rem] leading-relaxed text-faint">
            A social diary for records. Rate the album, rate the tracks, and keep the receipts.
          </p>
        </div>

        <nav aria-label="Browse" className="space-y-2">
          <Eyebrow>Browse</Eyebrow>
          <ul className="space-y-1.5">
            <li>
              <Link href="/albums" className={FOOTER_LINK}>
                Albums
              </Link>
            </li>
            <li>
              <Link href="/artists" className={FOOTER_LINK}>
                Artists
              </Link>
            </li>
            <li>
              <Link href="/lists" className={FOOTER_LINK}>
                Lists
              </Link>
            </li>
            <li>
              <Link href="/members" className={FOOTER_LINK}>
                Members
              </Link>
            </li>
          </ul>
        </nav>

        <nav aria-label="More" className="space-y-2">
          <Eyebrow>More</Eyebrow>
          <ul className="space-y-1.5">
            <li>
              {/* Footer-linked and nowhere else — see the docblock. */}
              <Link href="/spotlight" className={FOOTER_LINK}>
                Artist spotlight
              </Link>
            </li>
            <li>
              <Link href="/search" className={FOOTER_LINK}>
                Search
              </Link>
            </li>
            <li>
              <Link href="/for-you" className={FOOTER_LINK}>
                For you
              </Link>
            </li>
          </ul>
        </nav>

        {/*
          A `section` with a real heading rather than a bare paragraph, so the credit is
          navigable by landmark and by heading — somebody auditing the attribution can find it
          without reading the whole footer.
        */}
        <section aria-labelledby="provider-credit" className="space-y-2">
          <Eyebrow id="provider-credit">Data and artwork</Eyebrow>
          <p className="text-[0.8125rem] leading-relaxed text-muted">
            Catalogue metadata from{" "}
            <a href="https://www.deezer.com" className={CREDIT_LINK}>
              Deezer
            </a>{" "}
            and{" "}
            <a href="https://musicbrainz.org" className={CREDIT_LINK}>
              MusicBrainz
            </a>{" "}
            — MusicBrainz data is CC0 or CC BY-NC-SA depending on the field. Cover art from the{" "}
            <a href="https://coverartarchive.org" className={CREDIT_LINK}>
              Cover Art Archive
            </a>
            . Ratings and reviews are our members&rsquo; own.
          </p>
        </section>
      </div>

      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-5 sm:px-6">
        <p className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
          Deadwax · {new Date().getFullYear()}
        </p>
        <p className="font-mono text-[0.6875rem] uppercase tracking-wider text-faint">
          No trackers · no third-party scripts
        </p>
      </div>
    </footer>
  );
}

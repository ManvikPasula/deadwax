/**
 * "Listen on" — the `watch_providers` port.
 *
 * NO `"use client"`. `listenLinks()` is pure and client-safe, but nothing here holds state or
 * handles an event, so this renders on the server like the rest of the album page.
 *
 * ---------------------------------------------------------------------------------------
 * ONE LINK IS EXACT AND THE REST ARE SEARCHES, AND THE DIFFERENCE IS MARKED
 * ---------------------------------------------------------------------------------------
 *
 * There is no availability table in this product (lib/listen.ts writes out why: zero API
 * calls, nothing goes stale, no `market` threading, and it is the honest shape of the claim).
 * What that buys is that four of these five links are DETERMINISTIC SEARCH DEEPLINKS, and a
 * search can land on a results page rather than on the record.
 *
 * So the component says which is which. Deezer's own canonical URL — the one case where we
 * hold the record's real address, because Deezer is the catalogue — gets an "Exact" badge, and
 * every other row carries a visible "Search" label rather than implying it will land on the
 * album. THE ALTERNATIVE IS THE DISHONEST ONE: five identical buttons assert five equally
 * precise destinations, and the member who lands on a search result for an obscure reissue
 * reads that as our bug rather than as the limit of a deeplink.
 *
 * `target="_blank"` with `rel="noreferrer"`. `noreferrer` implies `noopener`, so the opened
 * tab gets no `window.opener` handle back into this origin AND no Referer header naming which
 * album page somebody left from — the second half being a privacy property rather than a
 * security one, and the reason `noreferrer` is written rather than the narrower `noopener`.
 *
 * THE NEW TAB IS ANNOUNCED. `sr-only` text says "opens in a new tab" on every row, because a
 * link that replaces nothing and silently spawns a tab is disorienting for anybody who cannot
 * see it happen, and the `ExternalLink` glyph is decoration that says nothing out loud.
 */

import { ExternalLink } from "lucide-react";
import type * as React from "react";

import { Badge, Eyebrow } from "@/components/ui/primitives";
import { listenLinks, type ListenService } from "@/lib/listen";
import { cn } from "@/lib/utils";

export type ListenLinksProps = {
  /** The album or track artist — whatever the member is looking at. */
  artist: string;
  /** The album or track title. Bracketed qualifiers are stripped inside `listenLinks`. */
  title: string;
  /** Deezer's own canonical link from the mirrored payload. Absent ⇒ Deezer is a search too. */
  deezerUrl?: string | null;
  /**
   * Defaults to the five in `listenLinks` (YouTube Music, Spotify, Apple Music, TIDAL,
   * Deezer). Bandcamp exists in the library and is deliberately not in the default set: it
   * stocks a fraction of the catalogue, so it is the one service where a search is usually a
   * dead end rather than a detour.
   */
  services?: ListenService[];
  /** Hide the section label when the caller already has a heading above it. */
  heading?: React.ReactNode;
  className?: string;
};

export function ListenLinks({ artist, title, deezerUrl, services, heading = "Listen on", className }: ListenLinksProps) {
  const links = listenLinks({ artist, title, deezerUrl, services });
  if (links.length === 0) return null;

  return (
    <section className={cn("space-y-2", className)}>
      {heading ? <Eyebrow>{heading}</Eyebrow> : null}

      <ul className="flex flex-wrap gap-1.5">
        {links.map((link) => (
          <li key={link.service}>
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-card border border-line bg-surface-2 px-2.5 py-1.5",
                "font-mono text-[0.6875rem] uppercase tracking-wider text-muted transition-colors",
                "hover:border-line-bright hover:bg-surface-3 hover:text-paper",
                "[&_svg]:size-3 [&_svg]:shrink-0",
              )}
            >
              {link.label}
              {/*
                THE MARK OF EXACTNESS. A badge for the one canonical link and a plain word for
                the rest — not a colour difference, because "this one actually goes there" is
                information and colour alone is not a channel this app uses on its own.
              */}
              {link.exact ? (
                <Badge tone="amber" className="border-0 bg-transparent px-0 py-0 text-amber">
                  Exact
                </Badge>
              ) : (
                <span className="text-faint">Search</span>
              )}
              <ExternalLink aria-hidden="true" />
              <span className="sr-only">
                {link.exact
                  ? ` — ${title} on ${link.label}, opens in a new tab`
                  : ` — search ${link.label} for ${artist} ${title}, opens in a new tab`}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

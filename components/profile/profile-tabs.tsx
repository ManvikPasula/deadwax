"use client";

/**
 * The profile's six tabs — AND THEY ARE SIX ROUTES, NOT SIX TAB PANELS.
 *
 * `/@name`, `/@name/diary`, `/@name/albums`, `/@name/wantlist`, `/@name/lists`,
 * `/@name/year/[year]`.
 *
 * > "These are separate routes rather than tab panels, so the highlight comes from the
 * > pathname instead of local state — every tab is linkable and survives a reload."
 *
 * components/ui/tabs.tsx says the same thing from the other side and names this component as
 * the counter-example: rebuilding these as Radix tabs would make five sixths of a member's
 * profile unaddressable and would lose the back button. Its own test is the right one — IF
 * SOMEBODY MIGHT WANT TO SEND A LINK TO THE PANEL, IT IS A ROUTE.
 *
 * `/@name/network` IS DELIBERATELY NOT A TAB. It is reached only from the follower and
 * following counters in `ProfileHeader`. Seven tabs on a phone is a scrolling strip where the
 * seventh is off-screen, and "who follows this person" is a detour from reading their diary
 * rather than one of the six things the profile is.
 *
 * ---------------------------------------------------------------------------------------
 * `"use client"` IS FOR EXACTLY ONE THING: `usePathname()`
 * ---------------------------------------------------------------------------------------
 *
 * Nothing else here needs the browser. The rejected alternative was passing the active
 * segment down from each page as a prop, which keeps this a Server Component — and puts the
 * same literal ("diary", "albums", …) in six page files, where the one that is wrong renders a
 * highlight on the wrong tab and nothing fails.
 *
 * ---------------------------------------------------------------------------------------
 * THE TWO THINGS THE ACTIVE TEST GETS RIGHT
 * ---------------------------------------------------------------------------------------
 *
 *   1. `decodeURIComponent`. THE `@` IS PERCENT-ENCODED in `usePathname()`, so the raw value
 *      is `/%40nadia/diary` and every comparison against a `/@nadia/...` href fails — with no
 *      error, just a strip where nothing is ever highlighted. The trailing slash is stripped
 *      for the same class of reason: `/@nadia/` and `/@nadia` are the same page.
 *
 *   2. EXACT FOR THE ROOT TAB, PREFIX FOR THE REST. The root tab's path is a prefix of every
 *      other tab's, so a prefix test there lights "Profile" on all six pages. The rest need
 *      the prefix precisely because of the year tab: the link points at one year
 *      (`/year/2025`) while the member may be reading another (`/year/2019`), and only a
 *      prefix match on `/year` keeps the tab lit where they actually are.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { cn } from "@/lib/utils";

type TabSpec = {
  label: string;
  /** Appended to `/@username`. Empty string is the root tab. */
  segment: string;
  /**
   * Where the link goes, when that differs from the segment — only the year tab, whose
   * segment is the family (`/year`) and whose href must name a specific year.
   */
  href?: string;
};

export type ProfileTabsProps = {
  /** The profile's owner. Safe to interpolate: `usernameSchema` is a `[a-zA-Z0-9_]` allowlist. */
  username: string;
  /**
   * Which year the "Year in review" tab links to.
   *
   * REQUIRED, AND COMPUTED ON THE SERVER — `getLoggedYears(userId)[0]` when the member has
   * logged anything, the current year otherwise. Defaulting to `new Date().getFullYear()`
   * inside this client component was the rejected alternative: it is evaluated in the browser,
   * so the link can differ between the server render and the hydration on either side of a
   * new year, and the route's bounds (1900–2200) belong to the page that validates them.
   */
  year: number;
  /**
   * Drop the wantlist tab. `wantlist_private` is checked in BOTH `generateMetadata` and the
   * route body, so a private wantlist 404s for a visitor — and a tab that leads to a 404 is
   * worse than an absent one. The owner always sees their own.
   */
  showWantlist?: boolean;
  className?: string;
};

export function ProfileTabs({ username, year, showWantlist = true, className }: ProfileTabsProps) {
  const pathname = usePathname();
  const base = `/@${username}`;

  const tabs = React.useMemo<TabSpec[]>(
    () =>
      [
        { label: "Profile", segment: "" },
        { label: "Diary", segment: "/diary" },
        { label: "Albums", segment: "/albums" },
        showWantlist ? { label: "Wantlist", segment: "/wantlist" } : null,
        { label: "Lists", segment: "/lists" },
        { label: "Year in review", segment: "/year", href: `${base}/year/${year}` },
      ].filter((tab): tab is TabSpec => tab !== null),
    [base, showWantlist, year],
  );

  // See the docblock: decode first (the `@` arrives as `%40`), then drop a trailing slash so
  // `/@nadia/` and `/@nadia` compare equal.
  const current = decodeURIComponent(pathname).replace(/\/$/, "");

  return (
    /*
      A `<nav>` WITH ITS OWN NAME. These are six links, so the landmark is navigation rather
      than a `tablist` — and a `role="tablist"` here would promise arrow-key traversal between
      panels that do not exist, which is worse than no role at all.

      The scrollbar is hidden, the documented opt-out from globals.css: six mono labels overflow
      a phone, and a scrollbar under one row of links reads as an accident.
    */
    <nav
      aria-label={`Sections of ${username}'s profile`}
      className={cn("overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}
    >
      {/*
        THE CLASSES DELIBERATELY MIRROR `TabsList` / `TabsTrigger` from components/ui/tabs.tsx,
        so the only switch in the app that IS Radix (the heatmap's colour source) and the only
        one that is routed look identical. The markup cannot be shared — one is a list of
        `<a>`, the other a set of `<button role="tab">` — but the paint is one vocabulary and
        a second visual language for "tabs" would teach the reader that the two mean different
        things.
      */}
      <ul className="inline-flex w-max items-center gap-1 rounded-card border border-line bg-surface-2 p-1">
        {tabs.map((tab) => {
          const target = `${base}${tab.segment}`;
          const active =
            tab.segment === ""
              ? // EXACT for the root, or it lights on every child.
                current === target
              : // PREFIX for the rest, so `/year/2019` still lights "Year in review". The `/`
                // in the second test is what stops `/albums` matching a hypothetical
                // `/albums-of-the-year`.
                current === target || current.startsWith(`${target}/`);

          return (
            <li key={tab.segment || "root"}>
              <Link
                href={tab.href ?? target}
                // `aria-current` IS THE DATA; the filled surface is the paint. A highlight with
                // no `aria-current` tells a screen-reader user nothing about where they are,
                // which on a six-route profile is the whole navigation.
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block rounded-[0.375rem] px-3 py-1.5 font-mono text-[0.6875rem] uppercase tracking-wider",
                  "transition-colors",
                  active ? "bg-surface-3 text-paper" : "text-faint hover:text-paper",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

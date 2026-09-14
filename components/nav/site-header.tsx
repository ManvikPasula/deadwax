/**
 * The sticky site header.
 *
 * AN ASYNC SERVER COMPONENT THAT CALLS `currentUser()` DIRECTLY, and that is the whole point:
 * the header re-reads the session on every navigation rather than hydrating a client auth
 * context. The rejected alternative was a `<SessionProvider>` wrapping the app with
 * `useSession()` here — it ships the auth client to every page, renders a signed-out header
 * for one frame on first paint, and buys nothing, because `currentUser()` is free (it decodes
 * the cookie, zero queries — see the ladder in lib/auth/session.ts).
 *
 * The two client islands are exactly the two things that need the browser: `SearchBox` (local
 * input state) and `AccountMenu` (a Radix dropdown). Everything else here is markup.
 *
 * `z-50` — rung two of the five-value ladder documented in app/layout.tsx. The film grain sits
 * ABOVE this at z-60 on purpose, because this bar is translucent and a clean rectangle of
 * un-grained header over a grained page shows its seam on every scroll.
 *
 * NO ACTIVE-LINK STATE, DELIBERATELY. Marking the current section needs the pathname, which
 * needs `usePathname`, which would make this a Client Component and cost exactly the
 * server-side session read that is the reason it exists. The nav is four links; the page's own
 * h1 says where you are.
 */

import { Search } from "lucide-react";
import Link from "next/link";

import { AccountMenu } from "@/components/nav/account-menu";
import { SearchBox } from "@/components/nav/search-box";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { currentUser } from "@/lib/auth/session";
import { cn } from "@/lib/utils";

/** Mono, 11px, uppercase — nav links are labels, and every label in this app is mono (§11.7). */
const NAV_LINK = cn(
  "shrink-0 rounded-card px-1 py-1 font-mono text-[0.6875rem] uppercase tracking-wider",
  "text-muted transition-colors hover:text-paper",
);

export async function SiteHeader() {
  const viewer = await currentUser();

  return (
    <header className="sticky top-0 z-50 border-b bg-ink/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4 sm:px-6">
        {/*
          One `Logo`, with the wordmark hidden below `sm` through its own class hook rather
          than by rendering a second mark-only copy — two copies would announce "Deadwax"
          twice, since `Logo` carries the accessible name in an `sr-only` span.
        */}
        <Link href="/" className="shrink-0 rounded-card" aria-label="Deadwax — home">
          <Logo wordClassName="hidden sm:inline" />
        </Link>

        {/*
          The nav never collapses into a menu. Four eleven-pixel labels fit beside the mark on
          a phone, and the horizontal-scroll escape hatch (with the bar hidden, as globals.css
          prescribes for rails) covers the narrowest viewports without a dialog, a hamburger
          or a second copy of the same links.
        */}
        <nav
          aria-label="Sections"
          className="flex min-w-0 items-center gap-3 overflow-x-auto sm:gap-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <Link href="/albums" className={NAV_LINK}>
            Browse
          </Link>
          <Link href="/artists" className={NAV_LINK}>
            Artists
          </Link>
          <Link href="/lists" className={NAV_LINK}>
            Lists
          </Link>
          {/*
            ONLY WHEN SIGNED IN: /for-you is built from the viewer's own ratings, so for a
            visitor it is not an empty page, it is a page with no possible content. A guest
            session counts as signed in — a guest rates and therefore has a taste profile.
          */}
          {viewer ? (
            <Link href="/for-you" className={NAV_LINK}>
              For you
            </Link>
          ) : null}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/*
            The box itself is hidden below `sm` and replaced by a link to the search page —
            a 200px input cannot share a 360px bar with a wordmark and an avatar, and a link
            to a real route degrades better than an input that overflows.
          */}
          <SearchBox className="hidden sm:block" />
          <Link
            href="/search"
            aria-label="Search"
            className="rounded-card p-2 text-muted transition-colors hover:bg-surface-2 hover:text-paper sm:hidden"
          >
            <Search className="size-4" aria-hidden="true" />
          </Link>

          {viewer ? (
            <AccountMenu username={viewer.username} avatarSeed={viewer.avatarSeed} isGuest={viewer.isGuest} />
          ) : (
            <>
              <Button asChild variant="ghost" size="sm">
                <Link href="/login">Sign in</Link>
              </Button>
              {/*
                NOT `primary`. At most one amber button per view, and on the landing page that
                one is "Start your diary" in the hero — the thing we actually want pressed.
              */}
              <Button asChild variant="secondary" size="sm" className="hidden sm:inline-flex">
                <Link href="/signup">Sign up</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

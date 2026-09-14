"use client";

/**
 * The avatar dropdown in the header. Profile, settings, sign out.
 *
 * `"use client"` because it is built on components/ui/menu, which is Radix — hooks and a
 * portal. Nothing else here needs the browser.
 *
 * A GUEST GETS A DIFFERENT MENU, not a disabled copy of this one:
 *
 *   - the avatar takes the placeholder branch (`isGuest` → the outline glyph), because the
 *     generated gradient is an identity and a guest does not have one yet;
 *   - SETTINGS IS ABSENT. A guest cannot reach /settings at all, and a menu item that exists
 *     to refuse you is worse than one that is not there;
 *   - the two conversion doors are here instead, which is the whole design of guest mode: the
 *     things a guest cannot do are the reasons to sign up;
 *   - SIGNING OUT IS BEHIND A CONFIRM. The framing is deliberately more pessimistic than the
 *     truth — signing out only drops the cookie, and the row survives — but there is no way
 *     back into that row, because the credentials provider refuses `is_guest` rows. "Lost"
 *     is the honest word for a diary nobody can ever open again.
 *
 * WHY `signOut` COMES FROM `next-auth/react` AND NOT A SERVER ACTION: the server-side
 * `signOut` is exported from lib/auth, which is `import "server-only"`, so a client component
 * cannot reach it; and this control is already a client island, so the fetch-and-redirect the
 * auth client does is the shortest honest path. The alternative — a `<form>` posting to
 * `/api/auth/signout` — needs the CSRF token, which means fetching it first anyway.
 */

import { BookMarked, ListMusic, LogOut, Settings, UserPlus, UserRound } from "lucide-react";
import { signOut } from "next-auth/react";
import Link from "next/link";
import * as React from "react";

import { Avatar } from "@/components/ui/avatar";
import { FormError } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { cn } from "@/lib/utils";

export type AccountMenuProps = {
  username: string;
  /** `users.avatar_seed` from the session token. Absent keys the gradient on the username. */
  avatarSeed?: string | null;
  /**
   * The token's `is_guest`, which is PRESENTATION ONLY (types/next-auth.d.ts). It picks the
   * menu and the avatar branch; everything that enforces the distinction re-reads the column.
   */
  isGuest?: boolean;
  className?: string;
};

const GUEST_SIGN_OUT_CONFIRM =
  "Sign out of this guest session? Your diary stays on the server but there is no way back into it — create an account first to keep it.";

export function AccountMenu({ username, avatarSeed, isGuest = false, className }: AccountMenuProps) {
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function leave() {
    // A guest's sign-out is destructive in every way that matters to them, so it is the one
    // menu item that asks. `window.confirm` rather than a dialog: this is a one-sentence
    // question from inside a dropdown, and mounting a second portal over an open menu to ask
    // it is how focus management goes wrong.
    if (isGuest && !window.confirm(GUEST_SIGN_OUT_CONFIRM)) return;

    setError(null);
    setPending(true);
    try {
      await signOut({ redirectTo: "/" });
    } catch {
      // The session cookie is still live, so the honest report is that nothing happened.
      // Rendered inline next to the control, like every other failure in the app.
      setError("Could not sign out. Try again.");
      setPending(false);
    }
  }

  return (
    <Menu>
      <MenuTrigger
        disabled={pending}
        className={cn(
          "flex items-center gap-2 rounded-full border border-line bg-surface-2 py-1 pl-1 pr-2.5",
          "transition-colors hover:bg-surface-3 disabled:opacity-60",
          className,
        )}
      >
        {/* The avatar is `aria-hidden` by contract, so the name comes from the text beside it. */}
        <Avatar username={username} seed={avatarSeed} isGuest={isGuest} size="xs" />
        <span className="hidden font-mono text-[0.6875rem] tracking-wider text-muted sm:inline">
          {isGuest ? "Guest" : `@${username}`}
        </span>
        <span className="sr-only">Account menu</span>
      </MenuTrigger>

      <MenuContent>
        <MenuLabel>{isGuest ? "Guest session" : `@${username}`}</MenuLabel>

        <MenuItem asChild>
          <Link href={`/@${username}`}>
            <UserRound aria-hidden="true" />
            Profile
          </Link>
        </MenuItem>
        <MenuItem asChild>
          <Link href={`/@${username}/diary`}>
            <BookMarked aria-hidden="true" />
            Diary
          </Link>
        </MenuItem>
        <MenuItem asChild>
          <Link href={`/@${username}/lists`}>
            <ListMusic aria-hidden="true" />
            Lists
          </Link>
        </MenuItem>

        <MenuSeparator />

        {isGuest ? (
          <>
            {/* Both doors, because a guest is either a new person or somebody who already
                has an account, and Path A (claim in place) and Path B (merge) are different
                routes through lib/auth/claim.ts. */}
            <MenuItem asChild>
              <Link href="/signup">
                <UserPlus aria-hidden="true" />
                Create an account
              </Link>
            </MenuItem>
            <MenuItem asChild>
              <Link href="/login">
                <UserRound aria-hidden="true" />
                I already have one
              </Link>
            </MenuItem>
          </>
        ) : (
          <MenuItem asChild>
            <Link href="/settings">
              <Settings aria-hidden="true" />
              Settings
            </Link>
          </MenuItem>
        )}

        {/*
          `preventDefault()` KEEPS THE MENU OPEN. Radix closes on select, which unmounts this
          content and its portal — so without this the confirm would be asked by a component
          already on its way out and a failed sign-out would have nowhere to render. The menu
          closes on its own the moment `signOut` navigates.
        */}
        <MenuItem
          disabled={pending}
          onSelect={(event) => {
            event.preventDefault();
            void leave();
          }}
        >
          <LogOut aria-hidden="true" />
          {isGuest ? "Discard and leave" : "Sign out"}
        </MenuItem>

        {error ? <FormError message={error} className="px-2.5 pb-1.5" /> : null}
      </MenuContent>
    </Menu>
  );
}

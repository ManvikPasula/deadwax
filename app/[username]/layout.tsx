/**
 * The profile shell — header, tab strip, and whichever of the seven profile routes is under it.
 *
 * ============================================================================
 * THE FOLDER IS `app/[username]/`, NOT `app/@[username]/`, AND THE `@` IS PART OF THE VALUE.
 *
 * `@` has a meaning to the App Router as a folder prefix (a named slot), so the segment is a
 * plain dynamic one and the sigil lives in the URL text. A profile is `/@nadia`, therefore
 * THIS ROUTE RECEIVES `username = "@nadia"` and has to take the sigil off itself.
 *
 * Consequence, and it is the reason `profileUsername` refuses anything without a leading `@`:
 * this segment sits at the TOP LEVEL, so it matches every one-segment path that no static
 * route claimed. Without the sigil check, `/robots.txt`, `/favicon.ico` and every typo of
 * `/albums` would become a member lookup — one query per stray request, and a 404 rendered
 * from a database miss instead of from the URL grammar.
 * ============================================================================
 *
 * WHY THE HEADER AND THE TABS LIVE IN A LAYOUT. They are identical on all seven routes and the
 * layout is not re-rendered on a navigation between them, so moving between Diary and Albums
 * re-runs only the page's own reads. The rejected alternative — a shared component each page
 * renders — costs the header's two reads on every tab change and lets one page forget it.
 *
 * WHAT A LAYOUT CANNOT DO IS HAND ANYTHING DOWN. There is no prop channel from a layout to a
 * page, so the page resolves the member again. That is one indexed lookup against the
 * functional unique index `users_username_lower_uq`; the EXPENSIVE read is `getProfileStats`
 * (four CTEs and nine scalar subqueries) and THAT one is wrapped in React `cache()`, so the
 * layout and the page may both call it and it runs once per request. Threading a value through
 * props to dodge a second call is exactly what the `cache()` wrapper exists to make
 * unnecessary — see its docblock, where running twice per view is recorded as a defect.
 *
 * A LAYOUT'S `notFound()` DOES NOT COVER ITS PAGES. Layout and page render in the same pass,
 * not in sequence, so a page whose own body skipped the check could still complete. Every
 * route under here therefore calls `loadProfile` for itself — and `generateMetadata` calls it
 * too, which is the same "two entry points, one check" rule that SEC-02 was.
 */

import { notFound } from "next/navigation";
import type * as React from "react";

import { ProfileHeader } from "@/components/profile/profile-header";
import { ProfileTabs } from "@/components/profile/profile-tabs";
import { currentUser } from "@/lib/auth/session";
import {
  canViewWantlist,
  getFollowCounts,
  getUserByUsername,
  isFollowing,
  type MemberRecord,
} from "@/lib/db/queries/users";
import { MAX_USERNAME_LENGTH, MIN_USERNAME_LENGTH } from "@/lib/security/schemas";
import { getLoggedYears } from "@/lib/stats/year";

/**
 * THE URL GRAMMAR FOR A HANDLE, WHICH IS DELIBERATELY NOT `usernameSchema`.
 *
 * The registration rule additionally refuses reserved words and the `guest_` prefix — and
 * every guest is literally called `guest_<10 hex>`. Validating a URL with the registration
 * schema would therefore 404 every guest's own profile, diary and year page, which is the one
 * thing guest mode exists to keep working. So this is the shape only: the same
 * `[a-zA-Z0-9_]` allowlist and the same two length bounds, imported rather than retyped.
 */
const HANDLE_PATTERN = new RegExp(`^[a-zA-Z0-9_]{${MIN_USERNAME_LENGTH},${MAX_USERNAME_LENGTH}}$`);

/**
 * `"%40nadia"` or `"@nadia"` -> `"nadia"`; anything else -> null.
 *
 * `decodeURIComponent` IS REQUIRED AND IS ALSO SAFE TO APPLY TWICE. The `@` is
 * percent-encoded in a pathname, so depending on how the request arrived this segment is
 * either `@nadia` or `%40nadia` — and `decodeURIComponent("@nadia")` is `"@nadia"`, so
 * running it on an already-decoded value is a no-op. It cannot double-decode a real username
 * either, because the allowlist below has no `%` in it. The `try` is for a lone `%`, which
 * throws rather than returning null.
 *
 * EXPORTED, AND IT LIVES HERE RATHER THAN IN `lib/`. Eight entry points under this folder need
 * it (seven pages plus their `generateMetadata`s) and the layout is the one module they all
 * already sit beneath. A copy per route file is the shape this codebase keeps warning about:
 * the fourth copy is the one that forgets the sigil check and turns every top-level path into
 * a profile lookup.
 */
export function profileUsername(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (!decoded.startsWith("@")) return null;
  const username = decoded.slice(1);
  return HANDLE_PATTERN.test(username) ? username : null;
}

/**
 * Segment -> member, or a 404. Called by the layout, by every page body, and by every
 * `generateMetadata` under this folder.
 *
 * IT APPLIES NO PRIVACY RULE, DELIBERATELY. A profile itself is public — including a guest's,
 * which `ProfileHeader` labels with a badge rather than hiding — and the one private surface
 * here is the wantlist, whose rule is `canViewWantlist` and belongs to that route. Folding a
 * privacy check into this loader would put the rule in a place where the routes that do not
 * need it would silently inherit it, and the route that does need it would stop looking like
 * it had one.
 */
export async function loadProfile(segment: string): Promise<MemberRecord> {
  const username = profileUsername(segment);
  if (!username) notFound();

  const member = await getUserByUsername(username);
  if (!member) notFound();

  return member;
}

export default async function ProfileLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  // A PROMISE IN NEXT 16. Awaited below; reading `params.username` directly is a type error
  // rather than a silent undefined, which is the one good thing about the change.
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  const [member, viewer] = await Promise.all([loadProfile(username), currentUser()]);

  const isSelf = viewer?.id === member.id;

  /*
   * THE FOLLOW CONTROL IS A TRI-STATE, AND `null` MEANS "DRAW NOTHING".
   *
   * Four situations produce it and they are not the same as "not following": signed out (no
   * session to write with), your own profile (nothing to follow), a guest profile (`toggleFollow`
   * refuses to follow a guest), and a guest VIEWER (`requireMember` refuses the write). Each of
   * those would render a button that is guaranteed to fail, so `isFollowing` is not even asked
   * — which is also why the query is inside the ternary rather than filtered afterwards.
   */
  const followable = viewer !== null && !isSelf && !member.isGuest && !viewer.isGuest;

  const [counts, years, following] = await Promise.all([
    getFollowCounts(member.id),
    /*
     * THE YEAR THE TAB LINKS TO IS COMPUTED HERE, ON THE SERVER, and `ProfileTabs` takes it as
     * a required prop for that reason: `new Date().getFullYear()` evaluated in the browser can
     * disagree with the server render across a new year, and the 1900–2200 bounds belong to the
     * route that validates them. Newest logged year first; the current year for a member who
     * has dated nothing, because that is the year they are about to fill.
     */
    getLoggedYears(member.id),
    followable ? isFollowing(viewer.id, member.id) : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-8">
      <ProfileHeader member={member} counts={counts} following={following} />

      <ProfileTabs
        username={member.username}
        year={years[0] ?? new Date().getUTCFullYear()}
        /*
         * A TAB THAT LEADS TO A 404 IS WORSE THAN AN ABSENT ONE. The wantlist route 404s a
         * private queue for a non-owner in both of its entry points, so the tab is dropped by
         * exactly the same predicate. The owner always keeps their own.
         */
        showWantlist={canViewWantlist(member, viewer?.id)}
      />

      {children}
    </div>
  );
}

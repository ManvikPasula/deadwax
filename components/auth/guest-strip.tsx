/**
 * The guest strip — THE SERVER HALF OF THE SPLIT-COMPONENT PATTERN.
 *
 * Rendered with no props from app/layout.tsx, so the decision cannot be forgotten by a page.
 * This half decides whether guest mode applies at all and counts what the client half needs;
 * components/auth/guest-banner.tsx owns dismissal, the leaving warning and every browser API.
 *
 * ============================================================================
 * IT ALWAYS RENDERS THE CLIENT BANNER FOR A GUEST — VISIBLE OR NOT.
 *
 * `GuestBanner` hides itself with `display: none` below the nudge threshold rather than being
 * left unrendered here, BECAUSE THE CLIENT HALF OWNS THE LEAVING WARNING AND MUST BE ARMED
 * FROM THE FIRST ENTRY. The `beforeunload` handler lives in an effect inside that component,
 * so a version of this file that returned `null` until twelve distinct albums had been rated
 * would give a guest with eleven albums no warning at all when they closed the tab.
 *
 * GETTING THIS WRONG IS SILENT. The banner still looks right — it is invisible in exactly the
 * cases it should be invisible — and the warning simply never fires, which is only noticed by
 * somebody who has already lost their diary.
 * ============================================================================
 *
 * NEVER RENDERED FOR A NON-GUEST, and the mirror rule in verify-banner.tsx is never rendered
 * for a guest. The source project shipped the other half of that pair as a production bug:
 * it asked guests to confirm `guest_46ee4182c3@guest.invalid`, an address on an RFC 2606
 * reserved TLD that can never receive mail, so the instruction was impossible to follow.
 *
 * WHY THE TOKEN'S `isGuest` IS ENOUGH HERE, unlike the twice-checked guard in
 * verify-banner.tsx. `SessionUser.isGuest` is presentation only (I-18), and this is
 * presentation — but the real reason is which way the failure would fall. A stale `true`
 * (banner shown to somebody who has converted) is the case a column read would catch, and it
 * is unreachable: both conversion paths re-issue the session, Path A precisely so a claimed
 * guest stops rendering as one. A stale `false` is the case with a cost — a missed leaving
 * warning — and A COLUMN READ CANNOT CATCH IT, because the read would sit behind the same
 * guard that already returned null. Spending a query per page on every signed-in member to
 * defend against nothing is the wrong trade; the banner in verify-banner.tsx buys its query
 * because it needs a column (`email`) that this one does not.
 *
 * `guestActivity` IS ONE STATEMENT AND THE ONLY QUERY THIS ADDS, and it runs on a guest's
 * page loads only.
 */

import { GuestBanner } from "@/components/auth/guest-banner";
import { GUEST_NUDGE_AFTER, GUEST_REVIEW_CAP, guestActivity } from "@/lib/auth/guest";
import { currentUser } from "@/lib/auth/session";

export async function GuestStrip() {
  const viewer = await currentUser();
  if (!viewer) return null;
  if (!viewer.isGuest) return null;

  /*
   * THREE NUMBERS, AND THE CLIENT HALF USES EACH FOR A DIFFERENT DECISION:
   *   `distinctAlbums` — compared against GUEST_NUDGE_AFTER, decides VISIBILITY.
   *   `logCount`       — `> 0` decides whether the LEAVING WARNING is armed.
   *   `reviewCount`    — renders "1 of 3 reviews written" beside the cap.
   *
   * A row whose account has been deleted returns zeros rather than throwing, so the strip
   * degrades to hidden-and-unarmed, which is the (I-17) tolerance every read here follows.
   */
  const activity = await guestActivity(viewer.id);

  return (
    <GuestBanner
      logCount={activity.logCount}
      distinctAlbums={activity.distinctAlbums}
      reviewCount={activity.reviewCount}
      /*
       * THE TWO CONSTANTS ARE PASSED DOWN, NOT IMPORTED BY THE CLIENT HALF. lib/auth/guest.ts
       * opens with `import "server-only"` — it hashes passwords and writes rows — so a client
       * component that imported `GUEST_NUDGE_AFTER` from it would be a build failure. The
       * rejected alternative was re-declaring 12 and 3 in the banner, which is two copies of
       * a tuned number whose drift has no symptom: the strip would simply appear at the wrong
       * time, and nothing would look broken.
       */
      nudgeAfter={GUEST_NUDGE_AFTER}
      reviewCap={GUEST_REVIEW_CAP}
    />
  );
}

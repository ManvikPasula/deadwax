/**
 * The "confirm your email" strip, and it is USUALLY NOTHING AT ALL.
 *
 * THE SERVER HALF OF THE SPLIT-COMPONENT PATTERN: this decides whether the thing applies and
 * reads what it needs; components/auth/verify-controls.tsx is the client half that owns the
 * button press. Rendered with no props from app/layout.tsx, so the decision cannot be
 * forgotten by a page.
 *
 * IT IS NEVER SHOWN TO A GUEST, AND THAT RULE IS A SHIPPED PRODUCTION BUG WRITTEN DOWN. In the
 * source project guest mode landed after verification, so this banner asked guests to confirm
 * addresses like `guest_46ee4182c3@guest.invalid` — `.invalid` is an RFC 2606 reserved TLD
 * that can never receive mail, so the instruction was not merely odd, it was impossible to
 * follow, and the only way out of it was to ignore the banner. The guard is checked twice
 * here on purpose: the token's `isGuest` decides whether the query is spent at all, and the
 * column decides the outcome (I-18), exactly as `assertEmailVerified()` does it.
 *
 * THE COPY CHANGES WITH THE FLAG RATHER THAN LYING. `REQUIRE_EMAIL_VERIFICATION` defaults OFF,
 * and with it off there is nothing this member cannot do — so the banner asks for a favour
 * ("when you get a chance") instead of naming consequences that would not happen. A banner
 * that threatens a gate which is not switched on teaches people that our warnings are noise.
 *
 * WHY IT READS THE DATABASE DIRECTLY, against the usual "components receive data as props"
 * rule: it needs `users.email`, and EVERY PROJECTION IN lib/db/queries DELIBERATELY OMITS IT
 * (see `MemberRecord`) because those objects cross the server/client boundary in the RSC
 * payload. The address is rendered into markup here and never handed to the client half, so
 * the omission stays true. The alternative — widening a shared projection to carry an email —
 * would put an address in the wire format of every page that renders a member.
 */

import { eq } from "drizzle-orm";
import { MailWarning } from "lucide-react";

import { VerifyControls } from "@/components/auth/verify-controls";
import { currentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { env } from "@/lib/env";

export async function VerifyBanner() {
  const viewer = await currentUser();
  if (!viewer) return null;
  // The token's copy is presentation only, and this is presentation: it buys the query.
  if (viewer.isGuest) return null;

  const rows = await db
    .select({ email: users.email, emailVerifiedAt: users.emailVerifiedAt, isGuest: users.isGuest })
    .from(users)
    .where(eq(users.id, viewer.id))
    .limit(1);

  const account = rows[0];
  // No row: the token outlived the account. Reads tolerate that (I-17) by rendering nothing.
  if (!account) return null;
  if (account.isGuest) return null;
  if (account.emailVerifiedAt) return null;

  const enforced = env.requireEmailVerification;

  return (
    <div className="border-b border-line bg-surface-2/70">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-6">
        <MailWarning className="size-4 shrink-0 text-amber" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-[0.8125rem] leading-relaxed text-paper">
          {enforced ? (
            <>
              Confirm <span className="font-mono text-muted">{account.email}</span> to post reviews, log listens, and
              build lists.
            </>
          ) : (
            <>
              Confirm <span className="font-mono text-muted">{account.email}</span> when you get a chance — it secures
              your account.
            </>
          )}
        </p>
        <VerifyControls />
      </div>
    </div>
  );
}

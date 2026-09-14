/**
 * Sign in.
 *
 * ============================================================================
 * IT REDIRECTS NON-GUEST MEMBERS ONLY, AND THAT IS THE WHOLE OF THE GUARD.
 *
 * The obvious implementation — "redirect anybody holding a session" — TRAPS GUESTS AWAY FROM
 * BOTH UPGRADE PATHS. A guest holds a perfectly good session, and this page and /signup are
 * the only two doors out of guest mode: sign-in MERGES the guest diary onto an existing
 * account (Path B) and sign-up CLAIMS the guest row in place (Path A). A blanket redirect
 * bounces them to the homepage from both, which is not a cosmetic bug — it makes guest mode a
 * dead end. The source shipped the blanket version and had to fix it while wiring guest mode.
 *
 * The decision lives in `redirectSignedInMember` (app/actions/auth.ts) rather than here,
 * because /signup needs exactly the same rule and a rule with two copies is a rule that has
 * already drifted. It reads `is_guest` FROM THE COLUMN, never from the token (I-18): a stale
 * `true` is harmless (a guest sees a form they did not need), while a stale `false` is the
 * trap itself.
 * ============================================================================
 *
 * `?next=` IS HONOURED, THROUGH `safeNextPath`. The source ships it as a dead parameter that
 * nothing reads — every guard in the application redirects to `/login?next=<where they were
 * going>` and then sign-in drops them on the homepage, which is the same experience as the
 * redirect not working. Honouring it safely is the allowlist in that function: a leading
 * slash, no `//` anywhere, and `[A-Za-z0-9/@._~-]` only, because a `next` parameter is the
 * classic open redirect — `/login?next=https://evil.example/login` would produce a real login
 * page, a real session, and then a hand-off to a convincing copy of ourselves.
 *
 * THE PARAMETER IS SANITISED ONCE, HERE, AND THE SANITISED VALUE IS WHAT THE FORM CARRIES.
 * `AuthForm` passes it back to `signIn`, which allowlists it again — that second check is the
 * one that counts, because a client can post anything. What filtering it here buys is that a
 * hostile `?next=` in a link somebody was sent does not survive into the markup at all, so it
 * cannot reach the mode-switch link or the "forgot your password" link either.
 *
 * NO `robots: noindex`. Unlike /verify, /reset and /forgot there is no token in this URL, and
 * a sign-in page is a legitimate destination somebody may search for. `?next=` is the only
 * query parameter and it is origin-relative by construction.
 */

import type { Metadata } from "next";

import { redirectSignedInMember, safeNextPath } from "@/app/actions/auth";
import { AuthForm } from "@/components/auth/auth-form";
import { currentUser } from "@/lib/auth/session";
import { Eyebrow } from "@/components/ui/primitives";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to Deadwax to keep rating records, writing reviews and following people with taste.",
};

export default async function LoginPage({
  searchParams,
}: {
  /** A PROMISE in Next 16. Awaited below; reading it synchronously is a type error. */
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  /**
   * THE GUARD RUNS BEFORE ANYTHING RENDERS, and it is handed the RAW parameter. `redirect()`
   * signals itself by throwing, so a member who should not be here never reaches the form.
   *
   * The raw value is correct as the argument: `redirectSignedInMember` calls `safeNextPath`
   * itself and falls back to `/`, so passing the already-filtered value would only mean
   * filtering twice — and passing it filtered here would hide from a reader that the function
   * owns the allowlist.
   */
  await redirectSignedInMember(params.next);

  /**
   * Read after the guard, so this only ever describes a guest or a signed-out visitor.
   *
   * `isGuest` from the TOKEN is enough for this, and the distinction matters: it decides one
   * paragraph of copy ("signing in merges that diary into the account you sign in to"). The
   * guard above already re-read the column for the decision that gates access; spending a
   * second query to choose a sentence would be paying for a guarantee nothing needs.
   */
  const viewer = await currentUser();
  const next = await safeNextPath(params.next);

  return (
    // `max-w-sm` — the auth container width, hand-picked per page (§11.1). A sign-in form at
    // the shell's full `max-w-7xl` is two fields stranded in a field of ink.
    <div className="mx-auto max-w-sm py-12">
      <Eyebrow>Welcome back</Eyebrow>
      <h1 className="mt-2 font-display text-4xl leading-tight text-paper text-balance">
        Put the needle back down.
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Your diary, your ratings and everybody you follow are where you left them.
      </p>

      <AuthForm mode="signin" next={next} isGuest={viewer?.isGuest === true} className="mt-8" />
    </div>
  );
}

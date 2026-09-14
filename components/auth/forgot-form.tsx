"use client";

/**
 * "Send me a reset link."
 *
 * IT ALWAYS RENDERS THE SAME CONFIRMATION, WHATEVER HAPPENED. Not because the action is
 * vague, but because *a form that says "no account with that address" is a membership oracle
 * answerable in bulk against a breach list* — one POST per address, no failed-login trail on
 * anybody's account, and the answer is exactly the thing worth selling. The action is built
 * the same way: it returns the identical success for an unknown address, for an unparseable
 * address, and for one throttled by the per-email budget.
 *
 * THE ONLY VISIBLE FAILURE IS THE PER-IP LIMIT, and that is safe to show precisely because it
 * is a fact about the caller rather than about any account. It arrives here as an ordinary
 * `ActionResult` failure and renders through the shared `FormError`.
 *
 * AND WHEN NO MAIL PROVIDER IS CONFIGURED, IT SAYS SO. `lib/email` logs the message and
 * returns `delivered: true, via: "log"` — deliberately, so a developer can finish the flow —
 * which means "check your email" would be a lie in every deployment without a RESEND_API_KEY.
 * An admin or a developer telling somebody "check your email" needs to know it will not
 * arrive. `mailConfigured` is a REQUIRED prop for that reason: a default would let the page
 * forget it, and the failure mode of forgetting is silence.
 *
 * THE FLAG COMES FROM `emailDeliveryConfigured()` ON THE PAGE, NOT FROM THE ACTION'S RESULT.
 * Reporting per-request delivery would reintroduce the oracle from the other end: "sent" for
 * a real address and nothing for an unknown one is the same leak wearing a helpful face.
 * Provider configuration is a static property of the deployment and leaks nothing about who
 * has an account.
 */

import Link from "next/link";
import * as React from "react";

import { requestPasswordReset } from "@/app/actions/password";
import { Button } from "@/components/ui/button";
import { Field, FieldHint, FormError, Input, Label } from "@/components/ui/field";
import { MAX_EMAIL_LENGTH } from "@/lib/security/schemas";
import { cn } from "@/lib/utils";

export type ForgotFormProps = {
  /**
   * `emailDeliveryConfigured()` from lib/email, read on the server by the page. False means
   * the link was written to the server log instead of being sent, and the confirmation says
   * exactly that.
   */
  mailConfigured: boolean;
  /**
   * `PASSWORD_RESET_TTL_MINUTES`. Passed in rather than hard-coded because lib/security/tokens
   * is `server-only` and cannot be imported here; the page can pass the real constant so this
   * sentence cannot drift from it. The default is today's value.
   */
  ttlMinutes?: number;
  className?: string;
};

export function ForgotForm({ mailConfigured, ttlMinutes = 30, className }: ForgotFormProps) {
  const [email, setEmail] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const emailId = React.useId();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      const result = await requestPasswordReset({ email });
      if (!result.ok) {
        // Only reachable through `reset:ip`. Everything else succeeded by construction.
        setError(result.error);
        return;
      }
      setSent(true);
    });
  }

  if (sent) {
    return (
      <div className={cn("space-y-4", className)}>
        {/*
          `role="status"` rather than `role="alert"`: this replaces the form after a
          deliberate submit, so it should be announced politely once, not interrupt.
        */}
        <div role="status" className="card p-4">
          <p className="text-sm leading-relaxed text-paper">
            If there is an account for that address, a reset link is on its way. It can be used once, and it expires
            in {ttlMinutes} minutes.
          </p>
          <p className="mt-2 text-[0.8125rem] leading-relaxed text-faint">
            We do not say whether an account exists — telling anyone that, for any address they typed, would be a
            membership list anybody could read.
          </p>
        </div>

        {mailConfigured ? null : (
          /*
            Not styled as an error, because nothing failed — styled as the operational notice
            it is. Amber is emphasis in this palette; rose is failure, and this is neither a
            member's fault nor a member's problem.
          */
          <p
            role="status"
            className="rounded-card border border-amber/40 bg-amber/12 px-3 py-2 text-[0.8125rem] leading-relaxed text-amber"
          >
            No email provider is configured — the reset link was written to the server log instead of being sent.
          </p>
        )}

        <Button asChild variant="secondary" size="md">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={cn("space-y-4", className)}>
      <Field>
        <Label htmlFor={emailId}>Email</Label>
        <Input
          id={emailId}
          name="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={MAX_EMAIL_LENGTH}
        />
        <FieldHint>The address you signed up with. Guest sessions have no password to reset.</FieldHint>
      </Field>

      <FormError message={error} />

      <Button type="submit" variant="primary" size="lg" className="w-full" disabled={pending}>
        {pending ? "Sending…" : "Send a reset link"}
      </Button>

      <Link
        href="/login"
        className="inline-block rounded-card font-mono text-[0.6875rem] uppercase tracking-wider text-muted hover:text-paper"
      >
        Back to sign in
      </Link>
    </form>
  );
}

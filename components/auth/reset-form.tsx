"use client";

/**
 * Set a new password from a link token.
 *
 * THE FORM NEVER SIGNS THEM IN. On success it says "Your password is set. Sign in as
 * @username." and stops. Two reasons, and neither is caution for its own sake: whoever is
 * holding this link is only proven to have read one mailbox at one moment, and signing them
 * in here would turn a password reset into a session-minting endpoint reachable with a
 * forwarded email. Making them sign in also confirms the new password works, immediately,
 * while they still have it on the clipboard.
 *
 * THE PAGE — NOT THIS COMPONENT — SETS `robots: noindex` AND `referrer: "no-referrer"`, so
 * the token in the URL never reaches a search engine or a `Referer` header. If this component
 * is ever rendered from a page without those two, the token leaks and nothing here will tell
 * you.
 *
 * THE CONFIRM FIELD IS UI, NOT A RULE. It exists because a mistyped password nobody can see
 * is unrecoverable without a second reset; it is checked here and nowhere else, and the
 * server does not know about it.
 */

import Link from "next/link";
import * as React from "react";

import { resetPassword } from "@/app/actions/password";
import { Button } from "@/components/ui/button";
import { Field, FieldHint, FormError, Input, Label } from "@/components/ui/field";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, PASSWORD_MAX_BYTES, passwordByteLength } from "@/lib/security/schemas";
import { cn } from "@/lib/utils";

export type ResetFormProps = {
  /** The raw `?token=`. Passed straight through; every shape check belongs to the server. */
  token: string;
  className?: string;
};

/**
 * The action owns its payload shape, and this reads it structurally so the file compiles
 * whether `resetPassword` is declared `ActionResult<{ username: string }>` or a bare
 * `ActionResult`. The username is the nicer sentence, not a requirement of it.
 */
function usernameFrom(result: { data?: { username?: string } | undefined }): string | null {
  return result.data?.username ?? null;
}

export function ResetForm({ token, className }: ResetFormProps) {
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [done, setDone] = React.useState(false);
  const [username, setUsername] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const passwordId = React.useId();
  const confirmId = React.useId();
  const hintId = React.useId();

  const bytes = passwordByteLength(password);
  const overBudget = bytes > PASSWORD_MAX_BYTES;
  const mismatch = confirm.length > 0 && confirm !== password;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    // Checked before the round trip because the server has no opinion about it: there is one
    // password field in the payload, and this is the local guard against a typo.
    if (password !== confirm) {
      setError("Those two passwords do not match.");
      return;
    }

    startTransition(async () => {
      const result = await resetPassword({ token, password });
      if (!result.ok) {
        // Every refusal the redeem path can produce — bad shape, no row, already consumed,
        // expired, account gone, email mismatch — arrives as one indistinguishable message,
        // because distinguishing them tells a guesser which tokens were real.
        setError(result.error);
        return;
      }
      setUsername(usernameFrom(result));
      setDone(true);
      // NO `router.refresh()` HERE, and that is the point: nothing about this viewer's
      // session changed. The only thing to render is the instruction to go and sign in.
    });
  }

  if (done) {
    return (
      <div role="status" className={cn("card space-y-4 p-5", className)}>
        <p className="font-display text-2xl leading-tight text-paper">Your password is set.</p>
        <p className="text-sm leading-relaxed text-muted">
          {username ? (
            <>
              Sign in as <span className="font-mono text-paper">@{username}</span>.
            </>
          ) : (
            <>Sign in with your new password.</>
          )}
        </p>
        <Button asChild variant="primary" size="lg">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={cn("space-y-4", className)}>
      <Field>
        <Label htmlFor={passwordId}>New password</Label>
        <Input
          id={passwordId}
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          maxLength={MAX_PASSWORD_LENGTH}
          aria-describedby={hintId}
          aria-invalid={overBudget || undefined}
        />
        <FieldHint id={hintId} className={overBudget ? "text-rose" : undefined}>
          At least {MIN_PASSWORD_LENGTH} characters.{" "}
          {bytes > 0 ? (
            // BYTES, NOT CHARACTERS — bcrypt truncates at 72 bytes, and an accented or
            // non-Latin character costs more than one. The same readout as the sign-up form,
            // from the same exported helper.
            <span className="font-mono tabular">
              {bytes}/{PASSWORD_MAX_BYTES} bytes
              {overBudget ? " — over the limit" : ""}
            </span>
          ) : null}
        </FieldHint>
      </Field>

      <Field>
        <Label htmlFor={confirmId}>Repeat it</Label>
        <Input
          id={confirmId}
          name="confirm"
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
          required
          maxLength={MAX_PASSWORD_LENGTH}
          aria-invalid={mismatch || undefined}
        />
        {/*
          The mismatch hint is text as well as a rose rim, because the rim alone is a colour
          carrying meaning on its own.
        */}
        {mismatch ? <FieldHint className="text-rose">These do not match yet.</FieldHint> : null}
      </Field>

      <FormError message={error} />

      <Button type="submit" variant="primary" size="lg" className="w-full" disabled={pending}>
        {pending ? "Setting…" : "Set my password"}
      </Button>
    </form>
  );
}

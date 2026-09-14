"use client";

/**
 * One form for sign-in and sign-up, discriminated by `mode`.
 *
 * WHY ONE COMPONENT. The two forms differ by one field and one verb, and the parts that must
 * not drift are the parts they share: the `?next=` handoff, the inline failure, the guest
 * conversion copy, the maxLength bounds. Two files diverge — the source audit's SEC-04 was
 * exactly that shape, a password rule written twice, strictly at sign-up and loosely at
 * sign-in, producing accounts that could never be signed into.
 *
 * EVERY BOUND COMES FROM lib/security/schemas.ts. That module is deliberately pure — no
 * `server-only`, no database import — precisely so a client component can read the same
 * numbers the server validates with. `maxLength={24}` written here by hand would be a second
 * copy of a rule that already has one home.
 *
 * `?next=` IS CARRIED THROUGH THE FORM TO THE ACTION, and the action allowlists it. This
 * component re-checks the shape before it navigates, which is defence in depth and not the
 * defence: a client-side test can be skipped by anybody who wants to, so the server's
 * allowlist is the one that counts. What the local test buys is that a hostile `?next=` in a
 * link somebody was sent cannot bounce this form's own success navigation off-site.
 *
 * THE HOUSE CLIENT CONVENTION: `useTransition`, an inline `<FormError>`, no `useActionState`
 * and no error boundary. A failure renders next to the control that caused it.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import { signIn, signUp } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { Field, FieldHint, FormError, Input, Label } from "@/components/ui/field";
import {
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  PASSWORD_MAX_BYTES,
  passwordByteLength,
} from "@/lib/security/schemas";
import { cn } from "@/lib/utils";

export type AuthFormMode = "signin" | "signup";

export type AuthFormProps = {
  /** The discriminator. Everything else about the two forms is shared. */
  mode: AuthFormMode;
  /** The raw `?next=` from the page's `searchParams`. Passed straight to the action. */
  next?: string | null;
  /**
   * The viewer is already in a guest session, so signing up CLAIMS that row in place and
   * signing in MERGES it. Both paths keep their logs, and saying so here is the whole reason
   * guest mode converts — the offer has to be visible at the door, not in a help page.
   */
  isGuest?: boolean;
  className?: string;
};

/** Only `/` is dangerous as a second character, and only because of protocol-relative URLs. */
const PROTOCOL_RELATIVE = /^\/[/\\]/;

/**
 * A site-relative path, or null.
 *
 * `//evil.example` is the case worth naming: it starts with a slash, so a `startsWith("/")`
 * test alone passes it, and the browser reads it as a protocol-relative absolute URL. A
 * backslash in the same position is rejected too, because some URL parsers fold it to a
 * slash and the two must not disagree about what this string means.
 */
function localPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/")) return null;
  if (PROTOCOL_RELATIVE.test(value)) return null;
  return value;
}

export function AuthForm({ mode, next, isGuest = false, className }: AuthFormProps) {
  const router = useRouter();
  const isSignUp = mode === "signup";

  const [username, setUsername] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  // Ids are generated, because a hard-coded id would let one form's label claim another
  // form's field if both ever rendered on the same page.
  const usernameId = React.useId();
  const emailId = React.useId();
  const passwordId = React.useId();
  const passwordHintId = React.useId();

  // THE BYTE COUNT, SHOWN LIVE ON SIGN-UP ONLY. bcrypt truncates at 72 BYTES, so "é" costs
  // two and a 72-character password can be 144 bytes; `passwordByteLength` is exported from
  // the schema module for exactly this readout. Telling somebody "at most 72 characters"
  // when the rule is bytes produces a password they cannot reproduce.
  const bytes = isSignUp ? passwordByteLength(password) : 0;
  const overBudget = bytes > PASSWORD_MAX_BYTES;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    startTransition(async () => {
      const result = isSignUp
        ? await signUp({ username, email, password, next: next ?? null })
        : await signIn({ email, password, next: next ?? null });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      // The action redirects on success, and a server redirect wins — this navigation is the
      // fallback for an action that chooses to return `ok` instead. `replace`, so the back
      // button does not land on a sign-in form the member is already past; `refresh` so the
      // header re-reads the session it just gained.
      router.replace(localPath(next) ?? "/");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className={cn("space-y-4", className)}>
      {isSignUp ? (
        <Field>
          <Label htmlFor={usernameId}>Username</Label>
          <Input
            id={usernameId}
            name="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            minLength={MIN_USERNAME_LENGTH}
            maxLength={MAX_USERNAME_LENGTH}
          />
          <FieldHint>
            {MIN_USERNAME_LENGTH}–{MAX_USERNAME_LENGTH} characters. Letters, numbers and underscores. Your profile
            lives at /@name, and usernames are permanent.
          </FieldHint>
        </Field>
      ) : null}

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
      </Field>

      <Field>
        <Label htmlFor={passwordId}>Password</Label>
        <Input
          id={passwordId}
          name="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          // `new-password` on sign-up asks the password manager to generate one;
          // `current-password` on sign-in asks it to fill the stored one. The wrong value
          // here is the difference between a manager that helps and one that fights.
          autoComplete={isSignUp ? "new-password" : "current-password"}
          required
          // NOT `MIN_PASSWORD_LENGTH` on sign-in: `signInSchema` uses min(1) on purpose, so a
          // member whose password predates the current rule can still get in. A stricter
          // attribute here would lock out exactly the accounts the rule was added to protect.
          minLength={isSignUp ? MIN_PASSWORD_LENGTH : 1}
          maxLength={MAX_PASSWORD_LENGTH}
          aria-describedby={isSignUp ? passwordHintId : undefined}
          aria-invalid={overBudget || undefined}
        />
        {isSignUp ? (
          <FieldHint id={passwordHintId} className={overBudget ? "text-rose" : undefined}>
            At least {MIN_PASSWORD_LENGTH} characters.{" "}
            {bytes > 0 ? (
              <span className="font-mono tabular">
                {bytes}/{PASSWORD_MAX_BYTES} bytes
                {overBudget ? " — over the limit; accented and non-Latin characters cost more than one byte" : ""}
              </span>
            ) : null}
          </FieldHint>
        ) : null}
      </Field>

      {/* The one place an action's refusal is rendered. An absent message renders nothing. */}
      <FormError message={error} />

      <Button type="submit" variant="primary" size="lg" className="w-full" disabled={pending}>
        {pending ? "Working…" : isSignUp ? "Create account" : "Sign in"}
      </Button>

      {isGuest ? (
        <p className="rounded-card border border-amber/40 bg-amber/12 px-3 py-2 text-[0.8125rem] leading-relaxed text-amber">
          {isSignUp
            ? "You are in a guest session. Creating an account claims it in place — every rating, diary entry, list and wantlist row you already have comes with you."
            : "You are in a guest session. Signing in merges that diary into the account you sign in to."}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        {/*
          The mode switch carries `?next=` forward. Losing it here is a quiet bug: somebody
          sent to /login?next=/verify who decides to register instead should still land on
          /verify afterwards.
        */}
        <Link
          href={`${isSignUp ? "/login" : "/signup"}${next ? `?next=${encodeURIComponent(next)}` : ""}`}
          className="rounded-card font-mono text-[0.6875rem] uppercase tracking-wider text-muted hover:text-paper"
        >
          {isSignUp ? "I already have an account" : "Create an account"}
        </Link>
        {isSignUp ? null : (
          <Link
            href="/forgot"
            className="rounded-card font-mono text-[0.6875rem] uppercase tracking-wider text-faint hover:text-paper"
          >
            Forgot your password?
          </Link>
        )}
      </div>
    </form>
  );
}

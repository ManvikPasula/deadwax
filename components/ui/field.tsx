/**
 * Form controls.
 *
 * NO `"use client"` IN THIS FILE. Every control here is an uncontrolled native element, so
 * the forms in this app — sign-up, sign-in, reset, settings, list editing, the admin ad
 * manager — post to a Server Action without shipping a form library, a validation library or
 * a change handler to the browser. Validation lives in lib/security/schemas.ts and runs on
 * the server; these are the inputs, not the rules.
 *
 * EVERY LABEL IS `.eyebrow`. That is the same 11px mono uppercase treatment as a section
 * label, which is why --color-faint had to be lifted to a measured 4.5:1 value: form labels
 * are the smallest persistent text in the product and they are the text a member must read
 * to know what they are typing into.
 *
 * NO CONTROL HERE SETS `focus:outline-none`. The global amber `:focus-visible` rule in
 * globals.css is the focus treatment; a control may only remove it if it replaces it, and
 * none of these do.
 *
 * NO RADIX SELECT AND NO RADIX CHECKBOX, on purpose. Exactly four Radix packages are used in
 * the whole app, and neither of those is one of them: a native <select> gets the platform's
 * own picker (which is better than any portal on a phone) and `accent-color` styles a native
 * checkbox to the amber accent in one declaration.
 */

import type * as React from "react";

import { cn } from "@/lib/utils";

/** Surface, hairline, radius and 14px type — shared so the four controls cannot drift apart. */
const CONTROL = cn(
  "w-full rounded-card border border-line bg-surface-2 px-3 py-2 text-sm text-paper",
  "placeholder:text-faint",
  "disabled:cursor-not-allowed disabled:opacity-60",
  // A rejected field is marked with `aria-invalid` by the server round trip, and the rose rim
  // is driven off that attribute rather than off a second `error` prop, so the visual state
  // and the announced state cannot disagree.
  "aria-[invalid=true]:border-rose",
);

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return <label className={cn("eyebrow block", className)} {...props} />;
}

/**
 * Label above control, with the vertical rhythm declared once. The `htmlFor`/`id` pairing is
 * still the caller's job — this wrapper does not generate ids, because a generated id would
 * differ between the server and client renders of the same form.
 */
export function Field({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("space-y-1.5", className)} {...props} />;
}

/** Help text. Below the control, never above: it is read after the label, not instead of it. */
export function FieldHint({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-[0.6875rem] leading-relaxed text-faint", className)} {...props} />;
}

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(CONTROL, "h-9 py-0", className)} {...props} />;
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  // `min-h` rather than `rows`, so a review box can grow with the page's layout while still
  // having a floor. `resize-y` only: horizontal resize escapes the column.
  return <textarea className={cn(CONTROL, "min-h-28 resize-y leading-relaxed", className)} {...props} />;
}

export function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select className={cn(CONTROL, "h-9 appearance-none py-0 pr-8 font-mono text-xs tracking-wider", className)} {...props}>
      {children}
    </select>
  );
}

/**
 * `accent-color` is the whole styling job — it tints the native check and its focus ring
 * without replacing the control, so the checkbox keeps the platform's own hit area, keyboard
 * behaviour and high-contrast rendering. This is why no Radix checkbox package is installed.
 */
export function Checkbox({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      className={cn("size-4 shrink-0 rounded-sm border border-line bg-surface-2 accent-amber", className)}
      {...props}
    />
  );
}

/** A checkbox and its label on one line, as every "Add to diary" style control is written. */
export function CheckboxField({
  label,
  className,
  ...props
}: React.ComponentProps<"input"> & { label: React.ReactNode }) {
  return (
    <label className={cn("flex cursor-pointer items-center gap-2", className)}>
      <Checkbox {...props} />
      <span className="font-mono text-xs tracking-wider text-muted">{label}</span>
    </label>
  );
}

/**
 * The one place a failed action's message is rendered.
 *
 * `role="alert"` so it is announced when it appears after a server round trip, and it renders
 * NOTHING AT ALL for an absent message — an empty alert region that exists on every form is
 * one a screen reader has already learnt to ignore by the time it matters.
 *
 * The message is always a string the action chose (see `ActionResult`), never a raw error:
 * driver errors carry the SQL and its bound parameters (I-35).
 */
export function FormError({
  message,
  className,
}: {
  message?: string | null;
  className?: string;
}) {
  if (!message) return null;
  return (
    <p role="alert" className={cn("text-[0.8125rem] text-rose", className)}>
      {message}
    </p>
  );
}

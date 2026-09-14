/**
 * The avatar. Renders what lib/avatar.ts computes, and decides the one thing that module
 * deliberately does not: what a GUEST looks like.
 *
 * NO `"use client"`. There is no state and no event handler here, so it renders inside
 * Server Components — which matters because this component appears in the header, in every
 * feed row, in every review card and in the members directory. A client component in those
 * positions would ship the avatar arithmetic to the browser for every row on the page.
 *
 * GUESTS SHORT-CIRCUIT BEFORE ANY OF THE GENERATED ART, and get a plain outline glyph. The
 * reason is a product one rather than a technical one: THE GENERATED AVATAR IS AN IDENTITY,
 * AND A GUEST DOES NOT HAVE ONE YET. A "G" monogram on a coloured field would suggest a
 * person — it would sit in a feed looking exactly like a member — when the correct reading is
 * "this account is not finished". The outline glyph is the placeholder, and it is the same
 * glyph for every guest on purpose.
 *
 * THE ELEMENT IS `aria-hidden` IN BOTH BRANCHES. An avatar is decoration in this interface:
 * the accessible name always comes from the surrounding text — the username link beside it in
 * a feed row, the heading above it on a profile. Naming it as well would make a screen reader
 * announce every member twice.
 */

import { UserRound } from "lucide-react";
import type * as React from "react";

import { avatarGradient } from "@/lib/avatar";
import { cn } from "@/lib/utils";

/**
 * FIVE SIZES, size-6 to size-24, and each one pairs the box with a monogram size. They are
 * paired here rather than derived because a monogram scaled linearly from the box looks
 * correct at `md` and wrong at both ends: too heavy in the 24px header badge, too thin on the
 * 96px profile.
 *
 * A plain lookup object rather than cva — see the note in components/ui/button.tsx about cva
 * being used exactly once.
 */
const SIZES = {
  xs: "size-6 text-[0.625rem]",
  sm: "size-8 text-[0.6875rem]",
  md: "size-10 text-xs",
  lg: "size-16 text-xl",
  xl: "size-24 text-3xl",
} as const;

const GLYPH_SIZES = {
  xs: "size-3",
  sm: "size-4",
  md: "size-4.5",
  lg: "size-7",
  xl: "size-10",
} as const;

export type AvatarSize = keyof typeof SIZES;

export type AvatarProps = {
  username: string;
  displayName?: string | null;
  /** `users.avatar_seed`. Absent means the gradient is keyed on the username. */
  seed?: string | null;
  /**
   * `users.is_guest`, READ FROM THE DATABASE — never from a session token (I-18). Defaults to
   * false so a caller that has a plain member row cannot accidentally render the placeholder.
   */
  isGuest?: boolean;
  size?: AvatarSize;
  className?: string;
};

export function Avatar({
  username,
  displayName,
  seed,
  isGuest = false,
  size = "md",
  className,
}: AvatarProps) {
  const shell = cn("inline-flex shrink-0 items-center justify-center rounded-full", SIZES[size], className);

  if (isGuest) {
    return (
      <span
        aria-hidden="true"
        className={cn(shell, "border border-dashed border-line-bright bg-surface-2 text-faint")}
      >
        <UserRound className={GLYPH_SIZES[size]} />
      </span>
    );
  }

  const { style, initial } = avatarGradient({ username, displayName, seed });

  return (
    <span
      aria-hidden="true"
      // The inline style is the gradient and nothing else; `hash` produced both of its
      // numbers, so two renders of the same member always agree and hydration is quiet.
      style={style}
      className={cn(shell, "font-display font-normal text-ink/85 shadow-inner shadow-black/20")}
    >
      {initial}
    </span>
  );
}

/**
 * The avatar beside the name it belongs to — the pairing used in feed rows, review cards and
 * the members directory.
 *
 * It exists so the `aria-hidden` contract above is honoured by construction: the text is a
 * real child of the same element, so nobody has to remember that the avatar carries no name.
 */
export function AvatarWithName({
  size = "sm",
  children,
  className,
  ...identity
}: AvatarProps & { children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Avatar {...identity} size={size} />
      {children}
    </span>
  );
}

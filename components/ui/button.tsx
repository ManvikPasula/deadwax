/**
 * The button, and THE ONLY PLACE `cva` IS USED IN THE WHOLE APP.
 *
 * WHY HERE AND NOWHERE ELSE. Button is the one primitive with two independent axes that both
 * need every combination (five variants x four sizes = twenty), which is exactly the problem
 * cva solves. Every other primitive has ONE axis and a handful of values, and for those a
 * plain lookup object is shorter, has no dependency and reads better in a diff — see
 * components/ui/primitives.tsx. Reaching for cva a second time is how a design system ends
 * up with two ways to express the same thing.
 *
 * THERE IS NO `"use client"` IN THIS FILE, AND THAT IS DELIBERATE. Button is a plain function
 * component with no state, no effects and no event handlers of its own, so a Server Component
 * renders it directly and it costs the client bundle nothing. `Slot` is imported purely for
 * PROP MERGING — it is not a client feature. Adding `"use client"` here would drag every
 * button on every server-rendered page into the browser bundle for no behavioural gain.
 *
 * `asChild` is how every navigation button in the app is written:
 *
 *   <Button asChild variant="primary"><Link href="/albums">Browse albums</Link></Button>
 *
 * That renders an <a> with the button's classes rather than a <button> that programmatically
 * navigates, which keeps middle-click, copy-link and prefetch working.
 *
 * ICON SIZING IS DONE WITH THE `[&_svg]` DESCENDANT SELECTOR so callers just drop a lucide
 * icon in as a child and NEVER SIZE IT. Every size below therefore carries its own
 * `[&_svg]:size-*`, and `[&_svg]:shrink-0` stops a long label squashing the glyph.
 */

import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-card",
    // Mono, wide-tracked and not uppercase: uppercase is `.eyebrow`'s job, and a button that
    // shouts competes with the section labels around it.
    "font-mono tracking-wider",
    "transition-colors duration-150",
    // No `focus:outline-none` anywhere in this file. The global amber :focus-visible outline
    // in globals.css is the focus treatment for every button in the app.
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
  ),
  {
    variants: {
      variant: {
        /** Amber on ink. AT MOST ONE PER VIEW — it is the answer to "what is this page for?". */
        primary: "bg-amber text-ink hover:bg-amber-bright",
        /**
         * THE DEFAULT, and the reason is that most buttons in a diary are ordinary: log,
         * save, follow, add to a list. A default of `primary` would put amber on all of them
         * and the page would have no focal point at all.
         */
        secondary: "border border-line bg-surface-2 text-paper hover:bg-surface-3",
        outline: "border border-line-bright bg-transparent text-paper hover:bg-surface-2",
        ghost: "text-muted hover:bg-surface-2 hover:text-paper",
        /**
         * Rose on a tinted field rather than solid rose. Destructive controls in this app are
         * two-press arm/confirm with a 4000ms self-disarm, so the RESTING state must read as
         * "available and serious", not as the loudest thing on the page — the armed state is
         * what escalates. A solid red resting button also competes directly with the amber
         * primary for attention, which inverts the hierarchy on any page holding both.
         */
        danger: "border border-rose/40 bg-rose/15 text-rose hover:bg-rose/25",
      },
      size: {
        sm: "h-8 px-3 text-[0.6875rem] [&_svg]:size-3.5",
        md: "h-9 px-4 text-xs [&_svg]:size-4",
        lg: "h-11 px-6 text-[0.8125rem] [&_svg]:size-4.5",
        /** Square, no padding, for a lone glyph. The caller still owes it an accessible name. */
        icon: "size-9 p-0 [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Render the single child element with these classes instead of a <button>. */
    asChild?: boolean;
  };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot : "button";
  // `className` is merged LAST through cn/tailwind-merge, which is what makes the escape
  // hatch real: `<Button className="w-full">` overrides the variant's width instead of
  // appending a second, losing declaration.
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };

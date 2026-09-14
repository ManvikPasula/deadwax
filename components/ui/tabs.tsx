"use client";

/**
 * Radix tabs — for GENUINELY LOCAL PANELS ONLY.
 *
 * READ THIS BEFORE USING IT. The profile's six "tabs" are NOT these: they are six routes
 * (`/@name`, `/diary`, `/albums`, `/wantlist`, `/lists`, `/year/[year]`) and their highlight
 * comes from `usePathname()`, so every tab is linkable, shareable and survives a reload.
 * Rebuilding those as Radix tabs would make five sixths of a member's profile unaddressable
 * and would lose the back button.
 *
 * What belongs here is a switch with no addressable state worth keeping — the discography
 * heatmap's source selector (member / critic / popularity / replay) being the example the
 * app actually has. The test is simple: IF SOMEBODY MIGHT WANT TO SEND A LINK TO THE PANEL,
 * IT IS A ROUTE, NOT A TAB.
 *
 * Same wrapper convention as the other Radix files. `Root` needs no styling beyond a layout
 * class the caller supplies, so it is a bare alias.
 */

import * as Primitive from "@radix-ui/react-tabs";
import type * as React from "react";

import { cn } from "@/lib/utils";

export const Tabs = Primitive.Root;

export function TabsList({ className, ...props }: React.ComponentProps<typeof Primitive.List>) {
  return (
    <Primitive.List
      className={cn(
        "inline-flex items-center gap-1 rounded-card border border-line bg-surface-2 p-1",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Mono and wide-tracked, like every other UI label in the app. The active state is a filled
 * surface rather than an underline because the list itself already has a border, and an
 * underline inside a bordered strip reads as a second, misaligned rule.
 */
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      className={cn(
        "rounded-[0.375rem] px-3 py-1.5 font-mono text-[0.6875rem] uppercase tracking-wider",
        "text-faint transition-colors hover:text-paper",
        "data-[state=active]:bg-surface-3 data-[state=active]:text-paper",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Content className={cn("mt-4", className)} {...props} />;
}

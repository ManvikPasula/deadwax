"use client";

/**
 * The dropdown menu — the account menu in the header, and the per-row overflow menus.
 *
 * Same convention as components/ui/dialog.tsx: `import * as Primitive`, bare aliases for the
 * parts that need no styling, a wrapper only where there are classes to add, and
 * `"use client"` because Radix is hooks and portals.
 *
 * `MenuContent` PORTALS ITSELF. Without the portal a menu opened from inside the sticky
 * header inherits the header's stacking context and is clipped by it — which presents as
 * "the menu is cut off below the first item" rather than as a z-index problem. It sits at
 * z-80, the same rung as dialog content.
 *
 * NOT WRAPPED, DELIBERATELY: `CheckboxItem`, `RadioGroup`, `RadioItem` and the `Sub*` family.
 * Nothing in the app uses them, and an unused wrapper is a styling decision nobody has
 * reviewed. Import and wrap them here when something actually needs one.
 */

import * as Primitive from "@radix-ui/react-dropdown-menu";
import type * as React from "react";

import { cn } from "@/lib/utils";

export const Menu = Primitive.Root;
export const MenuTrigger = Primitive.Trigger;
export const MenuGroup = Primitive.Group;
export const MenuPortal = Primitive.Portal;

export function MenuContent({
  className,
  sideOffset = 8,
  align = "end",
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "card z-80 min-w-48 overflow-hidden p-1 shadow-xl shadow-black/50",
          // Radix sets --radix-dropdown-menu-content-available-height; capping against it is
          // what keeps a long menu scrollable instead of running off the viewport.
          "max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto",
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  );
}

/**
 * `data-highlighted` rather than `:hover`: Radix drives it from BOTH pointer and keyboard, so
 * arrowing through the menu highlights exactly what clicking would. A `:hover` rule leaves
 * keyboard users with an invisible selection.
 */
export function MenuItem({ className, ...props }: React.ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-[0.375rem] px-2.5 py-2",
        "font-mono text-xs tracking-wider text-muted outline-none",
        "data-[highlighted]:bg-surface-2 data-[highlighted]:text-paper",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

export function MenuLabel({ className, ...props }: React.ComponentProps<typeof Primitive.Label>) {
  return <Primitive.Label className={cn("eyebrow px-2.5 pb-1 pt-2", className)} {...props} />;
}

export function MenuSeparator({ className, ...props }: React.ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn("my-1 h-px bg-line", className)} {...props} />;
}

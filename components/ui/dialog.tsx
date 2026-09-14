"use client";

/**
 * The dialog. A Radix wrapper, and it follows the convention every Radix wrapper here
 * follows:
 *
 *   1. `import * as Primitive` — one namespace import, so the underlying package is visible
 *      at the top of the file and nowhere else.
 *   2. RE-EXPORT THE PARTS THAT NEED NO STYLING AS BARE ALIASES. `Root`, `Trigger`, `Close`
 *      and `Portal` render no DOM of their own (or none we style), so wrapping them would add
 *      a component whose entire body is a spread.
 *   3. WRAP ONLY THE STYLED PARTS, spreading `React.ComponentProps<typeof Primitive.Y>`
 *      merged through `cn()`. That keeps the escape hatch and every Radix prop — including
 *      `onEscapeKeyDown` and `onPointerDownOutside`, which the log dialog needs in order to
 *      REFUSE TO CLOSE MID-SAVE.
 *   4. `"use client"` — mandatory. Radix is built on hooks, context and portals.
 *
 * EXACTLY FOUR RADIX PACKAGES ARE USED IN THE WHOLE APP: react-slot, react-dialog,
 * react-dropdown-menu and react-tabs. Do not add a fifth; each one is a client-bundle cost
 * and a versioning liability, and the two things people reach for next (select, tooltip) are
 * covered by a native <select> and a `title`/`aria-label` respectively.
 *
 * ACCESSIBILITY CONTRACT: `DialogContent` does NOT inject a title. Radix logs a warning when
 * content mounts without a `Dialog.Title`, and that warning is correct — a dialog with no
 * accessible name announces as "dialog" and nothing else. Every caller renders `DialogTitle`,
 * with `sr-only` on it if the design has no visible heading.
 */

import * as Primitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;
/**
 * Exported for completeness only. `DialogContent` PORTALS ITSELF and renders its own overlay,
 * so a caller must NOT wrap it in this — two nested portals mount the dialog twice, and the
 * copy that loses the focus trap is the one left visible.
 */
export const DialogPortal = Primitive.Portal;

/** z-70 — above the film grain (z-60), below the dialog content (z-80). */
export function DialogOverlay({ className, ...props }: React.ComponentProps<typeof Primitive.Overlay>) {
  return (
    <Primitive.Overlay
      className={cn("fixed inset-0 z-70 bg-ink/80 backdrop-blur-sm", className)}
      {...props}
    />
  );
}

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <DialogOverlay />
      <Primitive.Content
        className={cn(
          // z-80, shared with dropdown content: a menu inside a dialog and the dialog itself
          // are never both the top layer, so they do not need separate rungs.
          "card fixed left-1/2 top-1/2 z-80 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2",
          // max-h + overflow, because the log dialog grows with a review textarea and a tag
          // list and must stay reachable on a short viewport.
          "max-h-[calc(100dvh-3rem)] overflow-y-auto p-5 shadow-2xl shadow-black/60",
          className,
        )}
        {...props}
      >
        {children}
        <Primitive.Close
          className="absolute right-3 top-3 rounded-card p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-paper"
          // The glyph carries no text, so the name is here. It is the only control this
          // wrapper adds on the caller's behalf.
          aria-label="Close"
        >
          <X className="size-4" />
        </Primitive.Close>
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof Primitive.Title>) {
  return <Primitive.Title className={cn("font-display text-2xl leading-tight text-paper", className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Description>) {
  return <Primitive.Description className={cn("mt-1 text-sm text-muted", className)} {...props} />;
}

/**
 * Layout only, and NOT Radix — hence the plain <div>s. They exist so the padding rhythm of a
 * dialog is declared once rather than re-guessed in each of the five dialogs in the app.
 * `pr-8` on the header keeps the title clear of the close button above it.
 */
export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mb-4 pr-8", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-5 flex flex-wrap items-center justify-end gap-2", className)} {...props} />;
}

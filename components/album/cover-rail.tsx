/**
 * The horizontal cover rail — the home page's chart/new/top rows, the genre rows, and the
 * "more by this artist" row on an album page.
 *
 * NO `"use client"`. Like `CoverGrid` this is a LAYOUT ONLY: it takes children, so the same
 * rail holds album cards, artist cards and list cards without three copies of the scroll
 * classes. Everything interactive inside it is a link the child already owns.
 *
 * ---------------------------------------------------------------------------------------
 * THERE ARE NO ARROW BUTTONS, AND THAT IS THE WHOLE DESIGN
 * ---------------------------------------------------------------------------------------
 *
 * Every child keeps its own focusable link, so TABBING THROUGH THE RAIL SCROLLS IT NATIVELY —
 * the browser scrolls a focused element into view for free, and `scroll-behavior` is untouched
 * so the platform decides whether that is smooth. A pair of chevron buttons was the rejected
 * alternative and it loses three times over: it adds two tab stops per rail in front of the
 * content (six rails on the home page is twelve stops before anybody reaches a record), it
 * needs a scroll-position listener and a resize observer to know when to disable itself, and
 * both of those make this a client component — which is the entire cost of a rail, since a
 * rail is otherwise pure markup.
 *
 * The one thing lost is a pointer-only affordance on a desktop with no trackpad. That is
 * covered by the native scrollbar, by shift-scroll, and by the fact that every rail is
 * "see all"-linked to a real paged route (`SectionHeading`'s `action` slot) where the whole
 * set is reachable without horizontal scrolling at all.
 *
 * ---------------------------------------------------------------------------------------
 * THE VERTICAL PADDING IS LOAD-BEARING
 * ---------------------------------------------------------------------------------------
 *
 * `.sleeve` lifts `translateY(-3px)` on `.group:hover` and adds `0 14px 30px -14px` of drop
 * shadow. A scroll container's scrollable area includes its children's transformed boxes, so
 * WITHOUT VERTICAL PADDING the hover lift pushes content past the top edge and the browser
 * answers by showing a VERTICAL scrollbar inside a horizontal rail — which then narrows the
 * rail, which re-lays out the row under the cursor. `py-2` is 8px, comfortably more than the
 * 3px of travel, and it is why the hover state cannot be "fixed" by removing this padding.
 *
 * `[scrollbar-width:none] [&::-webkit-scrollbar]:hidden` opts OUT of the app's 10px scrollbar
 * (globals.css styles it globally). A bar under every row of covers reads as an accident —
 * unlike the discography heatmap, which KEEPS its bar because a 22-cell row genuinely has
 * content off-screen and nothing else in that layout says so.
 *
 * ---------------------------------------------------------------------------------------
 * THE CHILD WIDTH IS SET HERE, NOT BY THE CALLER
 * ---------------------------------------------------------------------------------------
 *
 * `[&>*]:w-[132px] sm:[&>*]:w-[152px]` is the same descendant-selector trick `Button` uses for
 * `[&_svg]:size-4`: a caller drops a `CoverCard` in and never sizes it, so twelve rails cannot
 * drift into twelve widths. `[&>*]:shrink-0` is mandatory — a flex child with a width and no
 * `shrink-0` is squeezed by the row rather than scrolling.
 *
 * NO `.stagger`. It is baked into `CoverGrid` and deliberately absent here: a rail's later
 * children are off-screen, so animating them is work nobody sees.
 */

import type * as React from "react";

import { cn } from "@/lib/utils";

export function CoverRail({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex gap-4 overflow-x-auto py-2",
        // `snap-x` resolves to PROXIMITY snapping in Tailwind, not mandatory, and the
        // difference matters for the keyboard: mandatory snapping re-aligns the container after
        // the browser has scrolled a newly-focused link into view, which can pull that link
        // back out of sight. Proximity tidies a pointer flick and leaves focus alone.
        "snap-x [&>*]:snap-start",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "[&>*]:w-[132px] [&>*]:shrink-0 sm:[&>*]:w-[152px]",
        className,
      )}
      {...props}
    />
  );
}

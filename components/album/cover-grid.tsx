/**
 * The cover grid. Server Component, and a layout only — it takes children so the same grid
 * holds album cards, artist cards and list cards without three copies of the column classes.
 *
 * `stagger` IS BAKED IN HERE, which is why rails deliberately do not have it: a rail scrolls
 * horizontally, so its later children are off-screen and animating them is work nobody sees.
 * The six hard-coded delay steps and the `nth-child(n + 7)` pin at 180ms live in globals.css
 * so a 24-card page lands in a fifth of a second rather than taking four seconds to arrive.
 *
 * `gap-y-5`, NOT `gap-y-6`. A square loses the extra vertical rhythm a 2:3 poster needs, and
 * at six columns the 2:3 grid's taller gutter left the rows looking unrelated.
 */

import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The catalogue page size.
 *
 * IT LIVES IN THIS FILE, BESIDE THE COLUMN CLASSES, BECAUSE IT IS ONLY CORRECT AS LONG AS IT
 * AGREES WITH THEM. 24 is divisible by 3, 4 and 6 — the three column counts below — so every
 * page of results fills its last row at every breakpoint. Move the breakpoints and this number
 * is wrong; keeping it in the same file is the only thing that makes that obvious, and a test
 * asserts the divisibility so the pair cannot drift silently.
 */
export const GRID_PAGE_SIZE = 24;

export function CoverGrid({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("stagger grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-4 lg:grid-cols-6", className)} {...props} />;
}

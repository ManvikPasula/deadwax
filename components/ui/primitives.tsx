/**
 * The small primitives: labels, headings, badges, chips, stat tiles, empty states, meters,
 * pagination and the spinner.
 *
 * NO `"use client"`. None of these hold state; they are shapes. Several of them appear dozens
 * of times on a single page (a chip per genre filter, a badge per tag, a tile per statistic),
 * so keeping them server-rendered is the difference between a page of markup and a page of
 * markup plus a hydration pass over it.
 *
 * THEY USE PLAIN INLINE LOOKUP OBJECTS FOR TONE AND SIZE, NOT `cva`. Each of these has one
 * axis with three or four values, and a lookup object is shorter, dependency-free and obvious
 * in a diff. `cva` is used exactly once in the app, in components/ui/button.tsx, where there
 * genuinely are two axes; the justification is written out there.
 */

import { Slot } from "@radix-ui/react-slot";
import { ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import Link from "next/link";
import type * as React from "react";

import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Labels and headings                                                        */
/* -------------------------------------------------------------------------- */

/** The `.eyebrow` class as a component, for the common case of a bare section label. */
export function Eyebrow({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("eyebrow", className)} {...props} />;
}

/**
 * A label with the hairline that trails off after it. `.section-rule`'s `::after` is the
 * hairline, so whatever is passed as children sits to its left.
 */
export function SectionRule({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("section-rule", className)} {...props} />;
}

export type SectionHeadingProps = {
  title: React.ReactNode;
  /** The small mono label above the title. Optional; most sections have one. */
  eyebrow?: React.ReactNode;
  /** A "see all" link or a filter control, placed after the hairline. */
  action?: React.ReactNode;
  /** `h2` by default: an h1 belongs to the page, not to a section inside it. */
  as?: "h1" | "h2" | "h3";
  className?: string;
};

export function SectionHeading({ title, eyebrow, action, as = "h2", className }: SectionHeadingProps) {
  const Heading = as;
  return (
    <div className={cn("section-rule mb-4", className)}>
      <div className="min-w-0">
        {eyebrow ? <Eyebrow className="mb-1">{eyebrow}</Eyebrow> : null}
        <Heading className="font-display text-2xl leading-tight text-paper">{title}</Heading>
      </div>
      {/*
        `order-1` IS LOAD-BEARING. `::after` is always the last flex item in the box, so
        without an explicit order the hairline renders AFTER the action and the action floats
        off the right edge with the rule to its left. Ordering the action past the pseudo
        element is the only way to get heading / rule / action, since nothing can be placed
        after a pseudo element in the DOM.
      */}
      {action ? <div className="order-1 shrink-0">{action}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Badges and chips                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The tone vocabulary, and it is a vocabulary rather than a palette: each tone already means
 * something everywhere else in the interface, so using one for decoration teaches the reader
 * the wrong thing. `teal` is replay and completion ONLY, `desert` is the Desert Island honour
 * ONLY, `rose` is destructive or failed, `amber` is emphasis.
 */
const BADGE_TONES = {
  neutral: "border-line bg-surface-2 text-muted",
  amber: "border-amber/40 bg-amber/12 text-amber",
  teal: "border-teal/40 bg-teal/12 text-teal",
  rose: "border-rose/40 bg-rose/12 text-rose",
  desert: "border-desert/40 bg-desert/12 text-desert",
} as const;

export type Tone = keyof typeof BADGE_TONES;

export function Badge({
  tone = "neutral",
  className,
  ...props
}: React.ComponentProps<"span"> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5",
        "font-mono text-[0.6875rem] uppercase tracking-wider",
        "[&_svg]:size-3 [&_svg]:shrink-0",
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

/**
 * A filter chip. Almost every chip in the app is a link (genre, decade, sort order), because
 * a filter must be addressable — so this takes `asChild` and is written
 * `<Chip asChild active={…}><Link href={…}>Ambient</Link></Chip>`.
 *
 * `aria-current` is the caller's job when the chip is a link: `active` here is the paint, and
 * paint alone does not tell a screen reader which filter is on.
 */
export function Chip({
  active = false,
  asChild = false,
  className,
  ...props
}: React.ComponentProps<"span"> & { active?: boolean; asChild?: boolean }) {
  const Component = asChild ? Slot : "span";
  return (
    <Component
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1",
        "font-mono text-[0.6875rem] uppercase tracking-wider transition-colors",
        active
          ? "border-amber/50 bg-amber/15 text-amber"
          : "border-line bg-surface-2 text-faint hover:border-line-bright hover:text-paper",
        className,
      )}
      {...props}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Tiles, empty states, meters                                                */
/* -------------------------------------------------------------------------- */

const TILE_VALUE_TONES = {
  neutral: "text-paper",
  amber: "text-amber",
  teal: "text-teal",
  rose: "text-rose",
  desert: "text-desert",
} as const;

/**
 * One number with a label under it — the profile's lifetime statistics and the signed-in
 * home.
 *
 * `tabular` on the value is not cosmetic: a row of tiles whose numbers change (a diary count
 * ticking up after a log) would otherwise shift width as the digits change, and the tiles
 * would visibly twitch.
 */
export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn("card p-4", className)}>
      <Eyebrow>{label}</Eyebrow>
      <p className={cn("mt-2 font-mono text-2xl tabular", TILE_VALUE_TONES[tone])}>{value}</p>
      {hint ? <p className="mt-1 text-[0.6875rem] text-faint">{hint}</p> : null}
    </div>
  );
}

/**
 * The designed empty state. It is a real state, not a fallback: most of this product is
 * empty on the day a member joins, so "nothing here yet" is the first thing they see on the
 * diary, the wantlist, their lists and their Desert Island.
 *
 * It therefore always offers the next move (`action`) rather than only reporting the absence.
 */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("card px-6 py-12 text-center", className)}>
      <p className="font-display text-2xl text-paper">{title}</p>
      {description ? (
        <p className="mx-auto mt-2 max-w-prose text-sm leading-relaxed text-muted text-balance">{description}</p>
      ) : null}
      {action ? <div className="mt-5 flex justify-center gap-2">{action}</div> : null}
    </div>
  );
}

const METER_FILL_TONES = {
  neutral: "bg-line-bright",
  amber: "bg-amber",
  teal: "bg-teal",
  rose: "bg-rose",
  desert: "bg-desert",
} as const;

/**
 * THE 2% FLOOR IS DELIBERATE, AND IT IS DELIBERATELY NOT THE 4% FLOOR `MonthlyBars` USES.
 *
 * Both floors exist so a non-zero value is visible rather than invisible, but they are
 * solving the problem at different sizes: a monthly bar is ~24px wide in a 128px-tall track,
 * where 2% is under three pixels and reads as nothing, while a meter is the full width of a
 * panel, where 2% is already a legible sliver and 4% would visibly overstate a single play
 * against a denominator of two hundred. KEEP THEM DIFFERENT — they were tuned against the
 * real shapes, and unifying them makes one of the two charts lie.
 */
const METER_MIN_PERCENT = 2;

export function Meter({
  ratio,
  tone = "amber",
  label,
  className,
}: {
  /**
   * 0..1, NOT 0..100.
   *
   * `meterPercent()` in lib/ratings.ts returns 0..100, so a caller holding a value and a
   * total must divide by 100 before it reaches here. Passing the percent straight through
   * silently pins every meter at 100%, which looks like a working feature.
   */
  ratio: number;
  tone?: Tone;
  /** Announced instead of the bar. Omit it only when adjacent text already says the number. */
  label?: string;
  className?: string;
}) {
  const bounded = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const percent = bounded === 0 ? 0 : Math.max(METER_MIN_PERCENT, Math.round(bounded * 100));

  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)}>
      {/*
        The bar is decoration and is hidden from assistive technology; the number beside it in
        the layout is the data. `label` exists for the cases where there is no such number.
      */}
      <div
        aria-hidden={label ? undefined : true}
        role={label ? "img" : undefined}
        aria-label={label}
        className={cn("h-full rounded-full", METER_FILL_TONES[tone])}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pagination and the spinner                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Prev / page / next, AND DELIBERATELY NO NUMBERED PAGE LIST.
 *
 * A numbered list needs a total, and for a provider-backed grid there is no honest total to
 * show: the catalogue walk requests `limit = GRID_PAGE_SIZE + 1` and learns only whether one
 * more row exists ("one past the window, so a full window is distinguishable from the end").
 * Rendering "1 … 47" from an estimate would be a fabricated number in the one place a member
 * would reasonably trust one.
 *
 * `totalPages` is accepted for the local-only surfaces that genuinely do know (a diary year,
 * a review list), and the "of N" appears only when it is passed.
 */
export function Pagination({
  page,
  hasNext,
  buildHref,
  totalPages,
  className,
}: {
  /** 1-based, already clamped by `parsePage`. */
  page: number;
  hasNext: boolean;
  buildHref: (page: number) => string;
  totalPages?: number;
  className?: string;
}) {
  const hasPrev = page > 1;
  if (!hasPrev && !hasNext) return null;

  const step = cn(
    "inline-flex h-9 items-center gap-1.5 rounded-card border border-line bg-surface-2 px-3",
    "font-mono text-[0.6875rem] uppercase tracking-wider text-muted transition-colors",
    "hover:bg-surface-3 hover:text-paper",
  );

  return (
    <nav aria-label="Pagination" className={cn("mt-8 flex items-center justify-between gap-3", className)}>
      {hasPrev ? (
        // A LINK, NOT A ROUTER PUSH. Every paged route reads its page from the query string,
        // so the next page has a real address — and a link keeps middle-click, copy-link and
        // crawlability, none of which a `router.push` in an onClick has.
        <Link href={buildHref(page - 1)} rel="prev" className={step}>
          <ChevronLeft />
          Previous
        </Link>
      ) : (
        // A span rather than a disabled link, so there is nothing to focus and nothing to
        // announce at the ends of the range.
        <span className={cn(step, "pointer-events-none opacity-40")} aria-hidden="true">
          <ChevronLeft />
          Previous
        </span>
      )}

      <p className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
        Page {page}
        {totalPages ? ` of ${totalPages}` : ""}
      </p>

      {hasNext ? (
        <Link href={buildHref(page + 1)} rel="next" className={step}>
          Next
          <ChevronRight />
        </Link>
      ) : (
        <span className={cn(step, "pointer-events-none opacity-40")} aria-hidden="true">
          Next
          <ChevronRight />
        </span>
      )}
    </nav>
  );
}

const SPINNER_SIZES = {
  sm: "size-3.5",
  md: "size-4",
  lg: "size-6",
} as const;

/**
 * THE `sr-only` LABEL IS NOT OPTIONAL, and the reason is the reduced-motion kill switch: the
 * blanket block in globals.css sets `animation-duration: 0.001ms !important` on everything,
 * so for a member who has asked for reduced motion this spinner is a STILL GLYPH. The text is
 * then the only thing that still says "working", which is exactly the situation in which a
 * bare spinning icon would communicate nothing at all.
 */
export function Spinner({
  size = "md",
  label = "Loading",
  className,
}: {
  size?: keyof typeof SPINNER_SIZES;
  label?: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LoaderCircle className={cn("animate-spin text-faint", SPINNER_SIZES[size])} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

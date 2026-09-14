"use client";

/**
 * The Top Four — four pinned ALBUMS, which is the natural profile-pin unit for music (the
 * television original pins four shows).
 *
 * ---------------------------------------------------------------------------------------
 * UNFILLED SLOTS ARE DASHED BOXES FOR THE OWNER ONLY
 * ---------------------------------------------------------------------------------------
 *
 * > "They say what the quota is far more plainly than a sentence about it would."
 *
 * Four dashed frames beside one filled one is the whole explanation of the feature: there are
 * four, you have used one. A visitor gets NOTHING AT ALL for an empty shelf — not an empty
 * state, not a placeholder row — because a stranger does not need telling that somebody has
 * not pinned anything, and "no favourites" is a sentence about a person rather than about the
 * product.
 *
 * ---------------------------------------------------------------------------------------
 * THE CLEAR CONTROL, AND WHY THIS FILE IS `"use client"`
 * ---------------------------------------------------------------------------------------
 *
 * `clearFavorite` IS WRITTEN AND NEVER CALLED IN THE SOURCE — a named defect. The consequence
 * there is specific and worth restating, because it is the reason this control exists: a
 * member who pinned four records could rearrange them forever and never get back to three.
 * `setFavorite` only ever swaps a slot's contents, so the only way out was to pin something
 * they did not want. This component is the caller, and a refactor that drops the control
 * re-creates the defect while leaving the action looking healthy.
 *
 * The clear control needs a handler, so the module takes the directive. The split-component
 * pattern (a server half that decides and a client half that writes) is what §11.6 prefers
 * and it is NOT AVAILABLE HERE: a `"use client"` directive is per module, and the two halves
 * would have to be two files. The cost is four sleeves' worth of markup hydrated on a profile,
 * which is the smallest client island in the app — against a second file whose entire body is
 * one button and whose props are the four fields this one already has.
 *
 * FOUR SLOTS, AND THE NUMBER IS RE-DECLARED RATHER THAN IMPORTED. `FAVORITE_SLOTS` lives in
 * app/actions/collections.ts beside the `slotSchema` that enforces it, and every export of a
 * `"use server"` module must be an async function — so the constant cannot be exported and
 * cannot be imported. Two literals bound by a comment, the same bargain the `INVALID` message
 * in that file already makes. `favorites.position` is documented as 1..4 in lib/db/schema.ts;
 * all three must move together.
 */

import { Disc3, LoaderCircle, X } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import * as React from "react";

import { clearFavorite } from "@/app/actions/collections";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { Eyebrow } from "@/components/ui/primitives";
import type { FavoriteEntry } from "@/lib/db/queries/users";
import { releaseYear } from "@/lib/format";
import { albumCover } from "@/lib/providers/images";
import { albumSlug } from "@/lib/slug";
import { cn } from "@/lib/utils";

/** See the docblock: the same four as `slotSchema` and as `favorites.position`. */
const FAVORITE_SLOTS = 4;

/** 1..4, so the dashed frames render in slot order rather than in "whatever is missing" order. */
const SLOTS = Array.from({ length: FAVORITE_SLOTS }, (_, index) => index + 1);

/** Four across at every breakpoint, so a 500px cover is never asked for. */
const COVER_SOURCE_WIDTH = 250;

export type TopFourProps = {
  /** `getFavorites(userId)`, already ordered by `position` — which IS the member's own order. */
  favorites: FavoriteEntry[];
  /**
   * The viewer is this member. Drives BOTH the dashed empty frames and the clear controls;
   * there is no separate "canEdit", because `clearFavorite` is keyed by the session user and
   * nothing else — there is no owner id in its payload to get wrong.
   */
  isOwner: boolean;
  className?: string;
};

export function TopFour({ favorites, isOwner, className }: TopFourProps) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  /**
   * Positions cleared optimistically. AN ABSENT ENTRY MEANS "TRUST THE PROP" — rolling back is
   * removing the position from the set, never setting it to some second value, so a failed
   * clear puts the pin back exactly as the server last reported it.
   */
  const [cleared, setCleared] = React.useState<ReadonlySet<number>>(() => new Set());
  const [busySlot, setBusySlot] = React.useState<number | null>(null);

  const bySlot = new Map(favorites.filter((entry) => !cleared.has(entry.position)).map((e) => [e.position, e]));

  /*
   * NOTHING AT ALL for a visitor looking at an empty shelf. See the docblock — this is the one
   * branch in the component that is a product decision rather than a layout one.
   */
  if (!isOwner && bySlot.size === 0) return null;

  function clear(position: number) {
    setError(null);
    setBusySlot(position);
    setCleared((current) => new Set(current).add(position));

    startTransition(async () => {
      const result = await clearFavorite({ position });
      setBusySlot(null);
      if (!result.ok) {
        setCleared((current) => {
          const next = new Set(current);
          next.delete(position); // ROLL BACK TO THE PROP
          return next;
        });
        setError(result.error);
        return;
      }
      /*
       * `router.refresh()` rather than leaving the optimistic set to stand: the profile's own
       * read is `getFavorites`, and the refreshed prop is what makes the dashed frame real
       * rather than a local guess. The set is deliberately NOT emptied here — clearing it
       * before the new tree lands would flash the pin back for the length of the round trip.
       */
      router.refresh();
    });
  }

  return (
    <section className={cn("space-y-3", className)}>
      <Eyebrow>Top four</Eyebrow>

      {/*
        FOUR ACROSS AT EVERY BREAKPOINT, which is the stated reason the quota is four and not
        five: a fifth slot wraps on a phone and the row stops reading as a set. `gap-x-4
        gap-y-5` matches `CoverGrid`, so the pins sit on the same rhythm as every other cover
        on the page — but there is no `stagger` here, because four covers arriving in sequence
        at the top of a profile reads as the page loading rather than as the page arriving.
      */}
      <ul className="grid grid-cols-4 gap-x-4 gap-y-5">
        {SLOTS.map((position) => {
          const entry = bySlot.get(position);

          if (!entry) {
            // Owner only — the `!isOwner` shelf returned null above, and a visitor looking at a
            // PARTLY filled shelf gets the filled pins with no gaps drawn between them.
            if (!isOwner) return null;
            return (
              <li key={position}>
                <div
                  className={cn(
                    "flex aspect-square w-full items-center justify-center rounded-card",
                    "border border-dashed border-line-bright bg-surface-2 text-line-bright",
                  )}
                  // Decorative: the sentence below is the accessible version, and four frames
                  // each announcing "empty slot" is four pieces of noise.
                  aria-hidden="true"
                >
                  <Disc3 className="size-7" />
                </div>
                <p className="mt-2 font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
                  Slot {position}
                </p>
              </li>
            );
          }

          const href = `/album/${albumSlug(entry.album.title, entry.album.id)}`;
          const cover = albumCover(entry.album, COVER_SOURCE_WIDTH);
          const year = releaseYear(entry.album.releaseDate);
          const busy = busySlot === position;

          return (
            /*
              `group` IS ON THE `<li>`, NOT ON THE LINK — the one place this component departs
              from the app's usual "the wrapping `<Link className='group'>` drives the sleeve".
              The clear control has to be a SIBLING of the link (a button nested in an anchor is
              invalid markup, and in practice a click that navigates instead of clearing), and a
              `group` on the link cannot reveal a sibling. Moving it up one level keeps the lift,
              the caption colour and the button's reveal on one hover.
            */
            <li key={position} className="group relative">
              <Link href={href} className="block">
                <div className="sleeve">
                  {cover ? (
                    <img
                      src={cover}
                      // Empty alt: the title is in the caption inside the same link.
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="size-full object-cover"
                    />
                  ) : (
                    <div className="flex size-full items-center justify-center">
                      <Disc3 className="size-7 text-line-bright" aria-hidden="true" />
                    </div>
                  )}
                </div>
                <p className="mt-2 line-clamp-2 font-sans text-[0.8125rem] leading-snug text-paper transition-colors group-hover:text-amber">
                  {entry.album.title}
                </p>
                <p className="mt-0.5 truncate font-mono text-[0.6875rem] tabular text-faint">
                  {entry.artist.name}
                  {year ? ` · ${year}` : ""}
                </p>
              </Link>

              {isOwner ? (
                /*
                  REVEALED ON HOVER AND ON FOCUS. `opacity-0` with only a `group-hover` partner
                  hides this from a keyboard member permanently, which is the usual way a
                  hover-revealed control becomes unreachable — so `focus-visible:opacity-100` is
                  not a nicety, it is the other half of the rule.
                */
                <Button
                  type="button"
                  variant="danger"
                  size="icon"
                  onClick={() => clear(position)}
                  disabled={pending}
                  // ICON-ONLY, SO THE NAME IS THE WHOLE SENTENCE. "Remove" repeated four times
                  // across a row of covers identifies nothing.
                  aria-label={`Remove ${entry.album.title} from slot ${position} of your top four`}
                  className={cn(
                    "absolute right-1.5 top-1.5 size-7 bg-ink/80",
                    "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100",
                    "hover:opacity-100",
                  )}
                >
                  {busy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <X aria-hidden="true" />}
                  {busy ? <span className="sr-only">Removing</span> : null}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/*
        THE SENTENCE IS FOR THE OWNER AND IT IS THE ONLY PLACE THE ROUTE TO FILLING A SLOT IS
        NAMED. `setFavorite` takes an album id, so there is nothing for a dashed frame to link
        to — pinning happens from an album's own page. Saying so once is cheaper than four
        frames each pretending to be a button.
      */}
      {isOwner && bySlot.size < FAVORITE_SLOTS ? (
        <p className="text-[0.8125rem] text-faint">
          Pin a record from its own page to fill a slot. Pinning something already pinned moves it.
        </p>
      ) : null}

      <FormError message={error} />
    </section>
  );
}

/**
 * The home hero's cross-fading covers.
 *
 * NO `"use client"`. THE WHOLE ANIMATION IS ONE CSS KEYFRAME AND TWO INLINE NUMBERS — there is
 * no timer, no `useState`, no `useEffect` and no interval to clean up. The rejected
 * alternative was the ordinary carousel: an index in state advanced by `setInterval`, which
 * ships JavaScript to animate decoration, repaints React thirty times a minute for as long as
 * the tab is open, and renders a single frame on the server so the first paint is a still that
 * then jumps.
 *
 * ---------------------------------------------------------------------------------------
 * HOW THE LOOP IS BUILT, AND WHY THE DELAY IS NEGATIVE
 * ---------------------------------------------------------------------------------------
 *
 * `.hero-frame` in globals.css owns the SHAPE of the fade and nothing else:
 * `0%,14% {opacity: 1} 20%,94% {opacity: 0} 100% {opacity: 1}`. Duration and delay are set
 * HERE, inline, because they depend on how many frames there are:
 *
 *   duration = frames.length * 7s        delay = index * 7 - 7s
 *
 * With five frames that is a 35s loop per frame, staggered 7s apart — a 4.9s hold (14% of 35s)
 * and a 2.1s cross-fade (14%→20% out, 94%→100% back in), so exactly one frame is at full
 * opacity at any time and two overlap during a fade.
 *
 * THE `- 7` IS WHAT MAKES THE FIRST VISIBLE FRAME A DELIBERATE CHOICE RATHER THAN AN ACCIDENT.
 * Without it, frame 0 starts its hold at t=0 and the last frame in the list would be mid-fade
 * out of nothing. With it, frame 0 is already 7s in (opacity 0, about to be last in the cycle)
 * and **frame 1 is the one visible at t=0**.
 *
 * SO THE DOM ORDER IS LOAD-BEARING IN TWO DIFFERENT DIRECTIONS, and both are deliberate:
 *
 *   - the FIRST child is what a member who asked for reduced motion sees, forever: the first
 *     of globals.css's two reduced-motion blocks kills the animation and shows
 *     `.hero-frame:first-child` only. So frames[0] must be a cover worth standing still.
 *   - the SECOND child is what everybody else sees first, for the first 4.9 seconds.
 *
 * Both are covers of the same kind, which is why one ordering can serve both; the caller is
 * told in `frames` to lead with its strongest cover.
 *
 * ---------------------------------------------------------------------------------------
 * COVERS ONLY, AND `aria-hidden`
 * ---------------------------------------------------------------------------------------
 *
 * No titles, no captions, no links, nothing focusable. A cross-fading link is a link that
 * cannot be clicked reliably, and a title that changes every seven seconds under a headline is
 * a second thing to read in a band designed to hold one. The whole stack is `aria-hidden`
 * because it IS decoration: the page's own `<h1>` and its browse link are the content, and a
 * screen reader announcing five album titles nobody can act on would be reading the wallpaper.
 *
 * ---------------------------------------------------------------------------------------
 * THE TREATMENT IS THE ALBUM HERO'S, FOR THE SAME REASON
 * ---------------------------------------------------------------------------------------
 *
 * There is no backdrop image in any music provider — the size ladder in
 * lib/providers/images.ts is square at every rung — so a hero's image is the cover itself:
 * `scale-[1.4] blur-2xl opacity-35 saturate-150`, with `.hero-scrim` and `.hero-vignette` over
 * it. components/album/album-hero.tsx writes out what each of those four values is for; this
 * file reuses the numbers rather than re-deriving them, so the home hero and the album hero
 * cannot drift apart.
 *
 * THIS COMPONENT RENDERS THE SCRIMS TOO. The caller must NOT add its own — two stacked scrims
 * darken the band to near-black and the headline stops needing one at all, which is how the
 * treatment gets "fixed" by deleting it.
 */

import { cn } from "@/lib/utils";

/**
 * Seconds per frame: the hold plus one cross-fade. SEVEN IS THE NUMBER THE KEYFRAME
 * PERCENTAGES WERE CHOSEN AGAINST — 14% of a 35s loop is 4.9s, which is long enough to read a
 * colour field as a still image and short enough that the band is never mistaken for static.
 * Changing it here changes both the duration and the stagger, because both are derived from it;
 * changing the percentages in globals.css instead would change the hold/fade ratio.
 */
const FRAME_SECONDS = 7;

export type HeroCycleProps = {
  /**
   * The covers, STRONGEST FIRST — see the DOM-order note in the docblock.
   *
   * Takes `{ coverUrl }` rather than a bare string so an `AlbumCard`, an `AlbumRow` run through
   * `albumCover(row, 1000)`, or a hand-built object all fit without the caller mapping first.
   * Nulls and duplicates are dropped here: a cover repeated inside one loop reads as the fade
   * having failed rather than as a cycle.
   *
   * FIVE IS THE INTENDED COUNT (a 35s loop). Every extra frame adds seven seconds to the loop
   * rather than speeding it up, so a twelve-frame rail's worth would take a minute and a half
   * to come round — pick the five.
   */
  frames: ReadonlyArray<{ coverUrl: string | null }>;
  className?: string;
};

export function HeroCycle({ frames, className }: HeroCycleProps) {
  const covers = [...new Set(frames.map((frame) => frame.coverUrl).filter((url): url is string => !!url))];

  /*
   * NOTHING, NOT A PLACEHOLDER. A cold mirror has no covers, and an empty hero band is a dark
   * band — which is what `bg-ink` already is. A generic "no artwork" graphic cycling behind the
   * headline would be five copies of a claim that we looked.
   */
  if (covers.length === 0) return null;

  const duration = covers.length * FRAME_SECONDS;

  return (
    <div aria-hidden="true" className={cn("absolute inset-0 overflow-hidden", className)}>
      {covers.map((cover, index) => (
        <div
          key={cover}
          className="hero-frame"
          style={{
            animationDuration: `${duration}s`,
            // The negative first delay — see the docblock. `animation-fill-mode: both` on
            // `.hero-frame` is what makes a negative delay start mid-cycle rather than at 0%.
            animationDelay: `${index * FRAME_SECONDS - FRAME_SECONDS}s`,
          }}
        >
          {/*
            A PLAIN `<img>`, as in components/album/cover-card.tsx: the URL already carries the
            width `coverAt()` asked the CDN for, so next/image would add an optimiser hop per
            frame to re-derive a size the CDN has rendered. Empty `alt` is belt and braces — the
            wrapper is already `aria-hidden`.

            The first two frames load eagerly because both are on screen in the first second
            (one is the reduced-motion still, the other is the frame visible at t=0); the rest
            are lazy, which for an in-viewport element means "fetch when the browser has spare
            capacity" rather than "compete with the headline".
          */}
          <img
            src={cover}
            alt=""
            loading={index <= 1 ? "eager" : "lazy"}
            decoding="async"
            className="size-full scale-[1.4] object-cover opacity-35 saturate-150 blur-2xl"
          />
        </div>
      ))}

      {/* Painting order, no z-index: three absolutely positioned siblings in DOM order. The
          app's ladder is five values and none of them is for a hero's internals. */}
      <div className="hero-scrim" />
      <div className="hero-vignette" />
    </div>
  );
}

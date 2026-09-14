"use client";

/**
 * The star input. Ten hit targets across five stars, and the most-used write control in the
 * product: it appears in the album sidebar, on every track row, in the log dialog and in the
 * onboarding quick-rate grid.
 *
 * THE WRAPPER DIV IS THE CONTROL. `role="slider"` on the wrapper, ten `tabIndex={-1}` buttons
 * inside it for the mouse. The rejected alternative — ten real buttons in the tab order — puts
 * ten stops between a member and the next field, on a page that has twelve tracklist rows.
 *
 * THE CONTRACT IS EXPRESSED IN STARS, NOT STORED UNITS: `aria-valuemin=0`, `aria-valuemax=5`
 * and `aria-valuenow` carrying `intToStars(shown)`. Announcing "7 of 10" would be announcing
 * the database units to somebody looking at five glyphs.
 *
 * TWO CALLBACKS, ON PURPOSE:
 *
 *   `onChange`  fires IMMEDIATELY on every gesture. The caller holds the optimistic value, so
 *               the stars move on the same frame as the click.
 *   `onCommit`  fires 250 ms after the last gesture, and on blur and on unmount. This is the
 *               network write.
 *
 * THE DEBOUNCE IS THE ONE DELIBERATE DEVIATION FROM THE SOURCE (§4.7), and it wraps
 * `onCommit` only — never the display. The source fires one Server Action round trip plus a
 * `router.refresh()` PER KEYSTROKE, which on a 12-track album, where a member sweeps a row of
 * stars and then the next row, is visibly worse than on a show page. Splitting the callbacks
 * is also what lets `LogDialog` pass no `onCommit`: a form that saves on submit must not write
 * per keystroke, so it gets no timer at all rather than a cancelled one.
 *
 * FLUSHED ON BLUR AND ON UNMOUNT. Without the unmount flush, a rating given and immediately
 * navigated away from is lost — the timer dies with the component.
 */

import * as React from "react";

import { Stars, type StarSize } from "@/components/rating/stars";
import { formatStars, intToStars, MAX_RATING, MIN_RATING } from "@/lib/ratings";
import { cn } from "@/lib/utils";

/** Long enough to absorb a sweep across five stars, short enough to still feel like a save. */
const DEBOUNCE_MS = 250;

const STARS = [1, 2, 3, 4, 5] as const;

export type StarInputProps = {
  /**
   * The value to SHOW, on the stored 1..10 scale, or `null` for unrated.
   *
   * THIS IS THE ROLLBACK TARGET. The caller makes it optimistic in `onChange` and, when the
   * write fails, puts it back to the prop it was rendered with — never to whatever the local
   * value happened to be one gesture ago.
   */
  value: number | null;
  /** Fired immediately on every gesture, with the resolved value. */
  onChange: (next: number | null) => void;
  /** The debounced write. Omit it and there is no timer: the control is pure form state. */
  onCommit?: (next: number | null) => void;
  size?: StarSize;
  /** Required: a glyph-only slider with no name is unusable. "Your rating for Kid A". */
  label: string;
  disabled?: boolean;
  className?: string;
};

export function StarInput({
  value,
  onChange,
  onCommit,
  size = "md",
  label,
  disabled = false,
  className,
}: StarInputProps) {
  const [hover, setHover] = React.useState<number | null>(null);

  /**
   * `undefined` means "nothing is waiting to be written", which is a different thing from
   * `null`, a real value meaning "clear the rating". Conflating the two drops a clear.
   */
  const pending = React.useRef<number | null | undefined>(undefined);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read through a ref so `flush` stays identity-stable and still calls the latest prop. The
  // unmount flush runs from an effect cleanup registered once, and a stale closure there would
  // post the value to whichever handler was current on first render.
  const commitRef = React.useRef(onCommit);
  React.useEffect(() => {
    commitRef.current = onCommit;
  }, [onCommit]);

  const flush = React.useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current === undefined) return;
    const next = pending.current;
    pending.current = undefined;
    commitRef.current?.(next);
  }, []);

  // The cleanup IS the unmount flush. `flush` is stable, so this effect runs once and its
  // cleanup runs exactly when the component goes away.
  React.useEffect(() => flush, [flush]);

  const schedule = React.useCallback(
    (next: number | null) => {
      if (!commitRef.current) return;
      pending.current = next;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        flush();
      }, DEBOUNCE_MS);
    },
    [flush],
  );

  /** The gesture path: report immediately, write later. */
  const apply = React.useCallback(
    (next: number | null) => {
      setHover(null);
      onChange(next);
      schedule(next);
    },
    [onChange, schedule],
  );

  /**
   * CLICKING THE VALUE YOU ALREADY HAVE CLEARS IT — the gesture Letterboxd uses, which members
   * arrive already expecting. Compared against the `value` PROP and not against the hover
   * preview: the question is "is this what is saved", not "is this what is under the cursor".
   */
  const commit = React.useCallback(
    (next: number) => {
      apply(next === value ? null : next);
    },
    [apply, value],
  );

  const shown = hover ?? value;

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    // Stepping is from the COMMITTED value, not from the hover preview: a preview sitting under
    // an idle cursor must not become the origin of an arrow key.
    const current = value ?? 0;

    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        event.preventDefault();
        // NOTE: the keyboard path calls `apply`, BYPASSING `commit`, so TOGGLE-OFF APPLIES TO
        // CLICKS ONLY. Arrowing onto the value you already hold must not clear it, or a
        // keyboard member cannot reach the top of the scale.
        apply(Math.min(MAX_RATING, current + 1));
        break;
      case "ArrowLeft":
      case "ArrowDown": {
        event.preventDefault();
        const next = current - 1;
        // STEPPING BELOW HALF A STAR CLEARS RATHER THAN CLAMPING. There is no 0 on this scale
        // (§4.1), so the only honest value below 1 is "no rating".
        apply(next < MIN_RATING ? null : next);
        break;
      }
      case "Backspace":
      case "Delete":
        event.preventDefault();
        apply(null);
        break;
      default:
        break;
    }
  }

  return (
    <div
      // The wrapper is the control. Nothing sets `focus:outline-none`: the one global amber
      // :focus-visible rule is the focus treatment here as everywhere.
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={5}
      // TRACKS THE HOVER PREVIEW, so what is announced is what the glyphs are showing rather
      // than what is stored.
      aria-valuenow={shown === null ? 0 : intToStars(shown)}
      aria-valuetext={shown === null ? "Not rated" : `${formatStars(intToStars(shown))} stars`}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      // `focusout` bubbles, so this also fires when focus moves to a hit target INSIDE the
      // wrapper. Guarding on `relatedTarget` is what stops a click flushing the debounce it
      // just scheduled, which would defeat the whole point of having one.
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        flush();
      }}
      onMouseLeave={() => setHover(null)}
      className={cn("relative inline-flex rounded-sm", disabled && "opacity-60", className)}
    >
      <Stars value={shown} size={size} label={null} />

      {/* Ten invisible half-width targets. `aria-hidden` because the slider above is the
          announced control, and `tabIndex={-1}` because these are the mouse affordance only. */}
      {disabled ? null : (
        <span className="absolute inset-0 flex" aria-hidden="true">
          {STARS.map((star) => {
            const fullValue = star * 2;
            const halfValue = fullValue - 1;
            return (
              <span key={star} className="flex h-full flex-1">
                <button
                  type="button"
                  tabIndex={-1}
                  className="h-full w-1/2 cursor-pointer"
                  onMouseEnter={() => setHover(halfValue)}
                  onClick={() => commit(halfValue)}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  className="h-full w-1/2 cursor-pointer"
                  onMouseEnter={() => setHover(fullValue)}
                  onClick={() => commit(fullValue)}
                />
              </span>
            );
          })}
        </span>
      )}
    </div>
  );
}

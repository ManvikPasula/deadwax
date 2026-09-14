"use client";

/**
 * The 30-second preview. `"use client"` because it owns an `<audio>` element, two event
 * handlers and a play/pause state — the whole test.
 *
 * ---------------------------------------------------------------------------------------
 * IT IS NOT RENDERED AT ALL WHEN THERE IS NOTHING TO PLAY
 * ---------------------------------------------------------------------------------------
 *
 * `previewSource()` returns null for an absent preview AND for a URL that is not on a
 * `*.dzcdn.net` host, which is the same allowlist as the CSP's one `media-src`. Null means the
 * component returns null: a disabled play button on nine of twelve rows is twelve rows of
 * visual noise reporting a provider's gaps, and unlike the Desert Island button's exhausted
 * state there is nothing here to explain — "Deezer did not give us a clip" is not a fact the
 * member can act on.
 *
 * ---------------------------------------------------------------------------------------
 * A DEAD URL MUST READ AS "NO PREVIEW", NEVER AS A FAULT
 * ---------------------------------------------------------------------------------------
 *
 * The preview URL IS SIGNED AND EXPIRING — it carries an `exp=` parameter, and it is refreshed
 * on every album sync. A page that has been open for a day, or a mirror that has not re-synced,
 * holds URLs that 403. So the `error` event HIDES THE CONTROL rather than surfacing anything:
 * the member gets the same interface they would have got if Deezer had never sent a clip, which
 * is the truth. Rendering "Preview failed" instead would report our expiry policy as a defect,
 * on a row where the member did nothing wrong and can do nothing about it.
 *
 * `preload="none"` is what keeps that cheap: twelve rows mount twelve `<audio>` elements, and
 * without it twelve signed URLs are fetched on page load — which both wastes the request and
 * expires the clip before anybody presses anything.
 *
 * ---------------------------------------------------------------------------------------
 * ONE `<audio>`, PAUSED ON UNMOUNT
 * ---------------------------------------------------------------------------------------
 *
 * The element is owned by this component and nothing else, so two rows can be playing at once
 * if somebody presses two buttons. THAT IS DELIBERATE AND IT IS THE CHEAP END OF A REAL
 * TRADE-OFF: the alternative is a page-level "currently playing" context, which means a
 * provider around the tracklist, every row subscribing to it, and a re-render of every row on
 * every press. Two overlapping 30-second clips is a self-correcting mistake; a context is a
 * permanent cost on every album page.
 *
 * The unmount pause is not optional. React removes the node, but a playing `HTMLAudioElement`
 * that has been detached KEEPS PLAYING in every browser tested — so navigating away mid-clip
 * would leave audio running with no control anywhere on the page to stop it.
 */

import { Pause, Play } from "lucide-react";
import * as React from "react";

import { previewSource } from "@/lib/listen";
import { cn } from "@/lib/utils";

export type PreviewButtonProps = {
  /** The raw `tracks.preview_url`. Routed through `previewSource` here, not by the caller. */
  previewUrl: string | null | undefined;
  /**
   * The track title, for the accessible name: "Play a 30-second preview of Aerodynamic".
   * REQUIRED — this is an icon-only control on twelve consecutive rows, and "play button"
   * repeated twelve times names nothing.
   */
  trackTitle: string;
  className?: string;
};

export function PreviewButton({ previewUrl, trackTitle, className }: PreviewButtonProps) {
  const source = previewSource(previewUrl);

  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = React.useState(false);
  /** Set by the `error` event, and one-way: a URL that failed once is expired, not flaky. */
  const [dead, setDead] = React.useState(false);

  /**
   * The unmount pause, which matters because navigating away from a tracklist while a preview
   * is playing would otherwise leave the audio running over the next page.
   *
   * THE ELEMENT IS CAPTURED INTO A LOCAL, not read off the ref inside the cleanup. A ref is a
   * mutable box: by the time a cleanup runs React may already have detached the node and set
   * `current` to null, so `audioRef.current?.pause()` is a silent no-op exactly when it is
   * needed. Reading it once while the effect body runs — when the element is definitely mounted
   * — is what makes the pause actually happen.
   *
   * An empty dependency list because this must run once per mount, not per render.
   */
  React.useEffect(() => {
    const audio = audioRef.current;
    return () => {
      audio?.pause();
    };
  }, []);

  if (!source || dead) return null;

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;

    if (playing) {
      audio.pause();
      return;
    }

    /*
     * `play()` RETURNS A PROMISE THAT REJECTS, and the rejection is not always a media
     * failure — an autoplay policy refusal lands here too. Either way the honest answer is the
     * same as a dead URL: there is no preview to offer, so the control removes itself instead
     * of sitting there refusing to work.
     *
     * `onPlay`/`onPause` drive the label rather than this branch setting it, so a clip that
     * ends on its own (`onEnded`) and a clip somebody paused both go through one path.
     */
    void audio.play().catch(() => setDead(true));
  }

  return (
    <span className={cn("inline-flex", className)}>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={playing}
        aria-label={playing ? `Pause the preview of ${trackTitle}` : `Play a 30-second preview of ${trackTitle}`}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-full border border-line transition-colors",
          "[&_svg]:size-3 [&_svg]:shrink-0",
          playing ? "border-amber/50 bg-amber/15 text-amber" : "bg-surface-2 text-faint hover:bg-surface-3 hover:text-paper",
        )}
      >
        {/*
          `fill="currentColor"` on both glyphs: a hollow triangle at 12px reads as a chevron.
          The play/pause STATE is carried by the glyph, by the amber fill AND by `aria-pressed`
          — three channels, because a 12px glyph swap is the least legible of the three.
        */}
        {playing ? <Pause fill="currentColor" aria-hidden="true" /> : <Play fill="currentColor" aria-hidden="true" />}
      </button>

      <audio
        ref={audioRef}
        src={source}
        // See the docblock: twelve rows must not fetch twelve signed URLs on page load.
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        // THE ERROR PATH IS A HIDE, NOT A MESSAGE. An expired signature is our housekeeping,
        // not the member's problem.
        onError={() => {
          setPlaying(false);
          setDead(true);
        }}
      />
    </span>
  );
}

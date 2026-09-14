"use client";

/**
 * The album page's write panel.
 *
 * `"use client"` because there are four optimistic states, four transitions, an arm/confirm
 * timer and event handlers. That is the whole test.
 *
 * ---------------------------------------------------------------------------------------
 * THESE ARE NARROW WRITERS AND THAT IS THE POINT
 * ---------------------------------------------------------------------------------------
 *
 * `saveLog` LEAVES EVERY COLUMN IT WAS NOT GIVEN ALONE (I-1 / SEC-01): `undefined` means
 * "leave this column", an explicit `null` means "clear it". So each control here sends ONLY the
 * field it owns —
 *
 *     StarInput   -> saveLog({ albumId, rating })
 *     the heart   -> saveLog({ albumId, liked })
 *
 * — and NUDGING A STAR CANNOT TOUCH A WRITTEN REVIEW. That is not a nicety; it is the fix for
 * the source audit's only CRITICAL finding, whose other half is `LogDialog`'s required
 * `initial` prop. Adding a field to one of these calls "while we are here" reopens it: a
 * control that sends a column it does not display is a control that can silently blank it.
 *
 * FOUR SEPARATE `useTransition`s, NOT ONE. A single shared pending flag would make a debounced
 * star commit disable the heart, the wantlist and the bulk markers for the length of its round
 * trip — which is exactly the coupling the narrow writers exist to avoid, reintroduced in the
 * interface instead of in the payload.
 *
 * ---------------------------------------------------------------------------------------
 * THE HEART DELIBERATELY DOES NOT `router.refresh()`
 * ---------------------------------------------------------------------------------------
 *
 * Everywhere else a write moves something this component cannot see — an average, a histogram,
 * a heatmap cell, a completion meter, a diary — so re-rendering the server tree is the only
 * honest reconciliation. A heart on an album moves exactly one thing: whether this viewer's
 * heart is filled. NOTHING ELSE ON THE PAGE DEPENDS ON IT. Refreshing would re-run every query
 * on the album page (the consensus card, the tracklist overlay, the reviews) to learn a boolean
 * this component already knows.
 *
 * The consequence, the same one `LikeButton` documents: ON SUCCESS THE OPTIMISTIC VALUE IS
 * KEPT. With no refresh the prop is stale from the moment the write lands, so dropping the
 * guess would snap the heart back. It is dropped only on FAILURE, which is the rollback.
 *
 * ---------------------------------------------------------------------------------------
 * ROLLBACK IS TO THE PROP, NEVER A FLIP
 * ---------------------------------------------------------------------------------------
 *
 * Every optimistic slot below is `T | null` (or `number | null | undefined` for the rating,
 * where `null` is the real value "cleared" and `undefined` is "nothing local"), and rolling
 * back is setting it back to the empty state — not inverting it. Inverting looks identical in
 * the common case and diverges permanently as soon as two writes overlap.
 *
 * ---------------------------------------------------------------------------------------
 * THE BULK MARKERS ARE TWO-PRESS ARM/CONFIRM, NOT A MODAL
 * ---------------------------------------------------------------------------------------
 *
 * One press can write a diary row for every track on the record — or every track of every
 * canonical release by the artist — and there is no one-click undo for either
 * (`unmarkAlbumListened` is per album and deliberately refuses to delete a row carrying a
 * rating or a review). So the second press is the cheapest honest confirmation available, with
 * a 4000ms SELF-DISARM so an armed bulk writer cannot sit under a cursor indefinitely. One
 * dwell time in the whole app, matching the destructive controls, so a member learns it once.
 *
 * A dialog was the rejected alternative: it would be the only dialog in the app that exists to
 * confirm a write rather than to collect one, and this pattern is already in the member's hands
 * from the delete controls. ARMING ONE DISARMS THE OTHER, which is why `armed` is one field
 * rather than two booleans — two live bulk writers side by side is a minefield.
 */

import { Bookmark, CheckCheck, Disc3, Heart, LibraryBig, LoaderCircle, NotebookPen } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { markAlbumListened, markDiscographyListened, saveLog } from "@/app/actions/logs";
import { toggleWantlist } from "@/app/actions/collections";
import { LogDialog, type LogDialogInitial } from "@/components/album/log-dialog";
import { GuestStart } from "@/components/auth/guest-start";
import { StarInput } from "@/components/rating/star-input";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { Eyebrow } from "@/components/ui/primitives";
import { localCalendarDate, plural } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Four seconds. The same window as every other arm/confirm control in the app. */
const DISARM_MS = 4000;

/** Which bulk writer is armed. One field, so arming one disarms the other. */
type Armed = "album" | "discography" | null;

export type AlbumActionsProps = {
  albumId: number;
  albumTitle: string;
  artistName: string;
  /**
   * The artist row id. OMIT IT TO HIDE the mark-whole-discography control — an album page
   * reached for a release whose artist has one mirrored record has nothing to offer there.
   */
  artistId?: number;
  /**
   * False for a signed-out visitor. The panel becomes the sign-in wall plus the guest door
   * rather than disappearing: a hidden control teaches nothing about what an account is for.
   */
  canWrite: boolean;
  /** Where to come back to after signing in. A path inside Deadwax; the route validates it. */
  signInNext?: string;

  /* -- the rollback targets, all read server-side --------------------------------------- */
  /** `viewerState.albumLog?.rating ?? null`, on the stored 1..10 scale. */
  viewerRating: number | null;
  /** `viewerState.albumLog?.liked ?? false` — the AUTHOR'S own heart, not the `likes` table. */
  liked: boolean;
  /** `isWanted(userId, albumId)`. */
  wanted: boolean;
  /** Every track of this record already marked. Drives the resting label of the bulk marker. */
  albumListened?: boolean;

  /* -- copy that needs a real number ---------------------------------------------------- */
  /** `album.trackCount`, so the confirmation can say how many rows it is about to write. */
  trackCount?: number;
  /** Canonical releases in the mirror, for the discography marker's accessible name. */
  albumCount?: number;

  /**
   * THE REAL ROW THE DIALOG IS PRIMED FROM. Required here because it is required there: a
   * dialog primed with blanks sends explicit nulls for the review, the diary date, the replay
   * flag and the tags. `viewerState.albumLog ?? { rating: null, review: null, listenedOn: null,
   * isReplay: false, liked: false, tags: [] }` — the blanks are correct only because the read
   * returned nothing.
   */
  logInitial: LogDialogInitial;
  /** `albumCover(album, 250)`, for the dialog's header. */
  coverUrl?: string | null;

  /**
   * The add-to-list trigger. A SLOT, because the add-to-list dialog reads the member's own
   * lists (`getListOptions`) and owns its own membership state — this file has no business
   * knowing either, and a client component cannot run that query anyway.
   */
  listControl?: React.ReactNode;
  className?: string;
};

export function AlbumActions({
  albumId,
  albumTitle,
  artistName,
  artistId,
  canWrite,
  signInNext,
  viewerRating,
  liked,
  wanted,
  albumListened = false,
  trackCount = 0,
  albumCount = 0,
  logInitial,
  coverUrl,
  listControl,
  className,
}: AlbumActionsProps) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [armed, setArmed] = React.useState<Armed>(null);

  /** `undefined` = defer to the prop; `null` = a real cleared rating. */
  const [optimisticRating, setOptimisticRating] = React.useState<number | null | undefined>(undefined);
  const [optimisticLiked, setOptimisticLiked] = React.useState<boolean | null>(null);
  const [optimisticWanted, setOptimisticWanted] = React.useState<boolean | null>(null);
  const [optimisticMarked, setOptimisticMarked] = React.useState<boolean | null>(null);

  const [ratingPending, startRating] = React.useTransition();
  const [likePending, startLike] = React.useTransition();
  const [wantPending, startWant] = React.useTransition();
  const [markPending, startMark] = React.useTransition();

  /*
   * THE SELF-DISARM. Cleared on unmount AND on re-arm: a panel that unmounts while armed (the
   * `router.refresh()` below re-renders this tree) would otherwise leave a `setState` scheduled
   * against a component that no longer exists, and arming the second control while the first
   * one's timer is live would disarm the new one early.
   */
  React.useEffect(() => {
    if (armed === null) return;
    const timer = window.setTimeout(() => setArmed(null), DISARM_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const rating = optimisticRating === undefined ? viewerRating : optimisticRating;
  const isLiked = optimisticLiked ?? liked;
  const isWanted = optimisticWanted ?? wanted;
  const isMarked = optimisticMarked ?? albumListened;

  /* -- the sign-in wall ------------------------------------------------------------------ */
  if (!canWrite) {
    return (
      <div className={cn("card space-y-3 p-4", className)}>
        <Eyebrow>Your log</Eyebrow>
        <p className="text-[0.8125rem] leading-relaxed text-muted">
          {`Rate ${albumTitle}, tick the tracks you know, and keep a diary of what you play.`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="primary" size="sm">
            {/* A link, not a router push: sign-in has a real address, and this keeps
                middle-click and copy-link working. */}
            <a href={signInNext ? `/login?next=${encodeURIComponent(signInNext)}` : "/login"}>Sign in</a>
          </Button>
          {/*
            THE GUEST DOOR, owned by components/auth/guest-start.tsx. It is rendered rather than
            described here because a guest session is a real row written by a Server Action, and
            the component that opens one also owns the leaving warning that comes with it.

            `next` is passed RAW: `safeNextPath` allowlists it inside the action, and a second,
            weaker copy of that rule here would only be a way for the two to disagree.
          */}
          <GuestStart next={signInNext ?? null} albumTitle={albumTitle} />
        </div>
      </div>
    );
  }

  /* -- the four narrow writers ----------------------------------------------------------- */

  /** The debounced commit from `StarInput`. NARROW: `rating` and nothing else. */
  function commitRating(next: number | null) {
    setError(null);
    startRating(async () => {
      const result = await saveLog({ albumId, rating: next });
      if (!result.ok) {
        setOptimisticRating(undefined); // ROLL BACK TO THE PROP
        setError(result.error);
        return;
      }
      // A rating moves the consensus card, the histogram, the strip and the member's totals,
      // none of which this panel can see.
      router.refresh();
    });
  }

  function toggleLiked() {
    const next = !isLiked;
    setError(null);
    setOptimisticLiked(next);
    startLike(async () => {
      // NARROW: `liked` and nothing else. A heart must not be able to touch a review.
      const result = await saveLog({ albumId, liked: next });
      if (!result.ok) {
        setOptimisticLiked(null); // back to the prop — see the docblock
        setError(result.error);
        return;
      }
      // NO router.refresh(). Read the docblock before adding one.
    });
  }

  function toggleWanted() {
    const next = !isWanted;
    setError(null);
    setOptimisticWanted(next);
    startWant(async () => {
      // AN EXPLICIT DESIRED STATE, NOT A FLIP: a read-then-invert action makes a double-click a
      // silent no-op that reports success twice while the row ends up in the state the member
      // did not ask for.
      const result = await toggleWantlist({ albumId, wanted: next });
      if (!result.ok) {
        setOptimisticWanted(null);
        setError(result.error);
        return;
      }
      // The wantlist shows on the profile and in the member's own tab; refreshed because those
      // are server-rendered and this page is the one that changed them.
      router.refresh();
    });
  }

  function markAlbum() {
    setError(null);
    setArmed(null);
    setOptimisticMarked(true);
    startMark(async () => {
      const result = await markAlbumListened({
        albumId,
        // The member's own calendar date. A server computing `toISOString()` puts somebody in
        // UTC+13 a day behind their own diary.
        listenedOn: localCalendarDate(),
      });
      if (!result.ok) {
        setOptimisticMarked(null); // ROLL BACK TO THE PROP
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function markDiscography() {
    if (artistId === undefined) return;
    setError(null);
    setArmed(null);
    startMark(async () => {
      const result = await markDiscographyListened({ artistId, listenedOn: localCalendarDate() });
      if (!result.ok) {
        // PARTIAL FAILURE IS REPORTED, NOT SWALLOWED — `markDiscographyListened` runs its whole
        // loop inside ONE `guard()` and returns a failure when part of it did not land. The
        // message is rendered verbatim rather than flattened into a success.
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className={cn("card space-y-4 p-4", className)}>
      <div className="space-y-1.5">
        <Eyebrow>Your rating</Eyebrow>
        {/*
          The album-level star input. `onChange` is optimistic and `onCommit` is the debounced
          write — the split exists because a member sweeping five stars would otherwise fire one
          round trip and one refresh per keystroke.
        */}
        <div className="flex items-center gap-2">
          <StarInput
            value={rating}
            onChange={setOptimisticRating}
            onCommit={commitRating}
            size="lg"
            label={`Your rating for ${albumTitle}`}
          />
          {ratingPending ? (
            <span className="inline-flex items-center">
              <LoaderCircle className="size-3.5 animate-spin text-faint" aria-hidden="true" />
              {/* The spinner is a still glyph under `prefers-reduced-motion`, so the word is the
                  only thing that still says "working". */}
              <span className="sr-only">Saving your rating</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={toggleLiked}
          disabled={likePending}
          aria-pressed={isLiked}
          aria-label={isLiked ? `Remove your love for ${albumTitle}` : `Love ${albumTitle}`}
          className={cn(isLiked && "border-rose/40 bg-rose/15 text-rose hover:bg-rose/25")}
        >
          {/* `fill` rather than a second component: swapping the element swaps the DOM node,
              which loses focus mid-toggle. The word beside it is the text equivalent of the
              fill, so the state is never carried by colour alone. */}
          <Heart fill={isLiked ? "currentColor" : "none"} aria-hidden="true" />
          {isLiked ? "Loved" : "Love"}
        </Button>

        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={toggleWanted}
          disabled={wantPending}
          aria-pressed={isWanted}
          aria-label={isWanted ? `Remove ${albumTitle} from your wantlist` : `Add ${albumTitle} to your wantlist`}
          className={cn(isWanted && "border-amber/40 bg-amber/15 text-amber hover:bg-amber/25")}
        >
          <Bookmark fill={isWanted ? "currentColor" : "none"} aria-hidden="true" />
          {isWanted ? "Wanted" : "Wantlist"}
        </Button>

        {/*
          THE LOG DIALOG. `initial` is the real row, passed straight through — this panel is
          the one place on the album page that holds it, and handing the dialog anything else
          is how a rating click erases a review.
        */}
        <LogDialog
          target={{ albumId }}
          initial={logInitial}
          title={albumTitle}
          subtitle={artistName}
          // The code line for an album log is the album's own title: the headline may be
          // truncated in the dialog header, and the mono line is the unambiguous copy.
          code={albumTitle}
          coverUrl={coverUrl}
        >
          <Button type="button" size="sm" variant="primary">
            <NotebookPen aria-hidden="true" />
            Log or review
          </Button>
        </LogDialog>

        {/* The add-to-list trigger arrives as a slot; see the prop's docblock. */}
        {listControl}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={armed === "album" ? "primary" : "secondary"}
          disabled={markPending || isMarked}
          // The accessible name carries the whole state, because the visible label shortens to
          // "Sure? …" when armed and a question alone describes nothing.
          aria-label={
            isMarked
              ? `Every track of ${albumTitle} is marked listened`
              : armed === "album"
                ? `Confirm: mark all ${plural(trackCount, "track")} of ${albumTitle} listened`
                : `Mark all ${plural(trackCount, "track")} of ${albumTitle} listened`
          }
          onClick={() => (armed === "album" ? markAlbum() : setArmed("album"))}
        >
          {markPending ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : isMarked ? (
            <CheckCheck aria-hidden="true" />
          ) : (
            <Disc3 aria-hidden="true" />
          )}
          {/*
            THREE LABELS, ONE BUTTON. `isMarked` DISABLES RATHER THAN HIDES, the same decision
            the Desert Island button makes at the quota: the button spends most of its life
            reporting a state, and that is the feature working rather than a failure.
          */}
          {isMarked ? "Album marked" : armed === "album" ? "Sure? this marks every track" : "Mark album listened"}
          {markPending ? <span className="sr-only">Saving</span> : null}
        </Button>

        {artistId === undefined ? null : (
          <Button
            type="button"
            size="sm"
            variant={armed === "discography" ? "primary" : "secondary"}
            disabled={markPending}
            aria-label={
              armed === "discography"
                ? `Confirm: mark all ${plural(albumCount, "mirrored release")} by ${artistName} listened`
                : `Mark all ${plural(albumCount, "mirrored release")} by ${artistName} listened`
            }
            onClick={() => (armed === "discography" ? markDiscography() : setArmed("discography"))}
          >
            <LibraryBig aria-hidden="true" />
            {armed === "discography" ? "Sure? this marks every release" : "Mark discography listened"}
          </Button>
        )}
      </div>

      {/*
        ONE SHARED `FormError`, placed AFTER the controls so a screen reader hears the control it
        belongs to first. It renders nothing at all for an absent message: a permanent empty
        alert region is one assistive technology has already learnt to ignore by the time it
        matters.
      */}
      <FormError message={error} />
    </div>
  );
}

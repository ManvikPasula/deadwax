"use client";

/**
 * THE LOG DIALOG — the only control in the application that writes every column of a log at
 * once, and therefore the most dangerous component in it.
 *
 * ---------------------------------------------------------------------------------------
 * `initial` IS REQUIRED, AND THAT IS THE WHOLE SAFETY MECHANISM
 * ---------------------------------------------------------------------------------------
 *
 * ANY CONTROL THAT SAVES A LOG MUST BE PRIMED WITH THESE REAL VALUES. PRIMING A FORM WITH
 * BLANKS AND THEN SAVING IT IS HOW A RATING CLICK SILENTLY ERASES A REVIEW — THE FORM SENDS
 * WHAT IT WAS TOLD, NOT WHAT EXISTS.
 *
 * `saveLog` has patch semantics (I-1 / SEC-01): `undefined` leaves a column alone and an
 * explicit `null` clears it. That protects the NARROW writers — a star click that sends only
 * `rating`, a heart that sends only `liked`. IT DOES NOT PROTECT THIS DIALOG, because this
 * dialog deliberately sends the whole row: the review, the diary date, the replay flag, the
 * tags. A dialog primed from blanks sends explicit nulls for all of them and destroys the
 * member's own words, instantly and unrecoverably, with no error and nothing in the interface
 * that said it would.
 *
 * So `initial: LogDialogInitial` is a REQUIRED PROP — typed required so that OMITTING IT IS A
 * COMPILE ERROR rather than silent data loss. The source ships one route that mounts this
 * component with no `initial` even though the value is in scope, and saving from that page
 * writes nulls across the board, reopening the shape of its audit's only CRITICAL finding.
 * Both halves are needed: patch semantics alone still lets a blank-primed dialog send nulls,
 * and priming alone still lets a bare star click blank the row.
 *
 * A target with NO log yet is primed from `viewerState.albumLog ?? { rating: null, … }`. The
 * blanks are correct there BECAUSE THE READ RETURNED NOTHING; what is forbidden is skipping the
 * read. `getViewerAlbumState` exists to produce exactly this shape and its docblock says so.
 *
 * ---------------------------------------------------------------------------------------
 * THE "ADD TO DIARY" CHECKBOX *IS* THE NULL-`listened_on` ENCODING
 * ---------------------------------------------------------------------------------------
 *
 * There is no `in_diary` column. A log with `listened_on IS NULL` is an opinion — a rating, a
 * review, a heart — and a log with a date is a PLAY, which is what the diary, the year pages
 * and every listening statistic are built from. The checkbox is not a preference about this
 * row; it is the row's own encoding, which is why unchecking it clears the date rather than
 * hiding it.
 *
 * THERE IS NO SPOILER TOGGLE. Music has no equivalent of an episode spoiler and the column
 * does not exist. Do not add one "for parity".
 *
 * ---------------------------------------------------------------------------------------
 * `submit(createNew)` ENCODES TWO RULES
 * ---------------------------------------------------------------------------------------
 *
 *     listenedOn: createNew ? (listenedOn ?? localCalendarDate()) : listenedOn,
 *     isReplay:   createNew || isReplay,
 *
 * A SECOND LISTEN IS DATED TODAY AND ALWAYS FLAGGED A REPLAY. "Log again" means "I played this
 * again", so an undated replay would be a play the diary cannot file and an unflagged one would
 * be indistinguishable from an edit of the first. `createNew` is also what makes a replay a
 * SECOND ROW rather than a mutation, which is the encoding the whole `logs` table is built on:
 * it skips `findExistingLog` on the server entirely.
 *
 * `localCalendarDate()` FROM lib/format.ts, NEVER A UTC SLICE. A member in UTC+13 logging at
 * 09:00 local must not get yesterday's date; the server accepts a client date within ±1 day of
 * UTC today for exactly this reason.
 *
 * ---------------------------------------------------------------------------------------
 * IT REFUSES TO CLOSE WHILE A SAVE IS IN FLIGHT
 * ---------------------------------------------------------------------------------------
 *
 * Dismissing mid-save hides the outcome of a request already in flight: the write lands or
 * fails against a page that has thrown away the only place its message could be rendered, and
 * the member is left to guess. `onOpenChange` therefore ignores every close request while
 * `pending` — Escape, the overlay, and the `X` the dialog wrapper adds on our behalf.
 *
 * FIELDS RE-SEED FROM `initial` ON OPEN, NOT ON CLOSE. An abandoned edit is discarded by the
 * next open rather than by the dismissal, so a failed save that the member dismisses does not
 * clear the box they were typing in before they can reopen it.
 */

import { Heart, LoaderCircle, Repeat2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";

import { saveLog } from "@/app/actions/logs";
import { StarInput } from "@/components/rating/star-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { CheckboxField, Field, FieldHint, FormError, Input, Label, Textarea } from "@/components/ui/field";
import { Eyebrow } from "@/components/ui/primitives";
import { localCalendarDate } from "@/lib/format";
import { CALENDAR_DATE_FLOOR, MAX_REVIEW_BODY, MAX_TAG_LENGTH, MAX_TAGS, type TargetInput } from "@/lib/security/schemas";

/**
 * THE REAL ROW, NOT A GUESS. Structurally `ViewerLog` minus its `id` — declared here rather
 * than imported because `lib/db/queries/albums.ts` is `server-only` and this is a client
 * component. A `ViewerLog` is assignable to it, which is the point: the caller hands over what
 * `getViewerAlbumState` returned.
 */
export type LogDialogInitial = {
  /** The stored 1..10 scale, or null for unrated. */
  rating: number | null;
  review: string | null;
  /** A STRING (I-9), and the member's own calendar date — never rebuilt from a `Date`. */
  listenedOn: string | null;
  isReplay: boolean;
  /** The AUTHOR'S heart on the thing they played — not the `likes` table. */
  liked: boolean;
  tags: string[];
};

export type LogDialogProps = {
  /**
   * The polymorphic target, exactly as `saveLog` takes it: `{ artistId }`, `{ albumId }`, or
   * `{ albumId, discNumber, trackNumber }`. `targetType` is NOT a field — the server derives it
   * with `targetTypeOf`, because a caller who could set it could write `target_type = 'album'`
   * on a row carrying a track number and every aggregate would count that row twice.
   */
  target: TargetInput;
  /** REQUIRED. Read the docblock before making this optional. */
  initial: LogDialogInitial;
  /** The headline: an album title, a track title, or an artist name. */
  title: string;
  /**
   * The mono code line under the cover: A TRACK LOCATOR for a track log, THE ALBUM TITLE for an
   * album log, and NOTHING for an artist log — an artist has no ordinal and no container, so
   * the line is absent rather than padded with the word "Artist".
   */
  code?: string | null;
  /** Usually the artist name. */
  subtitle?: string | null;
  /** Already sized by the caller through `albumCover(album, 250)`. */
  coverUrl?: string | null;
  /** The trigger. EXACTLY ONE ELEMENT — it is rendered through Radix `asChild`. */
  children: React.ReactNode;
  className?: string;
};

/** Which button is mid-flight, so both cannot read "Saving…" at once. */
type SavePath = "save" | "again";

/**
 * Tag parsing, client-side.
 *
 * TAGS ARE TRUNCATED RATHER THAN REJECTED: the server caps length and count, and a silent trim
 * beats bouncing the whole form for a typo in a minor field. Somebody who types thirteen tags
 * gets twelve and a hint saying so; somebody who types a 40-character tag gets 32 characters of
 * it. Neither is worth losing a review over.
 *
 * `.trim().toLowerCase()` RUNS BEFORE `.slice()`, and the order is invariant I-8 rather than a
 * style choice: `İ` lower-cases to TWO code units, so a 17-character tag normalises to 34 and
 * overflows `varchar(32)` at INSERT. Slicing after lowercasing is what makes the string that
 * leaves here the same string the server measures.
 *
 * Dedupe is a `Set` over the NORMALISED values, which is also why `tagList` on the server
 * deliberately does not dedupe: "at most 12 tags" reported for thirteen that collapse to nine
 * is a confusing message about a field nobody cares about.
 */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of input.split(",")) {
    const tag = raw.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (!tag) continue; // drop empties: "a,,b" and a trailing comma are both ordinary typing
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }

  return out;
}

export function LogDialog({
  target,
  initial,
  title,
  code,
  subtitle,
  coverUrl,
  children,
  className,
}: LogDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [path, setPath] = React.useState<SavePath | null>(null);
  const [pending, startTransition] = React.useTransition();

  /* -- form state, seeded from the REAL row ---------------------------------------------- */
  const [rating, setRating] = React.useState<number | null>(initial.rating);
  const [review, setReview] = React.useState(initial.review ?? "");
  /** THE NULL-`listened_on` ENCODING, as a checkbox. See the docblock. */
  const [inDiary, setInDiary] = React.useState(initial.listenedOn !== null);
  const [dateText, setDateText] = React.useState(initial.listenedOn ?? "");
  const [liked, setLiked] = React.useState(initial.liked);
  const [isReplay, setIsReplay] = React.useState(initial.isReplay);
  const [tagText, setTagText] = React.useState(initial.tags.join(", "));

  // Ids for the label/control pairing. `Field` deliberately does not generate them, and
  // `useId` is the one generator whose output is stable across a server and client render.
  const fieldId = React.useId();

  /**
   * ON OPEN, NOT ON CLOSE. Re-seeding here is what makes an abandoned edit discarded and a
   * dismissed failure recoverable — see the docblock.
   */
  function reseed() {
    setRating(initial.rating);
    setReview(initial.review ?? "");
    setInDiary(initial.listenedOn !== null);
    setDateText(initial.listenedOn ?? "");
    setLiked(initial.liked);
    setIsReplay(initial.isReplay);
    setTagText(initial.tags.join(", "));
    setError(null);
    setPath(null);
  }

  function onOpenChange(next: boolean) {
    // THE REFUSAL. Escape, the overlay and the wrapper's own `X` all arrive here.
    if (!next && pending) return;
    if (next) reseed();
    setOpen(next);
  }

  function submit(createNew: boolean) {
    setError(null);
    setPath(createNew ? "again" : "save");

    // The checkbox resolves to the column: a date when it is on, SQL NULL when it is off. An
    // empty text field with the box checked means "today" rather than an error, because the
    // member has already said they played it.
    const listenedOn = inDiary ? dateText || localCalendarDate() : null;

    startTransition(async () => {
      const result = await saveLog({
        ...target,
        rating,
        // Sent as a string, always. The server turns whitespace-only into SQL NULL once, so an
        // emptied box is a real clear rather than a blank review with a byline.
        review,
        // THE TWO RULES. A second listen is dated today AND always flagged a replay.
        listenedOn: createNew ? (listenedOn ?? localCalendarDate()) : listenedOn,
        isReplay: createNew || isReplay,
        liked,
        // A REPLACE, not a merge: this dialog shows the tags, so an empty array is the member
        // clearing them.
        tags: parseTags(tagText),
        createNew,
      });

      if (!result.ok) {
        // NOTHING IS ROLLED BACK BECAUSE NOTHING WAS OPTIMISTIC. The dialog stays open with
        // every field exactly as typed, which is the only state from which a member can fix a
        // refusal — a closed dialog that lost the review is the failure this component exists
        // to prevent.
        setError(result.error);
        setPath(null);
        return;
      }

      setPath(null);
      setOpen(false);
      /*
       * `router.refresh()`. Everything derived from this write is server-rendered: the
       * consensus card, the histogram, the heatmap cells, the diary, the profile totals, the
       * feed. There is no honest way to reconcile those in the browser.
       */
      router.refresh();
    });
  }

  /**
   * THE GUEST CAP RENDERS AS AN OFFER, NOT AN ERROR.
   *
   * A refusal that says "create an account" is not an error the member can fix by trying
   * again, so it does not get the rose `FormError` treatment — it gets an amber panel with the
   * two doors in it. `GUEST_REVIEW_CAP_MESSAGE` is deliberately not imported: lib/auth/guest.ts
   * opens with `import "server-only"`, so the string cannot cross into the browser, and the
   * message rendered below is THE SERVER'S OWN COPY arriving in `result.error` rather than a
   * second hand-written one.
   *
   * THE DETECTION COUPLES THIS CLIENT TO THE SERVER'S WORDING, because `ActionResult` has no
   * machine-readable code field. That is the documented trade: the alternative is a `code` on
   * every `ActionResult` in the application — a change to a frozen contract for the benefit of
   * one branch. It survives only because the sentence is declared once, in
   * `GUEST_REVIEW_CAP_MESSAGE`, and a test asserts it contains this substring.
   */
  const guestCap = error !== null && error.includes("Create an account");
  const today = localCalendarDate();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>

      <DialogContent
        className={className}
        // Belt and braces for the refusal above. The controlled `open` is what actually keeps
        // the dialog mounted; these two stop Radix running its dismiss side effects at all, and
        // they are the self-documenting version of the rule for the next reader.
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          {/* FIELD 1 — the cover and the code line, so the member can see WHAT they are about
              to write about. A dialog that says only "Log" is how somebody rates the wrong
              track from a page with twelve of them. */}
          <div className="flex items-start gap-3">
            <div className="sleeve w-16 shrink-0">
              {coverUrl ? (
                // A plain <img>, like every other cover in the app: the CDN has already
                // rendered the requested width and the optimiser would add a hop to re-derive
                // it. Empty alt — the title is the next element and is the content.
                <img src={coverUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
              ) : null}
              {/* No placeholder graphic, ever. `.sleeve`'s own field and hairline ARE the empty
                  state; a "no artwork" image is a claim that we looked. */}
            </div>

            <div className="min-w-0">
              <DialogTitle className="text-xl">{title}</DialogTitle>
              {subtitle ? <p className="mt-0.5 truncate text-sm text-muted">{subtitle}</p> : null}
              {/* Nothing at all for an artist log — there is no ordinal and no container to
                  print, and the word "Artist" here would be a label pretending to be data. */}
              {code ? (
                <p className="mt-1 font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">{code}</p>
              ) : null}
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          {/* FIELD 2 — the rating. NO `onCommit`: a form that saves on submit must not write per
              keystroke, so the star input gets no debounce timer at all rather than a cancelled
              one. `onChange` alone makes it pure form state. */}
          <Field>
            {/*
              `Eyebrow`, NOT `Label`. A `<label>` needs a control to point at, and `StarInput`
              is a `role="slider"` div that carries its own `aria-label` — a `<label for="">`
              aimed at nothing is a promise the accessibility tree does not keep. The visible
              treatment is identical: `Label` is `.eyebrow` with `block` on it.
            */}
            <Eyebrow>Your rating</Eyebrow>
            <StarInput
              value={rating}
              onChange={setRating}
              size="lg"
              label={`Your rating for ${title}`}
              className="mt-0.5"
            />
          </Field>

          {/* FIELD 3 — the diary checkbox, which IS the null-`listened_on` encoding. */}
          <div className="space-y-2">
            <CheckboxField
              label="Add to diary"
              checked={inDiary}
              onChange={(event) => {
                const next = event.currentTarget.checked;
                setInDiary(next);
                // Prefill on the first tick: an empty date input is a worse offer than today's
                // date, and "today" is what an unspecified play means.
                if (next && !dateText) setDateText(today);
              }}
            />
            <FieldHint>
              A dated entry is a play — it counts in your diary, your year and your listening
              time. Leave it off to rate or review without claiming a date.
            </FieldHint>

            {/* FIELD 4 — shown only when checked, because an inert date field beside an
                unchecked box invites somebody to fill in a date that will not be saved. */}
            {inDiary ? (
              <Field>
                <Label htmlFor={`${fieldId}-date`}>Listened on</Label>
                <Input
                  id={`${fieldId}-date`}
                  type="date"
                  value={dateText}
                  onChange={(event) => setDateText(event.currentTarget.value)}
                  // `max` is the MEMBER'S OWN today, not a UTC slice — the server's ceiling is
                  // UTC today + 1 day precisely so a member ahead of UTC is not refused their
                  // own date. `min` is the schema's floor, which is before recorded music.
                  max={today}
                  min={CALENDAR_DATE_FLOOR}
                  className="max-w-44"
                />
              </Field>
            ) : null}
          </div>

          {/* FIELD 5 — the two flags. `aria-pressed` toggles rather than checkboxes, because
              each is one glyph and one word whose whole state is "on or off", and a checkbox
              row beside the diary checkbox above would read as three settings of one kind. */}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={liked ? "primary" : "secondary"}
              aria-pressed={liked}
              onClick={() => setLiked((value) => !value)}
              className={liked ? "bg-rose text-ink hover:bg-rose/90" : undefined}
            >
              {/* `fill` rather than a second component: swapping the element swaps the DOM node,
                  which loses focus mid-toggle. */}
              <Heart fill={liked ? "currentColor" : "none"} aria-hidden="true" />
              {liked ? "Loved" : "Love it"}
            </Button>

            <Button
              type="button"
              size="sm"
              variant={isReplay ? "primary" : "secondary"}
              aria-pressed={isReplay}
              onClick={() => setIsReplay((value) => !value)}
              // Teal is replay and completion ONLY in this palette.
              className={isReplay ? "bg-teal text-ink hover:bg-teal/90" : undefined}
            >
              <Repeat2 aria-hidden="true" />
              Replay
            </Button>
          </div>

          {/* FIELD 6 — the review. */}
          <Field>
            <Label htmlFor={`${fieldId}-review`}>Review</Label>
            <Textarea
              id={`${fieldId}-review`}
              value={review}
              onChange={(event) => setReview(event.currentTarget.value)}
              // The bound is the schema's, imported rather than retyped: a fourth copy of a
              // number is a fourth thing to keep in step.
              maxLength={MAX_REVIEW_BODY}
              placeholder="What did you hear?"
            />
          </Field>

          {/* FIELD 7 — the tags. */}
          <Field>
            <Label htmlFor={`${fieldId}-tags`}>Tags</Label>
            <Input
              id={`${fieldId}-tags`}
              value={tagText}
              onChange={(event) => setTagText(event.currentTarget.value)}
              placeholder="shoegaze, rainy, late night"
              aria-describedby={`${fieldId}-tags-hint`}
            />
            <FieldHint id={`${fieldId}-tags-hint`}>
              {`Comma separated, lower-cased, up to ${MAX_TAGS} tags of ${MAX_TAG_LENGTH} characters. Anything over is trimmed rather than refused.`}
            </FieldHint>
          </Field>

          {guestCap ? (
            /*
             * THE OFFER. Amber, not rose: this is the product asking for something, and the
             * member has done nothing wrong. Both doors are real links, so middle-click and
             * copy-link work and the guest's own logs travel with them either way.
             */
            <div role="status" className="rounded-card border border-amber/40 bg-amber/12 p-3">
              <Eyebrow className="text-amber">One more thing</Eyebrow>
              {/* THE SERVER'S OWN SENTENCE, rendered verbatim. There is no second copy of it in
                  this file — see the note above `guestCap`. */}
              <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-paper">{error}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button asChild size="sm" variant="primary">
                  <Link href="/signup">Create an account</Link>
                </Button>
                <Button asChild size="sm" variant="ghost">
                  <Link href="/login">I already have one</Link>
                </Button>
              </div>
            </div>
          ) : (
            // Everything else is an ordinary refusal, rendered beside the form that caused it.
            <FormError message={error} />
          )}
        </div>

        <DialogFooter>
          {/*
            TWO SUBMITS, AND `path` IS WHY THEY CANNOT BOTH SAY "Saving…". One shared `pending`
            flag drives both buttons' disabled state — only one request can be in flight — but a
            member who presses "Log again" must see THAT button working, not both of them.
          */}
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => submit(true)}
            // The name states the rule the button encodes, because "Log again" alone does not
            // say that it dates the entry today and flags it a replay.
            aria-label={`Log ${title} again — a new entry, dated today and flagged a replay`}
          >
            {path === "again" ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Repeat2 aria-hidden="true" />}
            {path === "again" ? "Saving…" : "Log again"}
          </Button>

          <Button type="button" variant="primary" disabled={pending} onClick={() => submit(false)}>
            {path === "save" ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {path === "save" ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

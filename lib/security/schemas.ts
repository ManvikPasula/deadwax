/**
 * Every input rule in the application, once.
 *
 * THIS MODULE IS DELIBERATELY PURE. No `server-only`, no `next/headers`, no database import.
 * Two consequences, both wanted: it is unit-testable without a request or a connection, and a
 * client component can import `MAX_COMMENT_BODY` for a `maxLength` attribute instead of
 * hard-coding 2000 next to a schema that says 2000.
 *
 * WHY ONE MODULE RATHER THAN A SCHEMA BESIDE EACH ACTION. Two of the defects found in the
 * original audit came from copies drifting apart: sign-up and sign-in each had their own
 * password schema, and the stricter one created accounts that could not then be signed into
 * (I-25, SEC-04). One definition per rule is the fix, and it only holds if there is exactly
 * one place to put a definition.
 *
 * THE TYPE-ONLY IMPORT OF `TargetType` IS LOAD-BEARING FOR PURITY. `@/lib/db/schema` pulls in
 * `drizzle-orm/pg-core`; `import type` is erased at transpile, so nothing from it reaches a
 * client bundle. Do not turn it into a value import for convenience.
 */

import { z } from "zod";

import type { TargetType } from "@/lib/db/schema";
import { DISC_MAX, DISC_MIN, MAX_DB_INT, TRACK_MAX, TRACK_MIN } from "@/lib/slug";
import { hasGuestPrefix, isReserved } from "@/lib/username";

/* ========================================================================== *
 * IDENTITY
 * ========================================================================== */

export const MIN_USERNAME_LENGTH = 3;
/** The column is `varchar(32)`, deliberately roomier than the rule, so a rule change is not DDL. */
export const MAX_USERNAME_LENGTH = 24;

/**
 * AN ALLOWLIST, NOT A DENYLIST, and that is the whole point: anything outside
 * `[a-zA-Z0-9_]` cannot appear in a URL segment, in a `revalidatePath` argument, or in a
 * filename. A denylist of dangerous characters is a promise to have thought of all of them;
 * this is a promise to have thought of none of them.
 *
 * The two refinements are separate on purpose. "That name is taken by the system" and "names
 * cannot start with guest_" are different facts, and a member who hits one should not be told
 * the other.
 */
export const usernameSchema = z
  .string()
  .trim()
  .min(MIN_USERNAME_LENGTH, `Usernames are at least ${MIN_USERNAME_LENGTH} characters.`)
  .max(MAX_USERNAME_LENGTH, `Usernames are at most ${MAX_USERNAME_LENGTH} characters.`)
  .regex(/^[a-zA-Z0-9_]+$/, "Letters, numbers and underscores only.")
  .refine((value) => !isReserved(value), "That username is reserved.")
  // Without this ban a member could register `guest_ab12cd34` and be taken for a guest — or a
  // guest taken for them by any surface that reads the name instead of `users.is_guest`.
  .refine((value) => !hasGuestPrefix(value), "Usernames cannot start with “guest_”.");

/** `users.email` is `varchar(255)`; the bound is the column, so an insert cannot fail on length. */
export const MAX_EMAIL_LENGTH = 255;

/**
 * Length BEFORE format. The email pattern is cheap but not free, and a caller can post a
 * megabyte; measuring first means the expensive check never sees it. Same reasoning as
 * `passwordSchema`'s 400-character guard.
 *
 * Trimmed but NOT lower-cased. Storage is case-preserving so a member sees the address they
 * typed, and uniqueness is the database's functional `lower(email)` index rather than
 * something this schema has to emulate (I-26).
 */
export const emailSchema = z
  .string()
  .trim()
  .min(1, "Enter your email address.")
  .max(MAX_EMAIL_LENGTH, "That email address is too long.")
  .pipe(z.email("That does not look like an email address."));

export const MIN_PASSWORD_LENGTH = 8;
/**
 * A cheap guard so a megabyte string is rejected before it is encoded. It is not the real
 * limit — the real limit is bytes, below — and it is deliberately far above it, because a
 * character count and a byte count refuse different strings and telling somebody "at most 72
 * characters" when the rule is bytes is how you produce a password nobody can reproduce.
 */
export const MAX_PASSWORD_LENGTH = 400;

/**
 * INVARIANT I-24 / SEC-16: BYTES, NOT CHARACTERS.
 *
 * bcrypt silently truncates its input at 72 bytes. `"é".repeat(72)` — or any accented
 * Latin, or any CJK — is 72 characters and 144 bytes, so bcrypt would hash only the first 36
 * characters and those 36 would authenticate. Measuring with `TextEncoder` is what closes it.
 *
 * Rejected alternative: truncate to 72 bytes and hash that. It makes a shorter password
 * silently equivalent to a longer one, which is the same defect wearing a helpful face.
 */
export const PASSWORD_MAX_BYTES = 72;

const encoder = new TextEncoder();

/** Exported because the sign-up form shows a live byte count for exactly this reason. */
export function passwordByteLength(value: string): number {
  return encoder.encode(value).length;
}

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Passwords are at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH, "That password is too long.")
  .refine(
    (value) => passwordByteLength(value) <= PASSWORD_MAX_BYTES,
    `That password is too long. The limit is ${PASSWORD_MAX_BYTES} bytes, and accented or non-Latin characters cost more than one byte each.`,
  );

/**
 * The one message every authentication refusal uses.
 *
 * Exported so the sign-in action, `authorize()` and the sign-in form cannot each invent their
 * own. It must stay indistinguishable between "no such account", "wrong password" and "that
 * account is a guest" — a form that distinguishes them is a membership oracle answerable in
 * bulk against a breach list.
 */
export const GENERIC_AUTH_FAILURE = "Email or password is incorrect.";

/**
 * SIGN-IN IS NOT SIGN-UP, and the difference is not laxity.
 *
 * `min(1)` rather than `min(8)`: a member whose password predates the current rule must still
 * be able to sign in. Rejecting it here would lock out the exact accounts the rule was
 * introduced to protect, and there is no self-service path back.
 *
 * The over-length messages are `GENERIC_AUTH_FAILURE`, never a length explanation. A
 * length-specific refusal on the sign-in form tells a guesser that their candidate was
 * malformed rather than wrong, which is one bit of the answer.
 */
export const signInSchema = z.object({
  email: z.string().trim().min(1, GENERIC_AUTH_FAILURE).max(MAX_EMAIL_LENGTH, GENERIC_AUTH_FAILURE),
  password: z
    .string()
    .min(1, GENERIC_AUTH_FAILURE)
    .max(MAX_PASSWORD_LENGTH, GENERIC_AUTH_FAILURE)
    .refine((value) => passwordByteLength(value) <= PASSWORD_MAX_BYTES, GENERIC_AUTH_FAILURE),
});
export type SignInInput = z.infer<typeof signInSchema>;

/**
 * Note what is NOT here: `displayName`, `avatarSeed` and `role`.
 *
 * The first two are derived server-side (display name defaults to the username, the avatar
 * seed is generated), and `role`/`plan` have no member-facing write path at all — see the
 * comment on `users.role`. A field absent from the schema cannot be smuggled in by a caller
 * that sends it anyway, because `z.object` strips unknown keys.
 */
export const signUpSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
});
export type SignUpInput = z.infer<typeof signUpSchema>;

/* ========================================================================== *
 * DATES
 * ========================================================================== */

/** `DECISIONS.md` §3: the television original's floor was 1930, "that is before television". */
export const CALENDAR_DATE_FLOOR = "1900-01-01";

/**
 * The date literals Postgres accepts in a `date` column and nobody expects it to.
 *
 * INVARIANT I-4 / SEC-05, and it is the most expensive defect in the source audit: one stored
 * `infinity` made `EXTRACT(YEAR FROM listened_on)` throw on a member's public pages FOR EVERY
 * VISITOR, PERMANENTLY, with no way to undo it from the interface — the year page 500s, and
 * the year page is where you would go to delete the entry.
 *
 * Layer 1's regex already excludes every one of these. This set exists anyway because the
 * regex is the kind of thing that gets loosened ("let them type 2024-3-4") by somebody who has
 * never heard of `allballs`, and because a named set is a place to put this paragraph.
 */
export const POSTGRES_DATE_LITERALS: ReadonlySet<string> = new Set([
  "infinity",
  "-infinity",
  "now",
  "today",
  "yesterday",
  "tomorrow",
  "epoch",
  "allballs",
]);

/**
 * UTC today plus one day, as `YYYY-MM-DD`.
 *
 * THE `+1` IS THE TIMEZONE FIX, not slack. A member in UTC+13 logging at 09:00 local is
 * already on tomorrow's UTC date, and their own calendar date is the one the client sends
 * (`localCalendarDate` in lib/format.ts). Without the extra day the server refuses them for
 * logging "something you have not heard yet" — on a record they played this morning.
 *
 * Computed per call, never at module scope: a long-lived server that froze "today" at boot
 * would start refusing every diary entry the following midnight.
 */
export function calendarDateCeiling(now: Date = new Date()): string {
  return new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
}

/**
 * FIVE LAYERS, and each one catches something the others do not.
 *
 *   1. The shape. Fixed-width `YYYY-MM-DD` only.
 *   2. A round trip through `Date`. This is what rejects `2026-02-30`: `Date` parses it and
 *      normalises it to `2026-03-02`, so the round trip no longer equals the input. A regex
 *      cannot know February's length and a per-month lookup table is a second copy of the
 *      calendar.
 *   3. The Postgres literals (I-4 — see `POSTGRES_DATE_LITERALS`).
 *   4. The floor. 1900, because that is before recorded music.
 *   5. The ceiling. UTC today + 1 day (see `calendarDateCeiling`).
 *
 * The output is a STRING, deliberately. Drizzle reads and writes `date` columns as JS strings
 * and `timestamptz` as `Date` objects (I-9); handing a `Date` to `logs.listenedOn` is how you
 * get `"Invalid Date"` in a diary heading.
 */
export const calendarDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates look like 2001-10-02.")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "That date does not exist.")
  .refine((value) => !POSTGRES_DATE_LITERALS.has(value.toLowerCase()), "That date does not exist.")
  .refine((value) => value >= CALENDAR_DATE_FLOOR, "That is before recorded music.")
  .refine((value) => value <= calendarDateCeiling(), "You cannot log something you have not heard yet.");

/* ========================================================================== *
 * TEXT BODIES
 *
 * Every bound below is either a column width — so an insert cannot fail on length — or a
 * number with a reason written next to it. A bound with neither is a bound somebody will
 * change.
 * ========================================================================== */

export const MAX_TAGS = 12;
/** `log_tags.tag` is `varchar(32)`. The schema bound IS the column width. */
export const MAX_TAG_LENGTH = 32;

/**
 * NORMALISE BEFORE MEASURING. INVARIANT I-8, AND REVERSING THESE TWO LINES REINTRODUCES THE
 * BUG.
 *
 * `.trim().toLowerCase()` run before `.min()/.max()` because Zod applies string checks in
 * declaration order. `İ` (LATIN CAPITAL LETTER I WITH DOT ABOVE) lower-cases to TWO code
 * units, so a 17-character tag that passed a 32-character check became a 34-character value
 * and overflowed `varchar(32)` at INSERT — after the log row had already been written, which
 * is how it also became invariant I-32's transaction.
 *
 * Deduplication is deliberately NOT here. `saveLog` does `[...new Set(tags)]` after
 * normalisation, because the set has to be taken on the normalised values and a schema that
 * silently drops entries makes a confusing error message ("12 tags maximum" on 13 that
 * collapse to 9).
 */
export const tagList = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .min(1, "A tag cannot be blank.")
      .max(MAX_TAG_LENGTH, `Tags are at most ${MAX_TAG_LENGTH} characters.`),
  )
  .max(MAX_TAGS, `At most ${MAX_TAGS} tags.`);

/** Long enough for an essay, bounded so one row cannot be a megabyte. */
export const MAX_REVIEW_BODY = 20_000;
export const reviewBody = z.string().max(MAX_REVIEW_BODY, "That review is too long.");

/**
 * MUST STAY IN SYNC IN THREE PLACES: this schema, the textarea's `maxLength`, and the
 * character counter that appears at 1,801. Exported as a number for exactly that reason —
 * `maxLength={2000}` in a component is the fourth copy waiting to happen.
 */
export const MAX_COMMENT_BODY = 2_000;
export const commentBody = z
  .string()
  .trim()
  .min(1, "Write something first.")
  .max(MAX_COMMENT_BODY, "That comment is too long.");

/** `users.display_name` is `varchar(64)`. */
export const MAX_DISPLAY_NAME = 64;
export const displayNameSchema = z.string().trim().max(MAX_DISPLAY_NAME, "That display name is too long.");

/** `users.bio` is `text`, so this bound is a product decision: a profile header holds about five lines. */
export const MAX_BIO = 500;
export const bioSchema = z.string().trim().max(MAX_BIO, `Keep it under ${MAX_BIO} characters.`);

/** `lists.title` is `varchar(120)`. */
export const MAX_LIST_TITLE = 120;
export const listTitleSchema = z
  .string()
  .trim()
  .min(1, "Give the list a title.")
  .max(MAX_LIST_TITLE, "That title is too long.");

/** `lists.description` is `text`; bounded for the same reason as `reviewBody`. */
export const MAX_LIST_DESCRIPTION = 2_000;
export const listDescription = z.string().trim().max(MAX_LIST_DESCRIPTION, "That description is too long.");

/** `lists.note` / `wantlist.note` — one line of context, not a second review. */
export const MAX_NOTE = 280;
export const noteSchema = z.string().trim().max(MAX_NOTE, "That note is too long.");

/**
 * `users.avatar_seed` is `varchar(32)`. Avatars are generated gradients (there are no
 * uploads), so the seed is the entire avatar — and it is interpolated into a CSS gradient, so
 * it gets the same allowlist treatment as a username rather than being trusted as opaque text.
 */
export const MAX_AVATAR_SEED = 32;
export const avatarSeedSchema = z
  .string()
  .trim()
  .min(1, "Pick an avatar.")
  .max(MAX_AVATAR_SEED, "That avatar seed is too long.")
  .regex(/^[a-zA-Z0-9_-]+$/, "Letters, numbers, hyphens and underscores only.");

/* ========================================================================== *
 * IDS AND TARGETS
 * ========================================================================== */

/**
 * Bounded at `MAX_DB_INT`, imported from `lib/slug.ts` where it is declared ONCE.
 *
 * An id above int4 range reaches Postgres as "value out of range for type integer" — a 500
 * where a 404 belongs (I-5). The URL parsers close that for path segments; these close it for
 * ids arriving in an action payload, which is a different entry point with the same failure.
 */
export const artistIdSchema = z.int().min(1, "Unknown artist.").max(MAX_DB_INT, "Unknown artist.");
export const albumIdSchema = z.int().min(1, "Unknown album.").max(MAX_DB_INT, "Unknown album.");
export const listIdSchema = z.int().min(1, "Unknown list.").max(MAX_DB_INT, "Unknown list.");
export const logIdSchema = z.int().min(1, "Unknown entry.").max(MAX_DB_INT, "Unknown entry.");
export const commentIdSchema = z.int().min(1, "Unknown comment.").max(MAX_DB_INT, "Unknown comment.");
export const userIdSchema = z.int().min(1, "Unknown member.").max(MAX_DB_INT, "Unknown member.");

/**
 * MIN IS 0, NOT 1, for both — a pregap or a hidden track is legitimately numbered 0, and
 * Deezer returns `track_position: 0` for them. The bounds themselves come from `lib/slug.ts`
 * so the URL grammar and the action payload cannot disagree about what a track number is.
 */
export const discNumberSchema = z
  .int()
  .min(DISC_MIN, "Unknown disc.")
  .max(DISC_MAX, "Unknown disc.");
export const trackNumberSchema = z
  .int()
  .min(TRACK_MIN, "Unknown track.")
  .max(TRACK_MAX, "Unknown track.");

/**
 * The polymorphic target, shared by `logs`, `list_items` and `desert_island`.
 *
 * `targetType` IS NOT A FIELD HERE. It is derived by `targetTypeOf()` below and never accepted
 * from a client: the column is a `varchar(8)` with no check constraint, so a caller who could
 * set it could write `target_type = 'album'` on a row carrying a track number and every
 * aggregate that switches on the column would then count it twice.
 *
 * `artistId` is optional because on an album or track log the server RESOLVES IT FROM THE
 * ALBUM ROW and ignores whatever arrived. That closes "log a track against the wrong artist"
 * without needing its own check.
 */
export const targetSchema = z.object({
  artistId: artistIdSchema.optional(),
  albumId: albumIdSchema.optional(),
  discNumber: discNumberSchema.optional(),
  trackNumber: trackNumberSchema.optional(),
});
export type TargetInput = z.infer<typeof targetSchema>;

/**
 * THE DIRECTION OF THE TREE, in one expression.
 *
 * In the television original `show_id` is always present and the season/episode ordinals
 * narrow it. Here `artist_id` is the always-present anchor, `album_id` narrows it, and
 * `(disc_number, track_number)` narrow that — so the most specific present field decides the
 * tier.
 *
 * `!== undefined`, not truthiness: `trackNumber: 0` is a real pregap track and `albumId` is
 * never 0 (serials start at 1), but a truthiness test would silently demote that pregap log to
 * an album-level one and merge it into the album's own rating.
 */
export function targetTypeOf(input: TargetInput): TargetType {
  if (input.trackNumber !== undefined) return "track";
  if (input.albumId !== undefined) return "album";
  return "artist";
}

/** The two likeable/commentable containers. Comments themselves cannot be liked. */
export const socialTargetSchema = z.enum(["log", "list"]);

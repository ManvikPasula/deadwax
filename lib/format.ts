/**
 * Display formatting. PURE and client-safe.
 */

/**
 * Track length.
 *
 * The television original sums `COALESCE(e.runtime, s.episode_run_time, 0)` because TMDB's own
 * runtime field "is an empty array for every show checked", so a median-over-mirrored-episodes
 * fallback is load-bearing there. THAT WHOLE BRANCH IS ABSENT HERE: every Deezer track carries
 * a reliable duration, so listening time is a plain SUM of milliseconds computed at ingest.
 * The brief says explicitly that the runtime workaround should not be ported; this is what
 * replaces it.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Long-form, for totals: "1,204 hours" / "37 minutes". */
export function formatListeningTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 minutes";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return `${days} day${days === 1 ? "" : "s"}, ${remainder} hour${remainder === 1 ? "" : "s"}`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en-GB").format(Math.round(value));
}

/** "2001" from a date string or null. The year is what a cover caption carries. */
export function releaseYear(date: string | Date | null | undefined): string | null {
  if (!date) return null;
  const text = typeof date === "string" ? date : date.toISOString().slice(0, 10);
  const match = /^(\d{4})/.exec(text);
  return match ? match[1]! : null;
}

/** "3 March 2001" */
export function formatDate(date: string | Date | null | undefined): string | null {
  if (!date) return null;
  const value = typeof date === "string" ? new Date(`${date.slice(0, 10)}T00:00:00Z`) : date;
  if (Number.isNaN(value.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
}

/** "2 days ago" — for feed rows, where the absolute time is noise. */
export function formatRelative(date: Date | string, now = new Date()): string {
  const value = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(value.getTime())) return "";
  const seconds = Math.round((now.getTime() - value.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** Pluralise without a library. `plural(1, "track")` -> "1 track". */
export function plural(count: number, noun: string, pluralForm?: string): string {
  return `${formatCount(count)} ${count === 1 ? noun : (pluralForm ?? `${noun}s`)}`;
}

/**
 * The member's local calendar date.
 *
 * THE TIMEZONE FIX. The television original computes every date as
 * `new Date().toISOString().slice(0, 10)` — UTC, on both client and server, with no timezone
 * handling anywhere. The brief spells out both failures: a member in UTC+13 logging at 09:00
 * local gets YESTERDAY's date, and a member in UTC-8 logging at 18:00 can have the client
 * send a date the server's UTC-based upper bound already considers future, failing the save
 * with "You cannot log something you have not watched yet."
 *
 * So the client sends its own calendar date and the server accepts it only within +/- 1 day of
 * UTC today (see `calendarDate` in lib/security/schemas.ts). This function is the client half.
 */
export function localCalendarDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The server half: UTC today, used for bounds rather than for stamping. */
export function utcCalendarDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * SQL LIKE escaping. Seventeen lines whose docblock is an incident report.
 *
 *   Without this, `%` matches every row — a search for "%" returned the whole catalogue and
 *   the entire member list — and a title containing `_` or `%` could never be found by typing
 *   it. Postgres' default escape character is a backslash, and no query here specifies an
 *   explicit ESCAPE clause; the code relies on that default.
 *
 * THIS MATTERS MORE IN MUSIC THAN IN TELEVISION. Album and track titles contain `_` and `%`
 * far more often than episode titles do: "100%", "_______", "50% Off", "N_E_R_D". A member
 * typing the real title of a record and getting nothing back reads as a missing catalogue,
 * not as an escaping bug — which is exactly why this defect survived so long in the original.
 *
 * NAMING TRAP — three unrelated meanings of "like" in one codebase:
 *   (a) THIS FILE is SQL LIKE escaping.
 *   (b) `logs.liked boolean` is the AUTHOR'S OWN heart on the thing they played.
 *   (c) the `likes` table is OTHER MEMBERS hearting a review or a list.
 */

/** Escapes the three characters Postgres LIKE treats specially. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** ESCAPE FIRST, THEN WRAP. Reversing the order escapes the wildcards you just added. */
export function containsPattern(value: string): string {
  return `%${escapeLike(value)}%`;
}

/** Prefix match, for typeahead-shaped lookups. Same ordering rule. */
export function startsWithPattern(value: string): string {
  return `${escapeLike(value)}%`;
}

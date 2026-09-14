import "server-only";

import { createHash, randomBytes } from "node:crypto";

/**
 * Email-confirmation and password-reset link tokens.
 *
 * ONLY THE SHA-256 IS EVER STORED (I-27). `createLinkToken()` returns the plaintext once, to
 * be put in exactly one email and then forgotten; the row holds the digest. A database leak
 * then yields nothing redeemable, which is the entire reason the two token tables have a
 * `token_hash` column rather than a `token` one.
 *
 * SHA-256 RATHER THAN BCRYPT OR ARGON2, AND THAT IS NOT A COMPROMISE. A slow KDF exists to
 * make guessing a low-entropy human secret expensive. This is 256 bits of CSPRNG output —
 * there is nothing to guess, so the work factor would only slow down the legitimate lookup,
 * and the lookup is on the hot path of a link somebody just clicked. The rule of thumb is
 * about the entropy of the input, not about the word "token".
 *
 * A plain (unsalted, unpeppered) digest is also what makes the lookup possible: the row is
 * found BY the hash through a unique index, so there is no per-row salt to iterate over. That
 * is a deliberate trade and it is only sound because of the entropy above.
 */

/**
 * 32 bytes of CSPRNG output, base64url-encoded: 43 characters, 256 bits.
 *
 * base64url rather than hex so the link is 43 characters instead of 64, and rather than plain
 * base64 so `+`, `/` and `=` never need percent-encoding in a query string — a token that
 * survives being copied out of a mail client and pasted into a browser is worth more than two
 * characters of length.
 */
export function createLinkToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: sha256hex(token) };
}

/** Exported because redeeming a token means hashing the one that arrived and looking THAT up. */
export function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The shape check, applied BEFORE the database is touched.
 *
 * 43 characters of the base64url alphabet, with no padding — exactly what `createLinkToken`
 * produces. It is a cheap filter on a public endpoint, not a security control: a token of the
 * right shape still has to match a row, be unconsumed, be unexpired, belong to a live account
 * and match the address it was issued for. Its value is that a scanner hitting `/reset?token=`
 * with junk never becomes a query.
 *
 * Note this rejects a token with a trailing newline or a space, which is what a mail client's
 * line wrapping produces. That is intentional: the caller should surface the same single
 * refusal reason rather than trying to repair the input, because "repair the input" is how a
 * near-miss becomes a hit.
 */
export const looksLikeLinkToken = /^[A-Za-z0-9_-]{43}$/;

/**
 * SIXTY MINUTES FOR A CONFIRMATION, THIRTY FOR A RESET, and the asymmetry is the point.
 *
 * A confirmation link only proves that somebody reads mail at an address. A reset link TAKES
 * OVER AN ACCOUNT. So the interval in which a leaked or forwarded mailbox is dangerous should
 * be as small as is still usable, and 30 minutes is about the floor for "open the mail on your
 * phone, find the laptop, type a password twice".
 *
 * Rejected alternative: one shared TTL. It forces the confirmation flow to be as impatient as
 * the reset flow or the reset flow to be as relaxed as the confirmation one, and the second is
 * the direction people pick.
 */
export const VERIFICATION_TTL_MINUTES = 60;
export const PASSWORD_RESET_TTL_MINUTES = 30;

/**
 * `expires_at` for a token issued now.
 *
 * Returns a `Date` because both token tables' `expires_at` is `timestamptz`, which Drizzle
 * reads and writes as a `Date` — unlike a `date` column, which it hands back as a string
 * (I-9). Mixing the two produces `"Invalid Date"` silently.
 */
export function linkTokenExpiry(minutes: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

/**
 * Generated identity art. PURE and CLIENT-SAFE — no `server-only`, no I/O, no React.
 *
 * THERE IS NO IMAGE UPLOAD ANYWHERE IN THE PRODUCT (docs/DECISIONS.md §6), so an avatar is
 * computed from the member's own row rather than stored. That removes a whole subsystem —
 * object storage, a signed-upload route, size and content-type validation, moderation of
 * uploaded images, a `blob:` entry in the CSP's `img-src` — and it means a member is
 * recognisable from the moment they sign up, with nothing to configure.
 *
 * The cost, stated plainly: two members can share a gradient. Eight palettes over 360 angles
 * is 2,880 combinations, so collisions are common in a large directory. That is acceptable
 * because THE AVATAR IS NEVER THE IDENTIFIER — the username sits beside it every time it is
 * rendered, and the element itself is `aria-hidden` (see components/ui/avatar.tsx), so a
 * collision is a visual coincidence rather than an ambiguity.
 *
 * `avatarSeed` exists as a column so a member can reroll their gradient without renaming
 * their account: the key is the seed when present and the username otherwise, so a rename
 * changes the art only for members who never set a seed.
 */

export type AvatarPalette = {
  /** For debugging and for tests that assert the accent anchoring below. */
  name: string;
  from: string;
  to: string;
};

/**
 * EIGHT PALETTES, AND THE FIRST THREE ARE THE THEME ACCENTS — amber, teal, desert.
 *
 * That is deliberate: the three most likely gradients are the three colours the rest of the
 * interface already uses, so a directory of avatars reads as part of the product rather than
 * as a separate palette bolted on. The remaining five are hues the interface does NOT use
 * for meaning, which is why there is no green here at all: green is a rating bracket
 * ("Great"/"Awesome"), and an avatar in bracket-green beside a heatmap invites the reader to
 * interpret it as a score.
 *
 * The array length is the modulus below. Adding a ninth palette re-shuffles every existing
 * member's avatar, which is a cosmetic break but a real one — a member who has been the
 * amber one for a year becomes the teal one.
 */
export const AVATAR_PALETTES: readonly AvatarPalette[] = [
  { name: "amber", from: "#e9b44c", to: "#b06a1f" },
  { name: "teal", from: "#4fd1c5", to: "#1d7a72" },
  /** The Desert Island bracket's own pair. Shares the accent, not the meaning. */
  { name: "desert", from: "#57a3ff", to: "#2570e0" },
  { name: "rose", from: "#e2557b", to: "#8f2547" },
  { name: "violet", from: "#9a7bd8", to: "#4c3a82" },
  { name: "clay", from: "#d98453", to: "#8c3f2a" },
  { name: "indigo", from: "#6d7bd8", to: "#2f3570" },
  { name: "slate", from: "#8d9aab", to: "#3c4453" },
] as const;

/**
 * A tiny stable string hash. NOT a cryptographic function and not trying to be — it picks a
 * gradient.
 *
 * Three properties matter and all three are load-bearing:
 *   1. IT IS STABLE ACROSS RUNTIMES. No `Math.random`, no `Date`, no locale-dependent
 *      lowercasing, so the server-rendered avatar and the client-rendered one agree and
 *      React does not report a hydration mismatch.
 *   2. IT IS STABLE ACROSS DEPLOYS, because it is arithmetic rather than a hash whose
 *      implementation could change under us.
 *   3. THE `% 100000` IS INSIDE THE LOOP. Taking it only at the end would overflow the
 *      double-precision integer range on a long key and start losing low bits, which is
 *      exactly the part of the number the modulus below reads.
 *
 * `for...of` iterates CODE POINTS while `charCodeAt(0)` reads the first UTF-16 UNIT, so an
 * astral character contributes its high surrogate. That is a quirk, not a bug: it stays
 * deterministic, which is the only property required here.
 */
export function avatarHash(input: string): number {
  let value = 0;
  for (const character of input) {
    value = (value * 31 + character.charCodeAt(0)) % 100000;
  }
  return value;
}

export type AvatarArt = {
  palette: AvatarPalette;
  /** Degrees, 0..359. */
  angle: number;
  /** One upper-case character. */
  initial: string;
  /** Spread onto the element's `style`. The gradient is the whole visual. */
  style: { backgroundImage: string };
};

export type AvatarIdentity = {
  username: string;
  displayName?: string | null;
  /** `users.avatar_seed`. Present means the member has rerolled their gradient. */
  seed?: string | null;
};

/**
 * The whole avatar in one pure call.
 *
 * THE ANGLE IS HASHED IN A SEPARATE NAMESPACE (`${key}-angle`) rather than derived from the
 * same number as the palette. Reusing one hash for both would correlate them — every member
 * on the amber palette would share an angle band — and the point of the angle is to tell two
 * members on the same palette apart.
 *
 * GUESTS MUST NOT REACH THIS FUNCTION. The guest short-circuit lives in the component
 * (components/ui/avatar.tsx) rather than here, because it is a rendering decision rather than
 * an arithmetic one: a generated avatar is an identity, and a guest does not have one yet.
 */
export function avatarGradient({ username, displayName, seed }: AvatarIdentity): AvatarArt {
  const key = seed || username;
  // The modulus is the array length, not a literal 8, so the two cannot drift apart. Indexing
  // is unchecked (`noUncheckedIndexedAccess: false` in tsconfig) and the modulus makes it safe.
  const palette = AVATAR_PALETTES[avatarHash(key) % AVATAR_PALETTES.length];
  const angle = avatarHash(`${key}-angle`) % 360;

  /*
   * `||` RATHER THAN `??`, ON PURPOSE: an empty display name must fall through to the
   * username, and `??` would accept `""` as a real value and render a blank monogram.
   *
   * The `|| "?"` tail is reachable — `displayName` is truthy for a whitespace-only string,
   * and the `.trim()` then leaves nothing to slice. A username cannot be blank (three
   * characters minimum), so the fallback only ever covers that case.
   */
  const initial = (displayName || username).trim().slice(0, 1).toUpperCase() || "?";

  return {
    palette,
    angle,
    initial,
    style: { backgroundImage: `linear-gradient(${angle}deg, ${palette.from}, ${palette.to})` },
  };
}

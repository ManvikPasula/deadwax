"use client";

/**
 * The profile form — the only writer of a member's editable identity from the interface.
 *
 * ============================================================================
 * WHY THIS FILE IS COLOCATED UNDER app/settings/ RATHER THAN IN components/
 *
 * `app/settings/page.tsx` must stay a SERVER Component: it redirects an anonymous caller, it
 * redirects a guest, and it reads `users.email` — none of which a client component can do.
 * A Server Component cannot declare a client component in its own file, so the interactive
 * half has to live in a file of its own. It sits here rather than under components/ because
 * it is not reusable by anything: it posts the four fields of `updateProfile` and it is
 * rendered by exactly one route. `components/` is the shared vocabulary, and a one-caller
 * form in it is a shared thing nobody shares.
 * ============================================================================
 *
 * THE FOUR FIELDS ARE THE SECURITY BOUNDARY, AND WHAT IS MISSING MATTERS MORE THAN WHAT IS
 * HERE. `username` is permanent (it is a URL, and renaming would orphan every link and free
 * the old handle for impersonation); `email` is a FLOW rather than a field (changing it has
 * to re-verify the new address, retire the outstanding tokens and survive a collision), which
 * is why the page renders the confirmation controls beside this form instead of an address
 * input; and `role` and `plan` are unreachable — `updateProfile`'s Zod object strips unknown
 * keys and its patch is written out field by field, with `tests/no-escalation.test.ts`
 * asserting at the source level that only the admin actions may write those two columns.
 *
 * ---------------------------------------------------------------------------------------
 * NOTHING HERE IS OPTIMISTIC, AND THERE IS THEREFORE NOTHING TO ROLL BACK
 * ---------------------------------------------------------------------------------------
 *
 * The house convention at twenty other call sites is an optimistic update rolled back TO THE
 * PROP on failure, because those controls (a star, a heart, a follow button) display a value
 * the server owns. A form is the opposite shape: the fields ARE the pending edit, and
 * resetting them to the props because the server refused would throw away what somebody just
 * typed — the one rollback that would be worse than none. So a failure renders inline through
 * `<FormError>` with every character intact, and `router.refresh()` runs only on success,
 * because the header's name, the profile subtree and `/@name/wantlist`'s very existence are
 * all server-rendered from these columns.
 *
 * `useTransition` rather than `useActionState`, and no error boundary — the house client
 * convention. A failure renders next to the control that caused it.
 *
 * ---------------------------------------------------------------------------------------
 * THE AVATAR IS A SHUFFLE, NOT A TEXT FIELD AND NOT AN UPLOAD
 * ---------------------------------------------------------------------------------------
 *
 * There is no image upload anywhere in the product, so identity art is COMPUTED from the seed
 * — `avatarGradient` picks one of eight palettes and an angle by hashing it. That makes the
 * seed the entire avatar, which rules out both obvious controls: an upload needs a bucket and
 * a moderation question, and a bare text input asks somebody to type a value whose only
 * meaning is the picture it produces. A preview plus "shuffle" is the honest control for a
 * hash: you cannot choose a gradient, you can only keep drawing until you like one.
 *
 * THE SEED IS GENERATED WITH `crypto.getRandomValues`, NOT `Math.random`, and the shape is
 * twelve hex characters — deliberately identical to `newAvatarSeed()` in lib/auth/claim.ts
 * (`randomBytes(6).toString("hex")`), which is what sign-up writes. Two generators producing
 * different shapes for the same column is how a future length bound breaks one of them. It is
 * not a credential, so the CSPRNG is not a security requirement: it is the API that is
 * actually present in every browser this app supports, and `Math.random` in a loop of six is
 * how two shuffles in the same millisecond return the same gradient.
 */

import { Dices } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { updateProfile } from "@/app/actions/profile";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CheckboxField, Field, FieldHint, FormError, Input, Label, Textarea } from "@/components/ui/field";
import { Eyebrow } from "@/components/ui/primitives";
import { MAX_AVATAR_SEED, MAX_BIO, MAX_DISPLAY_NAME } from "@/lib/security/schemas";
import { cn } from "@/lib/utils";

/** Six bytes as hex — the same twelve characters `newAvatarSeed()` writes at sign-up. */
function shuffleSeed(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type SettingsFormProps = {
  /** `users.username`. Permanent, shown as context, and the avatar's fallback hash key. */
  username: string;
  /** `users.display_name`. Null renders as empty; every surface falls back to the username. */
  displayName: string | null;
  bio: string | null;
  /** `users.avatar_seed`. Null keys the gradient on the username instead. */
  avatarSeed: string | null;
  wantlistPrivate: boolean;
  className?: string;
};

export function SettingsForm({
  username,
  displayName,
  bio,
  avatarSeed,
  wantlistPrivate,
  className,
}: SettingsFormProps) {
  const router = useRouter();

  const [name, setName] = React.useState(displayName ?? "");
  const [about, setAbout] = React.useState(bio ?? "");
  const [seed, setSeed] = React.useState(avatarSeed ?? "");
  const [priv, setPriv] = React.useState(wantlistPrivate);
  const [error, setError] = React.useState<string | null>(null);
  /** Separate from `error`: a save that worked is not a failure and must not render in rose. */
  const [saved, setSaved] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  // Generated ids, because a hard-coded one would let this form's label claim another form's
  // field if both ever rendered on the same page.
  const nameId = React.useId();
  const bioId = React.useId();
  const bioHintId = React.useId();
  const seedId = React.useId();

  const bioLeft = MAX_BIO - about.length;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);

    startTransition(async () => {
      /**
       * ALL FOUR FIELDS, EVERY TIME, EVEN THE UNCHANGED ONES — and that is safe precisely
       * because the action is a PATCH (I-1): an ABSENT field leaves its column alone, so the
       * avatar picker elsewhere in the product cannot blank a bio it never rendered. This form
       * DID render all four, so it owns all four, and sending only the dirty ones would mean
       * tracking dirtiness in order to say something the action already understands.
       *
       * The empty string is sent rather than `undefined`: `updateProfile` maps a trimmed-empty
       * display name and bio to SQL NULL, because every surface renders `displayName ??
       * username` and `""` is not null — it would render as a nameless member rather than
       * falling back to the handle. So "clear my display name" has to arrive as a value.
       *
       * `avatarSeed` IS THE ONE EXCEPTION AND IT IS OMITTED WHEN EMPTY. `avatarSeedSchema` has
       * `min(1)` because the seed IS the avatar — it is interpolated into a CSS gradient, so
       * an empty one is a missing image rather than a default — and posting `""` would make the
       * whole save fail on a field the member never touched. Absent means "leave it", which is
       * the correct instruction for a member who has never had a seed and did not shuffle.
       */
      const result = await updateProfile({
        displayName: name,
        bio: about,
        ...(seed.length > 0 ? { avatarSeed: seed } : {}),
        wantlistPrivate: priv,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setSaved(true);
      // Everything derived from these columns is server-rendered: the header's name and
      // avatar, the profile subtree, and whether /@name/wantlist renders at all.
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className={cn("space-y-6", className)}>
      {/* -- identity art ---------------------------------------------------------- */}
      <div>
        <Eyebrow className="mb-2">Avatar</Eyebrow>
        <div className="flex items-center gap-4">
          {/*
            `Avatar` is `aria-hidden` by contract — it is a gradient and an initial, and
            neither is information. The name comes from the text beside it, which is why the
            seed is printed rather than only previewed.
          */}
          <Avatar username={username} displayName={name || null} seed={seed || null} size="lg" />
          <div className="min-w-0 space-y-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setSeed(shuffleSeed())}>
              <Dices />
              Shuffle
            </Button>
            <p id={seedId} className="font-mono text-[0.6875rem] tabular text-faint">
              {seed ? `Seed ${seed}` : `No seed — the gradient is keyed on @${username}`}
            </p>
          </div>
        </div>
        <FieldHint className="mt-2">
          There are no uploads here. The gradient and the letter are computed from the seed, so
          shuffling is the whole control. Up to {MAX_AVATAR_SEED} characters are stored.
        </FieldHint>
      </div>

      {/* -- display name ---------------------------------------------------------- */}
      <Field>
        <Label htmlFor={nameId}>Display name</Label>
        <Input
          id={nameId}
          name="displayName"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="nickname"
          maxLength={MAX_DISPLAY_NAME}
          placeholder={username}
        />
        <FieldHint>
          {/*
            The permanence of the username is stated HERE, next to the field that looks like
            it, rather than in a help page. It is the question this form invites.
          */}
          Shown wherever you appear. Leave it empty to be known as{" "}
          <span className="font-mono text-muted">@{username}</span> — usernames are permanent
          and there is no rename anywhere in the product, because your profile lives at a URL
          other people have learned.
        </FieldHint>
      </Field>

      {/* -- bio ------------------------------------------------------------------- */}
      <Field>
        <Label htmlFor={bioId}>Bio</Label>
        <Textarea
          id={bioId}
          name="bio"
          value={about}
          onChange={(event) => setAbout(event.target.value)}
          maxLength={MAX_BIO}
          aria-describedby={bioHintId}
        />
        <FieldHint id={bioHintId}>
          {/*
            A REMAINING COUNT RATHER THAN A USED ONE, and mono + `.tabular` so it does not
            jitter as the digits change width. `maxLength` already stops the overflow, so this
            is orientation rather than a warning — which is why it never turns rose.
          */}
          One or two lines, on your profile. <span className="font-mono tabular">{bioLeft}</span>{" "}
          characters left.
        </FieldHint>
      </Field>

      {/* -- privacy --------------------------------------------------------------- */}
      <div>
        <Eyebrow className="mb-2">Privacy</Eyebrow>
        <CheckboxField
          name="wantlistPrivate"
          checked={priv}
          onChange={(event) => setPriv(event.target.checked)}
          label="Keep my wantlist to myself"
        />
        <FieldHint className="mt-1.5">
          {/*
            It names the ONE thing the flag covers, because a privacy switch whose scope is
            unstated is read as covering everything. The checked state is honoured in both
            `generateMetadata` and the page body of /@name/wantlist — a check on one of two
            entry points is how the original leaked private titles through a title tag.
          */}
          Your wantlist is the only list this hides, and it hides it from everybody but you —
          the page and its title both. Diary entries, ratings and reviews stay public.
        </FieldHint>
      </div>

      <FormError message={error} />

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" size="lg" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        {/*
          `role="status"` rather than `role="alert"`: this follows a deliberate press, so it
          should be announced politely at the next pause instead of interrupting. Rendered only
          when there is something in it — a permanently present empty live region is one a
          screen reader has already learned to skip.
        */}
        {saved && !pending ? (
          <p role="status" className="font-mono text-[0.6875rem] uppercase tracking-wider text-teal">
            Saved
          </p>
        ) : null}
      </div>
    </form>
  );
}

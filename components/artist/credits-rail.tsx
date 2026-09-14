/**
 * Album credits — who made this record.
 *
 * NO `"use client"`. Rows in, text out.
 *
 * ---------------------------------------------------------------------------------------
 * THE DEDUPE IS THE WHOLE COMPONENT
 * ---------------------------------------------------------------------------------------
 *
 * `credits` has NO PEOPLE TABLE: person data is denormalised per row, and the unique index is
 * `(album_id, person_id, kind, role)` — so one person legitimately owns several rows. A
 * producer who also played keyboards and also engineered is three rows with the same
 * `person_id` and three different roles, and MusicBrainz relation types are fine-grained
 * enough that five or six is ordinary.
 *
 * Rendered straight, that is the same face five times in a row. So this collapses by
 * `person_id` AND MERGES THE ROLES INTO ONE LINE, which is what a sleeve does: "Nigel Godrich
 * — producer, engineer, keyboards".
 *
 * THE ORDER IS THE QUERY'S AND IS NOT RE-SORTED. `credit_order` is `999 - appearances`, so
 * ascending already puts the most-credited person first, with `name` as the tiebreak because a
 * null-role credit and a role-carrying one for the same person share an order and an unstable
 * order renders the same page two different ways. The dedupe below keeps FIRST OCCURRENCE,
 * which preserves that.
 *
 * ---------------------------------------------------------------------------------------
 * NOTHING HERE IS A LINK
 * ---------------------------------------------------------------------------------------
 *
 * There is no person page in this product and there is no route to invent one at. A credit is
 * reference text, so it is rendered as text — an anchor that navigates nowhere, or worse to a
 * search, is a promise the app cannot keep. That also means this rail has no tab stops, which
 * is correct: it is a list of names, and a keyboard user should pass over it in one key press
 * rather than eighteen.
 */

import Image from "next/image";
import { UserRound } from "lucide-react";

import { Eyebrow, SectionHeading } from "@/components/ui/primitives";
import type { AlbumCredit } from "@/lib/db/queries/albums";
import { artistPicture } from "@/lib/providers/images";
import { cn } from "@/lib/utils";

export type CreditsRailProps = {
  /** `getAlbumCredits(albumId)` — already ordered most-credited first. */
  credits: AlbumCredit[];
  /** Hard cap, so a MusicBrainz release with ninety relation rows does not become the page. */
  limit?: number;
  className?: string;
};

type MergedCredit = {
  personId: string;
  name: string;
  picturePath: string | null;
  /** `artist | crew`. The first row's kind wins; a person is rarely both on one record. */
  kind: string;
  /** Deduped, in first-seen order, and joined for display. */
  roles: string[];
};

/** Collapse by `person_id`, merge roles, keep first-occurrence order. Exported for testing. */
export function mergeCredits(credits: AlbumCredit[]): MergedCredit[] {
  const byPerson = new Map<string, MergedCredit>();
  for (const credit of credits) {
    const existing = byPerson.get(credit.personId);
    if (existing) {
      // A NULL role is a real state — see the unique-index trap in the schema — and it must not
      // become the string "null" on a page. It contributes nothing to the role line, and the
      // person still appears because the first row created them.
      if (credit.role && !existing.roles.includes(credit.role)) existing.roles.push(credit.role);
      // A later row may carry a picture where the first did not. Filling the gap is free and
      // a missing portrait is the most visible kind of missing data.
      if (!existing.picturePath && credit.picturePath) existing.picturePath = credit.picturePath;
      continue;
    }
    byPerson.set(credit.personId, {
      personId: credit.personId,
      name: credit.name,
      picturePath: credit.picturePath,
      kind: credit.kind,
      roles: credit.role ? [credit.role] : [],
    });
  }
  return [...byPerson.values()];
}

export function CreditsRail({ credits, limit = 24, className }: CreditsRailProps) {
  const merged = mergeCredits(credits).slice(0, limit);

  /*
   * NOTHING, NOT AN EMPTY STATE. Credits come from MusicBrainz relations, which most releases
   * simply do not have — so an empty rail is our mirror being thin, not a record that nobody
   * made. "No credits" is a claim; absence is not.
   */
  if (merged.length === 0) return null;

  return (
    <section className={cn("space-y-1", className)}>
      <SectionHeading eyebrow="Credits" title="Who made this" />
      <ul className="flex gap-4 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {merged.map((person) => {
          const picture = artistPicture({ picturePath: person.picturePath }, 250);
          return (
            <li key={person.personId} className="w-[104px] shrink-0 text-center sm:w-[120px]">
              <div className="relative mx-auto size-[72px] overflow-hidden rounded-full bg-surface-2 ring-1 ring-line sm:size-[88px]">
                {picture ? (
                  // Empty alt: the name is the next element and is the content. This is the
                  // same contract components/ui/avatar.tsx states — identity art is decoration
                  // and the accessible name comes from the surrounding text.
                  <Image src={picture} alt="" fill sizes="88px" className="object-cover object-top" />
                ) : (
                  <span className="flex size-full items-center justify-center text-faint" aria-hidden="true">
                    <UserRound className="size-7" />
                  </span>
                )}
              </div>
              <p className="mt-2 text-[0.8125rem] leading-tight text-paper">{person.name}</p>
              {/*
                The role line is mono because it is a label, and it is the text equivalent for
                nothing — there is no colour coding here. `line-clamp-2` rather than `truncate`
                because a merged role list is genuinely two lines often enough that cutting it
                at one loses the instrument somebody is looking for.
              */}
              {person.roles.length > 0 ? (
                <Eyebrow className="mt-0.5 line-clamp-2 normal-case tracking-wider">
                  {person.roles.join(", ")}
                </Eyebrow>
              ) : (
                // No role at all still says something: `kind` is `artist | crew`, which is the
                // coarsest honest answer available rather than a blank line.
                <Eyebrow className="mt-0.5">{person.kind === "crew" ? "Crew" : "Performer"}</Eyebrow>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

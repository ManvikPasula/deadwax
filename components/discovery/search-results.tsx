/**
 * The /search body: albums, artists and members in three labelled sections.
 *
 * NO `"use client"`. The typed query lives in `components/nav/search-box.tsx`, which is the
 * only client component in the search path; by the time results exist the query is a URL
 * parameter and this is markup over props.
 *
 * ---------------------------------------------------------------------------------------
 * THE TWO EMPTY STATES ARE DIFFERENT STATES AND THEY MUST NOT BE COLLAPSED
 * ---------------------------------------------------------------------------------------
 *
 *   NO QUERY   The member has not typed anything. Nothing has failed, nothing is missing, and
 *              the right response is an INVITATION — what can be searched, and one way in.
 *   NO RESULTS A real query came back empty. The right response is a REPORT, naming the query
 *              back so it is obvious what was searched, plus what to try next.
 *
 * Collapsing them into one "No results" panel is the defect this section exists to avoid: the
 * box then looks broken before it has ever been used, on the first page a curious visitor
 * opens. The two branches are the first thing in the component for that reason.
 *
 * ---------------------------------------------------------------------------------------
 * AN EMPTY SECTION IS OMITTED, NOT LABELLED
 * ---------------------------------------------------------------------------------------
 *
 * A query that matches two albums and no artists renders the Albums section and nothing else.
 * The rejected alternative — three headings, two of them followed by "no artists found" —
 * reports two absences per search and buries the one hit between them. The whole-page empty
 * state above already covers the case where every section is empty, which is the only case
 * where the absence is the answer.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT THIS COMPONENT DOES NOT DO
 * ---------------------------------------------------------------------------------------
 *
 * It does not merge, dedupe, cap or rank. The page does all four before calling it
 * (`uniqueCards` in lib/view.ts keeps the LOCAL copy of a record that appears in both the
 * mirror and the provider response, because that is the copy carrying member figures), and it
 * hands cards rather than rows so there is exactly one place — the adapter — that decides a
 * cover width, an href and which of the two dates is the year.
 */

import Link from "next/link";
import { UserRound } from "lucide-react";

import { CoverCard, type CoverCardAlbum } from "@/components/album/cover-card";
import { CoverGrid } from "@/components/album/cover-grid";
import { MemberCard } from "@/components/social/member-card";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionHeading } from "@/components/ui/primitives";
import type { MemberCardStats, MemberSummary } from "@/lib/db/queries/users";
import { plural } from "@/lib/format";
import type { ArtistCard } from "@/lib/view";
import { cn } from "@/lib/utils";

export type SearchResultsProps = {
  /**
   * The submitted query, already trimmed by the page. EMPTY IS A FIRST-CLASS STATE — see the
   * docblock — so this is required rather than optional.
   */
  query: string;
  /**
   * Merged, deduped and capped by the page. `AlbumCard` from lib/view.ts satisfies this; a
   * provider-only result arrives with `href: null` and `CoverCard` renders it inert rather
   * than linking to somebody else on a guessed id.
   */
  albums: CoverCardAlbum[];
  /** `cardFromArtistRow` / `cardFromDeezerArtist`. The latter returns null off-mirror, so the
      page has already dropped the unlinkable ones. */
  artists: ArtistCard[];
  members: MemberSummary[];
  /**
   * From `getMemberCardStats(ids)` — ONE batched query for the whole page (D-3). An absent
   * entry is normal and means the member has logged nothing yet; `MemberCard` renders zeroes.
   */
  memberStats?: ReadonlyMap<number, MemberCardStats>;
  /** From `viewerFollowSet(viewerId, ids)` — one query, not one per card. */
  followingIds?: ReadonlySet<number>;
  /** The viewer, so their own row offers no follow button. */
  viewerId?: number | null;
  /**
   * TRUE WHEN THE PROVIDER SEARCH WAS SKIPPED because `searchByIp` was over its budget, so
   * these results come from Deadwax's mirror alone.
   *
   * It is disclosed rather than hidden: a member who searches a real record and sees nothing
   * would otherwise conclude the catalogue does not have it, and try again with the same
   * words. The rate limiter fails open elsewhere (I-33) precisely so this is rare.
   */
  mirrorOnly?: boolean;
  className?: string;
};

export function SearchResults({
  query,
  albums,
  artists,
  members,
  memberStats,
  followingIds,
  viewerId = null,
  mirrorOnly = false,
  className,
}: SearchResultsProps) {
  /* ---- STATE 1 — nothing typed yet. An invitation, not a report. --------------------- */
  if (query.length === 0) {
    return (
      <EmptyState
        className={className}
        title="Search Deadwax"
        description="Records, the artists who made them, and the members writing about them. Try a title, a band, or an @handle."
        action={
          <Button asChild variant="secondary">
            <Link href="/albums">Browse the catalogue</Link>
          </Button>
        }
      />
    );
  }

  const total = albums.length + artists.length + members.length;

  /* ---- STATE 2 — a real query, nothing found. A report, naming the query back. ------- */
  if (total === 0) {
    return (
      <div className={cn("space-y-3", className)}>
        <EmptyState
          title={`Nothing found for “${query}”`}
          // `escapeLike` (I-6) means a title containing % or _ is findable by typing it, so
          // "try a different spelling" is honest advice here rather than a deflection.
          description="Deadwax searches its own catalogue and Deezer's. Try fewer words, a different spelling, or the artist instead of the record."
          action={
            <Button asChild variant="secondary">
              <Link href="/albums">Browse the catalogue</Link>
            </Button>
          }
        />
        {mirrorOnly ? <MirrorOnlyNote /> : null}
      </div>
    );
  }

  return (
    <div className={cn("space-y-12", className)}>
      {mirrorOnly ? <MirrorOnlyNote /> : null}

      {albums.length > 0 ? (
        <section>
          <SectionHeading eyebrow={plural(albums.length, "result")} title="Records" />
          <CoverGrid>
            {albums.map((album, index) => (
              <CoverCard
                // `deezerId` is present on every card shape and is stable across the
                // local/remote merge; the local id is null for an unmirrored provider result,
                // so it cannot be the key.
                key={album.deezerId}
                album={album}
                // The first row only. A page of thirty-six eager covers is thirty-six
                // requests competing with the document.
                eager={index < 6}
              />
            ))}
          </CoverGrid>
        </section>
      ) : null}

      {artists.length > 0 ? (
        <section>
          <SectionHeading eyebrow={plural(artists.length, "result")} title="Artists" />
          {/*
            `CoverGrid` is a layout only and takes children for exactly this — the same column
            counts hold album cards and artist cards without a second copy of the classes.

            ROUND PORTRAITS, NOT `.sleeve`, and the reason is the one written out in
            components/artist/similar-artists.tsx: `.sleeve` is the record geometry, and a
            square artist portrait sitting in a grid of square covers reads as one more album.
          */}
          <CoverGrid>
            {artists.map((artist) => (
              <Link key={artist.id} href={artist.href} className="group block text-center">
                <div
                  className={cn(
                    "relative mx-auto aspect-square w-full overflow-hidden rounded-full bg-surface-2",
                    "ring-1 ring-line transition-[transform,box-shadow] duration-150 ease-out-quick",
                    "group-hover:-translate-y-0.5 group-hover:ring-amber",
                  )}
                >
                  {artist.pictureUrl ? (
                    // Empty alt: the name below is inside the same link and is already this
                    // link's accessible name. Naming the image too announces every artist
                    // twice — the contract components/ui/avatar.tsx states.
                    <img
                      src={artist.pictureUrl}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="size-full object-cover object-top"
                    />
                  ) : (
                    <span className="flex size-full items-center justify-center text-faint" aria-hidden="true">
                      <UserRound className="size-8" />
                    </span>
                  )}
                </div>
                <p className="mt-2 truncate font-sans text-[0.8125rem] leading-snug text-paper transition-colors group-hover:text-amber">
                  {artist.name}
                </p>
                {artist.albumCount > 0 ? (
                  <p className="mt-0.5 truncate font-mono text-[0.6875rem] tabular text-faint">
                    {plural(artist.albumCount, "release")}
                  </p>
                ) : null}
              </Link>
            ))}
          </CoverGrid>
        </section>
      ) : null}

      {members.length > 0 ? (
        <section>
          <SectionHeading eyebrow={plural(members.length, "result")} title="Members" />
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {members.map((member) => (
              <li key={member.id}>
                <MemberCard
                  member={member}
                  stats={memberStats?.get(member.id)}
                  /*
                   * A TRI-STATE, NOT A BOOLEAN. `null` means "render no follow control", and
                   * three different situations produce it: signed out (no viewer), the viewer
                   * themselves, and a guest — who cannot be followed at all, because
                   * `toggleFollow` refuses one. "Not following" and "cannot follow" are
                   * different answers and a boolean would collapse them into the same button.
                   */
                  following={
                    !viewerId || member.isGuest || member.id === viewerId
                      ? null
                      : (followingIds?.has(member.id) ?? false)
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** The rate-limited disclosure. Its own component so both empty branches can carry it. */
function MirrorOnlyNote() {
  return (
    <p className="font-mono text-[0.6875rem] uppercase tracking-wider text-faint">
      Searching Deadwax&rsquo;s own catalogue only — the provider search is rate limited right
      now. Try again in a minute for records nobody here has logged yet.
    </p>
  );
}

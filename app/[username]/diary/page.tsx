/**
 * `/@name/diary` — the listening diary, paged, optionally filtered to one year.
 *
 * ============================================================================
 * THIS IS THE ONLY SURFACE IN THE APPLICATION THAT CARRIES A LOG DELETE CONTROL.
 *
 * `canDelete` is passed here and nowhere else. `deleteLog` authorises the author server-side
 * regardless, so this is not a security boundary — it is a decision about where a destructive
 * control lives. One place means one arm/confirm gesture to learn, one place to reason about,
 * and no chance of a member deleting a row from a feed where they were reading rather than
 * editing. The profile's own activity preview deliberately does not pass it.
 * ============================================================================
 *
 * THE DIARY IS SCOPED BY `listened_on`, NOT `created_at` — the day somebody played something
 * is the day it belongs to, even if they wrote it down a week later. A rating saved with "Add
 * to diary" unchecked has no date at all and is therefore absent from this page entirely,
 * rather than being filed under whenever it happened to be typed. That is why the stat tiles
 * can report more ratings than this page has rows.
 *
 * `countDiary` REPEATS `getDiary`'S THREE CONDITIONS AND MUST BE EDITED WITH IT (I-14). The
 * count is what produces `totalPages` below, so a total that filtered differently from the
 * body would put a "next page" link in front of a page that is empty.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { loadProfile } from "@/app/[username]/layout";
import { queryHref } from "@/components/discovery/sort-select";
import { ActivityFeed } from "@/components/social/activity-feed";
import { Button } from "@/components/ui/button";
import { Chip, EmptyState, Eyebrow, Pagination, SectionHeading } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import { countDiary, DIARY_PAGE_SIZE, getDiary, getLikedLogIds } from "@/lib/db/queries/logs";
import { plural } from "@/lib/format";
import { parseBoundedInt, parsePage } from "@/lib/slug";
import { getLoggedYears, YEAR_MAX, YEAR_MIN } from "@/lib/stats/year";

type PageProps = {
  params: Promise<{ username: string }>;
  // BOTH ARE PROMISES IN NEXT 16.
  searchParams: Promise<{ year?: string; page?: string }>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { username } = await params;
  const member = await loadProfile(username);
  const name = member.displayName ?? member.username;

  return {
    title: `${name}'s diary`,
    description: `Every record ${name} has played, filed under the day they played it.`,
  };
}

export default async function DiaryPage({ params, searchParams }: PageProps) {
  const [{ username }, query] = await Promise.all([params, searchParams]);

  /*
   * A BAD YEAR IS A BAD FILTER, NOT A BAD ADDRESS, so it falls back to "every year" rather
   * than to a 404 — unlike `/@name/year/[year]`, where the year IS the address and an
   * out-of-range one is `notFound()`. The bounds still matter: `year` is interpolated into a
   * date literal inside `diaryDateWindow`, and an unparseable one raises a driver error, which
   * is a 500 where a 404 belongs (the same class as I-5).
   */
  const year = parseBoundedInt(query.year, { min: YEAR_MIN, max: YEAR_MAX });
  const page = parsePage(query.page);

  const [member, viewer] = await Promise.all([loadProfile(username), currentUser()]);
  const isOwner = viewer?.id === member.id;
  const name = member.displayName ?? member.username;

  const [entries, total, years] = await Promise.all([
    getDiary(member.id, { year, limit: DIARY_PAGE_SIZE, offset: (page - 1) * DIARY_PAGE_SIZE }),
    countDiary(member.id, { year }),
    getLoggedYears(member.id),
  ]);

  // The dependent read: keyed by the ids this page just fetched, so it cannot join the batch.
  const likedIds = await getLikedLogIds(viewer?.id, entries.map((entry) => entry.id));

  const basePath = `/@${member.username}/diary`;
  /*
   * A REAL TOTAL, SO `Pagination` PRINTS "of N". It is allowed to here and not on a browse
   * grid: this page counts local rows with a known filter, whereas a provider-backed catalogue
   * walk only ever learns whether one more row exists. `Math.max(1, …)` keeps "Page 1 of 1" on
   * an empty diary rather than "of 0".
   */
  const totalPages = Math.max(1, Math.ceil(total / DIARY_PAGE_SIZE));

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow={year ? `Diary · ${year}` : "Diary"}
        title={year ? `${name} in ${year}` : `${name}'s diary`}
        as="h1"
        action={
          year ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/@${member.username}/year/${year}`}>Year in review</Link>
            </Button>
          ) : null
        }
      />

      <p className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
        {plural(total, "entry", "entries")}
        {year ? ` in ${year}` : ""}
      </p>

      {/*
        THE YEAR FILTER IS A ROW OF LINKS, NOT A SELECT. Every filtered view has a real address,
        so it survives a reload, a shared link and the back button — the same argument
        `ProfileTabs` makes for being six routes rather than six tab panels.

        The years come from `getLoggedYears`, which is newest-first and already bounded, so this
        row can only offer years the member actually has something dated in. `aria-current` is
        the caller's job: `Chip`'s `active` is paint, and paint alone does not tell a screen
        reader which filter is on.
      */}
      {years.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Eyebrow>Year</Eyebrow>
          <div role="group" aria-label="Filter the diary by year" className="flex flex-wrap gap-1.5">
            <Chip asChild active={year === null}>
              {/* `page` is deliberately absent: a new filter is a different set of rows, so
                  carrying page 7 over would land on a window nobody has seen the start of. */}
              <Link href={basePath} aria-current={year === null ? "true" : undefined}>
                All
              </Link>
            </Chip>
            {years.map((option) => (
              <Chip key={option} asChild active={option === year}>
                <Link
                  href={queryHref(basePath, { year: option })}
                  aria-current={option === year ? "true" : undefined}
                >
                  {option}
                </Link>
              </Chip>
            ))}
          </div>
        </div>
      ) : null}

      <ActivityFeed
        entries={entries}
        likedIds={likedIds}
        // See the module docblock. THE ONLY `canDelete` IN THE APPLICATION.
        canDelete={isOwner}
        // One member's diary: the heading names them, so fifty avatars say nothing.
        showAuthor={false}
        empty={
          <EmptyState
            title={year ? `Nothing dated ${year}` : "The diary is empty"}
            description={
              isOwner
                ? "A rating becomes a diary entry when you give it a date — the day you played the record, not the day you typed it."
                : `${name} has not dated anything${year ? ` in ${year}` : ""} yet.`
            }
            action={
              year ? (
                <Button asChild variant="ghost">
                  <Link href={basePath}>Show every year</Link>
                </Button>
              ) : isOwner ? (
                <Button asChild variant="primary">
                  <Link href="/albums">Find a record</Link>
                </Button>
              ) : null
            }
          />
        }
      />

      <Pagination
        page={page}
        hasNext={page * DIARY_PAGE_SIZE < total}
        totalPages={totalPages}
        buildHref={(next) => queryHref(basePath, { year, page: next > 1 ? next : null })}
      />
    </div>
  );
}

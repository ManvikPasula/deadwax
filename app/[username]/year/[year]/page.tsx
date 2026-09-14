/**
 * `/@name/year/2025` — Year in Review.
 *
 * THE YEAR IS THE ADDRESS, SO AN OUT-OF-RANGE ONE IS A 404 — unlike `/@name/diary?year=`,
 * where the year is a filter and a silly value falls back to "every year". `YEAR_MIN` and
 * `YEAR_MAX` are imported from lib/stats/year.ts rather than retyped: they are the same two
 * literals as the `BETWEEN '1900-01-01' AND '2200-01-01'` guard inside `getLoggedYears`, and
 * exporting them is what lets this route reject `/year/99999` with a 404 instead of handing an
 * absurd year to nine queries. 1900 is the floor because that is before recorded music — the
 * source's floor was 1930, which is before television.
 *
 * `parseBoundedInt` RETURNS NULL RATHER THAN CLAMPING, which is what makes the 404 possible.
 * Clamping `/year/1` to 1900 would render a real page nobody asked for.
 *
 * ============================================================================
 * THE SPARSE-YEAR GATE IS `summary.activeDays === 0`, NOT `tracksPlayed === 0`.
 *
 * A year of album ratings and reviews is a real year, and every track section below handles its
 * own empty case. Gating on tracks would hide a member's entire written year behind a "nothing
 * here" panel because they rate records rather than logging individual songs — which is the
 * commonest listener shape in the product.
 *
 * `isSparseYear` is imported rather than re-expressed as `review.summary.activeDays === 0`, so
 * there is one definition of "this year is empty" and the panel and the query cannot disagree.
 * ============================================================================
 *
 * EVERYTHING IS SCOPED BY `listened_on`, NOT `created_at`: the year you played something is the
 * year it belongs to, even if you logged it later. Ratings with no date are excluded from the
 * year entirely rather than attributed to whenever they were typed — which is also why
 * `activeDays` is the right gate: a member who backfills a decade in one evening gets ten real
 * years, and a member who rates fifty records without dating any of them gets no year at all.
 *
 * THE AVERAGE RATING RENDERS AS STARS, NEVER AS `n/10`. The stored scale is 1..10 and every
 * other surface in the product shows 0.5–5 stars; the source prints "/ 10" on this page alone,
 * which is a named honesty bug and is not copied. `Stars` takes the stored value and divides
 * internally, so nothing here converts.
 */

import type { Metadata } from "next";
import { CalendarDays, Disc3, Flag } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { loadProfile } from "@/app/[username]/layout";
import { CoverRail } from "@/components/album/cover-rail";
import { Histogram } from "@/components/rating/histogram";
import { Stars } from "@/components/rating/stars";
import { ComparisonRow, GenreSplit, MonthlyBars } from "@/components/year/year-charts";
import { Button } from "@/components/ui/button";
import {
  Badge,
  Chip,
  EmptyState,
  Eyebrow,
  SectionHeading,
  StatTile,
} from "@/components/ui/primitives";
import { formatCount, formatDate, formatListeningTime, plural } from "@/lib/format";
import { albumCover } from "@/lib/providers/images";
import { formatRating } from "@/lib/ratings";
import { albumSlug, artistSlug, parseBoundedInt, trackLocator } from "@/lib/slug";
import { getLoggedYears, getYearReview, isSparseYear, YEAR_MAX, YEAR_MIN } from "@/lib/stats/year";

/** 132px rendered in a rail; 250 is the next CDN rung, so it is sharp at 2x. */
const TILE_SOURCE_WIDTH = 250;

type PageProps = { params: Promise<{ username: string; year: string }> };

/** The bounds check, in one place, so the body and the metadata cannot disagree about it. */
function parseYear(raw: string): number | null {
  return parseBoundedInt(raw, { min: YEAR_MIN, max: YEAR_MAX });
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { username, year: rawYear } = await params;
  const year = parseYear(rawYear);
  if (year === null) notFound();

  const member = await loadProfile(username);
  const name = member.displayName ?? member.username;

  return {
    title: `${name}'s ${year}`,
    description: `What ${name} played in ${year} — the months, the records, the ratings.`,
  };
}

export default async function YearPage({ params }: PageProps) {
  const { username, year: rawYear } = await params;
  const year = parseYear(rawYear);
  // Independently evaluated. The metadata function above cannot cover the body, and vice versa.
  if (year === null) notFound();

  const member = await loadProfile(username);
  const name = member.displayName ?? member.username;

  const [review, years] = await Promise.all([
    // Nine independent panels in one `Promise.all` inside the query, nothing memoised: one
    // render, one caller per panel.
    getYearReview(member.id, year),
    getLoggedYears(member.id),
  ]);

  const { summary, platform } = review;
  const basePath = `/@${member.username}/year`;

  /**
   * The year picker. `getLoggedYears` is newest-first and already bounded, so this row can only
   * offer years with something dated in them — but the year in the URL is kept in the row even
   * when it is not one of them, because a member who typed `/year/1998` should be able to see
   * where they are before they leave.
   */
  const options = years.includes(year) ? years : [year, ...years];

  return (
    <div className="space-y-10">
      <div className="space-y-4">
        <SectionHeading eyebrow="Year in review" title={`${name} in ${year}`} as="h1" />

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Eyebrow>Year</Eyebrow>
          <div role="group" aria-label={`Pick a year of ${name}'s diary`} className="flex flex-wrap gap-1.5">
            {options.map((option) => (
              <Chip key={option} asChild active={option === year}>
                {/* `aria-current` is the caller's job: `Chip`'s `active` is the paint only. */}
                <Link
                  href={`${basePath}/${option}`}
                  aria-current={option === year ? "true" : undefined}
                >
                  {option}
                </Link>
              </Chip>
            ))}
          </div>
        </div>
      </div>

      {isSparseYear(review) ? (
        /*
          THE SPARSE BRANCH. See the module docblock: the gate is `activeDays === 0`, which is
          "nothing in this year carries a date" rather than "no tracks were logged". So this
          panel means exactly what it says, and a year of undated album ratings is NOT hidden
          behind it — those ratings simply belong to no year, which is what the copy explains.
        */
        <EmptyState
          title={`Nothing dated ${year}`}
          description={`A rating becomes part of a year when it carries the date it was played. Ratings ${name} saved without a date are on the profile and the shelf, but they belong to no year.`}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild variant="primary">
                <Link href={`/@${member.username}/diary`}>Open the diary</Link>
              </Button>
              {years[0] !== undefined && years[0] !== year ? (
                <Button asChild variant="ghost">
                  <Link href={`${basePath}/${years[0]}`}>{`Go to ${years[0]}`}</Link>
                </Button>
              ) : null}
            </div>
          }
        />
      ) : (
        <>
          {/* ---- The numbers ------------------------------------------------------ */}
          <section>
            <SectionHeading eyebrow="The year" title="By the numbers" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile
                label="Tracks played"
                value={formatCount(summary.tracksPlayed)}
                hint="Distinct tracks, so a replay counts once"
              />
              <StatTile
                label="Listening time"
                // MINUTES TO MILLISECONDS. `YearSummary.minutesPlayed` is minutes (the query is
                // `SUM(duration_ms) / 60000`, floored) and `formatListeningTime` takes
                // milliseconds — handing it the minutes reads "0 minutes" for a real year.
                value={formatListeningTime(summary.minutesPlayed * 60_000)}
                hint="Over those distinct tracks"
              />
              <StatTile
                label="Albums logged"
                value={formatCount(summary.albumsLogged)}
                hint="Album-level diary entries, not completions"
              />
              <StatTile label="Artists" value={formatCount(summary.artistsPlayed)} />
              <StatTile label="Diary entries" value={formatCount(summary.diaryEntries)} />
              <StatTile
                label="Active days"
                value={formatCount(summary.activeDays)}
                hint="Distinct dates with something on them"
              />
              <StatTile label="Ratings" value={formatCount(summary.ratingsGiven)} tone="amber" />
              <StatTile
                label="Replays"
                value={formatCount(summary.replays)}
                tone="teal"
                hint="Entries flagged as a replay"
              />
            </div>
          </section>

          {/* ---- The shape of the year -------------------------------------------- */}
          <section>
            <SectionHeading eyebrow="Months" title="When they listened" />
            <div className="card p-5">
              <MonthlyBars monthly={review.monthly} />
            </div>
          </section>

          {/* ---- Ratings ---------------------------------------------------------- */}
          <section>
            <SectionHeading eyebrow="Ratings" title="How they scored it" />
            <div className="card space-y-5 p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                <div>
                  <Eyebrow>Average</Eyebrow>
                  {summary.averageRating === null ? (
                    // NULL IS A REAL STATE AND IT IS NOT ZERO: an unrated year has no average,
                    // and zero stars is unrepresentable on a 1..10 scale.
                    <p className="mt-1 text-sm text-faint">Nothing rated this year</p>
                  ) : (
                    <div className="mt-1 flex items-baseline gap-2">
                      {/* STARS, NEVER "/10". See the module docblock. */}
                      <Stars value={summary.averageRating} size="md" />
                      <span className="font-mono text-sm tabular text-muted">
                        {formatRating(summary.averageRating)}
                      </span>
                    </div>
                  )}
                </div>
                <p className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
                  {plural(summary.reviewsWritten, "review")} written
                </p>
              </div>
              {/*
                THE HISTOGRAM HAS NO `DISTINCT ON`, DELIBERATELY: a record rated twice in one
                year counts twice, because this is a diary statistic rather than a consensus
                figure. Consensus figures are the ones that collapse replays (I-10).
              */}
              <Histogram buckets={review.histogram} />
            </div>
          </section>

          {/* ---- Top albums ------------------------------------------------------- */}
          {review.topAlbums.length > 0 ? (
            <section>
              <SectionHeading eyebrow="Records" title={`The ${year} shelf`} />
              <CoverRail>
                {review.topAlbums.map((album) => {
                  const href = `/album/${albumSlug(album.title, album.albumId)}`;
                  const cover = albumCover(
                    { coverPath: album.coverPath, mbid: album.mbid },
                    TILE_SOURCE_WIDTH,
                  );
                  return (
                    // The wrapping link is the `group`, which is what drives `.sleeve`'s lift.
                    <Link key={album.albumId} href={href} className="group block">
                      <div className="sleeve">
                        {cover ? (
                          <img
                            src={cover}
                            // Empty alt: the title is in the caption inside the same link.
                            alt=""
                            loading="lazy"
                            decoding="async"
                            className="size-full object-cover"
                          />
                        ) : (
                          <div className="flex size-full items-center justify-center">
                            <Disc3 className="size-8 text-line-bright" aria-hidden="true" />
                          </div>
                        )}
                      </div>
                      <p className="mt-2 line-clamp-2 font-sans text-[0.8125rem] leading-snug text-paper transition-colors group-hover:text-amber">
                        {album.title}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-[0.6875rem] tabular text-faint">
                        {album.artistName}
                      </p>
                      <p className="mt-0.5 font-mono text-[0.6875rem] tabular text-faint">
                        {`${album.tracksPlayed} `}
                        {album.tracksPlayed === 1 ? "track" : "tracks"}
                        {album.averageRating === null ? "" : ` · ★ ${formatRating(album.averageRating)}`}
                        {album.averageRating === null ? null : (
                          <span className="sr-only">{` — ${name} rated it ${formatRating(album.averageRating)} out of 5 stars this year`}</span>
                        )}
                      </p>
                    </Link>
                  );
                })}
              </CoverRail>
            </section>
          ) : null}

          {/* ---- Top tracks ------------------------------------------------------- */}
          {review.topTracks.length > 0 ? (
            <section>
              <SectionHeading eyebrow="Tracks" title="The songs of the year" />
              <ol className="card divide-y divide-line">
                {review.topTracks.map((track) => {
                  const locator = trackLocator({
                    disc: track.discNumber,
                    track: track.trackNumber,
                    discCount: track.discCount,
                  });
                  const albumHref = `/album/${albumSlug(track.albumTitle, track.albumId)}`;
                  const played = formatDate(track.listenedOn);
                  return (
                    <li
                      key={track.trackId}
                      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
                    >
                      {/* Mono and tabular: a track is identified by its position as much as by
                          its name, and a proportional font makes a column of them ragged. */}
                      <span className="w-8 shrink-0 font-mono text-[0.6875rem] tabular text-faint">
                        {locator}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm">
                          <Link
                            href={`${albumHref}/track/${locator}`}
                            className="text-paper transition-colors hover:text-amber"
                          >
                            {track.title}
                          </Link>
                        </p>
                        <p className="mt-0.5 truncate font-mono text-[0.6875rem] tabular text-faint">
                          <Link href={albumHref} className="transition-colors hover:text-paper">
                            {track.albumTitle}
                          </Link>
                          {" · "}
                          <Link
                            href={`/artist/${artistSlug(track.artistName, track.artistId)}`}
                            className="transition-colors hover:text-paper"
                          >
                            {track.artistName}
                          </Link>
                        </p>
                      </div>
                      <Stars value={track.rating} size="sm" />
                      {played ? (
                        <time
                          dateTime={track.listenedOn}
                          className="shrink-0 font-mono text-[0.6875rem] tabular text-faint"
                        >
                          {played}
                        </time>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}

          {/* ---- Genres ----------------------------------------------------------- */}
          <section>
            <SectionHeading eyebrow="Genres" title="What it was made of" />
            <div className="card p-5">
              <GenreSplit genres={review.genres} />
            </div>
          </section>

          {/* ---- Bookends and the longest session ---------------------------------- */}
          <section>
            <SectionHeading eyebrow="Bookends" title="First, last, longest" />
            <div className="grid gap-4 lg:grid-cols-3">
              {(["first", "last"] as const).map((which) => {
                const bookend = review.bookends[which];
                return (
                  <div key={which} className="card p-4">
                    <Eyebrow>{which === "first" ? `First of ${year}` : `Last of ${year}`}</Eyebrow>
                    {bookend === null ? (
                      <p className="mt-2 text-sm text-faint">Nothing dated.</p>
                    ) : (
                      <div className="mt-2 space-y-1.5">
                        <p className="text-sm">
                          {/*
                            THE LOG'S OWN PAGE IS THE DESTINATION. A bookend is one specific
                            entry, and /log/[id] is where its thread and its full text live —
                            linking to the album instead would lose which entry this was.
                          */}
                          <Link
                            href={`/log/${bookend.logId}`}
                            className="text-paper transition-colors hover:text-amber"
                          >
                            {bookend.trackTitle ?? bookend.albumTitle ?? bookend.artistName}
                          </Link>
                        </p>
                        <p className="font-mono text-[0.6875rem] tabular text-faint">
                          {bookend.albumTitle && bookend.trackTitle
                            ? `${bookend.albumTitle} · ${bookend.artistName}`
                            : bookend.artistName}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <time
                            dateTime={bookend.listenedOn}
                            className="font-mono text-[0.6875rem] tabular text-faint"
                          >
                            {formatDate(bookend.listenedOn)}
                          </time>
                          {bookend.rating === null ? (
                            // "Listened, not rated" is a real state; zero stars is not.
                            <Badge>Not rated</Badge>
                          ) : (
                            <Stars value={bookend.rating} size="xs" />
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="card p-4">
                <Eyebrow>Longest sitting</Eyebrow>
                {review.longestSession === null ? (
                  <p className="mt-2 text-sm text-faint">No single record filled a day.</p>
                ) : (
                  <div className="mt-2 space-y-1.5">
                    <p className="text-sm">
                      <Link
                        href={`/album/${albumSlug(review.longestSession.title, review.longestSession.albumId)}`}
                        className="text-paper transition-colors hover:text-amber"
                      >
                        {review.longestSession.title}
                      </Link>
                    </p>
                    <p className="font-mono text-[0.6875rem] tabular text-faint">
                      {review.longestSession.artistName}
                    </p>
                    <p className="flex flex-wrap items-center gap-2 font-mono text-[0.6875rem] tabular text-faint">
                      <CalendarDays className="size-3.5 shrink-0" aria-hidden="true" />
                      <time dateTime={review.longestSession.listenedOn}>
                        {formatDate(review.longestSession.listenedOn)}
                      </time>
                      <span>{`· ${plural(review.longestSession.tracks, "track")}`}</span>
                    </p>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* ---- Against everybody else -------------------------------------------- */}
          <section>
            <SectionHeading
              eyebrow="Compared"
              title={`${year} on Deadwax`}
              action={
                <span className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
                  <Flag className="mr-1.5 inline size-3.5" aria-hidden="true" />
                  {plural(platform.members, "member")}
                </span>
              }
            />
            {/*
              TWO ROWS, ONE SHARED SCALE PER ROW. `ComparisonRow` scales both bars to
              `max(mine, platform)` so their lengths are directly comparable; scaling each to
              its own value would make every pair read "you and everybody else did the same".

              `kind="rating"` hands the value to `<Stars>` rather than printing `n/10` — the
              platform average is on the same stored scale and must be shown the same way.
            */}
            <div className="card space-y-6 p-5">
              <ComparisonRow
                label="Tracks played"
                mine={summary.tracksPlayed}
                platform={platform.averageTracks}
                platformLabel="Average member"
              />
              <ComparisonRow
                label="Average rating"
                mine={summary.averageRating}
                platform={platform.averageRating}
                kind="rating"
                platformLabel="Everyone"
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

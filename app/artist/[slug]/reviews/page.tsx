/**
 * /artist/[slug]/reviews — everything written about an artist, their records and their tracks.
 *
 * ============================================================================
 * NO `loading.tsx` FOR THIS ROUTE, EVER (I-3)
 *
 * This function decides the response status. A `notFound()` raised after the shell has flushed
 * is sent as a 200, and a route-level `loading.tsx` flushes the shell immediately — so every
 * bad slug would become a 200 with not-found markup inside it. Parse, resolve, `notFound()`,
 * and only then read anything.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------------------
 * THE COUNT AND THE LIST ARE ASKED THE SAME QUESTION (I-14)
 * ---------------------------------------------------------------------------------------
 *
 * `countReviews` and `getReviews` are two functions over one conditions ladder, and they take
 * THE SAME TARGET AND THE SAME SCOPE here — built once, in a single `const`, so the two cannot
 * drift apart at this call site either. A "12 reviews" heading over ten visible ones reads as a
 * bug in the list rather than a bug in a count, and the total is what the pagination's page
 * arithmetic is computed from, so a disagreement is visible twice.
 *
 * ---------------------------------------------------------------------------------------
 * `scope: "any"` IS A TWO-LEVEL ROLLUP HERE, AND THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------------------------
 *
 * At album level the rollup reaches one tier down. At artist level it reaches two: a verdict on
 * the artist, a review of any of their records, and a review of any track on any of those
 * records all land on this page. **An exact-scope artist page would be empty for almost every
 * artist in the catalogue** — hardly anybody writes a paragraph about a career, and everybody
 * writes them about individual songs — while all the writing sat two tiers below the page that
 * exists to collect it.
 *
 * The heading says so in words, because the rollup is invisible in the URL.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { queryHref, SortSelect } from "@/components/discovery/sort-select";
import { ReviewCard } from "@/components/social/review-card";
import { Button } from "@/components/ui/button";
import { EmptyState, Eyebrow, Pagination } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import {
  countReviews,
  getLikedLogIds,
  getReviews,
  REVIEW_PAGE_SIZE,
  REVIEW_SORTS,
  type ReviewSort,
  type ReviewTarget,
} from "@/lib/db/queries/logs";
import { plural } from "@/lib/format";
import { ensureArtistById } from "@/lib/ingest/albums";
import { artistSlug, parseArtistSlug, parsePage } from "@/lib/slug";

/** Edited together with the album reviews page: the two surfaces name the same sorts alike. */
const REVIEW_SORT_LABELS: Readonly<Record<ReviewSort, string>> = {
  popular: "Most liked",
  recent: "Newest",
};

function parseReviewSort(value: string | null): ReviewSort {
  return (REVIEW_SORTS as readonly string[]).includes(value ?? "") ? (value as ReviewSort) : "recent";
}

type Params = Promise<{ slug: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = (raw ?? "").trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 40);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const id = parseArtistSlug((await params).slug);
  if (id === null) return { title: "Artist not found" };
  const artist = await ensureArtistById(id);
  if (!artist) return { title: "Artist not found" };
  return {
    title: `Reviews of ${artist.name}`,
    description: `What Deadwax members wrote about ${artist.name}, their records and their tracks.`,
  };
}

export default async function ArtistReviewsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  /* -- the 404 decision, and nothing else ---------------------------------------------- */
  const { slug } = await params;
  const id = parseArtistSlug(slug);
  if (id === null) notFound();
  const artist = await ensureArtistById(id);
  if (!artist) notFound();

  /* -- everything else ----------------------------------------------------------------- */
  const query = await searchParams;
  const sort = parseReviewSort(one(query.sort));
  const page = parsePage(one(query.page));
  const viewer = await currentUser();

  const artistHref = `/artist/${artistSlug(artist.name, artist.id)}`;

  /*
   * ONE TARGET, TWO READS. Declared once so the count and the window cannot disagree, and
   * declared `ReviewTarget` rather than inferred so a stray field is a compile error instead of
   * a silently different tier — `ReviewTarget` reads the tier off which fields are present.
   */
  const target: ReviewTarget = { artistId: artist.id, scope: "any" };
  const [total, reviews] = await Promise.all([
    countReviews(target),
    getReviews(target, { sort, limit: REVIEW_PAGE_SIZE, offset: (page - 1) * REVIEW_PAGE_SIZE }),
  ]);

  /* A second round: one query for every card, and it needs their ids. */
  const likedIds = await getLikedLogIds(viewer?.id, reviews.map((entry) => entry.id));

  const totalPages = Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE));
  const hasNext = page * REVIEW_PAGE_SIZE < total;

  return (
    /* `max-w-3xl` — the reviews column width. A review is prose and prose needs a measure. */
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="letterbox">
        <Eyebrow>{total === 0 ? "Reviews" : plural(total, "review")}</Eyebrow>
        <h1 className="mt-2 font-display text-3xl leading-tight text-paper text-balance sm:text-4xl">
          <Link href={artistHref} className="transition-colors hover:text-amber">
            {artist.name}
          </Link>
        </h1>
        {/* THE ROLLUP, SAID OUT LOUD. `scope: "any"` is invisible in the URL, and a member
            wondering why a review of one song is filed under the artist deserves the sentence. */}
        <p className="mt-2 text-sm text-muted">
          Verdicts on the artist, reviews of their records, and reviews of individual tracks.
        </p>
      </header>

      {total > 0 ? (
        <SortSelect
          basePath={`${artistHref}/reviews`}
          /* DELIBERATELY NO `page`: re-sorting invalidates the window it was paged into. */
          options={REVIEW_SORTS}
          value={sort}
          labels={REVIEW_SORT_LABELS}
          label="Sort reviews by"
        />
      ) : null}

      {reviews.length === 0 ? (
        <EmptyState
          title={page > 1 ? "Nothing on this page" : "Nobody has written about this artist yet"}
          description={
            page > 1
              ? "There are fewer reviews than this page number needs. The first page is where they start."
              : "Ratings are a number; a review is the reason. Open one of their records and say what you thought."
          }
          action={
            <Button asChild variant={page > 1 ? "secondary" : "primary"}>
              <Link href={page > 1 ? `${artistHref}/reviews` : artistHref}>
                {page > 1 ? "Back to the first page" : "Open the discography"}
              </Link>
            </Button>
          }
        />
      ) : (
        <ul className="space-y-4">
          {reviews.map((entry) => (
            <li key={entry.id}>
              {/*
                `showAuthor` stays on by default: this is a page of many people's writing, and
                the avatar is the only thing distinguishing two reviews of the same record.
                `canDelete` stays off — the diary is the one surface where a log delete control
                exists.
              */}
              <ReviewCard entry={entry} liked={likedIds.has(entry.id)} />
            </li>
          ))}
        </ul>
      )}

      <Pagination
        page={page}
        hasNext={hasNext}
        totalPages={totalPages}
        /* Page 1 carries no `page` parameter, so the canonical first page has ONE address
           instead of two that cache, prefetch and get indexed separately. */
        buildHref={(next) => queryHref(`${artistHref}/reviews`, { sort, page: next <= 1 ? null : next })}
      />
    </div>
  );
}

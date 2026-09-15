/**
 * /album/[slug]/reviews — every review of this record and of its tracks.
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
 * drift apart at this call site either. *A "12 reviews" heading over ten visible ones is the
 * kind of mismatch that looks like a bug in the list rather than a bug in a count*, and the
 * total is what the pagination's "of N" is computed from, so a disagreement is visible twice.
 *
 * `scope: "any"` ROLLS UP THE ALBUM'S OWN TRACKS. Most writing about music is about a specific
 * song, so the exact scope would leave this page empty while all the writing sits one tier
 * below it. The heading says "and its tracks" because the rollup is not obvious from the URL.
 *
 * ---------------------------------------------------------------------------------------
 * `PAGE_SIZE` AND THE SORT WHITELIST ARE IMPORTED, NOT RE-DECLARED
 * ---------------------------------------------------------------------------------------
 *
 * `REVIEW_PAGE_SIZE` and `REVIEW_SORTS` live beside the SQL that implements them. There are TWO
 * orders and no third: "popular" reuses the same correlated like-count subquery the SELECT list
 * uses, so the sort runs over every matching review before LIMIT/OFFSET rather than reordering
 * one page of already-chosen rows. There is deliberately no hot ranking and no time decay.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SortSelect } from "@/components/discovery/sort-select";
import { queryHref } from "@/components/discovery/sort-select";
import { ReviewCard } from "@/components/social/review-card";
import { Button } from "@/components/ui/button";
import { EmptyState, Eyebrow, Pagination } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import { getAlbumsByIds } from "@/lib/db/queries/albums";
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
import { ensureAlbumById } from "@/lib/ingest/albums";
import { albumSlug, artistSlug, parsePage, parseAlbumSlug } from "@/lib/slug";

/**
 * NOTHING HERE IS WORDED AS QUALITY. "Most liked" is what the order actually is — the count of
 * other members' hearts on the review, not a judgement of the record.
 */
const REVIEW_SORT_LABELS: Readonly<Record<ReviewSort, string>> = {
  popular: "Most liked",
  recent: "Newest",
};

/**
 * The whitelist as a parser. Written out here rather than imported because lib/db/queries/logs
 * exports the tuple and not a parser for it — the same shape `parseAlbumSort` has, and the
 * same reason: a sort key must select a branch rather than reach SQL as text.
 *
 * `as readonly string[]` is the house cast: comparing a `string` against a `readonly
 * ReviewSort[]` is a type error, and widening the ARRAY is safer than asserting the VALUE.
 */
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
  // `params` IS A PROMISE in Next 16.
  const id = parseAlbumSlug((await params).slug);
  if (id === null) return { title: "Record not found" };

  // React-`cache()`d, so `generateMetadata` and the body share one resolution.
  const album = await ensureAlbumById(id);
  if (!album) return { title: "Record not found" };

  // A bare title: the root's `title.template` makes it "… · Deadwax".
  return { title: `Reviews of ${album.title}`, description: `What Deadwax members wrote about ${album.title}.` };
}

export default async function AlbumReviewsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  /* -- the 404 decision, and nothing else ---------------------------------------------- */
  const { slug } = await params;
  const id = parseAlbumSlug(slug);
  if (id === null) notFound();

  const row = await ensureAlbumById(id);
  if (!row) notFound();

  /* -- everything else ----------------------------------------------------------------- */
  const query = await searchParams;
  const sort = parseReviewSort(one(query.sort));
  const page = parsePage(one(query.page));

  const viewer = await currentUser();

  /*
   * `getAlbumsByIds` rather than `getAlbumWithTracks`: this page needs the artist's name for one
   * breadcrumb line and has no use for a tracklist. The array form is the only projection that
   * carries the joined artist columns.
   */
  const [album] = await getAlbumsByIds([row.id]);
  // Deleted between the two statements. Still a 404, and still before anything has flushed.
  if (!album) notFound();

  const albumHref = `/album/${albumSlug(album.title, album.id)}`;

  /*
   * ONE TARGET OBJECT, HANDED TO BOTH. The whole of I-14 in one `const`: there is no second
   * place to forget `scope`.
   */
  const target: ReviewTarget = { albumId: album.id, scope: "any" };

  const [total, reviews] = await Promise.all([
    countReviews(target),
    getReviews(target, { sort, limit: REVIEW_PAGE_SIZE, offset: (page - 1) * REVIEW_PAGE_SIZE }),
  ]);

  /* A second round: one query for every card, and it needs their ids. */
  const likedIds = await getLikedLogIds(viewer?.id, reviews.map((entry) => entry.id));

  /*
   * THIS PAGE GENUINELY KNOWS ITS TOTAL, unlike the browse grids — the count is a local query
   * over one album, not an estimate behind a jsonb predicate — so `totalPages` is passed and
   * `Pagination` prints "of N". `hasNext` is computed from the same total rather than from the
   * row count, so the last page's "Next" is disabled even when the window happens to be full.
   */
  const totalPages = Math.max(1, Math.ceil(total / REVIEW_PAGE_SIZE));
  const hasNext = page * REVIEW_PAGE_SIZE < total;

  return (
    /* `max-w-3xl` — the reviews column width. A review is prose and prose needs a measure. */
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="letterbox">
        <Eyebrow>{total === 0 ? "Reviews" : plural(total, "review")}</Eyebrow>
        <h1 className="mt-2 font-display text-3xl leading-tight text-paper text-balance sm:text-4xl">
          {/* The record is the link back. A breadcrumb component would be one more primitive
              for a two-item trail that every page here spells the same way. */}
          <Link href={albumHref} className="transition-colors hover:text-amber">
            {album.title}
          </Link>
        </h1>
        <p className="mt-2 text-sm text-muted">
          <Link
            href={`/artist/${artistSlug(album.artistName, album.artistId)}`}
            className="transition-colors hover:text-amber"
          >
            {album.artistName}
          </Link>
          {/* THE ROLLUP, SAID OUT LOUD. `scope: "any"` is invisible in the URL, and a member
              wondering why a track review is filed under the album deserves the sentence. */}
          <span className="text-faint"> — the album and its tracks</span>
        </p>
      </header>

      {total > 0 ? (
        <SortSelect
          basePath={`${albumHref}/reviews`}
          /* DELIBERATELY NO `page`: re-sorting invalidates the window it was paged into. */
          options={REVIEW_SORTS}
          value={sort}
          labels={REVIEW_SORT_LABELS}
          label="Sort reviews by"
        />
      ) : null}

      {reviews.length === 0 ? (
        <EmptyState
          title={page > 1 ? "Nothing on this page" : "No reviews yet"}
          description={
            page > 1
              ? "There are fewer reviews than this page number needs. The first page is where they start."
              : "Ratings are a number; a review is the reason. Log this record and say what you thought."
          }
          action={
            <Button asChild variant={page > 1 ? "secondary" : "primary"}>
              <Link href={page > 1 ? `${albumHref}/reviews` : albumHref}>
                {page > 1 ? "Back to the first page" : "Open the record"}
              </Link>
            </Button>
          }
        />
      ) : (
        <ul className="space-y-4">
          {reviews.map((entry) => (
            <li key={entry.id}>
              {/*
                `showAuthor` stays on: this is a page of many people's writing, and the avatar is
                the only thing distinguishing two reviews of the same record. `canDelete` stays
                off — the diary is the one surface where a log delete control exists.
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
        buildHref={(next) => queryHref(`${albumHref}/reviews`, { sort, page: next <= 1 ? null : next })}
      />
    </div>
  );
}

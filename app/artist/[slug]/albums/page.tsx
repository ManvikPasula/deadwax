/**
 * /artist/[slug]/albums — the whole catalogue, including everything the artist page hides.
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
 * WHY THIS PAGE EXISTS AT ALL: it is the release valve on the canonical filter
 * ---------------------------------------------------------------------------------------
 *
 * `albums.is_canonical` keeps reissues, deluxe editions, live records and compilations out of
 * the heatmap, out of the completion denominator and out of the recommendation pool. That is
 * the right default — a deluxe edition's bonus tracks must never substitute for real ones —
 * but it is not the same as saying those releases do not exist. **They are still loggable, and
 * somebody who rated the 30th-anniversary edition needs a page that admits it is there.**
 *
 * So this route passes `includeNonCanonical: true` and the artist page does not. The two pages
 * disagree about the release count on purpose, and `DiscographyList` splits the difference
 * visibly: albums in one group, "EPs, singles and other releases" in the second.
 *
 * ---------------------------------------------------------------------------------------
 * `type` IS A WHITELIST AGAINST A CLOSED SET, NOT A PASS-THROUGH
 * ---------------------------------------------------------------------------------------
 *
 * `recordType` reaches a SQL comparison. It is parameterised, so a bad value is a miss rather
 * than an injection — but an unparsed value would still let any string become an addressable
 * empty page with its own `<title>`, which is a slow way to fill somebody's index with noise.
 * The four values here are Deezer's own `record_type` vocabulary.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DiscographyList } from "@/components/artist/discography-list";
import { DISCOGRAPHY_SORT_LABELS, queryHref, SortSelect } from "@/components/discovery/sort-select";
import { Chip, Eyebrow } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import {
  DISCOGRAPHY_SORTS,
  getArtistDiscography,
  parseDiscographySort,
} from "@/lib/db/queries/artists";
import { plural } from "@/lib/format";
import { ensureArtistById, ensureDiscography } from "@/lib/ingest/albums";
import { artistSlug, parseArtistSlug } from "@/lib/slug";

/** Deezer's `record_type` vocabulary, in the order a discography is usually read. */
const RECORD_TYPES = ["album", "ep", "single", "compilation"] as const;
type RecordType = (typeof RECORD_TYPES)[number];

const RECORD_TYPE_LABELS: Readonly<Record<RecordType, string>> = {
  album: "Albums",
  ep: "EPs",
  single: "Singles",
  compilation: "Compilations",
};

function parseRecordType(value: string | null): RecordType | null {
  return (RECORD_TYPES as readonly string[]).includes(value ?? "") ? (value as RecordType) : null;
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
    title: `Every ${artist.name} release`,
    description: `The full ${artist.name} catalogue mirrored by Deadwax, reissues and compilations included.`,
  };
}

export default async function ArtistAlbumsPage({
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
  const recordType = parseRecordType(one(query.type));
  const sort = parseDiscographySort(one(query.sort));
  const viewer = await currentUser();

  /*
   * The same fill the artist page runs inside a Suspense boundary, awaited here instead.
   *
   * There is no boundary because there is nothing to show around it: the list IS the page, so
   * a fallback would be a skeleton with a heading over it and one extra render. `ensureArtist`
   * and `ensureDiscography` are both wrapped in React `cache()` and both honour their TTLs, so
   * arriving here from the artist page costs no provider call at all.
   */
  await ensureDiscography(artist);

  const albums = await getArtistDiscography(artist.id, {
    viewerId: viewer?.id ?? null,
    sort,
    includeNonCanonical: true,
    recordType,
  });

  const basePath = `/artist/${artistSlug(artist.name, artist.id)}/albums`;

  return (
    <div className="space-y-6">
      <header className="letterbox">
        <Eyebrow>{plural(albums.length, "release")}</Eyebrow>
        <h1 className="mt-2 font-display text-3xl leading-tight text-paper text-balance sm:text-4xl">
          {/* The artist is the link back. A breadcrumb component would be one more primitive
              for a two-item trail that every page here spells the same way. */}
          <Link href={`/artist/${artistSlug(artist.name, artist.id)}`} className="transition-colors hover:text-amber">
            {artist.name}
          </Link>
        </h1>
        <p className="mt-2 text-sm text-muted">
          Everything we hold, reissues and compilations included — the discography grid shows only
          canonical releases.
        </p>
      </header>

      <nav aria-label="Filter and sort" className="space-y-3">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <Eyebrow className="pt-1.5">Type</Eyebrow>
          <div role="group" aria-label="Filter by release type" className="flex flex-wrap items-center gap-1.5">
            {/* "ALL" IS A CHIP, NOT A CLEAR BUTTON — the same convention as `FilterBar`: every
                option is one addressable view, so every option is one more link. */}
            <Chip asChild active={recordType === null}>
              <Link href={queryHref(basePath, { sort })} aria-current={recordType === null ? "true" : undefined}>
                All
              </Link>
            </Chip>
            {RECORD_TYPES.map((value) => (
              <Chip key={value} asChild active={recordType === value}>
                <Link
                  href={queryHref(basePath, { type: value, sort })}
                  aria-current={recordType === value ? "true" : undefined}
                >
                  {RECORD_TYPE_LABELS[value]}
                </Link>
              </Chip>
            ))}
          </div>
        </div>
        <SortSelect
          basePath={basePath}
          params={{ type: recordType }}
          options={DISCOGRAPHY_SORTS}
          value={sort}
          labels={DISCOGRAPHY_SORT_LABELS}
          label="Sort releases by"
        />
      </nav>

      {/*
        `DiscographyList` owns the empty state as well as the grouping, so a filter that matches
        nothing renders the same panel an artist with no mirrored releases gets. One component,
        one voice for both.
      */}
      <DiscographyList albums={albums} as="h2" />
    </div>
  );
}

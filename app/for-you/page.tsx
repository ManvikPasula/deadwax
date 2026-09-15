/**
 * /for-you — the recommender's full output, and the only page that explains itself.
 *
 * REDIRECTS AN ANONYMOUS CALLER TO `/login?next=/for-you`. There is nothing to predict for
 * somebody with no ratings, which is also why the header links this route only when signed in
 * — *the page is meaningless without ratings.* The `?next=` is honoured by /login, so signing
 * in lands back here rather than on the homepage.
 *
 * ============================================================================
 * THE THREE COLD-START GATES, WITH THEIR THREE DISTINCT MESSAGES — AND THE COPY IS THE
 * SERVER'S, VERBATIM.
 *
 * `RecommendationResult` has four arms and three of them carry their OWN `title` and
 * `message`. There is deliberately no shared `message` field, so this page CANNOT render one
 * apology for all three situations, and nothing below writes a sentence about a gate:
 *
 *   too-few    fewer than `MIN_RATED_ALBUMS` rated albums. Carries `needed`, so this is the
 *              one arm with a progress bar.
 *   no-variety `spread < NO_VARIETY_SPREAD`. Checked BEFORE ANY PROVIDER CALL, because a
 *              member whose ratings are all 8 cannot be helped by a better pool — every
 *              candidate would land within a few hundredths of every other.
 *   cold-pool  the pool, the candidate set or the final list came back empty.
 *
 * > Ten indistinguishable predictions dressed as a ranked list is worse than saying there is
 * > nothing to say yet.
 *
 * `withheld` is the discriminant rather than an `ok` flag because A WITHHELD LIST IS A PASS,
 * not a failure: the flat rater is *supposed* to be refused, and calling that arm an error is
 * how a correct refusal ends up logged as a bug.
 * ============================================================================
 *
 * ---------------------------------------------------------------------------------------
 * THE 90% CEILING IS PRINTED VERBATIM FROM `confidenceCeilingNote`
 * ---------------------------------------------------------------------------------------
 *
 * That function lives beside `CONFIDENCE_CEILING` in lib/taste/shared.ts *so that raising the
 * cap without rewriting the sentence is impossible.* Rewriting it here — or paraphrasing it,
 * or interpolating the constant into a sentence of this page's own — would restore exactly
 * the drift it exists to prevent. It is rendered as one string and not assembled.
 *
 * ---------------------------------------------------------------------------------------
 * UP TO TWO REASONS PER CARD. NOT ONE.
 * ---------------------------------------------------------------------------------------
 *
 * `reasons` holds at most three strings, pushed inside the branch that actually moved the
 * score, in a fixed order — and the NEIGHBOUR reason ("Listeners of Aphex Twin tend to play
 * this too") is pushed first whenever the album arrived through the neighbour graph, which is
 * the single largest term in the model and therefore most of the list. So rendering
 * `reasons[0]` alone, which is what the source surface does, means the attribute reasons
 * (genre lean, label, era, consensus alignment) are computed, ranked on, and then NEVER SEEN.
 *
 * ---------------------------------------------------------------------------------------
 * THE PREDICTION NEVER ENTERS THE CARD'S AVERAGE SLOT
 * ---------------------------------------------------------------------------------------
 *
 * `cardFromAlbumRow` leaves `memberAverage` null for these rows, deliberately: the card's
 * star figure means "what members here rated this", and a model estimate wearing it would be
 * indistinguishable from a real community average — the same dishonesty as putting Deezer's
 * `fans` in that slot. The estimate is printed BELOW the card with the word "predicted"
 * attached, and the number shown is `item.rating` (the model's actual estimate) and never
 * `rankingScore`, which is shrunk toward the member's mean for ordering only.
 *
 * NO SUSPENSE BOUNDARY, UNLIKE THE HOME RAIL. `getRecommendations` is the whole page here,
 * so streaming a shell around it would stream an empty page; and the home page's boundary is
 * safe only because nothing inside it can raise `notFound()` (I-3). Nothing here can either —
 * the gates are renders, not statuses — but there is no second half to flush first.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CoverCard } from "@/components/album/cover-card";
import { CoverGrid, GRID_PAGE_SIZE } from "@/components/album/cover-grid";
import { Stars } from "@/components/rating/stars";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, Eyebrow, Meter, SectionHeading } from "@/components/ui/primitives";
import { currentUser } from "@/lib/auth/session";
import { plural } from "@/lib/format";
import { formatRating } from "@/lib/ratings";
import { dislikedGenres, preferredGenres } from "@/lib/taste/profile";
import { getRecommendations } from "@/lib/taste/recommend";
import { confidenceBand, confidenceCeilingNote } from "@/lib/taste/shared";
import { cardFromAlbumRow } from "@/lib/view";

export const metadata: Metadata = {
  title: "For you",
  description:
    "Records predicted from your own ratings — with the reasons, the confidence, and what the model cannot know.",
};

/**
 * A FULL GRID RATHER THAN THE HOME RAIL'S TWELVE. 24 is `GRID_PAGE_SIZE`, which is divisible
 * by 3, 4 and 6 — `CoverGrid`'s three column counts — so the last row fills at every
 * breakpoint. It is imported rather than typed, because the number is only correct as long as
 * it agrees with those column classes and they live in the same file as the constant.
 */
const LIMIT = GRID_PAGE_SIZE;

export default async function ForYouPage() {
  const viewer = await currentUser();
  // Before any work and before any markup. `redirect()` signals itself by throwing.
  if (!viewer) redirect("/login?next=/for-you");

  const result = await getRecommendations(viewer.id, LIMIT);

  /* ================================================================== *
   * THE THREE GATES
   * ================================================================== */
  if (result.withheld) {
    return (
      <div className="mx-auto max-w-3xl py-8">
        <Eyebrow>For you</Eyebrow>
        <h1 className="mt-2 font-display text-4xl leading-tight text-paper text-balance">
          {/* The server's own title, per arm. This page writes no heading of its own. */}
          {result.title}
        </h1>

        <EmptyState
          className="mt-8"
          /*
           * NO `title`. The h1 above already carries `result.title`, and `EmptyState` renders
           * its own title in the same display serif — so passing it here printed the identical
           * sentence twice in a row, separated only by the card's border. The heading states
           * the verdict; the card states the reason.
           */
          description={result.message}
          action={
            <div className="flex flex-col items-center gap-4">
              {/*
                THE PROGRESS BAR BELONGS TO ONE ARM ONLY. `needed` is carried by `too-few` and
                by nothing else, so TypeScript's own narrowing is what stops a bar being drawn
                for a member whose ratings are merely too alike — where there is no number to
                count toward and a bar would imply that rating five more of the same thing
                would unlock it.
              */}
              {result.reason === "too-few" ? (
                <div className="w-64 space-y-1.5">
                  <p className="font-mono text-[0.6875rem] uppercase tracking-wider tabular text-faint">
                    {result.ratedAlbums} of {result.needed} albums rated
                  </p>
                  {/*
                    `ratio` IS 0..1. `meterPercent()` returns 0..100 and passing that straight
                    through pins every meter at 100%, which looks like a working feature. The
                    count is printed directly above, so the bar takes no `label` and stays
                    hidden from assistive technology.
                  */}
                  <Meter ratio={result.ratedAlbums / result.needed} tone="amber" />
                </div>
              ) : null}

              <div className="flex flex-wrap justify-center gap-2">
                <Button asChild variant="primary">
                  <Link href="/albums">Find records to rate</Link>
                </Button>
                {/*
                  THE SECOND DOOR IS THE ONBOARDING GRID, and it is offered on the `too-few`
                  arm only: twenty-four covers and a star control is exactly the right answer
                  to "I have not rated enough", and exactly the wrong one to "your ratings are
                  too alike" — where more of the same is the problem rather than the fix.
                */}
                {result.reason === "too-few" ? (
                  <Button asChild variant="secondary">
                    <Link href="/start">Rate a grid of familiar albums</Link>
                  </Button>
                ) : null}
              </div>
            </div>
          }
        />
      </div>
    );
  }

  /*
   * `items` IS NON-EMPTY HERE BY CONSTRUCTION: `getRecommendations` returns the `cold-pool`
   * arm — handled above — whenever the pool, the candidate set or the final list comes back
   * empty. There is no fourth empty state to design.
   */
  const { items, profile, ratedAlbums } = result;
  const liked = preferredGenres(profile, 3);
  const disliked = dislikedGenres(profile, 3);

  return (
    <div className="py-8">
      <Eyebrow>For you</Eyebrow>
      <h1 className="mt-2 max-w-3xl font-display text-4xl leading-tight text-paper text-balance">
        Records to try next.
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
        Built from {plural(ratedAlbums, "album")} you have rated — your own ratings and nobody
        else&apos;s. No collaborative signal, so nothing here is &ldquo;people like you also
        played&rdquo;.
      </p>

      {/* ---- what the model thinks it knows ------------------------------------- */}
      <section className="mt-8">
        <SectionHeading as="h2" eyebrow="Your profile" title="What this is built on" />
        <div className="card grid gap-5 p-5 sm:grid-cols-3">
          <div>
            <Eyebrow>Your average</Eyebrow>
            <p className="mt-2 flex items-center gap-2">
              <Stars value={profile.meanRating} size="sm" label={null} />
              <span className="font-mono text-sm tabular text-paper">
                {formatRating(profile.meanRating)}
              </span>
              <span className="sr-only">
                {`Your mean rating is ${formatRating(profile.meanRating)} out of 5 stars across ${plural(profile.sampleSize, "rated album")}.`}
              </span>
            </p>
            <p className="mt-1 text-[0.6875rem] leading-relaxed text-faint">
              {/*
                THE SPREAD IS EXPLAINED RATHER THAN PRINTED AS A NUMBER. A standard deviation in
                stored units means nothing to a reader, and it is the term that vetoes
                confidence outright — `confidenceFor` is multiplicative, so a member with no
                variance gets no confidence however many albums they have rated.
              */}
              {profile.spread >= 2
                ? "Your ratings vary by a whole star or more, which is what makes them readable."
                : "Your ratings sit close together, so the model has less to work with. The gaps are the signal."}
            </p>
          </div>

          <div>
            <Eyebrow>Leaning toward</Eyebrow>
            {liked.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {liked.map((entry) => (
                  <li key={entry.key}>
                    <Badge tone="amber">{entry.label}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[0.8125rem] text-faint">
                Nothing yet — no genre sits above your own average by enough to count.
              </p>
            )}
          </div>

          <div>
            <Eyebrow>Rating below your mean</Eyebrow>
            {disliked.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {/*
                  SLICED FROM THE ASCENDING END by `dislikedGenres`, and a test asserts the
                  sign: the source sliced the descending end of a descending array and
                  displayed the three LEAST disliked genres under a "disliked" heading — a bug
                  invisible unless you happen to know the member's actual opinion, because the
                  output is always a plausible list of genres.
                */}
                {disliked.map((entry) => (
                  <li key={entry.key}>
                    <Badge tone="rose">{entry.label}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[0.8125rem] text-faint">
                Nothing yet. Rating the things you disliked helps more than rating the things
                you loved.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ---- the ranked list ----------------------------------------------------- */}
      <section className="mt-10">
        <SectionHeading as="h2" eyebrow={`${items.length} records`} title="Ranked for you" />

        <CoverGrid>
          {items.map((item, index) => {
            // UP TO TWO — see the docblock. `slice` rather than `[0]` and `[1]`, because a
            // prediction with one reason is ordinary and two lookups would render "undefined".
            const reasons = item.reasons.slice(0, 2);
            const band = confidenceBand(item.confidence);
            const percent = Math.round(item.confidence * 100);

            return (
              <div key={item.id} className="space-y-1.5">
                {/* `eager` for the first row only: a page of twenty-four eager covers is
                    twenty-four requests competing with the document. Six is the `lg` column
                    count, which is the widest first row there is. */}
                <CoverCard album={cardFromAlbumRow(item)} eager={index < 6} />

                <p className="flex items-center gap-1.5 font-mono text-[0.6875rem] tabular text-faint">
                  {/*
                    `label={null}` because the sentence after it carries the whole readout —
                    the glyphs would otherwise announce "4 out of 5 stars" and then the
                    sr-only text would say it again with the word "predicted" attached, and
                    only the second version is true.
                  */}
                  <Stars value={item.rating} size="xs" label={null} />
                  <span aria-hidden="true">predicted</span>
                  <span className="sr-only">
                    {`Predicted ${formatRating(item.rating)} out of 5 stars — an estimate, not a rating anybody has given.`}
                  </span>
                </p>

                {/*
                  THE CONFIDENCE FIGURE LIVES HERE AND NOT ON THE HOME RAIL, because this is
                  the page where the ceiling is explained beside it. THE BAND IS TEXT AS WELL
                  AS A TONE: rose, neutral and teal are a colour carrying meaning on their own,
                  and `confidenceBand` returns the label precisely so the copy and the colour
                  cannot disagree.
                */}
                <p className="flex items-center gap-1.5 font-mono text-[0.6875rem] uppercase tracking-wider tabular">
                  <span
                    className={
                      band.tone === "teal" ? "text-teal" : band.tone === "rose" ? "text-rose" : "text-muted"
                    }
                  >
                    {percent}%
                  </span>
                  <span className="text-faint">{band.label}</span>
                </p>

                {reasons.length > 0 ? (
                  <ul className="space-y-0.5">
                    {reasons.map((reason) => (
                      // `line-clamp-2` rather than `truncate`: these sentences name an artist
                      // or a label, and cutting them at one line loses exactly the noun that
                      // makes the reason a reason.
                      <li key={reason} className="line-clamp-2 text-[0.6875rem] leading-snug text-faint">
                        {reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </CoverGrid>
      </section>

      {/* ---- the epistemic footer ------------------------------------------------ */}
      <footer className="mt-12 max-w-2xl border-t border-line pt-5">
        <Eyebrow className="mb-2">What this cannot know</Eyebrow>
        {/*
          VERBATIM FROM `confidenceCeilingNote`. See the docblock: the sentence lives beside
          `CONFIDENCE_CEILING` so that raising the cap without rewriting the sentence is
          impossible, and paraphrasing it here would restore the drift it prevents.
        */}
        <p className="text-[0.8125rem] leading-relaxed text-muted">{confidenceCeilingNote(ratedAlbums)}</p>
        <p className="mt-2 text-[0.8125rem] leading-relaxed text-faint">
          The percentage beside each record is how much the model trusts its own estimate, not
          how much you will like it. It rises with how many albums you have rated, how much
          your ratings vary, and how much is known about the candidate — and any one of those
          three can hold it down on its own.
        </p>
      </footer>
    </div>
  );
}

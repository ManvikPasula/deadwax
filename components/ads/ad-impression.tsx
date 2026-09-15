"use client";

/**
 * The impression beacon. An invisible span, an `IntersectionObserver`, and one `fetch`.
 *
 * > A render is not a view — a sidebar three screens down gets rendered every time and seen
 * > rarely — and writing to the database while rendering would also make the page uncacheable.
 *
 * Both halves of that sentence are load-bearing. Counting at render time would inflate every
 * sidebar placement by however often it is rendered below the fold, which makes the number an
 * advertiser is shown a measure of our layout rather than of their reach; and a `render` that
 * writes is a render with a side effect, which takes every page carrying an ad out of the
 * cache for the rest of time.
 *
 * ============================================================================
 * `threshold: 0.5` — HALF THE UNIT MUST BE ON SCREEN.
 *
 * > So a sliver at the edge of the viewport does not count.
 *
 * The default threshold is 0, which fires when a single pixel of the element crosses the
 * viewport — so an ad that never rose above the bottom edge of somebody's screen while they
 * scrolled past would be counted as seen. Half is the number this product sells against, and
 * the one property of this file that a change would silently inflate rather than break.
 *
 * The honest bound: an element TALLER than the viewport can never reach 50%, and would
 * therefore never be counted. An ad card is a headline, a line of copy and a button, so it
 * cannot reach that size — but a future unit that could would need a second rule, not a lower
 * threshold.
 * ============================================================================
 *
 * THE `sent` LATCH IS A REF, NOT STATE, for two reasons. A state flag would re-render the
 * component to change nothing that is drawn, and — the one that matters — a ref survives
 * React's development-mode double-invocation of effects, so the beacon fires once in
 * development too. Without it every local impression count is doubled and every measurement
 * taken against a development database is wrong.
 *
 * `keepalive: true` so navigating away does not drop it. The interesting case is the one this
 * is for: somebody sees an ad and immediately clicks it, so the impression request is in
 * flight when the document starts unloading. Without `keepalive` the browser is free to
 * cancel it, and the surviving click would arrive with no impression to attribute it to — a
 * click-through rate above 100%.
 *
 * AN EMPTY `.catch(() => {})`, because *a missed count is not worth a console error on
 * somebody's page.* There is deliberately no retry, no queue and no logging: this endpoint is
 * reporting, not billing (see lib/db/queries/ads.ts — one row per ad per day, nothing about
 * who saw it), so the correct response to a failed count is to forget about it.
 *
 * IF `IntersectionObserver` IS UNDEFINED IT REPORTS IMMEDIATELY. The alternative — no
 * observer, no count — would mean an ad served to an old browser or a scripted client
 * silently stopped existing in the report, which understates delivery rather than reporting
 * it. Over-counting a browser that cannot tell us what it painted is the better error, and
 * the whole surface is first-party rows with a per-IP rate limit in front of the endpoint.
 */

import * as React from "react";

/** The endpoint. `POST`, JSON, `{ adId }` — see the contract note on `AdImpressionProps`. */
const IMPRESSION_ENDPOINT = "/api/ads/impression";

export type AdImpressionProps = {
  /**
   * `ads.id`.
   *
   * THE REQUEST BODY IS `{ "adId": <integer> }`, and app/api/ads/impression/route.ts reads
   * that key. It bounds the integer itself and answers 400 on anything else, so nothing here
   * validates: an integer column cannot hold a string, and a string reaching the driver would
   * be a 500 rather than a 400.
   *
   * NOTHING ELSE IS SENT. No member id, no session, no page key, no referrer — the endpoint
   * reads no cookie and stores nothing about who saw it, which is exactly what makes it
   * uninteresting to attack: the worst outcome is an inflated number in a report.
   */
  adId: number;
};

export function AdImpression({ adId }: AdImpressionProps) {
  const anchor = React.useRef<HTMLSpanElement | null>(null);
  const sent = React.useRef(false);

  React.useEffect(() => {
    if (sent.current) return;

    function report() {
      if (sent.current) return;
      // Latched BEFORE the request, not in a `.then`: two observer callbacks can fire in the
      // same tick while the first fetch is still being constructed.
      sent.current = true;

      void fetch(IMPRESSION_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adId }),
        keepalive: true,
        /*
         * `credentials: "omit"` MAKES THE PRIVACY CLAIM STRUCTURAL RATHER THAN CONDITIONAL.
         *
         * The endpoint reads no session and `ad_stats` has no member column, so "nothing about
         * who saw it is stored" was already true — but a same-origin `fetch` defaults to
         * sending credentials, so the session cookie was arriving on every impression and the
         * guarantee rested entirely on the handler continuing to ignore it. Withholding it
         * costs nothing here and means a future handler CANNOT read a session it was never
         * sent.
         */
        credentials: "omit",
      }).catch(() => {});
    }

    if (typeof IntersectionObserver === "undefined") {
      report();
      return;
    }

    const node = anchor.current;
    // No node means the span is not in the document, which cannot happen on the mount this
    // effect runs after — but returning is the correct response to it rather than asserting.
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          report();
          // Disconnected on the first qualifying entry: there is nothing left to watch, and a
          // live observer on every ad for the life of the page is work with no possible result.
          observer.disconnect();
          return;
        }
      },
      { threshold: 0.5 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [adId]);

  return (
    <span
      ref={anchor}
      /*
       * `pointer-events-none` IS NOT OPTIONAL, AND FORGETTING IT IS INVISIBLE UNTIL SOMEBODY
       * TRIES TO CLICK THE AD.
       *
       * This span is `absolute inset-0` as the first child of the card, so it covers the whole
       * unit — including the CTA. Without this declaration it swallows every click on the one
       * control the card exists for, and the card still looks perfect. It is the same reason
       * the film grain in globals.css carries `pointer-events: none` while covering the entire
       * viewport.
       *
       * It measures the CARD, not itself: `inset-0` means its box is the card's box, so
       * "half of this span is visible" and "half of the unit is visible" are the same
       * statement. A zero-size element would intersect at a threshold of 0.5 as soon as its
       * single point crossed the edge.
       *
       * `aria-hidden` because it is not content. It has no text, no role and no name, and an
       * unnamed span in the accessibility tree over an ad is one more thing to skip past.
       */
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
    />
  );
}

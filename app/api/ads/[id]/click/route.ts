/**
 * `GET /api/ads/[id]/click` — count the click, then send them where they were going.
 *
 * ---------------------------------------------------------------------------------------
 * A GET THAT WRITES, AND IT IS A DELIBERATE DOCUMENTED TRADE
 * ---------------------------------------------------------------------------------------
 *
 * A side effect on GET is normally a mistake: prefetchers, link scanners and mail clients all
 * follow GETs, so the counter will be inflated by software nobody clicked with. The alternative
 * is a form POST, and a form POST **cannot be middle-clicked, cannot be opened in a new tab,
 * and cannot be copied as a link** — which is most of what people actually do with a link to a
 * record they are interested in.
 *
 * Breaking the affordance to protect the accuracy of a reporting number is the wrong way round,
 * so this is a GET, and the inflation is accepted and stated. `rel="sponsored nofollow noopener"`
 * on the anchor keeps crawlers that honour it away.
 *
 * ---------------------------------------------------------------------------------------
 * OVER THE LIMIT, THE CLICK STILL FORWARDS — IT IS JUST NOT COUNTED
 * ---------------------------------------------------------------------------------------
 *
 * This is the opposite decision from the impression endpoint, and for a concrete reason:
 * refusing to forward somebody who clicked a link is worse than an uncounted click. A 429 here
 * is a dead end for a member who did nothing wrong, in exchange for protecting a number that
 * is reporting rather than billing.
 *
 * So the order is: resolve the destination, consume the budget, count only if the budget
 * allowed it, and redirect either way.
 *
 * ---------------------------------------------------------------------------------------
 * NO OPEN REDIRECT IS POSSIBLE, AND THERE ARE TWO INDEPENDENT REASONS
 * ---------------------------------------------------------------------------------------
 *
 * 1. **The destination comes from the row, never from the query string.** There is no `?to=`
 *    parameter to tamper with; the only input is an integer id.
 * 2. `clickTarget` **re-tests `^https?://` on the stored value before returning it.** A
 *    `javascript:` or `data:` URL that somehow reached the column — a migration, a direct
 *    database edit, a future admin form with a weaker check — still cannot become a
 *    navigation. A test writes exactly those values and asserts the null.
 *
 * A null target sends the member to `/` rather than to an error page: they clicked a link that
 * has since been paused or archived, and leaving them somewhere real is a better answer than a
 * status code about an ad they were never told the state of.
 */

import { clickTarget, recordAdEvent } from "@/lib/db/queries/ads";
import { BUDGETS, clientAddress, consume } from "@/lib/security/rate-limit";
import { MAX_DB_INT, parseBoundedInt } from "@/lib/slug";

export async function GET(
  request: Request,
  /** A PROMISE in Next 16, for route handlers as well as for pages. */
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const adId = parseBoundedInt(id, { min: 1, max: MAX_DB_INT });

  /*
   * A MALFORMED ID IS A 400. A VALID ID WITH NOTHING BEHIND IT IS A REDIRECT HOME.
   *
   * The split is the whole of this endpoint's error policy, and it follows from asking who
   * actually receives each answer:
   *
   *   `/api/ads/abc/click`  — no anchor in the product can produce this. The id comes from
   *                           `AdCard`, typed `number`, so a non-numeric segment means a
   *                           crawler mangling a URL or somebody typing. Nobody's click is
   *                           being refused, so the honest status is the accurate one.
   *   `/api/ads/9999/click` — this one a real person CAN reach: they clicked a card that has
   *                           since been paused or archived. A status code would replace the
   *                           page they wanted with an error they cannot act on, so they go
   *                           home instead (see the redirect at the end).
   *
   * Redirecting on a malformed id was the first version, and it was wrong for a reason worth
   * keeping written down: it treats a parse failure as a routine outcome, which means a
   * genuinely broken link in some future component looks identical to a link to a dead ad.
   */
  if (adId === null) return new Response(null, { status: 400 });

  /*
   * THE DESTINATION IS RESOLVED FIRST, before the budget is touched.
   *
   * It has to be: the forward happens whether or not the budget allows the count, so the lookup
   * is not conditional on anything. Resolving it first also means a throttled click costs the
   * same single query as a counted one.
   */
  const target = await clickTarget(adId);

  /*
   * The budget decides whether to COUNT, not whether to FORWARD. `consume` fails open on a
   * database error (it returns `ok`), which is the right direction here for the same reason:
   * the failure mode of an unavailable limiter must not be a broken link.
   */
  const limit = await consume(BUDGETS.adEventByIp, await clientAddress());
  if (limit.ok && target !== null) {
    /*
     * Counted only when there was something to click through to. An archived or paused ad
     * resolves to null, and `recordAdEvent` would already refuse to increment an archived
     * row — but a paused one still counts if an event arrives, because discarding events would
     * make the daily curve lie about a period the advertiser was paying for. Guarding on
     * `target` keeps the click and the forward describing the same thing.
     */
    await recordAdEvent(adId, "click");
  }

  if (target === null) return home(request);

  /*
   * 302, not 301 or 308.
   *
   * A permanent redirect would be cached by the browser and by intermediaries — after which the
   * member's next click never reaches this route at all, the counter stops moving, and changing
   * the ad's destination has no effect for anybody who clicked it once. The mapping from id to
   * URL is explicitly mutable: that is what the admin panel is for.
   *
   * `cache-control: no-store` says the same thing to anything that caches responses rather than
   * redirects, and keeps a shared proxy from serving one member's resolved destination to
   * another after the ad has been repointed.
   */
  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      "cache-control": "no-store",
      /*
       * `referrer-policy: no-referrer` so the advertiser's server never learns which page of
       * Deadwax the click came from. The page key is in the ad planner's seed, not in a header,
       * and a `Referer` of `/@someone/diary` would hand a third party a member's profile URL.
       */
      "referrer-policy": "no-referrer",
    },
  });
}

/** `/` on the current deployment's own origin, resolved from the request rather than an env. */
function home(request: Request): Response {
  return new Response(null, {
    status: 302,
    headers: { location: new URL("/", request.url).toString(), "cache-control": "no-store" },
  });
}

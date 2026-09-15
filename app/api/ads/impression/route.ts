/**
 * `POST /api/ads/impression` — the only write in the product that no session is attached to.
 *
 * ---------------------------------------------------------------------------------------
 * WHY THIS IS A ROUTE HANDLER RATHER THAN A SERVER ACTION
 * ---------------------------------------------------------------------------------------
 *
 * The beacon is sent with `fetch(..., { keepalive: true })` from a component that may be
 * unmounting as the member navigates away. A Server Action is a POST to the current page's
 * route with an RSC payload in the response, and a navigation in flight cancels it — so the
 * counter would systematically miss exactly the impressions that mattered most (the ones where
 * somebody looked and then clicked through). A bare endpoint with a `keepalive` fetch survives
 * the unload.
 *
 * ---------------------------------------------------------------------------------------
 * THE ORDER OF THE FOUR CHECKS IS THE DESIGN
 * ---------------------------------------------------------------------------------------
 *
 *   1. Same-origin — MISSING `Origin` is allowed, a WRONG one is 403
 *   2. `adEventByIp` — 300/hour, then 429
 *   3. Malformed JSON — 400
 *   4. A bounded integer id — 400
 *
 * **The rate limit is consumed before the body is read**, so a flood of 10 MB bodies costs one
 * `INSERT … ON CONFLICT` each rather than a parse each. The same reasoning as consuming the
 * login budget before bcrypt runs.
 *
 * **A missing `Origin` header is allowed on purpose.** Browsers omit it on some same-origin
 * requests, and older ones omit it more often; refusing those would silently stop counting for
 * a slice of real members while looking like a working endpoint. A *wrong* origin is refused
 * because that is a cross-site caller, and the only thing they can achieve here is inflating a
 * number in a report — which is precisely why this endpoint is not worth hardening further.
 *
 * ---------------------------------------------------------------------------------------
 * NO SESSION IS READ. NO COOKIE IS SET. NOTHING ABOUT WHO SAW IT IS STORED.
 * ---------------------------------------------------------------------------------------
 *
 * That is not an omission, it is the product decision this endpoint exists to enforce:
 * `ad_stats` holds one row per ad per day, with no member column and no per-event row, so an
 * impression cannot be joined against a person even by somebody with full database access. A
 * promise not to do that is a promise somebody can break in one afternoon; a table that cannot
 * express it is a different kind of assurance.
 *
 * The worst outcome of an abusive caller is therefore an inflated number in an operator's
 * report. **The counters are explicitly reporting, not billing.**
 *
 * ---------------------------------------------------------------------------------------
 * EVERY RESPONSE IS 204 OR AN ERROR WITH NO BODY WORTH READING
 * ---------------------------------------------------------------------------------------
 *
 * The caller discards the response (`.catch(() => {})` and nothing else), so a JSON body would
 * be bytes nobody reads. 204 also cannot be cached as a useful representation, which keeps the
 * endpoint out of any intermediary's store.
 */

import { BUDGETS, clientAddress, consume } from "@/lib/security/rate-limit";
import { recordAdEvent } from "@/lib/db/queries/ads";
import { MAX_DB_INT } from "@/lib/slug";

/** No body: the caller never reads one, and 204 is the honest status for a counter bump. */
const NO_CONTENT = new Response(null, { status: 204 });

export async function POST(request: Request): Promise<Response> {
  /* -- 1. same-origin, before anything else ------------------------------------------- */
  const origin = request.headers.get("origin");
  if (origin !== null && !sameOrigin(origin, request)) {
    return new Response(null, { status: 403 });
  }

  /* -- 2. the budget, BEFORE the body is parsed --------------------------------------- */
  const limit = await consume(BUDGETS.adEventByIp, await clientAddress());
  if (!limit.ok) {
    /*
     * `Retry-After` is set even though this caller discards the response: it is the correct
     * header for a 429 and costs nothing, and the next thing to read this endpoint may be a
     * crawler or a proxy rather than the beacon.
     */
    return new Response(null, {
      status: 429,
      headers: { "retry-after": String(Math.max(1, limit.retryAfterSeconds)) },
    });
  }

  /* -- 3. the body ------------------------------------------------------------------- */
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    // Not logged. A malformed beacon is noise, and noise in the log is how a real error gets
    // missed — the endpoint is unauthenticated and anybody can send anything to it.
    return new Response(null, { status: 400 });
  }

  /* -- 4. the id --------------------------------------------------------------------- */
  const adId = boundedId(payload);
  if (adId === null) return new Response(null, { status: 400 });

  /*
   * `recordAdEvent` IS A SILENT NO-OP FOR AN AD THAT DOES NOT EXIST OR IS ARCHIVED, and this
   * route deliberately does not check first. Two reasons: a existence probe would turn the
   * endpoint into an oracle for which ad ids are live, and the check would be a second round
   * trip to learn something the single statement already handles (the INSERT selects from the
   * CTE, so an archived ad increments neither counter).
   *
   * So a valid-shaped id for a missing ad returns 204. The response says "your beacon was
   * well-formed", not "that ad exists".
   */
  await recordAdEvent(adId, "impression");
  return NO_CONTENT;
}

/**
 * The origin comparison.
 *
 * Compared as HOSTS, not as strings. `request.url` is reconstructed by the runtime from the
 * forwarded headers, and on a platform that terminates TLS at the edge its protocol can differ
 * from the browser's (`http` inside the function, `https` outside) — so a string compare of the
 * two origins would 403 every real request in production. The host is the part that identifies
 * the site; the scheme is already `upgrade-insecure-requests` territory.
 *
 * A malformed `Origin` header throws out of `new URL` and is refused, which is the right answer
 * for a value that is supposed to be a browser-generated serialised origin.
 */
function sameOrigin(origin: string, request: Request): boolean {
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/**
 * `{ adId: number }` and nothing else.
 *
 * ACCEPTS ONLY A JSON NUMBER, not a numeric string: the only caller is `AdImpression`, which
 * sends `JSON.stringify({ adId })` from a prop typed `number`, so accepting `"12"` would widen
 * the endpoint's contract to serve a caller that does not exist. The bound is the Postgres
 * `integer` ceiling — an id above it is a guaranteed miss, and passing it to the driver would
 * raise a numeric-overflow error instead of doing nothing.
 */
function boundedId(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as { adId?: unknown }).adId;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value >= 1 && value <= MAX_DB_INT ? value : null;
}

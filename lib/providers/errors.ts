/**
 * The two error classes every provider client throws, and nothing else.
 *
 * Keeping them to two is what lets the ingest layer make one decision — "is this a missing
 * thing or a broken provider?" — without knowing which provider it was talking to.
 */

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    // The response body is truncated by the caller before it reaches here. An HTML error page
    // is tens of kilobytes and would flood the log with markup nobody reads.
    super(`[${provider} ${status}] ${path} — ${message}`);
    this.name = "ProviderError";
  }

  /** True for the statuses that mean "this thing does not exist", as opposed to "we are down". */
  get isMissing(): boolean {
    return this.status === 404 || this.status === 410;
  }
}

export class ProviderBudgetError extends Error {
  constructor(
    readonly provider: string,
    readonly retryAfterSeconds: number,
  ) {
    super(`[${provider}] outbound budget exhausted; retry in ${retryAfterSeconds}s`);
    this.name = "ProviderBudgetError";
  }
}

/** Truncate a response body before it is put in an error or a log line. */
export function truncateBody(body: string, max = 200): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

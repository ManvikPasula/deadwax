/**
 * Next's instrumentation hook: runs once per server process, before any request.
 *
 * The television original has no startup validation pass at all, so a missing variable
 * surfaces on the first request that happens to need it — which in practice means a member
 * discovers it, not the operator. This fails at boot instead.
 */
export async function register(): Promise<void> {
  const { assertEnv } = await import("./lib/env");
  assertEnv();
}

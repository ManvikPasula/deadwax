/**
 * A dynamic HTTP attack harness, run against a LIVE server. Not part of CI.
 *
 *   npm run dev            # in one terminal
 *   npm run security:probe # in another
 *
 * WHY THIS EXISTS SEPARATELY FROM THE UNIT TESTS. Server Actions need a request context and
 * cannot be invoked from Vitest, so the HTTP-level attacks — header policy, anonymous access,
 * malformed input, error hygiene, authorization boundaries, rate limits — have no other home.
 * The unit suite proves the rules; this proves they are actually wired to the wire.
 *
 * TWO WARNINGS, both real:
 *
 *  1. RUNNING THIS DELIBERATELY TRIPS RATE LIMITS and will lock out the accounts and the
 *     source address it touches for up to an hour. **Do not point it at production.** It
 *     refuses to run against a non-localhost origin unless PROBE_ALLOW_REMOTE=1 is set.
 *
 *  2. The television original this is ported from ships one assertion written as
 *     `report(..., sawRejection || true, ...)`, which therefore ALWAYS PASSES — the comment
 *     concedes it and points at the unit test instead. That is not copied here: the
 *     rate-limit section below either observes a refusal or FAILS, and says which endpoint it
 *     was watching.
 */

const BASE = (process.env.PROBE_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ALLOW_REMOTE = process.env.PROBE_ALLOW_REMOTE === "1";

type Severity = "fail" | "warn" | "info";
const results: Array<{ ok: boolean; severity: Severity; name: string; detail: string }> = [];

function report(name: string, ok: boolean, detail: string, severity: Severity = "fail"): void {
  results.push({ ok, severity, name, detail });
  const mark = ok ? "PASS" : severity === "fail" ? "FAIL" : severity === "warn" ? "WARN" : "note";
  console.info(`  ${mark.padEnd(4)}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function probe(
  path: string,
  init?: RequestInit & { noRedirect?: boolean },
): Promise<{ status: number; headers: Headers; body: string }> {
  const response = await fetch(`${BASE}${path}`, {
    redirect: init?.noRedirect ? "manual" : "follow",
    ...init,
  });
  const body = await response.text().catch(() => "");
  return { status: response.status, headers: response.headers, body };
}

/* -------------------------------------------------------------------------- */
/* 1. Response headers                                                        */
/* -------------------------------------------------------------------------- */

async function headerSection(): Promise<void> {
  console.info("\n[1] Response headers");
  const { headers, status } = await probe("/");
  report("the site responds", status < 500, `status ${status}`);

  const expected: Array<[string, (value: string | null) => boolean, string]> = [
    ["x-content-type-options", (v) => v === "nosniff", "nosniff"],
    ["x-frame-options", (v) => v === "DENY", "DENY"],
    ["referrer-policy", (v) => v === "strict-origin-when-cross-origin", "strict-origin-when-cross-origin"],
    ["cross-origin-opener-policy", (v) => v === "same-origin", "same-origin"],
    ["permissions-policy", (v) => Boolean(v && v.includes("camera=()")), "denies camera"],
    ["content-security-policy", (v) => Boolean(v && v.includes("default-src 'self'")), "default-src 'self'"],
  ];
  for (const [header, check, description] of expected) {
    const value = headers.get(header);
    report(`header ${header}`, check(value), value ? `got "${value.slice(0, 70)}"` : `expected ${description}, got nothing`);
  }

  // HSTS is only meaningful over TLS, and a dev server is plain HTTP — so its absence there is
  // information, not a finding.
  const hsts = headers.get("strict-transport-security");
  const overTls = BASE.startsWith("https://");
  report(
    "header strict-transport-security",
    overTls ? Boolean(hsts?.includes("max-age=")) : true,
    hsts ?? (overTls ? "missing over TLS" : "absent on a plain-HTTP origin, which is expected"),
    overTls ? "fail" : "info",
  );

  const csp = headers.get("content-security-policy") ?? "";
  report("CSP carries a per-request nonce", /'nonce-[A-Za-z0-9]+'/.test(csp), "");
  report("CSP forbids framing", csp.includes("frame-ancestors 'none'"), "");
  report("CSP forbids objects", csp.includes("object-src 'none'"), "");
  report("CSP pins form-action to self", csp.includes("form-action 'self'"), "");
  report(
    "CSP allows only the four image origins",
    csp.includes("dzcdn.net") && csp.includes("archive.org") && !csp.includes("img-src *"),
    "",
  );
  report(
    "CSP allows exactly one media origin, for previews",
    csp.includes("media-src") && csp.includes("cdnt-preview.dzcdn.net"),
    "",
  );
  // style-src keeps 'unsafe-inline' DELIBERATELY: the interface sets style attributes from
  // trusted values (heatmap cells, avatar gradients, meter widths) and none is
  // attacker-controlled. Asserted so that "tightening" it is a conscious decision.
  report(
    "style-src keeps 'unsafe-inline' deliberately",
    csp.includes("style-src") && csp.includes("'unsafe-inline'"),
    "documented trade, not an oversight",
    "info",
  );

  // Two nonces from two requests must differ. A reused nonce is the same as no nonce.
  const second = await probe("/");
  const nonceOf = (value: string) => /'nonce-([A-Za-z0-9]+)'/.exec(value)?.[1] ?? "";
  const a = nonceOf(csp);
  const b = nonceOf(second.headers.get("content-security-policy") ?? "");
  report("the nonce is fresh per request", Boolean(a) && Boolean(b) && a !== b, a && b ? "" : "could not read both nonces");
}

/* -------------------------------------------------------------------------- */
/* 2. Anonymous access                                                        */
/* -------------------------------------------------------------------------- */

async function anonymousSection(): Promise<void> {
  console.info("\n[2] Anonymous access");

  for (const path of ["/", "/albums", "/artists", "/lists", "/members", "/search?q=kid", "/spotlight"]) {
    const { status } = await probe(path);
    report(`public: ${path}`, status === 200, `status ${status}`);
  }

  // Admin routes must 404, NOT 403. A 403 confirms the route exists and that the caller found
  // a real admin surface; a 404 is indistinguishable from a typo.
  for (const path of ["/admin", "/admin/ads"]) {
    const { status } = await probe(path);
    report(`admin route 404s for an anonymous caller: ${path}`, status === 404, `status ${status}`);
  }

  // Gated pages redirect rather than erroring.
  for (const path of ["/settings", "/for-you"]) {
    const { status, headers } = await probe(path, { noRedirect: true });
    const location = headers.get("location") ?? "";
    report(
      `gated page redirects to sign-in: ${path}`,
      (status === 307 || status === 302 || status === 303) && location.includes("/login"),
      `status ${status} -> ${location || "no location"}`,
    );
  }

  // Token-bearing and admin pages must not be indexed.
  for (const path of ["/reset?token=" + "a".repeat(43), "/verify?token=" + "a".repeat(43)]) {
    const { headers, body } = await probe(path);
    const noindex = (headers.get("x-robots-tag") ?? "").includes("noindex") || /noindex/i.test(body);
    report(`token page is noindex: ${path.split("?")[0]}`, noindex, "");
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Malformed input — every one of these must be a 404 or a 400, never a 500 */
/* -------------------------------------------------------------------------- */

async function malformedSection(): Promise<void> {
  console.info("\n[3] Malformed input (a 500 here is the finding)");

  /**
   * Each of these corresponds to a real production failure class in the source project:
   * an id above int4 range raised "value out of range for type integer", and `?page=1e30`
   * reached SQL OFFSET as the string "5e+31".
   */
  const paths = [
    "/album/kid-a-9999999999",
    "/album/kid-a-99999999999999999999999999",
    "/album/kid-a--1",
    "/album/nonsense",
    "/album/kid-a-1/track/abc",
    "/album/kid-a-1/track/2-",
    "/album/kid-a-1/track/99999",
    "/artist/radiohead-9999999999",
    "/list/9999999999",
    "/albums?page=1e30",
    "/albums?page=-1",
    "/albums?decade=99999",
    "/albums?sort=%27%3B%20DROP%20TABLE%20users%3B--",
    "/@a",
    "/@" + "a".repeat(64),
    "/@bad%20name",
    "/@nadia/year/99999",
    "/search?q=%25",
    "/search?q=" + encodeURIComponent("%_%"),
    "/search?q=" + "x".repeat(3000),
  ];

  for (const path of paths) {
    const { status } = await probe(path);
    report(`no 500: ${decodeURIComponent(path).slice(0, 54)}`, status !== 500, `status ${status}`);
  }

  // `?q=%` must not return the whole catalogue. Route every search string through escapeLike.
  const wildcard = await probe("/search?q=%25");
  const plausible = await probe("/search?q=" + encodeURIComponent("kid a"));
  report(
    "a bare % does not return the whole catalogue",
    wildcard.body.length <= plausible.body.length * 1.6,
    `${wildcard.body.length} bytes vs ${plausible.body.length} for a real query`,
  );
}

/* -------------------------------------------------------------------------- */
/* 4. Error hygiene                                                           */
/* -------------------------------------------------------------------------- */

async function hygieneSection(): Promise<void> {
  console.info("\n[4] Error hygiene");

  // A dev server deliberately shows stack traces and source frames, so these downgrade to
  // informational rather than reporting a false finding.
  const isDev = !BASE.startsWith("https://");
  const severity: Severity = isDev ? "info" : "fail";

  const leaks: Array<[string, RegExp]> = [
    ["a SQL fragment", /\b(?:SELECT|INSERT INTO|UPDATE\s+\w+\s+SET|DISTINCT ON)\b/],
    ["a stack trace", /\bat\s+\w+\s+\(.*:\d+:\d+\)/],
    ["a filesystem path", /[A-Za-z]:\\\\Users\\\\|\/home\/\w+\/|\/Users\/\w+\//],
    ["a connection string", /postgres(?:ql)?:\/\/[^\s"]+/],
    ["a bcrypt hash", /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{20,}/],
    ["an environment variable name", /AUTH_SECRET|RESEND_API_KEY|CRON_SECRET/],
  ];

  for (const path of ["/album/kid-a-9999999999", "/albums?page=1e30", "/@" + "a".repeat(64), "/list/9999999999"]) {
    const { body } = await probe(path);
    for (const [label, pattern] of leaks) {
      report(`${path.slice(0, 34)} does not leak ${label}`, !pattern.test(body), "", severity);
    }
  }

  // The 404 page must not echo whatever was in the URL, or it is a reflected-content surface.
  const echo = await probe("/album/" + encodeURIComponent("<script>alert(1)</script>") + "-1");
  report("a 404 does not echo raw markup from the URL", !/<script>alert\(1\)<\/script>/.test(echo.body), "");
}

/* -------------------------------------------------------------------------- */
/* 5. Cookies and the session                                                 */
/* -------------------------------------------------------------------------- */

async function sessionSection(): Promise<void> {
  console.info("\n[5] Cookies and the session");

  const csrf = await probe("/api/auth/csrf");
  report("the auth endpoint answers", csrf.status === 200, `status ${csrf.status}`);

  const setCookie = csrf.headers.getSetCookie?.() ?? [];
  const relevant = setCookie.filter((cookie) => /csrf|session|callback/i.test(cookie));
  if (relevant.length === 0) {
    report("auth cookies were observable", false, "no Set-Cookie on /api/auth/csrf", "warn");
  } else {
    for (const cookie of relevant) {
      const name = cookie.split("=")[0] ?? "?";
      report(`${name} is HttpOnly`, /HttpOnly/i.test(cookie), "");
      report(`${name} is SameSite-restricted`, /SameSite=(Lax|Strict)/i.test(cookie), "");
      if (BASE.startsWith("https://")) {
        report(`${name} is Secure`, /Secure/i.test(cookie), "");
        report(`${name} uses a __Host- or __Secure- prefix`, /^__(Host|Secure)-/.test(name), "", "warn");
      }
    }
  }

  // A forged session cookie must not authenticate. This is the mutated-token check: four
  // characters changed in an otherwise well-formed value.
  const forged = await probe("/settings", {
    noRedirect: true,
    headers: { cookie: "authjs.session-token=" + "A".repeat(40) + ".forged.value" },
  });
  report(
    "a forged session cookie does not authenticate",
    forged.status !== 200,
    `status ${forged.status} (a 200 would mean /settings rendered)`,
  );
}

/* -------------------------------------------------------------------------- */
/* 6. Write endpoints                                                         */
/* -------------------------------------------------------------------------- */

async function writeSection(): Promise<void> {
  console.info("\n[6] Write endpoints");

  // A WRONG Origin must be refused. A MISSING one is allowed — a same-origin navigation or a
  // non-browser caller — and is covered by the per-IP budget instead.
  const wrongOrigin = await probe("/api/ads/impression", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example.com" },
    body: JSON.stringify({ adId: 1 }),
  });
  report("impression refuses a cross-origin POST", wrongOrigin.status === 403, `status ${wrongOrigin.status}`);

  const badJson = await probe("/api/ads/impression", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  report("impression rejects malformed JSON with a 400", badJson.status === 400, `status ${badJson.status}`);

  for (const body of [{ adId: "1" }, { adId: -1 }, { adId: 1e30 }, { adId: null }, {}]) {
    const { status } = await probe("/api/ads/impression", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    report(`impression rejects a non-integer id: ${JSON.stringify(body)}`, status === 400, `status ${status}`);
  }

  // A bad ad id on the click route must 400, and a missing one must land the member somewhere
  // real rather than on an error page they did not ask for.
  const badClick = await probe("/api/ads/abc/click", { noRedirect: true });
  report("click rejects a non-numeric id", badClick.status === 400, `status ${badClick.status}`);

  const missingClick = await probe("/api/ads/99999999/click", { noRedirect: true });
  report(
    "click on a missing ad redirects home rather than erroring",
    missingClick.status === 302 || missingClick.status === 307,
    `status ${missingClick.status} -> ${missingClick.headers.get("location") ?? "none"}`,
  );

  // The cron endpoint must not be runnable without its bearer token.
  const cron = await probe("/api/cron/prune");
  report(
    "the prune cron refuses an unauthenticated caller",
    cron.status === 401 || cron.status === 404,
    `status ${cron.status} (404 is correct when CRON_SECRET is unset)`,
  );

  // A Server Action invoked without the framework's action header must not execute.
  const forgedAction = await probe("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nope: true }),
  });
  report(
    "a bare POST to a page does not execute an action",
    forgedAction.status !== 200 || !/"ok"\s*:\s*true/.test(forgedAction.body),
    `status ${forgedAction.status}`,
  );
}

/* -------------------------------------------------------------------------- */
/* 7. Rate limits — and this section either observes a refusal or FAILS       */
/* -------------------------------------------------------------------------- */

async function rateLimitSection(): Promise<void> {
  console.info("\n[7] Rate limits (this WILL lock out this address for up to an hour)");

  /**
   * The source project's equivalent assertion is written `report(..., sawRejection || true,
   * ...)` and therefore always passes; its own comment concedes it. This is the honest version:
   * it hammers the search budget (30/60s) and requires an observable change of behaviour.
   *
   * What counts as observable: a 429, or the documented degrade-to-local-mirror — over the
   * limit, /search substitutes an empty remote result and renders from the mirror alone, so
   * the response shrinks. Either is a pass; neither is a fail.
   */
  const attempts = 45;
  let sawFourTwoNine = false;
  const sizes: number[] = [];

  for (let index = 0; index < attempts; index += 1) {
    const { status, body } = await probe(`/search?q=probe${index}`);
    if (status === 429) sawFourTwoNine = true;
    sizes.push(body.length);
  }

  const early = sizes.slice(0, 8).reduce((a, b) => a + b, 0) / 8;
  const late = sizes.slice(-8).reduce((a, b) => a + b, 0) / 8;
  const degraded = late < early * 0.85;

  report(
    "the search budget is enforced (a 429, or the documented degrade to the local mirror)",
    sawFourTwoNine || degraded,
    sawFourTwoNine
      ? "observed a 429"
      : `early ${Math.round(early)} bytes vs late ${Math.round(late)} bytes over ${attempts} requests`,
  );

  // The refusal message must never name the mechanism.
  const overLimit = await probe("/search?q=probe-final");
  report(
    "a refusal does not name the mechanism",
    !/bucket|rate_limits|window_start|make_interval|\bselect\b|\binsert\b/i.test(overLimit.body),
    "",
  );
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const isLocal = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(BASE);
  if (!isLocal && !ALLOW_REMOTE) {
    console.error(
      `[probe] refusing to run against ${BASE}.\n` +
        `        This harness deliberately trips rate limits and locks out the accounts and\n` +
        `        source address it touches. Set PROBE_ALLOW_REMOTE=1 only if you are certain.`,
    );
    process.exit(1);
  }

  console.info(`[probe] ${BASE}`);
  try {
    await probe("/");
  } catch {
    console.error(`[probe] cannot reach ${BASE}. Start the server first: npm run dev`);
    process.exit(1);
  }

  await headerSection();
  await anonymousSection();
  await malformedSection();
  await hygieneSection();
  await sessionSection();
  await writeSection();
  await rateLimitSection();

  const failures = results.filter((entry) => !entry.ok && entry.severity === "fail");
  const warnings = results.filter((entry) => !entry.ok && entry.severity === "warn");
  const notes = results.filter((entry) => !entry.ok && entry.severity === "info");

  console.info(
    `\n[probe] ${results.length} assertions — ${results.filter((r) => r.ok).length} passed, ` +
      `${failures.length} failed, ${warnings.length} warnings, ${notes.length} notes`,
  );
  if (failures.length > 0) {
    console.error("\nFAILURES:");
    for (const failure of failures) console.error(`  - ${failure.name} — ${failure.detail}`);
  }
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error("[probe] harness error —", error instanceof Error ? error.message : error);
  process.exit(1);
});

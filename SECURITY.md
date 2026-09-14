# Security

Deadwax inherits its security architecture from an adversarial audit of the project it was
ported from, which closed seventeen findings before that product was called done. This
document records the resulting controls, the risks that were accepted rather than closed, and
the invariants that must not be broken.

`docs/DECISIONS.md` §5 lists the ten known defects in the source implementation that were
fixed here rather than reproduced. Three of those were security-relevant and are marked below.

## Reporting

Open a private security advisory on the repository. Do not open a public issue for a
vulnerability.

## Authentication

- **Email and password only.** Auth.js v5 with the Credentials provider, JWT sessions, **no
  adapter** — there are zero Auth.js tables and no third-party account provisioning.
- **bcrypt cost 12** everywhere: registration, reset, the throwaway guest hash, and the dummy.
- **Passwords are bounded in BYTES, not characters** — `PASSWORD_MAX_BYTES = 72`, measured with
  `TextEncoder`. bcrypt truncates at 72 bytes, and `"é".repeat(72)` is 72 characters but 144
  bytes, so its first 36 characters would authenticate. Measuring a limit in a different unit
  from the limit it enforces was a HIGH finding in the source audit.
- **One password schema** is shared by sign-up, sign-in and the provider. Two copies of the
  same rule, expressed differently, created accounts that could never be signed into.
- **Every sign-in attempt runs exactly one bcrypt compare**, against a real `$2b$12$` dummy
  hash when the account does not exist. An early return on the not-found path turns the
  endpoint into an oracle for "does this person have an account here" — answerable in bulk
  against a breach list, with no failed-login trail on any account.
- **Both login budgets are consumed inside `authorize`, before the compare.** *(Fixes a source
  defect: there they live only in the Server Action, so a direct POST to
  `/api/auth/callback/credentials` reaches bcrypt with no budget consumed.)*
- **Sessions last 14 days** with a daily re-issue. These are stateless JWTs with no
  server-side revocation list, so the token's lifetime is the exposure window for a stolen
  cookie; the re-issue means a real user is not logged out while a stolen token still ages out.
- **Case-insensitive uniqueness is declared in the schema**, as functional unique indexes on
  `lower(username)` and `lower(email)` — not checked in a read-then-write. A unique index
  cannot lose that race; a SELECT-then-INSERT can, and when it did, one member's profile became
  unreachable.

## Authorization

- **Every mutation re-reads the account row.** A stateless JWT keeps asserting an identity
  after the row behind it is gone. Reads tolerate that; writes must not. `requireUser()` is
  also the single revocation point.
- **`role`, `plan` and `is_guest` are read from the database on every request, never from the
  session token.** The token copies are presentation only. Putting the role in the JWT for
  speed would mean revocation takes effect on token expiry rather than on the next request.
- **Privilege escalation is impossible by construction, not merely unimplemented.** No
  member-facing path writes `users.role` or `users.plan`; the only way to become an admin is an
  operator running `npm run admin:grant`, which needs database credentials. A **source-level
  test** asserts that only `app/actions/admin.ts` and `scripts/grant-admin.ts` may write those
  columns, so a future action fails a test instead of quietly shipping escalation.
- **Privileged queries self-gate.** `listAccounts` and the ad reads call `requireAdmin()`
  themselves rather than trusting their caller: these return email addresses and revenue
  counters, so a page that forgot the check would be a disclosure bug. Making the query refuse
  is the difference between one mistake and a breach.
- **Admin routes 404 for non-admins, not 403.** A 403 confirms the route exists and that they
  found a real admin surface; a 404 is indistinguishable from a typo.
- **Existence is not visibility.** One shared `assertVisibleTarget` guards every write into a
  container: a log needs existence only, a list must exist *and* be public or owned.
- **Privacy checks are duplicated in `generateMetadata` and the page body.** Two entry points
  into one route with the check on only one of them is how a private list's `<title>` and
  `<meta description>` leaked while its body correctly 404'd. Any new entry point — an OG image
  route, an RSS feed, an API handler — needs the same check.
- **`proxy.ts` protects no route.** It sets headers and mints a CSP nonce. Every authorization
  decision happens inside the page or the action. This matches the framework's own guidance,
  and it means a matcher regex added in the belief that it gates routes would ship an
  unprotected app.

## Input handling

- **One shared Zod schema library.** Validation lives in one module rather than beside each
  action, because two of the source audit's findings came from copies drifting apart.
- **`calendarDate` has five layers**: a shape regex, a round-trip `Date` check (which is what
  rejects `2026-02-30`), an explicit rejection of the Postgres date literals, a lower bound,
  and an upper bound. The third layer is the important one: **Postgres accepts `infinity`,
  `-infinity`, `now`, `today` and `epoch` as valid dates**, and one stored `infinity` made
  `EXTRACT(YEAR FROM listened_on)` throw on a member's public diary and year pages **for every
  visitor, permanently, with no way to undo it from the interface**. The read side keeps a
  defensive `BETWEEN '1900-01-01' AND '2200-01-01'` as well.
- **Every route id is bounded, and the digit-length check precedes `Number()`** so a 30-digit
  segment cannot round to something valid. An id above the `integer` ceiling used to raise
  "value out of range for type integer" — a 500 where a 404 belongs. Parsers return `null` so
  the caller can 404; only page numbers clamp.
- **All search text goes through `escapeLike`.** A raw `%` matched every row: `?q=%` returned
  the whole catalogue and the entire member list.
- **Tags are normalised before they are measured.** `İ` (U+0130) lowercases to two code units,
  so a 17-character tag became a 33-character value and overflowed `varchar(32)` at insert.
- **A write only touches the columns it was given.** `undefined` means leave alone; an explicit
  `null` clears. The source audit's only CRITICAL finding was a write API that expressed
  "replace" where callers meant "patch", so clicking Like or a star on an album you had
  reviewed destroyed your own review, diary date, flags and every tag. The paired half: any
  control that saves must be primed from the real row, never from blanks — which is why the log
  dialog's `initial` prop is **required, not optional**. *(The source ships one route that
  omits it, reopening the same data loss.)*
- **A log's target is verified to exist in the mirror before the write.** Without it, a crafted
  call publishes a review of a track that does not exist, which renders on the album page,
  links to a 404, and inflates the author's public totals.

## Rate limiting

Fifteen fixed-window budgets in one Postgres table, checked with one statement. Kept in
Postgres on purpose: an in-process counter is per-instance, and serverless runs many
instances, so an attacker spreading requests across them would face no limit at all.

- **Two limits per auth flow — one keyed by the subject, one by the source** — because the two
  attacks look different. Both are counted **before bcrypt runs**, so a flood cannot be used to
  burn CPU either.
- **The limiter is inside `guard()`, not in each action**, so a new action cannot be written
  without one. Per-endpoint limits are the kind of control that gets forgotten exactly once.
- **It fails open.** A rate limiter that takes the whole site down when Postgres hiccups trades
  a small risk for a large one; the controls that must fail closed are the authorization
  checks, not this. **Corollary: the limiter is no defence against an attacker who can also
  degrade the database.**
- **Fixed windows admit up to 2× a limit across a boundary.** Accepted, and the limits are set
  with that doubling in mind — so do not "tighten" one by halving it.
- **One platform-wide outbound budget per provider**, because the provider relationship is the
  scarce resource: being throttled takes the catalogue down for everyone.
- **`rate_limits` is pruned by a scheduled job.** *(Fixes a source defect: there nothing
  schedules the prune, so the table grows by distinct `(bucket, identity)` pairs forever —
  including every email address ever tried at sign-in, which makes it a list of email addresses
  and therefore a data-retention question as well as a disk one.)*

## Tokens and mail

- **Only the SHA-256 of a link token is stored.** A database leak yields nothing redeemable.
  SHA-256 rather than a slow KDF because the token is 256 bits of CSPRNG output, so there is
  nothing to brute force.
- **Verification 60 minutes, password reset 30.** A confirmation link only proves an address; a
  reset link takes over an account, so the interval in which a leaked mailbox is dangerous
  should be as small as is still usable.
- **Every refusal returns one identical reason.** Bad shape, no row, already consumed, expired,
  account gone and email mismatch all answer the same way, because distinguishing them tells a
  guesser which tokens were real.
- **Issuing or redeeming retires every outstanding token for that user in the same
  transaction.**
- **A reset request always answers identically** — even for an unparseable address, even when
  rate-limited by email. The only branch that returns a failure is the per-IP limit, because a
  form that says "no account with that address" is a membership oracle answerable in bulk.
- **Verification is redeemed on a button press by a signed-in member, never on page load.**
  Mail clients and security scanners follow links automatically, which would burn a single-use
  token before the member clicked it. It additionally requires the token to belong to the
  signed-in account.
- **Mail is a closed catalogue.** Callers choose from a fixed set of messages; no caller
  supplies headers, a sender, or raw HTML, which removes header injection and template
  injection as a class rather than filtering for them. Recipients come from the database, never
  from a request. `assertSingleLine` is defence in depth on top of that.
- **An admin-triggered reset does not change the password**, so an admin cannot take over an
  account without the owner's mailbox. That is why there is no "set a new password for this
  member" button anywhere.

## Browser hardening

Set per request by `proxy.ts`: HSTS (`max-age=63072000; includeSubDomains; preload`),
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a
`Permissions-Policy` denying eight features, `X-Frame-Options: DENY`,
`Cross-Origin-Opener-Policy: same-origin`, and a CSP with a **fresh per-request nonce** — a
reused nonce is the same as no nonce.

- `img-src` allows exactly four origins. `*.archive.org` is required because the Cover Art
  Archive 302-redirects there, and the node is not stable.
- `media-src` allows exactly one origin, for the 30-second track previews.
- `font-src 'self'` — which is why the fonts **must** come through `next/font` and not a
  stylesheet link.
- **`style-src` keeps `'unsafe-inline'` deliberately.** The interface sets style attributes from
  trusted values — heatmap cell colours, avatar gradients, meter widths — and none of it is
  attacker-controlled. Blocking them would break the UI without closing a real attack path.
- **There are no third-party browser scripts of any kind.** No analytics, no tag manager, no
  CDN script, no chat widget. House ads are first-party rows with no image column, which is why
  the CSP needs no holes cut in it — a headline and a line of copy cannot carry a tracking
  pixel.

## Logging

`safeErrorDetail` whitelists exactly four fields: `name`, `message`, `code`, `constraint`. Do
not add `stack`, `query`, `parameters` or `detail`. Driver errors carry the failing SQL and,
depending on the driver, its bound parameters — which for this app means review bodies, email
addresses, and password hashes. Logs are not a safe place for any of that, and hosted logs are
readable by anyone with project access.

Error messages returned to a caller are flat. A non-admin gets the same refusal as a signed-out
visitor: no hint about what the action was, or that they were close to reaching it.

## Privacy by construction

- **Ad statistics are one row per ad per day, never one row per impression.** An advertiser
  needs a daily curve; nobody needs a log of which member saw which ad. The impression endpoint
  reads no session and sets no cookie, which is what makes it uninteresting to attack — the
  worst outcome is an inflated number in a report. A test asserts the daily row's keys do not
  include a user id.
- **There is no image upload anywhere.** Avatars are computed gradients. No bucket, no
  host allowlist for user content, no review process for what those hosts serve.
- **Guests never appear on a public surface.** Every public aggregate filters
  `users.is_guest = false`. There is no database-level guard, so this is an invariant a new
  aggregate must honour.
- **The wantlist has a privacy flag.** *(The source has none, so `/@anyone/watchlist` is fully
  public to signed-out visitors.)*

## Accepted residual risks

Documented, not overlooked.

- **No individually revocable sessions.** A stolen cookie is valid for up to 14 days, and a
  password reset does **not** invalidate existing sessions — the JWTs carry no `jti` or version
  claim, so the only global revocation is rotating `AUTH_SECRET`.
- **Registration confirms that an email address is already taken.** The generic alternative
  needs a notification email to be usable at all, and the 5/hour sign-up budget bounds
  enumeration.
- **Fixed-window limiters admit 2× bursts across a boundary.** See above.
- **`x-forwarded-for` is trusted.** It is only trustworthy behind a proxy that overwrites it.
  Off such a platform, every per-IP budget is bypassable with one header, and
  `clientAddress()` would need to change with the deployment.
- **The rate limiter fails open.**
- **The audit trail is append-only by convention, not by enforcement.** No trigger, no `REVOKE
  UPDATE/DELETE`, no hash chain. Anyone with database credentials can rewrite history — and
  database credentials are also the grant mechanism, so the operator is fully trusted by
  construction.
- **Seeded demo accounts share a published password.** Do not seed a production instance you
  care about without changing it.
- **Comments cannot be liked and logs have no privacy flag.** If private logs are ever added,
  `assertVisibleTarget` is the single place that must learn about it.
- **No external penetration test.**

## Verified clean

Useful as a checklist rather than as a claim about the future:

- **Injection** — every query is Drizzle with bound parameters. The one `sql.raw` interpolates
  a column name from a two-valued literal.
- **XSS** — no `dangerouslySetInnerHTML`, no markdown renderer. All member text renders as
  escaped JSX children.
- **Secrets** — no credential in the git history (gitleaks runs over full history in CI). The
  catalogue needs no credential at all.
- **CSRF** — the framework validates Origin against Host for every Server Action, Auth.js adds
  its own token, and no state-changing GET exists except the ad click redirect, which is a
  deliberate documented trade: a click has to survive being middle-clicked, and the write is a
  single increment with no other effect.
- **Open redirect** — the ad click destination comes from the row, never from the query string,
  and the stored URL is re-tested against `^https?://` before it is returned. `?next=` on the
  auth routes is allowlisted to a same-site path shape.
- **SSRF** — only paths are interpolated into provider URLs; every parameter goes through
  `searchParams.set`.
- **File upload, webhooks, payments** — none exist.

# Deadwax — Task Checklist

The executable form of `PLAN.md`, updated as built. Invariant references (`I-n`) point at §19 of
`ARCHITECTURE_AND_REPLICATION_BRIEF.md`; defect references (`D-n`) point at its §20.6.

**Status: phases 0–14 complete except the two hosted-deployment steps that require account
access — see the end of this file.** Every route, component and script exists; everything below
has been run, not just written.

Verification at time of writing:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` (`--max-warnings 0`) | clean |
| `npm test` | **354 tests green across 16 suites** |
| `npm run build` | succeeds; **39 route entries**, all server-rendered on demand bar `/icon.svg` |
| `npm run smoke` | **68/68** against PGlite **and 68/68 against hosted Neon Postgres** |
| `npm run security:probe` (live dev server, hosted database) | **94 assertions, 91 passed, 0 failed, 0 warnings, 3 notes** |
| `GET /api/cron/prune` with a real secret | 200, all five sweeps executed on genuine Postgres |
| `npm run taste-eval` | 36 distinct titles across 54 slots, 1 of 10 personas correctly withheld |

The three probe notes are stack-trace checks that are informational on a development server by
design — Next serves overlays there and not in production.

---

## Phase 0 — Decisions
- [x] `docs/DECISIONS.md` — all five §20.1 questions answered with reasoning and rejected alternatives, plus §5a recording every finding that came from measuring rather than reasoning
- [x] `docs/ARCHITECTURE.md` — schema, providers, algorithms, constants, routes
- [x] `docs/PLAN.md` — phases, gates, deviations, risks
- [x] `docs/TASKS.md` — this file

## Phase 1 — Skeleton, schema, dual-driver switch
- [x] `package.json`, `tsconfig.json`, `next.config.ts` (4 remote patterns), `eslint.config.mjs`, `postcss.config.mjs`, `.gitignore`, `.env.example`, `drizzle.config.ts`, `vitest.config.mts`
- [x] `lib/env.ts` — getters, `required()` rejecting `""`, plus `assertEnv()`
- [x] `instrumentation.ts` — the startup validation pass the source lacks
- [x] `lib/db/index.ts` — lazy `Proxy`, `globalThis` memoisation, `DATABASE_URL`-or-PGlite, TLS on unless `sslmode=disable` (I-37)
- [x] `lib/db/schema.ts` — 22 tables, 7 `logs` indexes, the `list_items` COALESCE expression unique index, functional `lower()` unique indexes
- [x] `drizzle/0000_init.sql` — 22 tables, 28 cascading FKs, exactly 1 SET NULL
- [x] `scripts/migrate-deploy.ts`, `scripts/db-local.ts` (refuses to run with `DATABASE_URL` set), `scripts/db-reset.ts` (honours `PGLITE_DATA_DIR`, unlike the source)
- [x] `tests/stubs/{server-only,next-cache}.ts`
- [x] **Gate met:** `db:local` prints 22 tables; `build` succeeds with no `DATABASE_URL`

## Phase 2 — Providers, mappers, ingest, slugs
- [x] `lib/providers/errors.ts`, `deezer/{client,index,mappers,types}.ts`, `musicbrainz/{index,mappers}.ts`, `lastfm/index.ts`, `images.ts`
- [x] Deezer client: budget first, `undefined` params skipped, **in-200-body error detection**, `Retry-After` honoured once, 200-char truncation, throwing/optional split with the written rule
- [x] MusicBrainz: serialising queue ≥1100 ms, `User-Agent` from the site URL, **three outcomes (`found`/`absent`/`unavailable`) so a 503 is never cached**, one retry
- [x] `lib/canonical.ts` — `isCanonicalRelease`, `albumIdentity`, `hasTitleNoise`
- [x] `lib/slug.ts` — `slugify`, `parseIdSlug` (length check **before** `Number()`), `parseBoundedInt`, `parsePage`, **`parseTrackLocator` + `trackLocator`**, `MAX_DB_INT` declared once
- [x] `lib/listen.ts` — deterministic deeplinks, zero API calls
- [x] `lib/ingest/albums.ts` — `ensureArtist`/`ensureAlbum`/`ensureDiscography`, `cacheAlbumSummaries` (dedupe in JS first, I-7), derived-columns SQL, MusicBrainz enrichment, `ensureArtistSimilar`
- [x] `lib/view.ts` — card adapters
- [x] `tests/fixtures/*.json` — 16 captured real payloads
- [x] `tests/{mappers,slug,canonical,listen,bounds}.test.ts`
- [x] **Gate met:** `ensureAlbum("302127")` mirrors *Discovery* with 14 tracks and a `duration_ms` matching Deezer's own figure

## Phase 3 — Rating maths
- [x] `lib/ratings.ts` — branded `Stored`/`Stars`, four transforms, ten-bucket histograms, seven brackets, `ratingColor`/`bracketLegend`
- [x] `lib/ratings/dual.ts`, `lib/like.ts`, `lib/format.ts`, `lib/utils.ts`
- [x] `components/rating/{stars,star-input,histogram,dual-rating,consensus,bracket-legend}.tsx`
- [x] `tests/ratings.test.ts` — incl. the hue-not-brightness regression and the `mbRatingToStored` scale bridge

## Phase 4 — Auth, security, the action contract
- [x] `lib/security/{rate-limit,schemas,tokens}.ts`, `lib/username.ts`
- [x] `lib/auth/{index,session,admin}.ts` — **both login budgets consumed inside `authorize`** (D-6)
- [x] `app/actions/result.ts` — `guard()`, `safeErrorDetail` (4 fields), `VERIFICATION_EXEMPT` typed as `Set<ActionLabel>`
- [x] `proxy.ts` — nonce on request and response, CSP with `media-src` and `*.archive.org`, gates nothing
- [x] `lib/email/index.ts` — closed message catalogue, Resend-or-log
- [x] `tests/security.test.ts` (24), `tests/no-escalation.test.ts` (8)

## Phase 5 — The core loop
- [x] `lib/db/queries/logs.ts` — `LogEntry`, correlated counts, one-query tags
- [x] `app/actions/logs.ts` — `saveLog` six-step authorization, patch semantics (I-1), one transaction (I-32), release-date gate; `markDiscographyListened` in **one** `guard()` (D-5)
- [x] `components/album/*` — `log-dialog.tsx` with **`initial` required, not optional** (D-1)
- [x] Content routes with `notFound()` before anything streams (I-3)

## Phase 6 — Aggregates, consensus, the heatmaps
- [x] Six `DISTINCT ON` variants, each with `(rating IS NOT NULL) DESC` (I-11) and `u.is_guest = false` (I-12)
- [x] `components/rating/consensus.tsx` — the zero-votes collapse rather than a greyed zero
- [x] `components/artist/discography-heatmap.tsx` + `components/album/track-strip.tsx`
- [x] `tests/aggregates.test.ts` (23) — all three invariants
- [x] **Gate met:** histogram buckets sum to the rating count; heatmap renders 12 rows / 153 cells on seeded data

## Phase 7 — Guest mode and onboarding
- [x] `lib/auth/guest.ts` — `GUEST_NUDGE_AFTER` on **distinct albums**, not log rows
- [x] `lib/auth/claim.ts` — Path A (`is_guest = true` inside the UPDATE, I-30), Path B (one transaction, **`desert_island` merged respecting the quota**, I-36)
- [x] `components/auth/{guest-strip,guest-banner,guest-start}.tsx` — hidden not unmounted
- [x] `app/start/page.tsx` — **guest-gated**, fixing a source defect
- [x] `tests/guest.test.ts` (17)

## Phase 8 — Verification and reset
- [x] `lib/auth/password-reset.ts`, `app/actions/{verification,password}.ts`
- [x] `app/{verify,forgot,reset}/page.tsx` — `noindex`, `no-referrer`, confirmation on a button press (I-28)
- [x] `tests/password-reset.test.ts` (20) — incl. all five refusals returning one byte-identical value

## Phase 9 — Social
- [x] `lib/db/queries/users.ts` — batched `getMemberCardStats` (D-3), parenthesised OR (I-13)
- [x] `app/actions/social.ts` — `assertVisibleTarget` (I-16), followee existence and not-a-guest checks added
- [x] `components/social/*` — `RUN_THRESHOLD = 5`, day grouping on the member's local date
- [x] `app/log/[id]/page.tsx` (D-2)

## Phase 10 — Lists, collections, stats
- [x] `lib/db/queries/lists.ts` — polymorphic membership, one-query mosaic
- [x] `app/actions/{lists,collections}.ts` + `app/list/[slug]/edit` (D-8)
- [x] `lib/stats/profile.ts` — React `cache()` (D-4), `clampListened`
- [x] `lib/stats/year.ts` — `listened_on` scoping, the `BETWEEN` guard (I-4), always twelve months
- [x] `components/year/year-charts.tsx` — CSS only, stars not `/10` (D+b)
- [x] Profile routes; `wantlist_private` honoured in both entry points (D-9)

## Phase 11 — Desert Island
- [x] `lib/desert-island/index.ts` — rating gate outside the transaction, count-then-insert inside one (I-29), idempotence **before** the quota
- [x] `components/album/desert-island-button.tsx` — disabled not hidden when exhausted
- [x] `tests/desert-island.test.ts` (13) — all seven boundary cases

## Phase 12 — The recommender (harness first)
- [x] `scripts/taste-eval.ts` + ten adversarial personas under `@taste.test`
- [x] `lib/taste/{shared,profile,recommend,tracks}.ts` — prior weight **40**, three axes, coarse-only absence penalties, `DETAIL_SYNC_LIMIT = 8` sequential
- [x] `app/for-you/page.tsx` — three gates, the 90% ceiling verbatim, **two** reasons rendered
- [x] `tests/taste.test.ts` (37) — property tests only
- [x] **Gate met:** 36 distinct titles across 54 slots; the no-variety gate fires on the flat rater and on nobody else

## Phase 13 — Admin and ads
- [x] `lib/db/queries/{admin,ads}.ts` — **both self-gating** (I-20), fixing the source's non-uniformity
- [x] `app/actions/{admin,ads}.ts` — `expectedUsername` staleness, transactional audit in both
- [x] `lib/ads/{plan,serve}.ts`
- [x] `app/api/ads/{impression,[id]/click}/route.ts`
- [x] `components/ads/*`, `components/admin/*`, `app/admin/*` — 404 not 403 (I-21), `ForbiddenError`/`UnauthorizedError` converted and **everything else rethrown**
- [x] `AdSlot` wired into all five serving surfaces — `/` (`home` signed out, `feed` signed in), `/album/[slug]`, `/artist/[slug]`, `/@[username]`; `/spotlight` bypasses the ceiling and the Pro exemption on purpose
- [x] `tests/ads.test.ts` (25) + `tests/ads-serve.test.ts` (13)
- [x] `scripts/grant-admin.ts`

## Phase 14 — Seed, verify, ship
- [x] `scripts/seed.ts` — 6 members, 37 catalogue albums expanding to 189 mirrored, five idempotency keys
- [x] `scripts/smoke.ts` — 68 checks incl. the histogram sum, `monthly.length === 12`, and the `critic_score` scale assertion
- [x] `app/api/cron/prune/route.ts` (bearer `CRON_SECRET`, **404 when unset**) + `lib/db/queries/prune.ts` + `vercel.json` (D-10)
- [x] `tests/prune.test.ts` (15) — every sweep against real Postgres, **every assertion paired** with something that must survive it
- [x] `scripts/security-probe.ts` — **with the source's always-passing assertion fixed rather than copied**
- [x] `README.md`, `SECURITY.md`, `AGENTS.md`/`CLAUDE.md`, `.github/workflows/ci.yml`
- [x] `npm run typecheck && npm run lint && npm test` green
- [x] `git init`, GitHub repo, push — <https://github.com/ManvikPasula/deadwax>
- [x] Vercel project created

### Deploying — one interactive step is left

**The database is provisioned, migrated and seeded.** It is a Neon Lakebase Postgres created
through the claimable-database flow, which needs no signup and no API key:

```powershell
npx neon@latest claim create --service postgres --file .env.local
```

That wrote `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and `NEON_BRANCH` into `.env.local` beside
the existing `AUTH_SECRET`, and `CRON_SECRET` was generated locally alongside them. The
migrations were then applied over the **pooled** endpoint with `rejectUnauthorized: true`,
which is the first real exercise of the hosted branch of the dual-driver switch — until then
only PGlite had ever run these migrations.

**It is unclaimed, and that is the one thing with a clock on it.** An unclaimed project lives
**72 hours**, is capped at 100 MB of storage and 1 GB of transfer, and then disappears.
Claiming transfers it into your own Neon account and removes all three limits:

```powershell
npx neon@latest claim accept          # opens a browser; sign in, pick a destination
npx neon@latest claim status          # state, and the expiry to beat
```

Run that before the deadline printed by `claim status`. Nothing about the connection string
changes when you claim it, so anything already deployed keeps working.

**The remaining step is `vercel login`.** It opens a browser and waits for a confirmation, so
it is interactive by construction — there is no flag that makes it otherwise, and a token
pasted into a terminal is a credential in a shell history. Everything after it is scripted:

```powershell
# In a real PowerShell window, not through an agent: the CLI flips to --non-interactive when it
# detects one, and the account picker needs arrow keys. `vercel` is not necessarily on PATH —
# the npm global prefix here is D:
pm-global.
D:
pm-globalercel.cmd login

npm run vercel:setup         # link, push the three variables, deploy to production
```

`scripts/vercel-setup.mjs` reads the values from `.env.local` rather than asking you to retype
them — the connection string is a hundred-odd characters with a password in it, and the failure
mode of one mistyped character is a deployment that builds cleanly and 500s on every page. It
pushes exactly `DATABASE_URL`, `AUTH_SECRET` and `CRON_SECRET`, to both production and preview,
and the script's docblock lists every variable it deliberately leaves behind and why. The most
important omission: `NEXT_PUBLIC_SITE_URL` is `http://localhost:3000` locally and `env.siteUrl`
already falls back to `VERCEL_PROJECT_PRODUCTION_URL`, so pushing it would replace a correct
answer with one that points every verification email at your laptop.

Then verify against the live instance:

```powershell
# PowerShell has no inline env-var prefix — `VAR=x cmd` is a parse error, not an env-prefixed
# run, and it fails quietly enough to look like the tool is broken. Assign, then call.
npm run smoke                       # reads .env.local, so this is the hosted database

$env:PROBE_BASE_URL   = "https://<domain>"
$env:PROBE_ALLOW_REMOTE = "1"
npm run security:probe              # 94 assertions

npm run admin:grant -- you@example.com   # DATABASE_URL comes from .env.local; needed for /admin
```

`npm run smoke` reads `.env.local`, so with `DATABASE_URL` set it now targets Neon rather than
PGlite — that is the step that proves the dual-driver architecture is actually dual, and it is
the reason that script asserts rows rather than printing them. The probe over HTTPS additionally
exercises the two assertions a plain-HTTP origin cannot: `Strict-Transport-Security` and the
`Secure` cookie flag. `admin:grant` takes the **email address**, matched through the same
`lower()` expression as the functional unique index, and is the only writer of `users.role`
outside `app/actions/admin.ts`.

**To go back to local PGlite**, comment out `DATABASE_URL` in `.env.local`. `npm run db:local`
refuses to run while it is set, which is the guard that stops a "local" command from touching
the hosted database. `npm test` is safe either way: every database-backed suite deletes
`process.env.DATABASE_URL` in `beforeAll` before importing `@/lib/db`, and that line must never
be removed.

### Two notes on what could not be done from here

**The Vercel MCP surface creates projects it cannot read back.** `create_git_project` returned a
real project id for `deadwax-web` (`prj_Z81DscqkfS7c1UXgxXcmXhd8fgHc`) and then failed to verify
its own git link with a 404. `list_projects` for the account's only team returns `[]` — and it
404s on `cliffhanger` (`prj_SzEK7KsarPK4vNK7pePW5jy8qY0R`), a long-standing project in that team
that is live right now, so this is not new-project propagation. Its write scope and its read
scope are not the same scope, so it cannot set an environment variable or confirm a link. Three
projects exist as a result — `deadwax`, `deadwax-app` (`prj_AzCyWAteApJ088GscNUL5n3nSzzd`) and
`deadwax-web`. Keep whichever the dashboard shows linked to `ManvikPasula/deadwax` and delete
the other two; `npm run vercel:setup <name>` takes the name as its one argument.

**`vercel deploy --temporary` needs no login but builds locally, and a local build cannot
complete on this machine.** Vercel's build output deduplicates identical serverless functions
with symlinks, and symlink creation is denied to a non-elevated Windows process here —
confirmed directly rather than inferred from the error: `New-Item -ItemType SymbolicLink` fails
with *"Administrator privilege required"* on both `C:` and `D:`, so Developer Mode is off. This
does not affect `npm run vercel:setup`, which uses a plain `vercel deploy` and builds on
Vercel's own Linux builders.

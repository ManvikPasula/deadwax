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

## Deployed

**<https://deadwax-web.vercel.app>**

Vercel project `deadwax-web` in `manvik-pasulas-projects`, database `neon-camel-drawer` —
Neon Lakebase Postgres on the free plan, region `iad1`, provisioned through the Vercel
Marketplace and connected to production, preview and development. Migrated and seeded:
**191 artists, 288 albums, 1234 tracks, 1864 logs, 55 albums with MusicBrainz critic votes.**

| Verified against the live instance | Result |
| --- | --- |
| `npm run smoke` | **68/68**, `driver: Postgres (hosted)` |
| the scale bridge on real data | 55 albums, range **6.0–10.0** — above 5, so MusicBrainz's 0–5 was doubled exactly once |
| `/` `/albums` `/artists` `/lists` `/members` `/spotlight` | 200, each rendering seeded rows |
| `/admin` `/admin/ads` | **404** to an anonymous caller (I-21) |
| `GET /api/cron/prune` | 404 unauthenticated; **200 with the secret**, all five sweeps run |
| response headers | all seven, **including HSTS** — the one assertion a plain-HTTP origin cannot exercise |

```powershell
npm run vercel:setup        # link, push AUTH_SECRET + CRON_SECRET, deploy to production
npm run smoke               # reads .env.local, so this is the hosted database
```

`DATABASE_URL` is **not** pushed by that script any more and must not be: the Marketplace
integration injects it into all three environments itself, so Vercel owns the value, it exists
everywhere at once, and a credential rotation needs no script re-run. A manually-pushed copy
would shadow the integration's and go stale silently.

### How the database got here, including the wrong turn

The first attempt used Neon's **claimable** flow, which needs no signup and no API key:

```powershell
npx neon@latest claim create --service postgres --file .env.local
```

That worked, and migrating and seeding over it was the first real exercise of the hosted branch
of the dual-driver switch — until then only PGlite had ever run these migrations. **But a
claimable project cannot be claimed into a Vercel-managed Neon organisation, which is what this
account has**, so it had a 72-hour clock and no way to stop it. Worse, the attempt to claim it
left the project in a `pending` state, and **a pending claim revokes database access** and
permits nothing but status polling.

That produced a production build failure worth recording, because the first diagnosis was
wrong:

```
[migrate] FAILED —
  Error: Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"
  caused by:   error: password authentication failed for user 'neondb_owner'  code=28P01
```

The inference was that the script's `vercel env add` had corrupted the password on its way
through `cmd.exe` — plausible, since the string was structurally intact and wrong only in the
bytes nobody can see. Removing the shell **did not fix it.** What identified the real cause was
the cheap test: run the same connection string locally, where it had worked an hour earlier,
and watch it fail identically. The credential, not the transport.

Two things were kept from that detour on their own merits:

- `scripts/migrate-deploy.ts` now prints the **cause chain**, not just `error.message`. Drizzle
  wraps every driver error, the migrator's first statement is that `CREATE SCHEMA`, and so a
  connection failure, a permissions failure and a genuine SQL failure all used to print the
  same line — which was the entire content of a failed production build. The fields printed are
  the `safeErrorDetail` whitelist (I-35): never `query`, `parameters` or `stack`, because build
  logs are readable by anyone with project access.
- `scripts/vercel-setup.mjs` runs the CLI's own JS entry under this Node instead of the `.cmd`
  shim through a shell, which gives a clean argv and stdin everywhere. Its docblock says
  explicitly that this was **not** the bug, because a comment claiming a fix that was never
  demonstrated is how the next person stops looking.

### The bits that still need a person

- **`vercel login`** was, and remains, the one interactive step. Run it in a real terminal
  window: the CLI defaults to `--non-interactive` when it detects an agent, and its account
  picker needs arrow keys.
- **Three Vercel projects exist**, all git-linked to the same repository, so every push builds
  three times. `deadwax-web` is the live one; `deadwax` and `deadwax-app`
  (`prj_AzCyWAteApJ088GscNUL5n3nSzzd`) were created by MCP calls that could not read their own
  results, and deleting them is a dashboard click.
- **`npm run admin:grant -- you@example.com`** is the only way to reach `/admin`, and it takes
  the email address rather than the username.
- **The dead claimable project** `billowing-water-90138651` is stuck in `pending` and expires on
  its own on 2026-09-18. `npx neon@latest claim delete` can drop the local record early.

### Going back to local PGlite

Comment out `DATABASE_URL` in `.env.local`. `npm run db:local` refuses to run while it is set,
which is the guard that stops a "local" command touching the hosted database. `npm test` is
safe either way: every database-backed suite deletes `process.env.DATABASE_URL` in `beforeAll`
before importing `@/lib/db`, and that line must never be removed.

Note that the Vercel CLI rewrites `.env.local` with **quoted** values when it pulls. Anything
reading that file with a naive `cut -d=` gets the quotes too — which is how a correct
`CRON_SECRET` produced a 404 from the cron route for several minutes.

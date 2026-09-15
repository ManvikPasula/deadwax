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
| `npm run smoke` | **68/68** against PGlite |
| `npm run security:probe` (live dev server) | **94 assertions, 91 passed, 0 failed, 0 warnings, 3 notes** |
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

### The two steps that need account access

Everything above is done and verified locally. These two cannot be completed from here, and
both are stated plainly rather than guessed at:

1. **A hosted Postgres `DATABASE_URL`.** The app runs on PGlite locally with zero
   configuration, but PGlite writes to the local filesystem and allows one writer, so it
   cannot back a serverless deployment. Provisioning a database requires an interactive
   signup (Vercel Marketplace → Neon, or Neon/Supabase directly), which is not reachable
   from here. The free tiers are sufficient.

2. **Vercel CLI authentication.** A `vercel` CLI is installed but its stored token is
   rejected, and `vercel login` is interactive. The Vercel MCP surface available here can
   *create* projects but its reads return 404 for them, so it cannot verify a git link or set
   environment variables.

Once those exist the remaining sequence is mechanical, and the build already runs migrations
itself:

```bash
vercel login
vercel link --project deadwax-app
vercel env add DATABASE_URL production     # the connection string
vercel env add AUTH_SECRET production      # openssl rand -base64 32
vercel env add CRON_SECRET production      # openssl rand -hex 32
vercel deploy --prod                       # migrations run inside the build

# then seed the hosted database once
DATABASE_URL=<the connection string> npm run seed
DATABASE_URL=<the connection string> npm run smoke   # 68 checks against hosted Postgres
```

`npm run smoke` against the hosted URL is the step that proves the dual-driver architecture is
actually dual — it is the reason that script asserts rows rather than printing them.

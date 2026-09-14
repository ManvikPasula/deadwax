# Deadwax — Task Checklist

The executable form of `PLAN.md`. Checked off as built. Invariant references (`I-n`) point at
§19 of `ARCHITECTURE_AND_REPLICATION_BRIEF.md`; defect references (`D-n`) point at §20.6.

---

## Phase 0 — Decisions
- [x] `docs/DECISIONS.md` — all five §20.1 questions answered with reasoning and rejected alternatives
- [x] `docs/ARCHITECTURE.md` — schema, providers, algorithms, constants, routes
- [x] `docs/PLAN.md` — phases, gates, deviations, risks
- [x] `docs/TASKS.md` — this file

## Phase 1 — Skeleton, schema, dual-driver switch
- [ ] `package.json`, `tsconfig.json` (strict, `@/*` paths), `next.config.ts` (4 remote patterns), `eslint.config.mjs`, `postcss.config.mjs`, `.gitignore`, `.env.example`, `drizzle.config.ts`, `vitest.config.ts`
- [ ] `lib/env.ts` — getters, `required()` rejecting `""`, plus `assertEnv()`
- [ ] `instrumentation.ts` — calls `assertEnv()` once at boot (the original's missing startup pass)
- [ ] `lib/db/index.ts` — the lazy `Proxy`, `globalThis` memoisation, `DATABASE_URL`-or-PGlite, TLS on unless `sslmode=disable` (I-37)
- [ ] `lib/db/schema.ts` — 22 tables, 7 `logs` indexes, the `list_items` COALESCE expression unique index, functional `lower()` unique indexes on `users`
- [ ] `drizzle/0000_init.sql` via `db:generate`
- [ ] `scripts/migrate-deploy.ts` — refuses nothing, skips silently with no `DATABASE_URL`, exits 1 on failure
- [ ] `scripts/db-local.ts` — **exits 1 if `DATABASE_URL` is set**, runs the pglite migrator, prints `information_schema` tables
- [ ] `tests/stubs/server-only.ts`, `tests/stubs/next-cache.ts`
- [ ] **Gate:** `npm run db:local` prints 22 tables; `npm run build` succeeds with no `DATABASE_URL`

## Phase 2 — Providers, mappers, ingest, slugs
- [ ] `lib/providers/errors.ts` — `ProviderError`, `ProviderBudgetError`
- [ ] `lib/providers/deezer/client.ts` — budget first, `undefined` params skipped, **in-200-body error detection**, `Retry-After` honoured once if ≤2s, 200-char body truncation, throwing + optional variants with the written rule
- [ ] `lib/providers/deezer/index.ts` — `getAlbumDetail`, `getArtistDetail`, `getArtistAlbums`, `getRelatedArtists`, `getAlbumTracks` (paged >100), `searchAlbums`, `searchArtists`, `chartAlbums`, `chartArtists`, `genreArtists`, `genreList`
- [ ] `lib/providers/deezer/mappers.ts` — **pure**; `nullableDate` accepting `YYYY`/`YYYY-MM` with the `infinity` guard (I-4), `pickImage`, `normaliseRank`, `normaliseLabel`, `mapAlbumDetail`/`mapAlbumSummary` (epoch sentinel, poisoned counts), `mapTrack` (zero-votes ⇒ null score), `mapArtist`, `mapCredits`
- [ ] `lib/providers/musicbrainz/queue.ts` — serialising, ≥1100 ms spacing
- [ ] `lib/providers/musicbrainz/client.ts` — `User-Agent` from `NEXT_PUBLIC_SITE_URL`, busy⇒503, **optional-only**
- [ ] `lib/providers/musicbrainz/mappers.ts` — **`mbRatingToStored` (the one scale bridge)**, `mbTagsToAttributes` (count ≥2, stoplist, slice 25), `secondaryTypes`, `firstReleaseDate`
- [ ] `lib/providers/lastfm/*` — env-gated, optional-only
- [ ] `lib/providers/images.ts` — client-safe, no `server-only`
- [ ] `lib/canonical.ts` — `isCanonical`, `NON_CANONICAL`, `TITLE_NOISE`, `albumIdentity`, `stripSuffixes`
- [ ] `lib/slug.ts` — `slugify`, `parseIdSlug` (length check **before** `Number()`), `parseBoundedInt`, `parsePage`, **`parseTrackLocator` + `trackLocator`**, `MAX_DB_INT` declared **once**
- [ ] `lib/listen.ts` — deterministic YouTube Music / Spotify / Apple / Tidal / Deezer deeplinks, client-safe
- [ ] `lib/ingest/albums.ts` — `ensureArtist`, `ensureAlbum`, `ensureDiscography` (sequential, capped 12, logs what it dropped), `cacheAlbumSummaries` (**dedupe in JS first** I-7, genre-name resolution, `setWhere` asymmetric backfill), the derived-columns SQL, `enrichFromMusicBrainz`, `ensureArtistSimilar`
- [ ] `lib/view.ts` — `cardFromSummary`, `cardFromRow`
- [ ] `tests/fixtures/*.json` — captured real payloads
- [ ] `tests/mappers.test.ts`, `tests/slug.test.ts`, `tests/canonical.test.ts`, `tests/listen.test.ts`, `tests/bounds.test.ts`
- [ ] **Gate:** `ensureAlbum("302127")` mirrors *Discovery* with 14 tracks and a non-zero `duration_ms`

## Phase 3 — Rating maths
- [ ] `lib/ratings.ts` — `Stored`/`Stars` brands, four transforms, `histogram`/`histogramFromCounts` (10 buckets, `Math.max(...counts, 0)`), the seven brackets, `ratingBracket`/`ratingColor`/`bracketLegend`, `MIN/MAX_RATING`, `LOW_CONFIDENCE_THRESHOLD`
- [ ] `lib/ratings/dual.ts` — `dualRating` (Iterable), `divergenceNote` (gates 4 parts / 1.5 stored units)
- [ ] `lib/like.ts` — `escapeLike`, `containsPattern` (escape **then** wrap) (I-6)
- [ ] `lib/format.ts`, `lib/utils.ts` (`cn`)
- [ ] `components/rating/{stars,star-input,histogram,dual-rating,consensus}.tsx`
- [ ] `tests/ratings.test.ts` — incl. `ratingColor(7.4) !== ratingColor(7.6)` **and the red channel falling**; within-bracket shading with a stable label; `mbRatingToStored(4.5) === 9`
- [ ] **Gate:** `npm test` green

## Phase 4 — Auth, security, the action contract
- [ ] `lib/security/rate-limit.ts` — the one-statement upsert, `ok = count <= limit`, **fails open** (I-33), 15 budgets, `clientAddress()` left-most XFF (I-34), `retryMessage` leaking nothing, `pruneRateLimits`
- [ ] `lib/security/schemas.ts` — **pure**; `calendarDate` five layers incl. the Postgres date-literal rejection and the UTC+1 upper bound; `tagList` normalising **before** measuring (I-8); `passwordSchema` in **bytes** (I-24); `discNumberSchema`/`trackNumberSchema` min 0
- [ ] `lib/security/tokens.ts` — 32-byte base64url, SHA-256 stored only (I-27), the two TTLs
- [ ] `lib/username.ts` — `RESERVED_USERNAMES` regenerated from Deadwax's route tree
- [ ] `lib/auth/index.ts` — two Credentials providers, `DUMMY_HASH` (I-23), **budgets consumed inside `authorize`** (D-6), the `isGuest` presentation-only comment
- [ ] `lib/auth/session.ts` — `currentUser` / `requireUser` (I-17) / `requireMember`
- [ ] `lib/auth/admin.ts` — `requireAdmin` throwing, role from the DB (I-18)
- [ ] `app/actions/result.ts` — `ActionResult`, `ok`, `fail`, `guard`, `safeErrorDetail` (4 fields only, I-35), `VERIFICATION_EXEMPT` typed as `Set<ActionLabel>`
- [ ] `proxy.ts` — nonce on request **and** response, all headers, the CSP with `media-src` and `*.archive.org`, documents-only matcher, **gates nothing**
- [ ] `lib/email/index.ts` — `assertSingleLine` on `to` and `subject`, fixed message catalogue, Resend-or-log, `via` reported honestly
- [ ] `app/api/auth/[...nextauth]/route.ts`
- [ ] `tests/security.test.ts` — the single mocked seam, `beforeEach(signInAs(null))`
- [ ] `tests/no-escalation.test.ts` — source-level, **plus the raw-SQL grep** the original lacks (I-22)

## Phase 5 — The core loop
- [ ] `lib/db/queries/logs.ts` — `LogEntry` projection, correlated count subqueries, one-query tag attachment, the `notGuest` placement
- [ ] `app/actions/logs.ts` — `saveLog` (six-step authorization, patch semantics I-1, one transaction I-32, release-date gate), `toggleTrackListened`, `markAlbumListened`, `unmarkAlbumListened`, `markDiscographyListened` (**one guard** D-5), `deleteLog`, `toggleDesertIsland`
- [ ] `lib/db/queries/albums.ts` — `getViewerAlbumState` (TS reduce, no `DISTINCT ON`)
- [ ] `components/album/log-dialog.tsx` — **`initial` required** (D-1), refuses to close mid-save, `submit(createNew)` dating a replay today and flagging it, the guest cap rendered as an offer
- [ ] `components/album/{cover-card,cover-grid,cover-rail,track-row,tracklist,album-actions,listen-links,preview-button}.tsx`
- [ ] `app/album/[slug]/page.tsx`, `app/album/[slug]/track/[track]/page.tsx`, `app/artist/[slug]/page.tsx` — **`notFound()` before anything streams** (I-3)
- [ ] `app/albums/page.tsx`, `app/artists/page.tsx`, `app/search/page.tsx`
- [ ] Two-press arm/confirm with 4000 ms self-disarm on the destructive controls

## Phase 6 — Aggregates, consensus, the heatmaps
- [ ] Six `DISTINCT ON` variants (I-10) each carrying `(rating IS NOT NULL) DESC` (I-11) and `u.is_guest = false` (I-12), with explicit `IS NULL` predicates
- [ ] `components/rating/consensus.tsx` — two columns, provider left, the zero-votes collapse
- [ ] `components/album/track-strip.tsx`
- [ ] `components/artist/discography-heatmap.tsx` — ragged rows, 10rem gutter, real `<Link>` cells, `sr-only` per cell, four switched sources, the designed empty state, outset crown ring
- [ ] `tests/aggregates.test.ts` — one-vote-per-member, the rating-survives-a-replay case, guest exclusion
- [ ] **Gate:** histogram buckets sum to the rating count

## Phase 7 — Guest mode and onboarding
- [ ] `lib/auth/guest.ts` — `createGuest` (budget, discarded plaintext, `.invalid`, 5-retry loop), `GUEST_REVIEW_CAP`, `GUEST_NUDGE_AFTER` (distinct albums), `countReviewsBy(userId, ignore)` with the per-column null branch
- [ ] `lib/auth/claim.ts` — Path A (`is_guest = true` **inside** the UPDATE, I-30), Path B (one transaction I-31, **`desert_island` merged respecting the quota**, favourites discarded, guest row deleted) (I-36)
- [ ] `components/auth/{guest-strip,guest-banner,guest-start}.tsx` — hidden not unmounted; `beforeunload` from the first entry
- [ ] `app/start/page.tsx` — **guest-gated** (D: the original has no guard), 24 from 32, cover-less dropped, the familiarity heuristic (Last.fm ⇒ else curated seed by `fans`), prefilled ratings, mandatory `cacheAlbumSummaries`
- [ ] `components/onboarding/{intro-dialog,quick-rate,start-diary-button}.tsx`
- [ ] `app/login`, `app/signup` — redirect **non-guest** only; `?next` honoured with an allowlist (D-7)
- [ ] `tests/guest.test.ts`

## Phase 8 — Verification and reset
- [ ] `lib/auth/password-reset.ts` — issue retires outstanding tokens in the same transaction; redeem has five refusals returning one reason; reset confirms the address
- [ ] `app/actions/{verification,password}.ts`
- [ ] `app/{verify,forgot,reset}/page.tsx` — `noindex`, `no-referrer`; **confirmation on a button press** (I-28)
- [ ] `components/auth/{verify-banner,verify-controls,forgot-form,reset-form,auth-form}.tsx` — banner copy changes with the flag
- [ ] `tests/password-reset.test.ts`

## Phase 9 — Social
- [ ] `lib/db/queries/users.ts` — follows, feeds, directory (**batched** `getMemberCardStats` D-3), `searchUsers` with the **parenthesised** OR (I-13)
- [ ] `app/actions/social.ts` — `toggleFollow` (**existence + not-a-guest** checks added), `toggleLike`, `addComment`, `deleteComment`, `assertVisibleTarget` (I-16)
- [ ] `components/social/{activity-feed,review-card,comment-thread,follow-button,delete-log-button}.tsx` — `groupByDay` on the **member's local** date, `collapseRuns` with `RUN_THRESHOLD = 5`
- [ ] `app/log/[id]/page.tsx` (D-2), `app/album/[slug]/reviews`, `app/artist/[slug]/reviews`, `app/members`
- [ ] `countReviews` **duplicating the conditions ladder** — edited together with the list query (I-14)
- [ ] All five N+1 patterns reproduced

## Phase 10 — Lists, collections, stats
- [ ] `lib/db/queries/lists.ts` — `attachPreviews` in one query, polymorphic membership `EXISTS`
- [ ] `app/actions/lists.ts` + `collections.ts` — the three-line ownership rule, `cloneList` inverting it, `setFavorite` deleting first
- [ ] `app/list/[slug]/page.tsx` + `edit/page.tsx` (D-8) — **privacy checked in `generateMetadata` AND the body** (I-15)
- [ ] `lib/stats/profile.ts` — nine numbers, one round trip, `DISTINCT`, `clampListened`, wrapped in React `cache()` (D-4)
- [ ] `lib/stats/year.ts` — everything scoped by `listened_on`, the `BETWEEN '1900-01-01' AND '2200-01-01'` guard (I-4), always twelve months, no `DISTINCT ON` on the histogram
- [ ] `components/year/year-charts.tsx` — CSS-only, `MIN_BAR_PERCENT = 4` vs. the 2% `Meter` floor, **stars not `/10`** (D+b)
- [ ] `app/@[username]/*` — six routed tabs + `/network`; `wantlist_private` honoured in both entry points (D-9)
- [ ] `components/profile/*` — Top Four, Desert Island strip, three rankings tie-broken on `fans DESC`, `dislikedGenres` **sliced from the ascending end** (D+c)

## Phase 11 — Desert Island
- [ ] `lib/desert-island/index.ts` — rating gate **outside** the transaction reading the *latest* rating; count-then-insert **inside** one transaction (I-29); **idempotence checked before the quota**; uncrown never re-checks the rating; the profile read reports the current rating without filtering on it
- [ ] `components/album/desert-island-button.tsx` — the global-`used` optimistic arithmetic; **disabled, not hidden, when exhausted**
- [ ] Three surfaces, all gated on `viewerRating === MAX_RATING`
- [ ] `tests/desert-island.test.ts` — all seven cases: 10 ok / 11th refused, slot reuse, sub-five-star refusal, no-rating refusal, latest-rating-wins, **idempotence at the boundary**, no-op uncrown

## Phase 12 — The recommender (harness first)
- [ ] `scripts/taste-eval.ts` + the **ten adversarial personas** under `@taste.test`
- [ ] `lib/taste/shared.ts`, `profile.ts` (12 fields, `affinities` ±2 cap + shrinkage 5, `preferredCentre`, `leanFor` support-weighted, `reliableAverage` prior 7 / weight **40**)
- [ ] `lib/taste/recommend.ts` — nine formula steps, three axes, coarse-only absence penalties, seven retrieval sources, identity-based exclusion, three hard filters, `DETAIL_SYNC_LIMIT = 8` **sequential**
- [ ] `lib/taste/tracks.ts` — `forecastTracks`, `ownWeight` saturating at 6
- [ ] `app/for-you/page.tsx` — three cold-start gates with three distinct messages; the 90% ceiling printed verbatim; **up to two reasons rendered**
- [ ] `components/home/personal-rails.tsx` in Suspense
- [ ] `tests/taste.test.ts` — property tests only; names quoting the defect each locks out
- [ ] **Gate:** ≥60 distinct titles across 60 slots

## Phase 13 — Admin and ads
- [ ] `lib/db/queries/admin.ts` + `ads.ts` — **both self-gating** (I-20)
- [ ] `app/actions/admin.ts` — `expectedUsername` staleness, `deleteAccount`'s strict order, `sendAccountPasswordReset` audited **before** the send, `resyncAlbum` (the `revalidateTag` caller)
- [ ] `app/actions/ads.ts` — `recordAction(tx, …)` used consistently (the brief's inconsistency fixed)
- [ ] `lib/ads/plan.ts` — FNV-1a `seedHash`, `planKinds` hashing the **index**, `pickAd` in a **different hash namespace**, the ×2 genre bonus as a bonus not a filter
- [ ] `lib/ads/serve.ts` — half-open eligibility window, defensive row mapping, the Pro exemption read from the **table** at fetch time, affinity in a `try/catch`
- [ ] `app/api/ads/impression/route.ts` + `[id]/click/route.ts` — the ordered checks; **click forwards even when throttled**; `clickTarget` re-validating the scheme
- [ ] `components/ads/{ad-card,ad-slot,ad-impression}.tsx` — 0.5 threshold, `keepalive`, swallowed catch
- [ ] `app/admin/*` — 404 not 403 (I-21), `noindex`, the policy explained in prose with the real constants
- [ ] `tests/ads.test.ts` — the 2,000-page ±0.04 reservation assertion; the `javascript:` URL case; **`ad_stats` has one row and no `userId` key**
- [ ] `scripts/grant-admin.ts`

## Phase 14 — Seed, verify, ship
- [ ] `scripts/seed.ts` — 6 members, 20 albums, deliberate overlaps, backwards-walking dates, deterministic ±1 jitter, **five idempotency keys**
- [ ] `scripts/smoke.ts` — 25 checks incl. the histogram sum, `monthly.length === 12`, and the `critic_score` scale assertion
- [ ] `app/api/cron/prune/route.ts` + `vercel.json` (D-10)
- [ ] `scripts/security-probe.ts` — and **the always-passing assertion the original ships is fixed** rather than copied
- [ ] `app/{page,layout,error,not-found}.tsx`, `app/icon.svg`, `globals.css`
- [ ] `README.md`, `SECURITY.md`, `AGENTS.md`/`CLAUDE.md`, `.github/workflows/ci.yml`
- [ ] `npm run typecheck && npm run lint && npm test && npm run build` all green
- [ ] `git init`, GitHub repo, push
- [ ] Vercel project linked to the repo
- [ ] `DATABASE_URL` + `AUTH_SECRET` + `CRON_SECRET` set; migrations land in the build
- [ ] Seed the hosted database
- [ ] **Gate: fetch the live URL and confirm a seeded page renders**

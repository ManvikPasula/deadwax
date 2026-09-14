# Deadwax — Build Plan

Fourteen phases. **Each phase ends somewhere shippable** — the ordering is the brief's §20.4
with two insertions and one reordering, each justified below.

| Phase | Deliverable | Gate (how we know it is done) |
| --- | --- | --- |
| **0** | Decisions written down | `docs/DECISIONS.md` + `docs/ARCHITECTURE.md` exist and answer all five §20.1 questions |
| **1** | Repo skeleton, schema, migration `0000`, the dual-driver switch, `db:local`, an asserting-nothing smoke script | `npm run db:local` prints 22 tables; `npm run build` succeeds with **no** `DATABASE_URL` |
| **2** | Provider clients, typed endpoints, **pure mappers with fixture tests**, cache-through ingest, slugs, listen links | `npm test` green on `mappers`, `slug`, `canonical`, `listen`; `ensureAlbum(302127)` mirrors Daft Punk *Discovery* with 14 tracks |
| **3** | Rating maths, histogram, brackets, star input — all unit tested | `npm test` green on `ratings`, including the two hue regression tests and the `mbRatingToStored` scale-bridge assertion |
| **4** | Auth, sessions, `guard()`, the shared Zod library, the rate limiter, `proxy.ts`, env + startup validation | `npm test` green on `security`; the no-escalation test passes |
| **5** | `logs` + `saveLog` with patch semantics + the log dialog + the three content pages | A rating can be saved, edited and deleted from the UI without destroying a review |
| **6** | `DISTINCT ON` aggregates + the consensus card + **both heatmaps** | The thesis feature renders; `npm test` green on `aggregates` |
| **7** | Guest mode, both conversion paths, onboarding | A guest can rate, and both upgrade paths preserve their logs — **including `desert_island`** |
| **8** | Email verification + password reset | `npm test` green on `password-reset` |
| **9** | Social: follows, feed, reviews, likes, comments, `/log/[id]`, directory | |
| **10** | Lists (incl. the edit surface), collections, profile stats, year in review | `npm run smoke` passes all 25 checks |
| **11** | Desert Island | `npm test` green on `desert-island` — all seven boundary cases |
| **12** | The recommender — **with `scripts/taste-eval.ts` and the ten personas built FIRST** | `taste-eval` prints ≥ 60 distinct titles across 60 slots for ten personas |
| **13** | Admin, then house ads (ads depend on the taste profile) | `npm test` green on `ads`; the 1/3 reservation test passes within ±0.04 |
| **14** | Seed, full smoke, prune cron, GitHub, Vercel, live verification | A public URL serves a seeded, working instance |

## Deviations from the brief's suggested order, and why

1. **Phase 2 is before Phase 3** (the brief has mappers at 2 and ratings at 3 — unchanged), but
   **fixture capture happens inside Phase 2, not later.** The brief is explicit: *"The mappers
   are where the provider's awkward cases live. Write the fixture tests here, not later."*
   Deezer's in-200-body error shape and MusicBrainz's flakiness are exactly those cases.
2. **Phase 4 (auth/security) stays before all feature work.** *The audit's root causes were
   mostly "the rule expressed twice"* — building the shared Zod library and `guard()` first is
   what prevents the second copy from ever being written.
3. **Desert Island is pulled out into its own Phase 11**, after lists. In the brief it is part
   of the signature-features section built early. It is moved later because its quota logic is
   the most concurrency-sensitive code in the app (I-29) and it is cheaper to write against a
   settled `logs` read layer than to keep re-fixing it.
4. **Phase 12 builds the evaluation harness before the model.** This is the brief's §20.5
   instruction taken literally, and it is the single most transferable thing in the whole
   document: *"copy the method not the numbers."*
5. **Phase 14 includes live verification, not just deployment.** A deploy that builds is not a
   deploy that works; the brief's smoke script exists for exactly this distinction.

## Risks, and what is done about each

| Risk | Mitigation |
| --- | --- |
| **MusicBrainz is flaky** (1 in 3 responses were "server currently busy" during probing) | It is *only* ever reached through the optional client, on a 30-day TTL, behind a serialising queue, and **never on a path that decides a response status**. Every feature it powers degrades to absent: no critic score ⇒ the consensus column is not rendered; no tags ⇒ the recommender runs on coarse genres. |
| **Deezer has no published SLA and could change** | Provider code is behind `lib/providers/<name>/` with a mapper boundary, and nothing above `lib/ingest/` knows which provider a row came from. Swapping in Spotify means writing one client + one mapper. |
| **`critic_score` scale confusion** — the brief calls this the sharpest hazard | One conversion function (`mbRatingToStored`), called from one place (the MusicBrainz mapper), asserted by a test, and the column is documented as "already on the stored 0–10 scale" at its declaration. |
| **Parallel codegen breaking a strict-TS monorepo** | The spine (schema, db, env, security, ratings, providers, `actions/result`, layout, tokens) is written first and in one pass; only leaf modules fan out, against a frozen spine. `typecheck` gates every phase. |
| **No programmatic Postgres provisioning on Vercel** | The app runs on PGlite locally with zero configuration, so everything is verifiable before the deploy. The hosted database is the one step that may need the account owner; it is raised explicitly rather than guessed at. |
| **PGlite single-writer** (I-38) | `fileParallelism: false` in Vitest; every DB script documents "stop the dev server first"; `db:local` refuses to run when `DATABASE_URL` is set. |
| **Recommender ships plausible nonsense** | Property tests only — *"a recommender is the easiest kind of code to ship broken: it always returns a plausible-looking number, and nothing crashes when that number is nonsense."* Plus the diversity metric, which is what caught the retrieval problem in the TV version. |

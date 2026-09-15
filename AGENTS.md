# Working on Deadwax

A social diary for records. Rate artists, albums and tracks; keep a listening diary; see the
shape of a discography.

## Read these before changing anything

| File | What it is |
| --- | --- |
| `docs/DECISIONS.md` | Why the system is shaped the way it is. Five decisions, every retuned constant with its reason, and the departures from the source brief. |
| `docs/ARCHITECTURE.md` | The specification. Schema, providers, algorithms, constants, routes. |
| `docs/PLAN.md` / `docs/TASKS.md` | The build plan and its checklist. |
| `ARCHITECTURE_AND_REPLICATION_BRIEF.md` | The source brief this project was ported from (a Letterboxd for television). **§19 is the invariant list — the things that were broken once and must not be broken again.** |
| `lib/db/schema.ts` | The whole domain in one heavily-commented file. The authority on column names. |

## The house habit

The single most valuable convention here, inherited from the source project: **the code
records the rejected alternative and the measurement that rejected it.**

> "An amber ramp was theoretically better behaved and practically useless."
> "43 distinct titles filled 100 slots."
> "Longest-token chose 'ADA France' over 'Daft Life', which is exactly backwards."

A constant with a number tells you *what*. A constant with a rejected alternative tells you
whether the number still applies when something changes. Keep the habit.

## Layering

```
lib/providers/      clients, typed endpoints, pure mappers      (no DB, no React)
lib/ingest/         the only writer of the content mirror       (provider + DB, no React)
lib/db/             schema, the dual-driver connection, queries (no React)
lib/ratings*        rating maths, histograms, colour scale      (pure)
lib/taste/          the recommender                             (pure model + DB reads)
lib/stats/          profile and year aggregation                (DB reads)
lib/auth/           Auth.js config, session helpers, guards
lib/security/       rate limits, Zod schemas, link tokens
lib/desert-island/  the quota rule engine
app/actions/        Server Actions, one file per domain, Zod-validated
components/         presentational; data arrives as props
```

- Pure logic has **no I/O** and is unit tested.
- **Server Actions validate, authorize, mutate and revalidate — nothing more.**
- **Components receive data as props; they do not query.**
- Each query module owns one table's reads.
- **Anything with a rule worth proving lives in `lib/` and is tested against a real database.**
  An action is a shell, and a rule that only exists inside one is a rule nobody can prove.

## Things that will bite you

- **PGlite allows exactly one writer.** Stop the dev server before `db:local`, `seed` or
  `smoke`. Keep `fileParallelism: false` in the Vitest config.
- **The database instance is memoised at first property read.** DB-backed tests must set
  `PGLITE_DATA_DIR` and `delete process.env.DATABASE_URL` in `beforeAll` *before* any dynamic
  `import("@/lib/db")`. A top-level static import binds the wrong database, silently.
- **Vitest loads `.env.local`.** If you have a `DATABASE_URL` there, `npm test` would point at
  real Postgres were it not for that explicit `delete`. Never remove that line.
- **Drizzle returns `date` columns as JS strings and `timestamptz` as `Date`s.** Mixing them
  silently produces `"Invalid Date"`.
- **`IN ()` is invalid SQL.** Guard every empty-array case.
- **`notFound()` must be reached before anything streams.** A `notFound()` raised after the
  shell has flushed is sent as a **200**. Adding a route-level `loading.tsx` to a content route
  turns every 404 into a 200 with not-found UI.
- **`proxy.ts` gates nothing.** It sets headers. Every authorization decision happens inside
  the page or the action. If you add a matcher expecting it to protect a route, you ship an
  unprotected app.
- **Read `role`, `plan` and `is_guest` from the database, never from the session token.** The
  token copies are presentation only.
- **`albums.criticScore` is already on the stored 0–10 scale.** MusicBrainz's 0–5 is doubled
  exactly once, in `lib/providers/musicbrainz/mappers.ts`. Do not convert at a call site.
- **`albums.isCanonical` is the "specials" exclusion.** Filter on it in every completion
  denominator, discography row and recommendation pool — and copy the comment saying why.
- **Popularity is not quality.** `albums.fans`, `albums.popularity`, `tracks.popularity` and
  `artists.fans` are never rendered as stars or called a rating.

## Commands

```
npm run dev          next dev
npm run build        migrations first, then next build (&& aborts the build on failure)
npm run typecheck    tsc --noEmit
npm run lint         eslint --max-warnings 0
npm test             vitest run
npm run db:local     apply ./drizzle to the local PGlite store, then print the table list
npm run db:reset     delete the local store (honours PGLITE_DATA_DIR)
npm run seed         a demo community, idempotent, through the normal ingest path
npm run smoke        assert the raw-SQL aggregates return real rows on this driver
npm run taste-eval   print the recommender's actual output for ten adversarial personas
npm run admin:grant  -- <email> [--revoke]
```

`--conditions=react-server` on the script commands is what makes the `server-only` package
resolve to its no-op export, so a plain Node script can import the query layer.

## The catalogue needs no credential

Deezer, MusicBrainz and the Cover Art Archive are all keyless. A cold clone works with nothing
set but `AUTH_SECRET`. `LASTFM_API_KEY` is optional and unlocks better familiarity data and a
second artist-similarity source; absent, both features degrade to absent rather than to wrong.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

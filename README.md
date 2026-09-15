# Deadwax

**A social diary for records.** Rate artists, albums and individual tracks; keep a listening
diary; write reviews; build lists; follow people with taste — and see the *shape* of a
discography.

The deadwax is the blank run-out groove at the end of a record side, where the mastering
engineer scratches a private signature. A diary of personal verdicts on records is the same
gesture.

---

## What it is

Letterboxd treats a film as **one object**. A record is a **tree**: artist → album → track.
Deadwax makes all three first-class rateable objects, and the product is designed around the
consequences.

### The four pillars

**1. Shape.** A discography has a quality curve across a career, and an album has one across
its running order. That curve is the most interesting thing music has that film does not, so it
gets a real visualisation — **the discography heatmap**: one row per album, one cell per track,
coloured by rating. It draws the sophomore slump and the late return to form the way a TV grid
draws a show's arc. A compact **track strip** does the same job inside a single album.

**2. Replay.** Nobody is "partway through" a 42-minute album, so the progress pillar that
makes sense for television does not transfer. What replaces it is how many times, and when — a
replay is a **second log row**, never a mutation, which is why every community aggregate
collapses to one vote per member before it averages anything.

**3. Attributed consensus.** MusicBrainz's rating is shown **beside** the member average,
never averaged into it. The two numbers live in different columns and nothing in the app
combines them. Where there is no real vote count, the column is **not rendered at all** rather
than being filled with a streaming-popularity figure wearing a rating's clothes.

**4. The artist as a repeated author.** A television show is not made repeatedly by one named
person; an artist makes albums. That makes **artist affinity** a legitimate second axis in the
recommender, and it has no clean television equivalent.

### Two signature features

- **The discography heatmap** — described above. Four colour sources (member average, critic
  score, your own ratings, predicted), switched rather than blended, so every number keeps its
  attribution.
- **Desert Island** — you may crown ten individual tracks, and only tracks your *latest* rating
  puts at five stars. An honour with no ceiling is a second "like"; the mark means something
  because an eleventh requires taking one back.

---

## The catalogue needs no credential

This is the decision the whole project rests on, and it is worth stating plainly: **a cold
clone works with nothing configured but `AUTH_SECRET`.**

| Provider | Role | Auth |
| --- | --- | --- |
| **Deezer** | Album and artist metadata, full tracklists with real disc/track positions, 30-second previews, charts, genre browse, and **related artists** | none |
| **MusicBrainz** | The one thing Deezer cannot supply: a real crowd rating **with a vote count**. Also release-group first-release dates, curated genres, artist country | none (a descriptive `User-Agent` is required) |
| **Cover Art Archive** | Cover art fallback | none |
| **Last.fm** | *Optional.* Listener counts and a second similarity source | `LASTFM_API_KEY` |

Spotify was evaluated and rejected: it needs an hourly OAuth token, reports `popularity` with
**no vote count** (so a consensus card built on it could only relabel popularity as quality),
and **deprecated `related-artists` and `/recommendations` for new applications in late 2024** —
which removes the largest single term in the recommender.

YouTube Music was evaluated and rejected *as a catalogue*: it has no official metadata API, and
the sanctioned YouTube Data API allows roughly **100 searches per day** for an entire platform.
It is used for what it is genuinely good at — a listen deeplink, built deterministically with
zero API calls, alongside Spotify, Apple Music, TIDAL and Deezer's own canonical link.

`docs/DECISIONS.md` §0 has the full evaluation, with the evidence from actually calling each
one.

---

## Running it

```powershell
npm install
Copy-Item .env.example .env.local   # then set AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

npm run db:local                    # apply ./drizzle to a local PGlite store
npm run seed                        # a demo community, through the normal ingest path
npm run dev
```

<sub>On macOS or Linux the only difference is `cp` for `Copy-Item`. `node -e` rather than
`openssl rand -base64 32` because it is the one generator guaranteed present — this repo
already depends on Node and not on OpenSSL being on PATH.</sub>

**With no `DATABASE_URL` the app runs on [PGlite](https://pglite.dev) — a WebAssembly Postgres
in a local directory.** Set `DATABASE_URL` and the same migrations, the same queries and the
same raw SQL run against hosted Postgres instead. The presence of that one variable is the
entire switch: there is no dialect fork and no second set of queries.

Two caveats, both real: PGlite writes to the local filesystem, so it is for development and one
long-lived server, **not** serverless. And it allows **exactly one writer** — stop the dev
server before `db:local`, `seed` or `smoke`.

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | **Migrations first**, then the build. The `&&` aborts the build if the schema did not land |
| `npm run typecheck` / `lint` / `test` | `tsc --noEmit` / `eslint --max-warnings 0` / `vitest run` |
| `npm run db:local` | Apply `./drizzle` to PGlite, then print the resulting table list |
| `npm run db:reset` | Delete the local store (honours `PGLITE_DATA_DIR`) |
| `npm run seed` | Idempotent demo community — six members with written personalities, ~37 records across 1959–2020, deliberate rating overlaps |
| `npm run smoke` | Assert the raw-SQL aggregates return real rows **on this driver**. The highest-value script in the repo for a dual-driver architecture |
| `npm run taste-eval` | Print the recommender's actual output for ten adversarial personas, plus a diversity metric |
| `npm run security:probe` | An HTTP attack harness against a live server. **Deliberately trips rate limits — do not point it at production** |
| `npm run admin:grant -- <email> [--revoke]` | The only way to become an admin |

---

## How it is built

```
Next.js 16 (App Router) · React 19 · TypeScript strict
Tailwind CSS v4, CSS-first — no config file
Drizzle ORM + raw SQL where aggregates need it
Postgres (hosted) or PGlite (local), one variable switches
Auth.js v5, Credentials only, JWT sessions, no adapter
Zod 4, one shared schema module
Server Actions only — four route handlers exist, all for non-form paths
Vitest — pure suites, plus integration suites against a real throwaway PGlite
```

### Layering

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

Server Actions **validate, authorize, mutate and revalidate — nothing more.** Components
receive data as props and do not query. And the sharpened version of the rule: **anything with
a rule worth proving lives in `lib/` and is tested against a real database** — an action is a
shell, and a rule that only exists inside one is a rule nobody can prove.

### The design system

Dark only — `color-scheme: dark` and nothing else. No `dark:` variant, no toggle, no light
palette. A single warm accent (amber) for rating and focus, teal for replay, rose for
destructive, and one blue that is **the same hex as the top rating bracket**, so the Desert
Island badge and the heatmap's peak cannot drift apart.

Album art is **1:1**, which is the one hard geometric change from a film or television
equivalent, and everything downstream of it — the grid, the cards, the rails, the hero crop —
is re-proportioned. There is no wide "backdrop" image in any music provider, so the hero uses
the cover itself: scaled, blurred and desaturated behind its own scrim.

Charts are plain elements with CSS widths and heights. No charting library, no SVG, no canvas,
no measuring pass, no hydration cost.

---

## Provenance

Deadwax is a port. `ARCHITECTURE_AND_REPLICATION_BRIEF.md` is a complete account of
**Cliffhanger**, a Letterboxd for television, written for somebody rebuilding it in another
catalogue domain — and its §20 is a replication playbook whose worked example is music albums.

Roughly 60% of that architecture is domain-generic and is reproduced closely: the polymorphic
log table and its three nullability encodings, the no-uniqueness-plus-read-time-`DISTINCT ON`
pattern, the `guard()` wrapper and the shared Zod library, the Postgres rate limiter with all
thirteen of its budget numbers, the token machinery, guest mode and both conversion paths, the
admin subsystem with its structural no-escalation test, the house-ad planner with its
one-third indie reservation, the design tokens, and the dual-driver database switch.

The rest was redesigned, because the domain is genuinely different:

| | Television | Deadwax |
| --- | --- | --- |
| Middle tier | a season, identified by its **ordinal** | an album, identified by an **id** |
| Depth | three tiers | three, plus a real **disc** dimension (*The Wall* is 13 + 13) |
| Progress | a member is partway through a show | **replaced** by replay and discography completion |
| "Specials" exclusion | `season_number > 0` | a derived `is_canonical`, from record type, MusicBrainz secondary types, and a title check |
| Crowd baseline | TMDB, already on a 0–10 scale | MusicBrainz on 0–5, converted **exactly once** |
| Neighbour graph | `/tv/{id}/recommendations` | Deezer related artists, **cached in a table** |
| Asset ratio | 2:3 plus a backdrop | 1:1 and no backdrop |

`docs/DECISIONS.md` records every one of those calls with its reasoning and its rejected
alternative. The brief also lists ten known defects in the shipped television code; **all ten
are fixed here rather than inherited**, and §5 of the decision record says which.

### The habit worth stealing

The most reusable thing in the source project is not its schema or its recommender. It is a
convention visible in almost every comment: **the code records the rejected alternative and the
measurement that rejected it.**

Deadwax keeps it, and the entries it added are the ones found by running the thing rather than
reading about it:

> `GET /album/{id}`'s embedded tracklist omits `track_position` and `disk_number`. Only
> `/album/{id}/tracks` has them, and that tuple *is* a track's identity.

> Longest-token label normalisation chose "ADA France" over "Daft Life", which is exactly
> backwards — ADA is the distributor.

> Rejecting "(Remastered)" as non-canonical removed the only edition of Nevermind, Abbey Road
> and London Calling the catalogue stocks. A remaster of a studio album *is* the studio album.

> Collapsing "MusicBrainz says no such release" and "MusicBrainz is busy" into one `null`
> turned a five-minute outage into thirty days of permanent absence: one seeding run stamped a
> whole 37-album batch and produced a catalogue with no consensus card anywhere.

> `/artist/{id}/albums` summaries carry no artist object at all, so a filter requiring one
> silently dropped all 38 rows and the discography fill reported success having inserted
> nothing.

A constant with a number tells you *what*. A constant with a rejected alternative tells you
whether the number still applies when the domain changes.

---

## Deploying

`npm run build` runs the migrations and then the build, in that order, with `&&` — so a
deployment whose schema did not land does not produce a running site. Three variables are
needed in production and only the first is strictly required:

| Variable | Needed | Absent means |
| --- | --- | --- |
| `AUTH_SECRET` | **yes** | `assertEnv()` throws at boot, by design |
| `DATABASE_URL` | **in practice** | PGlite, which is one-writer and filesystem-backed, so not viable on serverless |
| `CRON_SECRET` | no | `/api/cron/prune` 404s rather than running unauthenticated |

There is no need to sign up for a database to get one. Neon's claimable flow provisions a
Lakebase Postgres with no account and no API key, and you attach it to an account afterwards:

```powershell
npx neon@latest claim create --service postgres --file .env.local   # writes DATABASE_URL
npx neon@latest claim accept                                        # keep it: 72h otherwise
```

An unclaimed project is capped at 100 MB and expires in 72 hours; claiming removes both limits
and changes nothing about the connection string.

Then, once `vercel login` has been done — the one step that is interactive by construction:

```powershell
npm run vercel:setup        # link, push DATABASE_URL / AUTH_SECRET / CRON_SECRET, deploy
```

It reads the values from `.env.local` rather than asking for them to be retyped, and its
docblock lists every variable it deliberately does **not** push. The most important of those is
`NEXT_PUBLIC_SITE_URL`: `env.siteUrl` already falls back to `VERCEL_PROJECT_PRODUCTION_URL`, so
pushing the local value would point every verification email at a laptop.

`docs/TASKS.md` ends with the full sequence, including the verification steps worth running
against the hosted instance — `npm run smoke` with a real `DATABASE_URL`, which is what proves
the dual-driver architecture is actually dual, and the security probe over HTTPS, which
exercises the two assertions a plain-HTTP origin cannot.

## Security

See `SECURITY.md`. Summary: seventeen findings from an adversarial audit of the source project
are closed here structurally rather than by patching; three further source defects with
security relevance are fixed rather than reproduced. There are **no third-party browser
scripts of any kind**, no image uploads, and the ad statistics table is deliberately incapable
of recording who saw what.

## Licence

The code is MIT. The catalogue data is not ours: music metadata comes from
[Deezer](https://developers.deezer.com) and [MusicBrainz](https://musicbrainz.org) (CC0 / CC
BY-NC-SA depending on the field), and cover art from the
[Cover Art Archive](https://coverartarchive.org). Attribution is rendered in the site footer,
as those terms require.

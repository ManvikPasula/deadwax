# Cliffhanger — Architecture and Replication Brief

**What this is.** A complete account of how Cliffhanger (a Letterboxd for television) is
built: its data model, its algorithms with their real constants, every deliberate design
decision and the rejected alternative behind it, and the traps that will bite anyone who
rebuilds it.

**Who it is for.** Someone rebuilding this product for a different catalogue domain. The
worked example throughout is **music albums** (artist → album → track, sourced from
MusicBrainz or Spotify instead of TMDB), but §20 generalises the method to any vertical.

**How it is organised.** §1–§18 describe the system as built. Every section ends with a
**Porting note** separating what is domain-generic (copy it) from what is TV-coupled
(redesign it). §19 is the invariant list — the things that were broken once and must not
be broken again. §20 is the replication playbook. Appendices are lookup tables.

**Source of truth.** Everything here is drawn from the code, the migration history, the
original design spec (`docs/superpowers/specs/2026-08-11-cliffhanger-design.md`),
`SECURITY.md`, `SECURITY_AUDIT.md`, and the commit log. Where a rationale is inferred
rather than written down, it is marked *(inference)*.

---

## Table of contents

| § | Subject |
| --- | --- |
| 1 | The product thesis |
| 2 | Stack and why each piece was chosen |
| 3 | The domain model |
| 4 | Content ingestion: external catalogue → local mirror |
| 5 | The rating system |
| 6 | Logging, progress, and the one write path |
| 7 | Discovery, taste, and recommendations |
| 8 | The two signature features |
| 9 | The social layer |
| 10 | Lists and collections |
| 11 | Statistics and Year in Review |
| 12 | Identity: auth, guest mode, onboarding |
| 13 | Security architecture |
| 14 | Admin and moderation |
| 15 | Monetisation: house ads |
| 16 | UI and the design system |
| 17 | The Server Action contract and the layering doctrine |
| 18 | Infrastructure: build, test, CI, seed, smoke |
| 19 | Invariants — do not break these |
| 20 | Replication playbook: TV → music albums |
| A–E | Appendices: routes, constants, env, actions, files |

---

## 1. The product thesis

Letterboxd treats a film as **one object**. A television show is a **tree**: series →
season → episode. Cliffhanger makes all three levels first-class rateable objects, and
the entire product is designed around the two consequences:

1. **Progress.** A member is usually *partway through* a show, not finished with it. This
   is why the schema has no `watched` boolean and why four separate progress computations
   exist (§6.6).
2. **Shape.** A show has a quality curve across its run. That curve is the most
   interesting thing television has that film does not, so it gets a real visualisation —
   the **episode heatmap** (§8.2), which the spec calls "the signature view".

A third pillar emerged in implementation: **attributed consensus**. Baseline critical
scores come from TMDB and are shown *beside* member ratings, never averaged into them
(§5.4). This is stated three times in the codebase and enforced structurally — the two
numbers live in different tables and nothing in the app combines them.

### 1.1 What the spec deliberately excluded, and what shipped anyway

The original design doc has a "Deliberately excluded" section. Comparing it to the
shipped product is the fastest way to understand the project's actual growth:

| Excluded in the spec | Shipped? | Where |
| --- | --- | --- |
| Direct messages | No | — |
| Notifications | No | — |
| Moderation tooling | **Yes** | `/admin`, `admin_audit_log` (commit `524017b`) |
| Paid tiers | **Partly** | `users.plan` free/pro, operator-set only, no billing |
| Native apps | No | — |
| Image uploads to blob storage | No | Avatars are generated gradients (§16.7) |
| Full-text search infrastructure | No | Postgres `ILIKE` + provider search |
| Any recommendation engine | **Yes** | `lib/taste/` (commit `f8a9c99`, then 3 fix rounds) |

Plus three features with no spec entry at all: **guest mode** (`253c12a`), **house ads
with a one-third indie reservation** (`b2cee46`), and **Absolute Cinema** (`89e228f`).

**Read this as a warning.** The recommender's every hedge — the withholding gates, the
0.90 confidence ceiling, the "reasons are never invented" rule — exists because it was
added against the spec's judgement and then had to earn its place through three
adversarial fix rounds. If you rebuild, decide up front whether you want it.

### 1.2 Development timeline (from `git log`)

Twenty-one commits over three days, in a revealing order:

```
2026-08-11  3b9784d  feat: Cliffhanger — a social diary for television   (the whole MVP)
2026-08-11  377167f  fix: keep the landing page up when an optional read fails
2026-08-11  fcdefdc  feat: run fully local on PGlite, with one variable to expand later
2026-08-11  91a7768  fix: close the defects found by the adversarial audit
2026-08-11  92d6fe8  security: harden authentication, add rate limiting and browser controls
2026-08-11  fce0dfa  feat: email verification, and bound passwords in bytes not characters
2026-08-11  362c4c6  test: assert the cross-origin refusal itself, not the dev-only reason
2026-08-11  524017b  feat: admin panel, and make email verification non-blocking for now
2026-08-11  f8a9c99  feat: two ratings per show, and a taste model
2026-08-11  22664ba  chore: give demo members five rated shows, including low ones
2026-08-11  857bdea  fix: the recommender was scoring most candidates on no attributes
2026-08-11  d303bf3  fix: the second round of recommender defects, incl. one my own fix caused
2026-08-11  4ffbdeb  fix: recommend by what people actually watch next, not TMDB's top score
2026-08-12  ffd2bb3  feat: season ratings as their own thing, readable heatmap colours
2026-08-12  89e228f  feat: Absolute Cinema, ten slots per member, admin-sent resets
2026-08-12  253c12a  feat: guest mode with two ways to keep the logs, forgot-password
2026-08-12  b2cee46  feat: house ads, a third of every slot reserved for indie filmmakers
2026-08-13  3f2fb20  feat: onboarding that starts with ratings, cycling hero, shows-first home
2026-08-13  7badc24  fix: stop asking guests to confirm an address that cannot exist
2026-08-13  d186072  feat: a tab icon that is actually this app's mark
```

The shape to notice: **one large MVP commit, then security, then the recommender fought
over three times, then features that each required a schema migration.** The recommender
rounds are the most instructive — each fix commit message names the measured defect and
the measurement (`43 distinct titles filled 100 slots` → `77 distinct across 80 slots`).

---

## 2. Stack and why each piece was chosen

| Concern | Choice | Stated reason |
| --- | --- | --- |
| Framework | Next.js 16, App Router, TypeScript `strict` | Server Components keep the API key server-side and let poster grids stream |
| Styling | Tailwind CSS v4, CSS-first (`@theme`), no config file | Tokens as CSS variables; no `tailwind.config.js` exists |
| Primitives | Radix UI (4 packages actually used) + `cva` for Button only | Accessible primitives to restyle, not a look to fight |
| Database | Postgres. Neon in production, **PGlite locally** | Relational aggregates over ratings; one variable switches |
| ORM | Drizzle | Typed schema in TS, raw SQL where aggregates need it |
| Auth | Auth.js v5, Credentials provider, **JWT sessions, no adapter** | Self-contained email/password; no third-party provisioning to sign up |
| Catalogue | TMDB API v3 with a v4 read token as a bearer | Series/season/episode/credits/watch-providers in one API |
| Validation | Zod 4, one shared schema module | One definition per rule; two audit defects came from copies drifting |
| Mutations | Server Actions only | No hand-written API surface (2 route handlers exist, both for non-form paths) |
| Tests | Vitest | Unit coverage on the pure layers; integration on real PGlite |
| Mail | Resend, degrading to `console.info` | Local dev completes the flow with no account anywhere |

### 2.1 The single most portable infrastructure decision

`lib/db/index.ts` is 84 lines and is the whole local↔hosted story:

```ts
type Database = NodePgDatabase<typeof schema>;
const LOCAL_DATA_DIR = process.env.PGLITE_DATA_DIR ?? "./.pglite";

function connect(): Database {
  const url = process.env.DATABASE_URL;
  if (url) {
    globalForDb.cliffhangerPool ??= new Pool({
      connectionString: url,
      max: 5,                              // serverless: many short-lived instances
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: url.includes("sslmode=disable") ? false : { rejectUnauthorized: true },
    });
    globalForDb.cliffhangerDb = drizzlePg(globalForDb.cliffhangerPool, { schema });
  } else {
    globalForDb.cliffhangerDb = drizzlePglite(LOCAL_DATA_DIR, { schema }) as unknown as Database;
  }
  return globalForDb.cliffhangerDb;
}

// Lazy: module-scope construction would make every route that merely imports a query
// module fail during `next build`, before it ever needed a database.
export const db = new Proxy({} as Database, {
  get(_t, property, receiver) {
    const instance = connect();
    const value = Reflect.get(instance, property, receiver);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});
```

Four properties worth copying exactly:

1. **The presence of `DATABASE_URL` is the entire switch.** No dialect fork, no
   conditional query code. `DISTINCT ON`, lateral joins and `jsonb_array_elements` behave
   identically on both drivers.
2. **The `Proxy` makes connection lazy**, which is what lets CI run `npm run build` with
   no database at all.
3. **The instance is memoised on `globalThis`**, so Next dev HMR does not open a pool per
   reload — and so the driver choice is frozen at first property read. Every DB-backed
   test therefore sets env in `beforeAll` *before* any dynamic `import("@/lib/db")`.
4. **TLS verification stays on** unless the URL literally contains `sslmode=disable`.

Caveats to know: PGlite writes to the local filesystem, so it works for development and
for one long-lived server but **not** on serverless hosting. PGlite also allows **exactly
one writer** — stop the dev server before `db:local`, `seed` or `smoke`. And
`@neondatabase/serverless` is a declared dependency that `lib/db/index.ts` never imports:
production reaches Neon over ordinary TCP with `pg`.

> **Porting note (§2).** The whole stack is domain-generic. Only the catalogue row
> changes. Two things that *do* change materially for music: (a) Spotify needs an OAuth2
> client-credentials token that expires hourly, so a static bearer header becomes a cached
> refreshable token with a 401-triggered retry; (b) MusicBrainz requires a descriptive
> `User-Agent` and rate-limits to ~1 req/s, which breaks the lazy-ingest-inside-a-request
> pattern and needs a queue or pre-warm step.

---

## 3. The domain model

### 3.1 The content tree is flat, not nested

```
shows (PK = tmdb_id, the provider's own id)
  ├── seasons   (show_id FK, addressed by season_number ordinal)
  ├── episodes  (show_id FK, addressed by (season_number, episode_number))
  ├── credits   (show_id FK; person data denormalised, no people table)
  └── watch_providers (show_id FK, per region and offer type)
```

**`episodes` does not reference `seasons.id`.** Seasons and episodes are *siblings* under
shows; an episode carries `season_number` as an ordinal. The addressable identity of any
content node is therefore one of three tuples, each backed by a unique index:

- `(show_id)` — `shows` PK
- `(show_id, season_number)` — `seasons_show_number_uq`
- `(show_id, season_number, episode_number)` — `episodes_show_season_number_uq`

This flatness is what makes the polymorphic log table possible.

### 3.2 `logs` — one table for watching, rating, reviewing, liking and the diary

The load-bearing decision of the whole system. Columns:

```sql
CREATE TABLE logs (
  id                serial PRIMARY KEY,
  user_id           integer  NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  target_type       varchar(8) NOT NULL,          -- 'show' | 'season' | 'episode'
  show_id           integer  NOT NULL REFERENCES shows(tmdb_id)   ON DELETE CASCADE,
  season_number     integer,                      -- NULL for a series-level log
  episode_number    integer,                      -- NULL unless target is an episode
  rating            smallint,                     -- 1..10, NULL = "watched, not rated"
  review            text,                         -- NULL = no review
  contains_spoilers boolean  NOT NULL DEFAULT false,
  watched_on        date,                         -- NULL = a rating not in the diary
  is_rewatch        boolean  NOT NULL DEFAULT false,
  liked             boolean  NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
```

**Three encodings carried by nullability:**

| State | Encoding |
| --- | --- |
| Watch mark | a row with `rating IS NULL` |
| A rating that never entered the diary | `watched_on IS NULL` |
| A rewatch | **a second row**, not a mutation |

**Five indexes, zero unique constraints:**

```sql
logs_user_created_idx  (user_id, created_at)                                   -- feed, profile
logs_user_watched_idx  (user_id, watched_on)                                   -- diary
logs_target_user_idx   (show_id, season_number, episode_number, user_id, created_at)
                                                       -- "what did this member rate" → DISTINCT ON
logs_target_rating_idx (show_id, target_type, season_number, episode_number, rating)
                                                       -- per-target rating aggregates
logs_show_idx          (show_id)
```

**The absence of uniqueness is the feature.** A member can hold many logs for the same
target because a rewatch is a real, separately-dated, separately-rated event. The cost is
paid on every read: see §5.5 (`DISTINCT ON`).

**There is no `watched` boolean.** At episode level, "watched" means *an episode-targeted
log row exists* — regardless of `watched_on`. A rating with "Add to diary" unchecked still
ticks the checkmark. A member can be `62/62 watched` with an empty diary.

Tags live in a side table: `log_tags(log_id, tag varchar(32))`, composite PK, cascade
from `logs`.

**Nothing enforces `target_type` ↔ NULL consistency.** There is no CHECK constraint
anywhere in the schema (verified: `drizzle/meta/0007_snapshot.json` records zero enums,
zero views, zero check constraints, zero RLS policies). The invariant is maintained in
three places instead:

1. `targetTypeOf(input)` **derives** the type and never accepts it from the client:
   `episodeNumber !== undefined ? "episode" : seasonNumber !== undefined ? "season" : "show"`.
2. `saveLog` verifies the target exists in the mirror before writing (§6.1 step 5).
3. Every read builds the matching `IS NULL` predicates explicitly rather than omitting
   the column from the WHERE clause.

### 3.3 Complete table catalogue — 22 tables

**Content mirror (5).**

| Table | PK | Notes |
| --- | --- | --- |
| `shows` | `tmdb_id integer` | No surrogate key. `genres`/`networks`/`creators`/`origin_country` are `jsonb NOT NULL DEFAULT '[]'`. `episode_run_time integer` = median episode minutes (derived, §4.5). `synced_at timestamptz NOT NULL DEFAULT now()`. Indexes on `slug`, `popularity`, `first_air_date` — none unique. |
| `seasons` | `serial` | `uniqueIndex(show_id, season_number)`. `synced_at` **nullable** — null means "episode list never fetched". |
| `episodes` | `serial` | `uniqueIndex(show_id, season_number, episode_number)` + `index(show_id)`. `tmdb_vote_average real` is NULL for unaired episodes (see §4.4). |
| `credits` | `serial` | No `people` table; `person_id`, `name`, `profile_path` denormalised per row. `kind varchar(8)` = cast\|crew. `order integer DEFAULT 999`. `uniqueIndex(show_id, person_id, kind, role)` — `role` is nullable, so this does **not** dedupe (§4.4 trap). |
| `watch_providers` | `serial` | `region varchar(2)`, `offer_type varchar(12)` ∈ flatrate/free/ads/rent/buy. `uniqueIndex(show_id, region, offer_type, provider_id)`. |

**Member data (11).**

| Table | Key | Notes |
| --- | --- | --- |
| `users` | `serial`, + `uniqueIndex(lower(username))`, `uniqueIndex(lower(email))` | `username varchar(32)`, `email varchar(255)`, `password_hash text`, `display_name varchar(64)`, `bio text`, `avatar_seed varchar(32)`, `email_verified_at`, `role varchar(16) DEFAULT 'member'`, `is_guest boolean DEFAULT false`, `plan varchar(16) DEFAULT 'free'`, `plan_updated_at`. |
| `logs` | `serial`, no unique | §3.2 |
| `log_tags` | PK `(log_id, tag)` | + `index(tag)` |
| `watchlist` | PK `(user_id, show_id)` | `note text` (never written by any code path), `added_at`. + `index(user_id, added_at)` |
| `favorites` | PK **`(user_id, position)`** | The pinned "Top Four", `position smallint` 1–4. Keyed by **slot, not by show** — so the DB permits one show in two slots; the action prevents it by deleting first (§10.4). |
| `absolute_cinema` | `serial` + `uniqueIndex(user_id, show_id, season_number, episode_number)` | + `index(user_id, created_at)`. §8.1 |
| `follows` | PK `(follower_id, followee_id)` | + `index(followee_id)` so the reverse direction is indexed. Nothing at DB level forbids self-follow. |
| `lists` | `serial` | `title varchar(120)`, `slug text` **not unique at any scope**, `is_ranked`, `is_public`, `cloned_from_id integer` **with no FK**. Indexes `(user_id, updated_at)`, `(is_public, updated_at)`. |
| `list_items` | `serial` (never queried) + `uniqueIndex(list_id, show_id)` | `position integer DEFAULT 0`, `note text`. + `index(list_id, position)`. **Can hold only shows** — never seasons or episodes. |
| `likes` | PK `(user_id, target_type, target_id)` | `target_type` ∈ log\|list. `target_id` has **no FK** (polymorphic). + `index(target_type, target_id)`. |
| `comments` | `serial` | Same polymorphic target, no FK. `index(target_type, target_id, created_at)`. **Flat — no `parent_id`, depth is exactly 1.** |

**Operational (6).**

| Table | Notes |
| --- | --- |
| `email_verification_tokens` | `token_hash text` = SHA-256 hex (never the token), `email varchar(255)` bound at issue so a later email change cannot be confirmed by an old link, `expires_at`, `consumed_at`. `uniqueIndex(token_hash)`. TTL 60 min, application-side. |
| `password_reset_tokens` | **Structurally identical, deliberately a second table** — "so a bug in one flow cannot redeem a token minted by the other." TTL 30 min. |
| `admin_audit_log` | `actor_id integer` **no FK**, `actor_username varchar(32) NOT NULL` copied at write time, `action varchar(32)`, `target_id`/`target_username`, `detail text`. Index on `created_at`. Append-only by convention only. |
| `rate_limits` | `key text PRIMARY KEY` = `bucket:identity`, `window_start timestamptz`, `count integer`. No secondary indexes. |
| `ads` | 22 columns. `kind varchar(8)` general\|indie, `slot` feed\|sidebar\|any, `status` draft\|active\|paused\|archived, copy fields, indie credit block, `genres jsonb` (a scoring bonus, not a filter), `weight smallint DEFAULT 1`, half-open `starts_at`/`ends_at`, lifetime `impressions`/`clicks`, `created_by` → the **only** `ON DELETE SET NULL` FK in the schema. `index(status, kind, slot)`. **No image column** by design. |
| `ad_stats` | `uniqueIndex(ad_id, day)` — one row per ad per day, never per impression. |

### 3.4 Foreign keys and the cascade graph

24 FKs, all `ON UPDATE no action`. **23 are `ON DELETE cascade`; exactly one is
`SET NULL`** (`ads.created_by`).

- **Into `shows(tmdb_id)` — 9 cascading FKs:** seasons, episodes, credits,
  watch_providers, logs, watchlist, favorites, list_items, absolute_cinema. Deleting one
  `shows` row erases every member's logs, watchlist entries, pins, list items and crowns
  for that show. No soft delete, no `RESTRICT`. Nothing in the app ever deletes from
  `shows`.
- **Into `users(id)` — 11 cascading FKs** plus the one SET NULL. Deleting a member wipes
  logs (and transitively log_tags), lists (and list_items), watchlist, favourites, follows
  in both directions, likes, comments, tokens and crowns — but **leaves their
  `admin_audit_log` rows intact**, because `actor_id`/`target_id` have no FK and the
  username was copied at write time. An audit trail that vanishes with the account it
  describes is not an audit trail.
- **Deliberately unreferenced:** `likes.target_id`, `comments.target_id`,
  `lists.cloned_from_id`, `admin_audit_log.actor_id`/`target_id`, `credits.person_id`.
- **Outside the graph entirely:** `rate_limits`, `admin_audit_log`.

The cascade graph is what makes the test harness cheap: every DB-backed suite resets with
`TRUNCATE users, shows RESTART IDENTITY CASCADE`.

**Consequence to plan for:** deleting a log removes the row only. Its likes and comments
become permanent orphans (no FK, nothing prunes them). Counts stay correct because the
subqueries simply find nothing, but the rows accumulate forever.

### 3.5 Migration history — read this as the product's growth plan

`drizzle/` is the single source of truth for both drivers. Eight migrations over ~35
hours; every later feature layered onto a shipped schema.

| # | Tag | When | What it added |
| --- | --- | --- | --- |
| 0000 | `init` | 19:03 | 15 tables, 18 FKs, 24 indexes. The whole content mirror **and the whole social product** in one shot. `users` has 7 columns and *case-sensitive* unique indexes. |
| 0001 | `security_controls` | +2h | `rate_limits`. Then DROPs `users_username_uq`/`users_email_uq` and replaces them with functional unique indexes on `lower(...)`. This is audit finding SEC-13. |
| 0002 | `email_verification` | +28m | `email_verification_tokens` + `users.email_verified_at`. |
| 0003 | `admin_roles` | +28m | `admin_audit_log` + `users.role`, `users.plan`, `users.plan_updated_at`. Roles and plans arrive together because the admin panel sets both. |
| 0004 | `absolute_cinema` | next day | `absolute_cinema` + its two indexes. |
| 0005 | `password_reset` | +10m | `password_reset_tokens`, column-for-column identical to 0002's table. Note the reversal: SEC-14 had recorded "No password reset… a deliberate omission, because reset flows are the most commonly broken part of an authentication system and none is safer than a weak one." It was built anyway, ten minutes after 0004. |
| 0006 | `guest_accounts` | +4h | **73 bytes, one statement:** `ALTER TABLE users ADD COLUMN is_guest boolean DEFAULT false NOT NULL;` The entire guest feature at schema level. |
| 0007 | `ads` | next day | `ads`, `ad_stats`, their indexes, the one SET NULL FK. |

**End state: 22 tables, 24 FKs, 0 enums, 0 views, 0 check constraints, 0 RLS policies.**

Two lessons for a rebuild:

- **Guest mode landed after email verification and password reset**, which is exactly why
  both then needed guest special-cases retrofitted (and why one shipped as a bug — commit
  `7badc24`, a banner asking guests to confirm `guest_46ee4182c3@guest.invalid`). Decide
  guest mode *before* shipping anything that touches email.
- **Do not squash the migrations.** Each intermediate state is what a test was written
  against, and replaying 0001 against a database containing rows that differ only by case
  will fail at the `CREATE UNIQUE INDEX`.

### 3.6 Why no enums and no check constraints

Confirmed empirically, not assumed. Every closed value set is a `varchar(n)` documented
in a comment. *(Inference, since no comment states it:* adding an enum value is DDL and a
migration, whereas `varchar` costs nothing; and every value set is already enforced with
Zod at the action boundary, so a database check would be a second copy of the same rule.*)*
The price is that a bug can write `target_type = 'seasonn'` and nothing stops it.

Several `varchar` widths sit **exactly** at their longest legal value: `ads.status
varchar(8)` must hold `'archived'` (8 chars); `logs.target_type varchar(8)` must hold
`'episode'` (7). Adding a value one character longer fails at INSERT, not at review time.

> **Porting note (§3).** The *pattern* is the deliverable, not the columns.
>
> **Copy verbatim:** the one-polymorphic-log-table design and its three nullability
> encodings; no-uniqueness-plus-read-time-`DISTINCT ON`; the five index shapes; the
> cascade philosophy (cascade from the owner, no FK on polymorphic targets, copy the
> username into the audit row); `users`, `follows`, `likes`, `comments`, `log_tags`, both
> token tables, `rate_limits` — all nine are domain-free.
>
> **Structural break #1 — the PK type.** TMDB ids are 32-bit integers, which is why the
> whole codebase bounds ids at `MAX_DB_INT = 2_147_483_647`, why `parseShowSlug` extracts
> trailing digits, and why audit finding SEC-06 existed. MusicBrainz MBIDs are UUIDs;
> Spotify ids are 22-char base62. Either switch every id column to `text`/`uuid`
> (invasive: 9 FK columns, the slug parser, every bounds check) **or** keep a local
> `serial` surrogate PK with the external id as a unique secondary column. The second is
> far less invasive and preserves the bounded-int parsing the audit added. Note the
> 500-instead-of-404 bug class does **not** disappear — a malformed UUID raises
> `invalid input syntax for type uuid`, which is the same 500 in different clothes.
>
> **Structural break #2 — the middle tier is not an ordinal.** A season is identified by
> its *position* within a show; an album is not. `unique(show_id, season_number)` becomes
> `unique(artist_id, album_id)` where `album_id` is an external id, and **every place the
> code treats the middle tier as an integer changes type**: `logs.season_number`,
> `absolute_cinema.season_number`, `episodeKey(s,e) = "${s}:${e}"`, the URL segment
> `/season/[season]`, `seasonNumberSchema`, `SEASON_MAX`.
>
> **Structural break #3 — music needs a fourth ordinal (disc).** Either add it (unique
> index and log columns both gain a level) or collapse disc+track into one `position`.
> Decide before writing the schema.
>
> **Structural break #4 — the outer tier is weaker.** Rating a whole *artist* is closer to
> a favourite than to a review, whereas rating a whole *series* is a real verdict. Decide
> whether the top level is loggable at all, or whether the tree is album→track with artist
> as pure metadata. Note the direction also flips: in Cliffhanger `show_id` is always
> present and season/episode narrow it; in music the artist is the outer container, so
> either add `artist_id NOT NULL` as the always-present anchor with `album_id` nullable,
> or drop artist-level logging.
>
> **Column mapping, concretely.** `target_type` ∈ artist\|album\|track; `show_id` →
> `artist_id`; `season_number` → `album_id`; `episode_number` → `track_number`;
> `watched_on` → `listened_on`; `is_rewatch` → `is_relisten`; `contains_spoilers` has **no
> music equivalent — delete it**, along with its toggle, its `LogEntry` field, and the
> blur/reveal branch in the review card. Keep `liked` and `rating smallint 1..10`.
>
> **`list_items` needs a real change.** Cliffhanger's lists can hold only series. A music
> list of *tracks* (a playlist) is the obvious primary use case, so `list_items` must gain
> the same polymorphic target columns `logs` has, and `unique(list_id, show_id)` becomes a
> unique over the whole target tuple. That also breaks `getListOptions`'s simple `EXISTS`
> membership check and the four-poster mosaic (a track has no cover of its own).
>
> **`watch_providers` transfers in shape but not in sourcing.** TMDB bundles providers via
> `append_to_response`; music needs per-service lookups or a link aggregator (Odesli /
> song.link is the JustWatch equivalent), so the ingest fan-out grows. Also note Spotify's
> `market` parameter changes *which tracks and albums are returned*, not just availability
> — it must be threaded into the detail and search calls, unlike TMDB's `region`.

---

## 4. Content ingestion: external catalogue → local mirror

The whole boundary between Cliffhanger and the outside world lives in three modules:
`lib/tmdb/` (HTTP + typed endpoints + pure mappers), `lib/ingest/shows.ts` (cache-through
upserts) and `lib/slug.ts` (URL grammar). No component ever sees a raw provider shape.

### 4.1 The model: cache-through, not a crawler

> "The database is the read path, TMDB is the fill path. Nothing crawls. A show is
> mirrored the first time somebody looks at it, and refreshed when the mirror goes stale.
> A running show refreshes daily; a finished show refreshes weekly."

Why mirror at all: member aggregates (rating histograms, `DISTINCT ON` per-member votes,
watch-time sums, the heatmap) are SQL joins against show/season/episode rows. Without a
local mirror every aggregate would need a network call.

Why on-demand: it bounds the mirror to what the community actually uses, needs no
scheduler or worker, and makes a cold deployment instantly usable.

### 4.2 The HTTP client — order of operations

`tmdbFetch<T>(path, options)` is the single egress point.

1. **Budget first, before any network work.** `consume(BUDGETS.tmdbOutbound, "all")`, where
   the budget is `{ bucket: "tmdb:global", limit: 600, windowSeconds: 60 }`. The identity
   is the literal string `"all"` — one platform-wide counter, not per user or per IP,
   because **the credential is the scarce resource**: TMDB throttles and can ban a key,
   taking the data source down for everyone. On rejection it logs and throws
   `TmdbBudgetError`.
2. **URL assembly.** `new URL(BASE_URL + path)` with `BASE_URL` hard-coded to
   `https://api.themoviedb.org/3`. Params are set with `url.searchParams.set` and any
   `undefined` value is skipped entirely — which is what lets every endpoint pass optional
   filters straight through with no conditional object building. Only the path is
   interpolated, which is why the audit found no SSRF surface.
3. **Auth + caching.** `Authorization: Bearer <env.tmdbReadToken>` (a TMDB **v4**
   read-access token against the **v3** REST API, not an `api_key` query param) plus
   `next: { revalidate, tags }`.
4. **Errors.** Non-2xx throws `TmdbError(status, path, message)`; the response body is
   truncated to 200 characters so an HTML error page cannot flood the log.
5. **The degrading variant.** `tmdbFetchOptional<T>` wraps the above, logs, and returns
   `null`. Its docblock states the rule and its prohibition: *"Never use it where the
   caller needs to distinguish 'missing' from 'broken'."* Accordingly `getShowDetail` and
   `getSeasonDetail` use the throwing form (so ingest can tell a 404 from an outage and
   keep the stale mirror), while every discovery/search/genre/recommendation call uses the
   optional form and coalesces to `[]`.

**There is no retry, no backoff, and no 429 handling anywhere.** A TMDB 429 becomes an
ordinary `TmdbError`. Rate handling is entirely preventative.

### 4.3 Cache TTLs and the tag namespace

```ts
const CACHE_SECONDS = {
  detail:    60 * 60 * 12,      //  43,200s — /tv/{id}, /tv/{id}/recommendations
  season:    60 * 60 * 12,      //  43,200s — /tv/{id}/season/{n}
  discovery: 60 * 60 * 3,       //  10,800s — trending/popular/top_rated/airing/on_the_air/discover
  search:    60 * 10,           //     600s — /search/tv
  static:    60 * 60 * 24 * 7,  // 604,800s — /genre/tv/list
};
```

Tags: `tmdb:show:{id}`, `tmdb:season:{id}:{n}` (deliberately *also* tagged with the show
tag so purging a show purges its seasons), `tmdb:discovery`, `tmdb:genres`. Search and
recommendations pass no tags.

**Critical caveat: nothing in the product ever calls `revalidateTag`.** A repo-wide grep
finds it only in generated types and in the empty test stub. The tag namespace is
forward-looking; today the only invalidation is TTL expiry. Do not assume a purge path
exists.

### 4.4 The mapper layer — pure, unit-tested, and where the awkward cases live

`lib/tmdb/mappers.ts` imports exactly two things: the `NewShow` insert type and
`slugify`. No `db`, no `fetch`, no React. That purity is what makes the awkward provider
cases testable against captured fixtures.

Every non-obvious transform, because each one is a real data-quality workaround:

- **`nullableDate(value)`** returns `null` unless the value matches
  `^\d{4}-\d{2}-\d{2}$`. TMDB returns `""` for absent dates in some payloads. This is also
  load-bearing beyond tidiness: Postgres accepts `infinity` as a valid `date`, and
  `EXTRACT(YEAR ...)` then throws — see invariant I-4.
- **`medianRuntime(runtimes)`** filters `> 0`, sorts ascending, returns the middle (or the
  rounded mean of the two middles). *"The median is a better basis for watch-time totals
  than the first entry, which is often a pilot or a feature-length finale."*
- **Whitespace-only `tagline` / `overview` become `null`.**
- **`mapShowSummary` poisons two fields on purpose.** `seasonCount: 0, episodeCount: 0`
  ("a summary does not know the counts, and overwriting a detailed row with zeros would
  corrupt progress math") and **`syncedAt: new Date(0)`** — the Unix epoch as a
  permanent-stale sentinel.
- **`mapSeasonSummary` deliberately omits `syncedAt`**, which is the mechanism that
  preserves each season's own episode-sync stamp across a show refresh.
- **`mapEpisode`**: `tmdbVoteAverage = vote_count > 0 ? vote_average : null` — *"An unaired
  episode reports 0 votes and a 0 average. Storing null instead keeps it out of the
  heatmap rather than painting it as terrible."*
- **`mapSeasonDetail`** computes `episodeCount` from `detail.episodes.length` rather than
  trusting the declared count, and is the only writer of `seasons.synced_at`.
- **`mapCredits`**: cast is `aggregate_credits.cast.slice(0, 40)` with the first billed
  character as the role; crew is flatMapped one row per job, filtered to
  `{Creator, Executive Producer, Writer, Director, Producer}` because *"crew is dominated
  by one-episode contributors"*, sorted by `order: 999 - episode_count` (so the person
  credited on the most episodes leads) and sliced to 20.

**Trap.** `credits_show_person_role_uq(show_id, person_id, kind, role)` includes the
**nullable** `role`. Postgres treats NULLs as distinct in a unique index, so
`onConflictDoNothing` will *not* dedupe crew rows with a null role. The ingest sidesteps
this by DELETE-ing all credits for the show before inserting. Do not "optimise" that
DELETE into a pure upsert.

### 4.5 The ingest algorithm

```ts
const DAY_MS = 86_400_000;
const RUNNING_TTL  = DAY_MS;       // in_production
const FINISHED_TTL = 7 * DAY_MS;

function isStale(show) {
  if (show.syncedAt.getTime() === 0) return true;              // epoch sentinel
  const ttl = show.inProduction ? RUNNING_TTL : FINISHED_TTL;
  return Date.now() - show.syncedAt.getTime() > ttl;
}
```

The comment names the rejected alternative: **not** `episodeCount === 0`, which is also
the honest value for an announced show with no episodes yet and would pin such a show as
permanently stale, re-running the whole non-transactional write path on every view.

`ensureShow = cache(ensureShowUncached)` — React's per-request `cache()`, because
`generateMetadata` and the page body both need the show, and *"without it, every stale
show ran the whole non-transactional sync twice per page view — including two
DELETE-then-INSERT cycles over its credits."*

`ensureShowUncached(tmdbId)`:

1. `db.query.shows.findFirst`. If present and not stale, **return it. This is the only
   path that avoids the provider entirely.**
2. `getShowDetail(tmdbId)` (throwing variant) then `mapShowDetail`.
3. **Shows upsert: full-row overwrite** — `onConflictDoUpdate({ target: shows.tmdbId, set:
   { ...row } })` — because a detail payload is authoritative for every column including
   `slug` (so a retitled show gets a new slug here).
4. **Seasons upsert on `[showId, seasonNumber]`**, setting six columns via
   `sqlExcluded(col)` and **conspicuously omitting `syncedAt`**.
5. **Credits: DELETE by show_id, then INSERT `onConflictDoNothing`.**
6. **Providers: DELETE unconditionally, scoped to `(show_id, region)`**, then insert if
   non-empty — so a show that lost all its providers correctly ends with zero rows and
   other regions are untouched.
7. On error: log and **return the existing mirror**. *"A TMDB failure does not fail the
   caller when a mirror already exists — the page renders slightly stale rather than not at
   all. Only a cold miss can return null."*

The whole sequence is **non-transactional**: four independent statements. A crash between
the credits DELETE and INSERT leaves a show with zero credits until the next stale window.

**`ensureSeasonEpisodes(tmdbId, seasonNumber)`** fetches a season's episodes only when the
season is actually viewed — *"which keeps a 300-episode show from costing 20 requests on
first visit."* Here the season upsert **does** write `syncedAt`. It ends by calling:

```sql
UPDATE shows SET episode_run_time = median.value
FROM (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY runtime)::int AS value
      FROM episodes
      WHERE show_id = $1 AND season_number > 0
        AND runtime IS NOT NULL AND runtime > 0) AS median
WHERE shows.tmdb_id = $1 AND median.value IS NOT NULL;
```

Rationale: *"TMDB's own `episode_run_time` is an empty array for every show checked, so the
documented fallback was dead and any episode without its own runtime silently contributed
zero minutes to watch time."* So `medianRuntime()` in the mapper is a first guess that is
almost always null in practice, and this SQL median over real mirrored episodes is what
actually populates the column.

**`ensureAllSeasons(show)`** — the latency optimisation:

```
numbered = seasons.filter(s => s.seasonNumber > 0).sort(asc)
latest   = numbered.at(-1)?.seasonNumber
pending  = numbered.filter(s => s.syncedAt === null
                             || (show.inProduction && s.seasonNumber === latest))
for (const season of pending) await ensureSeasonEpisodes(...)   // sequential on purpose
```

Two things to preserve: season 0 is never bulk-filled (only on direct navigation), and the
loop is `await`ed **sequentially** — *"TMDB rate-limits bursts, and a 20-season show would
otherwise fire 20 parallel requests on a cold page."* This turns a 38-request wait on The
Simpsons into one request per genuinely stale season.

### 4.6 `cacheShowSummaries` — the asymmetric backfill upsert

The write path for every discovery surface. Three details, each a bug postmortem:

1. **Resolve genre ids to names** via the 7-day-cached `/genre/tv/list`. Without it a
   summary row is stored with no genres and the recommender cannot see the show at all.
   Commit `857bdea` quantifies it: **370 of 433 mirrored shows (85%) had no genres.**
2. **Dedupe by id in JS before the bulk insert.** *"Postgres refuses an
   `ON CONFLICT DO UPDATE` that would touch the same row twice in a single statement,
   which failed the whole batch and left every candidate in it untagged."* Commit
   `4ffbdeb`: *"Every summary cache write failed silently — the console line was there, the
   candidates were simply untagged."*
3. **The upsert touches only four columns, and only rows with nothing to lose:**

```ts
.onConflictDoUpdate({
  target: shows.tmdbId,
  set: { genres:          sqlExcluded("genres"),
         popularity:      sqlExcluded("popularity"),
         tmdbVoteAverage: sqlExcluded("tmdb_vote_average"),
         tmdbVoteCount:   sqlExcluded("tmdb_vote_count") },
  setWhere: sql`shows.genres = '[]'::jsonb`,
})
```

*"A detail sync knows more than a summary does — its episode counts, networks, and creators
must not be overwritten by this path — but a row with no genres has nothing to lose."*
**Consequence: once a row has genres, this path can never refresh its popularity or vote
counts. Only a detail sync can.**

### 4.7 The two entry shapes

Every consumer picks one:

**A. Id-first, DB-backed.** `parseShowSlug` then `ensureShow` then `notFound()` on null.
Used by every content route, and — importantly — by Server Actions as an **existence and
foreign-key guard before writing member data**. `saveLog`, `addToList` and the collection
actions all call `ensureShow` first. Ingest is load-bearing for integrity, not just
display.

**B. Summary-first, render-then-mirror.** A discovery surface fetches provider summaries,
renders them directly through `cardFromSummary` (which computes the slug on the fly so the
poster still links correctly), and `await`s `cacheShowSummaries` so the row exists by the
time the link is clicked.

`/search` is the one place with a second budget: `BUDGETS.searchByIp` at 30/60s; over the
limit it substitutes `Promise.resolve([])` for the remote search and renders from the
local mirror alone — *"a scraper gets far less than they asked for, a person hitting the
limit barely notices."*

### 4.8 Pagination: stitching 20-per-page into 24-per-page

TMDB's page size is fixed at 20 and its ceiling is page 500. The poster grid reaches six
columns and 20 is not divisible by 6, leaving a four-cell hole. So:

```ts
const TMDB_PAGE_SIZE = 20;
const GRID_PAGE_SIZE = 24;    // divisible by 3, 4 and 6 — every breakpoint's column count

windowBounds(page, size) {
  const offset = (Math.max(1, page) - 1) * size;
  return { firstPage: Math.floor(offset / 20) + 1, skip: offset % 20 };
}
maxWindowPage(size) { return Math.max(1, Math.floor((500 * 20) / size)); }  // 416 at size 24
```

`discoverShowsWindow` fetches `skip + size + 1` cards (**one past the window, so a full
window is distinguishable from the end**), breaks at upstream page 500, dedupes by id in a
`Set`, and breaks when a short page arrives. A test asserts `GRID_PAGE_SIZE % columns === 0`
for `[3, 4, 6]` so a new breakpoint cannot silently reintroduce the hole.

The dedupe comment is precise about its own limits: *"TMDB's popularity ordering is
recomputed continuously, so the same show really does come back on two consecutive pages.
Dropping repeats keeps one poster from appearing twice in a single grid; it cannot make
the ordering stable across pages, and no amount of client-side work would."*

### 4.9 Slugs: readable prefix, numeric id as the key

```
/show/breaking-bad-1396
```

`slugify(input)` is an ordered pipeline: NFKD normalise, strip combining marks, lowercase,
**delete** `'` and `’` outright (so "It's Always Sunny" becomes `its-always-sunny`, not
`it-s-...`), collapse every non-alphanumeric run to one hyphen, trim edge hyphens,
`slice(0, 80)`, trim again (the slice can land mid-hyphen), and fall back to the literal
string `"show"`. `slugify("日本語")` is therefore `"show"`.

**There is no collision handling and no unique constraint on `slug`, by design.** Two
shows named "The Office" both store `the-office` and are distinguished purely by the id
suffix. The slug is recomputed on every detail sync, so a rename changes it — and old URLs
keep working because the parser ignores everything before the trailing id. There is no
canonical redirect: any slug text in front of the right id renders the page.

The parser is hardened, and the hardening **order** matters:

```ts
const MAX_DB_INT = 2_147_483_647;   // largest Postgres integer

parseShowSlug(slug) {
  const match  = /-(\d+)$/.exec(slug);
  const digits = match ? match[1] : (/^\d+$/.test(slug) ? slug : null);
  if (digits === null) return null;
  if (digits.length > 10) return null;             // BEFORE Number()
  const id = Number(digits);
  return Number.isSafeInteger(id) && id > 0 && id <= MAX_DB_INT ? id : null;
}
```

The length check precedes `Number()` *"so a 30-digit segment cannot round to something
valid."* `parseBoundedInt(value, {min, max})` requires `^\d{1,10}$` — rejecting `"1e30"`,
`"0x10"`, `" 5 "`, `"-1"` — and returns **null rather than clamping**, so the caller can
404. `parsePage` is the single exception: it clamps to 1, because *"a silly `?page=` should
not break a link."*

Both bounds exist because of real production 500s: `/show/breaking-bad-9999999999` raised
`value out of range for type integer`, and `?page=1e30` reached `OFFSET` as the string
`"5e+31"`.

One deliberate quirk, pinned by test: `parseShowSlug("show--4")` is **4**, not −4, because
the separator is itself a hyphen, so a minus sign can never enter.

### 4.10 Images

`lib/tmdb/images.ts` is the only `lib/tmdb/*` module without `import "server-only"` —
*"Client-safe: only the public CDN base is used, never the API token."*

```ts
const url = (size, path) => (path ? `${TMDB_IMAGE_BASE}/${size}${path}` : null);
```

Returns **null, not a placeholder**, so every call site branches. Five typed size ladders:
posters `w154|w185|w342|w500|w780|original` (default `w342`), backdrops
`w780|w1280|original` (`w1280`), stills `w300|w500|original` (`w300`), profiles
`w185|h632|original` (`w185`), logos `w45|w92|w154|w300|original` (`w92`). `PosterCard`
pairs each card size with one CDN width — *"no point shipping w500 into a 132px rail."*

`next.config.ts` allowlists exactly one remote pattern (`image.tmdb.org/t/p/**`), so
overriding `NEXT_PUBLIC_TMDB_IMAGE_BASE` alone is not enough to repoint the CDN — the
config and the CSP must move in lockstep.

> **Porting note (§4).**
>
> **Copy essentially unchanged:** the whole client shape (base URL, param serialisation,
> revalidate/tags, two error classes, a platform-wide outbound budget), the
> throwing/optional variant split *with its written rule*, the pure-mapper boundary, the
> cache-through `ensure*` functions, the epoch-sentinel plus `setWhere` asymmetric
> backfill, the React `cache()` dedup, the error-swallow-to-stale-mirror policy,
> `slugify`, the bounded parsers, `lib/view.ts`'s card adapters, and the `searchByIp`
> degrade-to-mirror behaviour.
>
> **Retune the TTLs.** They are tuned to how fast TV metadata moves. An album's tracklist
> is *immutable once released*, so album detail can be 7–30 days rather than 12 hours;
> artist detail ~24h so new releases appear; new-releases browse ~3–6h; search 10 min
> unchanged. The `season` TTL has no analogue — on Spotify tracks arrive inside the album
> payload, so `ensureSeasonEpisodes` collapses into `ensureAlbum` unless the album exceeds
> the 50-track page limit. `ensureAllSeasons` becomes `ensureDiscography`, and the
> "fetched once and finished airing cannot change" rule is *stronger* for music.
>
> **Endpoint mapping (Spotify).** `/tv/{id}` maps to `GET /albums/{id}` (already embeds
> `tracks.items`, so the `append_to_response` trick is unnecessary) plus `GET /artists/{id}`.
> `/tv/{id}/season/{n}` maps to `GET /albums/{id}/tracks` (paging only) or
> `GET /artists/{id}/albums`. `/trending/tv/week` maps to `GET /browse/new-releases`.
> **`/tv/popular` and `/tv/top_rated` have no direct equivalent** — use search sorted by
> popularity, a curated seed, or Last.fm charts. **`/tv/airing_today` and `/tv/on_the_air`
> have no analogue at all: delete them.** `/discover/tv` maps to `GET /search` with the
> `q=` filter grammar, which is far weaker: **Spotify search has no `with_genres` AND-join**,
> so the two-genre intersection query (§7.6) must become post-filtering, and there is **no
> `vote_count.gte` floor** — substitute album popularity or a follower threshold.
> `/tv/{id}/recommendations` maps to `GET /artists/{id}/related-artists`, which is
> artist-level, so the recommender's per-show neighbour provenance becomes per-artist.
> **Verify availability first: Spotify deprecated related-artists and `/recommendations`
> for new applications in late 2024.**
>
> **Endpoint mapping (MusicBrainz).** `/ws/2/release-group/{mbid}?inc=artists+releases+tags+ratings`,
> `/ws/2/release/{mbid}?inc=recordings`, `/ws/2/artist/{mbid}?inc=release-groups`,
> `/ws/2/release-group?query=`. There are **no trending or popular endpoints at all**, so
> pair MusicBrainz (metadata) with Last.fm (charts) the way this app pairs TMDB with
> nothing. Note the four-tier problem: artist → release-group → release → recording. The
> whole URL and rating scheme assumes exactly three tiers. **Collapse release-group and
> release, and decide it before writing any code.**
>
> **Sharp hazards specific to music.**
> - **Date precision.** Spotify's `release_date_precision` can be `year` or `month`, so
>   `nullableDate`'s strict `^\d{4}-\d{2}-\d{2}$` would silently null a large fraction of
>   the catalogue. Relax it or normalise to `YYYY-01-01` — but keep the `infinity` guard.
> - **Reissues.** Always use the release-*group* first-release date, or every remaster
>   reads as a recent album.
> - **Aspect ratio.** Album art is 1:1, not 2:3. Every grid, card, hero crop and the
>   `GRID_PAGE_SIZE` column arithmetic must be re-proportioned. There is **no "backdrop"
>   image** in either provider — the hero needs a different treatment (blurred cover art as
>   its own scrim, or an artist image where available).
> - **Image URL shape.** Spotify gives a pre-rendered `images[]` array (typically
>   640/300/64), so `posterUrl(path, size)` becomes `pickImage(images, minWidth)` and there
>   is no path concatenation. Cover Art Archive is closer to TMDB
>   (`https://coverartarchive.org/release-group/{mbid}/front-500`) — but it **302-redirects
>   to archive.org**, so *both* origins must appear in `img-src` and in `remotePatterns`.
> - **Pagination ceilings.** Spotify: `limit <= 50`, `offset + limit <= 1000` — so
>   `maxWindowPage` drops from 416 to ~41 at size 24 and the UI must lean on filters rather
>   than deep paging. Setting `limit = 24` makes the stitching problem vanish entirely,
>   which is the simplest port. MusicBrainz: `limit <= 100`, no hard offset ceiling, but
>   1 req/s makes multi-page stitching expensive.
> - **`backfillEpisodeRunTime` should not be ported.** It is a TMDB data-quality
>   workaround. Every Spotify/MusicBrainz track carries a reliable `duration_ms`, so the
>   equivalent is a deterministic `SUM(duration_ms)` per album written at ingest.
> - **The recommender's 18 parallel `ensureShow` calls (§7.7) would violate MusicBrainz's
>   1 req/s policy outright.** Serialise them or pre-warm.

---

## 5. The rating system

Everything in `lib/ratings.ts`, `lib/ratings/dual.ts` and `components/rating/*` is pure —
no I/O, no React — which is exactly why it is the unit-tested layer (20 tests in
`tests/ratings.test.ts`, plus 4 dual-rating tests in `tests/taste.test.ts`).

### 5.1 Storage: integers 1–10, displayed as 0.5–5 stars

```ts
const MIN_RATING = 1;
const MAX_RATING = 10;
const LOW_CONFIDENCE_THRESHOLD = 5;

starsToInt(stars)      = Math.min(10, Math.max(1, Math.round(stars * 2)));
intToStars(value)      = value / 2;                        // a bare division, no clamp
tmdbToStars(voteAvg)   = Math.round((voteAvg / 2) * 10) / 10;
formatStars(stars)     = Number.isInteger(stars) ? String(stars) : stars.toFixed(1);
formatRating(value)    = value == null ? "—" : formatStars(intToStars(value));
```

**Why integers:** *"so histogram bucketing and equality comparisons never touch floating
point."* A stored 7 is exactly 3.5 stars, `counts[rating - 1]` is an exact array index, and
`shown === halfValue` in the star input is a safe strict equality. This is stated three
separate times across the repo, which makes it the load-bearing decision of the subsystem.

**There is no 0.** Zero stars is unrepresentable; "no rating" is SQL NULL. `starsToInt(0)`
and `starsToInt(-4)` both return 1. Any UI offering "0 stars" is a bug — clearing sends
`null`.

**`starsToInt` has zero production callers.** The UI computes stored integers directly
(`fullValue = star * 2`, `halfValue = fullValue - 1`); the real input guard is the Zod
schema in the action.

### 5.2 Histograms — always ten buckets

```ts
type HistogramBucket = { value: number;   // stored 1..10
                         stars: number;   // 0.5..5
                         count: number;
                         ratio: number }; // share of the tallest bucket, 0..1
```

Two constructors with identical output: `histogram(ratings[])` (increments, drops
out-of-range values silently) and `histogramFromCounts(rows)` (assigns, because SQL already
grouped). Both allocate `new Array(10).fill(0)`, compute `peak = Math.max(...counts, 0)`
(the `, 0` seed prevents `-Infinity` on empty), and emit `ratio = peak === 0 ? 0 : count / peak`.

**Always exactly ten buckets, even for zero ratings** — *"so the chart keeps a stable shape
when a show has only a handful of ratings"* and *"the silhouette of a show with twelve
ratings stays comparable to one with twelve thousand."* Rendering floors each bar at
`max(2px, ratio%)` — *"a 2px floor keeps an unused bucket legible as a bucket."*

### 5.3 The seven-bracket colour scale — hue, not lightness

The largest block of rationale in the subsystem:

> "Hue, not lightness. The first version of this was a single amber ramp, which meant a 6.2
> and an 8.4 episode were two barely different shades of the same colour and a heatmap of a
> long run read as one flat wash. These are the brackets seriesgraph uses, and they are
> worth copying exactly because a viewer who has seen one of these grids already knows that
> blue is the peak and purple is the floor — a palette people can read without the legend
> beats a prettier one. Note that the order is not a simple spectrum: dark green ('Awesome')
> outranks bright green ('Great'), and blue sits above both. That is deliberate."

| key | label | min (inclusive, 0–10) | from | to |
| --- | --- | --- | --- | --- |
| `garbage` | Garbage | 0 | `#5b3f8f` | `#8a67cf` |
| `bad` | Bad | 4 | `#c22f22` | `#ef4a35` |
| `average` | Average | 5.5 | `#d9791a` | `#fba52a` |
| `good` | Good | 6.5 | `#dfbb1b` | `#ffe155` |
| `great` | Great | 7.5 | `#249a45` | `#48d76c` |
| `awesome` | Awesome | 8.5 | `#0f5c30` | `#1c8a49` |
| `cinema` | **Absolute Cinema** | 9.25 | `#2570e0` | `#57a3ff` |

Unrated is the CSS string `var(--heat-none)` (resolving to `#22262e`) — **not a hex**, so
anything parsing the return value must not be handed a null score. `ratingBracket(NaN)` is
`"none"`, not `"garbage"`.

```ts
ratingBracket(score)  // walks the array DOWNWARDS; the highest satisfied `min` wins
ratingColor(score) {
  const band     = bracketFor(score);
  const ceiling  = nextBand?.min ?? 10;
  const span     = ceiling - band.min;
  const position = span <= 0 ? 1 : (Math.min(score, 10) - band.min) / span;
  return mix(band.from, band.to, clamp(position, 0, 1));   // straight sRGB lerp
}
```

*"The brackets carry the meaning; the gradient carries the precision"* — a 7.6 and an 8.4
are distinguishable while both stay unmistakably "Great". The top bracket's ceiling is 10
and the bottom's floor is 0, so both ends get the full gradient.

`bracketLegend()` reverses the array (best first) and samples each swatch at the
**midpoint** of its range — *"so a swatch is not the shade that sits next to the
neighbouring bracket."*

Two regression tests encode the original defect: one asserts `ratingColor(7.4) !==
ratingColor(7.6)` **and** that the red channel *falls* across that boundary (a hue move,
not a brightness move); another asserts within-bracket shading while `bracketLabel` stays
"Great" for both.

### 5.4 Consensus — two numbers, never merged

Stated three times. From the component:

> "A show with six member ratings must not borrow the authority of TMDB's twenty thousand,
> so each number keeps its attribution and its vote count."

From the spec:

> "TMDB's average and vote count are labelled as TMDB's, shown next to Cliffhanger's member
> average and vote count. Where a show or episode has fewer than five member ratings, the
> interface leads with the TMDB baseline and says so. **The two numbers are never averaged
> together into one unattributed score.**"

Implementation: a two-column card, TMDB on the **left** (that is how "leads with the
baseline" is expressed physically), member on the right. `LOW_CONFIDENCE_THRESHOLD = 5`;
below it the member column gets `opacity-60` and a footer sentence reads exactly *"Too few
member ratings — showing TMDB's baseline as the reference."* The member average is forced
to `null` when `count === 0` regardless of what was passed.

A `label` prop exists for honesty: a season has no season-level TMDB score, so the season
page passes `label="TMDB series score"` while showing season-scoped member stats.

**The heatmap generalises this to a source switch rather than a blend:** four sources
(`member` / `tmdb` / `mine` / `predicted`), each returning exactly one number —
*"switching source rather than blending them keeps each number attributable."*

**Nothing in the codebase combines the two into one score.** No Bayesian prior, no
shrinkage toward the TMDB mean, no vote-weighted blend. Provider consensus enters a
computed number only in the taste model, where *measured agreement* weights predictions —
never a displayed community average.

**The scale bridge is accidental and fragile.** TMDB's `vote_average` is 0–10 decimal and
the member average is a mean of stored 1–10 integers, so both happen to be on 0–10 — which
is the *only* reason both can be passed to the same `<Stars>` component (it divides by 2
internally).

### 5.5 `DISTINCT ON` — one vote per member

Because a rewatch is a new row, a naive `AVG(rating)` would let one enthusiastic member
vote five times. **Every aggregate collapses to one row per member first.** The canonical
form:

```sql
WITH scoped AS (
  SELECT DISTINCT ON (l.user_id) l.user_id, l.rating, l.liked
  FROM logs l
  JOIN users u ON u.id = l.user_id
  WHERE l.show_id      = $tmdbId
    AND l.target_type  = $targetType            -- 'show' | 'season' | 'episode'
    AND <l.season_number  IS NULL | = $n>
    AND <l.episode_number IS NULL | = $n>
    AND u.is_guest = false
  ORDER BY l.user_id, (l.rating IS NOT NULL) DESC, l.created_at DESC
)
SELECT rating,
       COUNT(*) FILTER (WHERE rating IS NOT NULL)::int AS rating_count,
       COUNT(*)::int                                   AS watched_by,
       COUNT(*) FILTER (WHERE liked)::int              AS likes
FROM scoped GROUP BY rating;
```

**Three details that are each load-bearing:**

1. `ORDER BY ..., (l.rating IS NOT NULL) DESC, l.created_at DESC` — Postgres sorts
   `false < true`, so DESC puts *rated* logs first. **A member's rating survives a later
   unrated rewatch mark.** Without this clause, marking an episode watched after rating it
   silently withdraws the rating from the community average.
2. `AND u.is_guest = false` on every public aggregate. *"One click of a guest's must not
   move a figure members read as consensus."*
3. An omitted season/episode becomes an **explicit `IS NULL`**, not an omitted predicate —
   otherwise a series-level query would sweep in every season and episode row.

The average is then computed in TypeScript as a genuine weighted mean
(`Σ(rating × count) / Σcount`), not SQL `AVG`.

**Six variants exist and each carries the pattern independently — nothing centralises it:**

| Query | DISTINCT ON key | Notes |
| --- | --- | --- |
| `getRatingStats` | `(user_id)` | the canonical form above |
| `getEpisodeAggregates` | `(user_id, season_number, episode_number)` | pre-filters `rating IS NOT NULL`; feeds the heatmap |
| `getSeasonAggregates` | `(user_id, season_number)` | |
| `getMostRatedShows` | `(user_id, show_id)` | then `GROUP BY show_id ORDER BY rating_count DESC` |
| `getTopShows/Seasons/Episodes` | widening keys | no guest filter (own profile); ties break on `s.tmdb_vote_count DESC` |
| `getRatedShows` (taste) | `(show_id)` | single member, so no join needed |

The four non-canonical ones pre-filter `rating IS NOT NULL` in the WHERE and order purely
by `created_at DESC`. **Changing one without the others makes a member's rating vanish from
one surface while persisting on another.**

**Two deliberate exceptions.** `getViewerShowState` does *not* use `DISTINCT ON` — it pulls
every one of the member's logs for one show `ORDER BY created_at DESC` and reduces in
TypeScript (first row seen wins), because *"a show's logs for one member are small (tens to
low hundreds), so reducing in TypeScript beats five separate aggregate queries."* And the
year-in-review histogram deliberately has no `DISTINCT ON` at all — *a rewatch rated twice
in one year counts twice, because it is a diary statistic, not a consensus figure.*

### 5.6 Dual rating — a verdict on the whole, beside the mean of the parts

```ts
type DualRating = {
  showRating:     number | null;  // their verdict on the whole work, 1..10
  episodeAverage: number | null;  // unweighted mean of the parts they rated
  episodesRated:  number;
  divergence:     number | null;  // showRating − episodeAverage, signed, stored units
};
```

The rationale, verbatim:

> "A show rating is a judgement of the whole thing: how much they enjoyed it as a work,
> including the shape of its run and how it ended… An episode average is the mean of the
> episodes they actually rated. It answers a different question… They diverge for real
> reasons, and the divergence is interesting rather than an error: a show of consistently
> fine episodes that fumbles its ending rates lower as a whole than its episodes average,
> and a patchy show with three transcendent episodes often rates higher as a whole than its
> mean hour."

`dualRating` takes an **Iterable**, not an array, so callers hand it `Map.values()`
directly. Out-of-range episode ratings are skipped rather than skewing the mean.

`divergenceNote` speaks only when **both** gates pass: `episodesRated >= 3` and
`|divergence| >= 1.5`. The threshold is in **stored units — 1.5 is three quarters of a
star**, and an inline comment exists purely to prevent that misreading. Copy:
`"You rate the whole more highly than its parts."` / `"Strong episodes, weaker as a whole."`

The panel labels the right-hand figure *"Derived from N episodes"* and gives it no control
— *"so nobody looks for a control to set it."*

**A season gets its own pair, computed against that season's episodes only:** *"A season is
its own work — some shows are anthologies, and a member who thought season four was the weak
one needs to be able to say so without it being folded into a series verdict."* Reusing the
series-wide average on a season page is the named rejected alternative: it would produce
*"a series statistic wearing a season's label."*

Dual rating is **viewer-private**. It is never computed for the community.

### 5.7 The star input

> "Ten hit targets across five stars. Hovering previews, clicking commits, and clicking the
> value you already have clears it — the same gesture Letterboxd uses, which members expect.
> Arrow keys step by half a star, so the control is usable without a pointer."

- Five dim `★` glyphs with an absolutely-positioned amber overlay clipped by a percentage
  width, so half stars always align and fractional averages render continuously.
- Two invisible half-width buttons per star (`tabIndex={-1}`) drive hover and click.
  `fullValue = star * 2`, `halfValue = fullValue - 1`.
- `commit(next) { onChange(next === value ? null : next) }` — clicking your current value
  clears.
- Keyboard on the wrapper: Right/Up → `min(10, current + 1)`; Left/Down → `next < 1 ? null
  : next` (**stepping below half a star clears rather than clamping**); Backspace/Delete →
  null. **The keyboard path bypasses `commit`, so toggle-off applies to clicks only.**
- A11y: the wrapper `<div>` is the control — `role="slider"`, `aria-valuemin={0}`,
  `aria-valuemax={5}`, `aria-valuenow={intToStars(shown)}`. **The contract is expressed in
  stars, not stored units**, and `aria-valuenow` tracks the hover preview.
- **No debounce.** Every keypress fires `onChange`, which in the show panel is one Server
  Action round trip plus a `router.refresh()` per keystroke.

Two consumers, both optimistic with rollback: the show panel (`saveLog({ showId, rating })`
— only the field it owns) and onboarding quick-rate (`saveLog({ showId, rating,
watchedOn: null })` — an explicit null so an onboarding session never floods the diary).

### 5.8 `escapeLike` — the search-wildcard fix

Seventeen lines whose docblock is an incident report:

> "Without this, `%` matches every row — a search for '%' returned the whole catalogue and
> the entire member list — and a title containing `_` or `%` could never be found by typing
> it. Postgres' default escape character is a backslash."

```ts
escapeLike(v)      = v.replace(/[\\%_]/g, (c) => "\\" + c);   // backslash, percent, underscore
containsPattern(v) = `%${escapeLike(v)}%`;                     // escape FIRST, then wrap
```

Used by `searchLocalShows`, `searchUsers` and the admin account search. No query specifies
an explicit `ESCAPE` clause — the code relies on Postgres' default backslash.

**Naming trap: three unrelated meanings of "like" in one codebase.** (a) `lib/like.ts` is
SQL `LIKE` escaping. (b) `logs.liked boolean` is the *author's own* heart on the thing they
watched. (c) The `likes` table is *other members* hearting a review or a list.

> **Porting note (§5).**
>
> **Copy verbatim:** the 1–10 integer store with 0.5–5 star display and all four
> transforms; the ten-bucket histogram and its renderer; `DISTINCT ON` one-vote-per-member
> *including the `(rating IS NOT NULL) DESC` tiebreak* — which matters **more** in music,
> where relistening is the norm and a member may hold dozens of logs per track; the
> guest-exclusion predicate; `escapeLike`/`containsPattern` (music titles contain `_` and
> `%` far more often than TV episode titles do); the star input; the null-not-zero contract
> on `averageRating`; the whole `mix`/bracket/legend maths.
>
> **`dualRating` is the most valuable transplant in the subsystem** and maps nearly
> one-to-one, but one structural asymmetry must be handled deliberately: a season is a time
> slice of a continuing work, whereas **an album is the primary work**. So in music the
> album should be the default scope and the artist level optional — the reverse of
> Cliffhanger, whose default is `scope="show"`. The prose survives: *"You rate the whole
> more highly than its parts"* is verbatim reusable; *"Strong episodes, weaker as a whole"*
> becomes *"Strong tracks, weaker as an album."* Keep the 1.5-stored-unit gate; consider
> raising the 3-rated-parts gate, since 3 of 12 tracks is a much lower bar than 3 of 62
> episodes.
>
> **The consensus card is the hardest piece to port,** because neither music provider hands
> you a `(score, votes)` pair.
> - **MusicBrainz** has real user ratings (`rating.value` as a float **0–5**, plus
>   `rating.votes-count`). So `tmdbToStars(v) = round(v/2*10)/10` becomes
>   `mbToStars(v) = round(v*10)/10` — **no halving** — and **the scale bridge breaks**:
>   MusicBrainz is 0–5 while your member average is 0–10, so unlike Cliffhanger you cannot
>   hand both to the same `<Stars>`. Either double the provider value or halve the member
>   value; **pick one and pin it in a test. This is the single sharpest hazard in the port.**
> - **Spotify** has no ratings at all, only `popularity` 0–100 with no vote count. The
>   honest adapter is `p / 20`, the caption relabelled "Spotify popularity", and the "N
>   votes" line either removed or replaced. Better: drop the baseline column rather than
>   dressing popularity up as a rating. The `label` override prop already exists for exactly
>   this kind of honesty.
> - `LOW_CONFIDENCE_THRESHOLD = 5` transfers unchanged.
>
> **The palette's provenance is TV.** The exact bounds and hexes are copied from seriesgraph
> so a TV-grid viewer recognises them; in a music app that recognition argument evaporates.
> Either keep the seven bands and rename only the top one ("Perfect", "Desert Island",
> "Album of the Year"), or design fresh — but preserve the two properties the tests enforce:
> adjacent brackets differ in **hue**, and shade still varies **within** a bracket.
>
> **Three scales, no type safety.** Stored units (1–10 integers), stars (0.5–5), and
> community averages (float on the 0–10 stored scale) all flow through code typed `number`.
> Passing 4.5 where 9 is expected renders a 2.25-star bar with no error. Consider branded
> types in the rebuild.

---

## 6. Logging, progress, and the one write path

> "Watching an episode and reviewing a series differ only in which columns are filled,
> which is why there is one `saveLog` rather than six near-identical actions."

### 6.1 `saveLog` — the single write

`saveLog(input): Promise<ActionResult<{ logId: number }>>`, wrapped in `guard("saveLog", …)`.

**Zod schema** (composed from the shared library, §13.2):

```ts
targetSchema = { showId: showIdSchema,
                 seasonNumber:  seasonNumberSchema.optional(),
                 episodeNumber: episodeNumberSchema.optional() }

saveLogSchema = targetSchema.extend({
  rating:           z.number().int().min(1).max(10).nullable().optional(),
  review:           reviewBody.nullable().optional(),      // max 20_000
  containsSpoilers: z.boolean().optional(),
  watchedOn:        calendarDate.nullable().optional(),    // see §13.2
  isRewatch:        z.boolean().optional(),
  liked:            z.boolean().optional(),
  tags:             tagList.optional(),                    // max 12, each ≤32 after normalise
  createNew:        z.boolean().optional(),
})
```

A parse failure returns the flat string `"That log does not look right."` — **no field
detail leaks**.

**Authorization, strictly in this order:**

1. **`guard()`** consumes a rate-limit token *before anything else, including before
   `requireUser()`* — `write:user` 120/60s for a signed-in caller, `write:anon` 30/60s
   keyed on client IP otherwise. Then the email-verification gate (§13.4). `saveLog` is
   **not** exempt.
2. **`requireUser()`** — re-reads the `users` row, so a JWT for a deleted account cannot
   write.
3. **`ensureShow(showId)`** — the show must exist locally or be fetchable, else
   `"Could not find that show on TMDB."`
4. **Guest review cap** — if a review is present and the caller is a guest, count their
   existing reviews *excluding this target* and refuse at 3 (§12.4).
5. **Target existence.** For an episode target: `ensureSeasonEpisodes(...)` **then** verify
   the exact `(showId, seasonNumber, episodeNumber)` row exists. For a season target,
   verify the season row. The comment names the attack: *"Without this, a crafted call
   publishes a review of 'S42E999' that renders on the show page and links to a 404, and
   inflates the author's public episode and watch-time totals."*

**Finding the row to patch:** unless `createNew`, `SELECT id FROM logs WHERE <target
conditions> ORDER BY created_at DESC LIMIT 1`.

**The mutation, inside one `db.transaction`:**

```ts
// UPDATE path — patch semantics
const patch = { updatedAt: new Date() };
if (data.rating           !== undefined) patch.rating           = data.rating;
if (data.review           !== undefined) patch.review           = review;
if (data.containsSpoilers !== undefined) patch.containsSpoilers = data.containsSpoilers;
if (data.watchedOn        !== undefined) patch.watchedOn        = data.watchedOn;
if (data.isRewatch        !== undefined) patch.isRewatch        = data.isRewatch;
if (data.liked            !== undefined) patch.liked            = data.liked;
await tx.update(logs).set(patch).where(eq(logs.id, existing.id));

// TAGS — only touched when data.tags is present; a full replace, not a merge
if (data.tags) {
  await tx.delete(logTags).where(eq(logTags.logId, id));
  const cleaned = [...new Set(data.tags)].filter(Boolean);
  if (cleaned.length) await tx.insert(logTags).values(cleaned.map(tag => ({ logId: id, tag })));
}
```

**`undefined` means "leave alone"; an explicit `null` still clears the column.** This is
the fix for the audit's only CRITICAL finding, SEC-01: before it, the compact rating panel
— which knows only the rating — was handed hardcoded nulls for everything else and resent
them, so *clicking Like or a star on a show you had reviewed destroyed your own review,
diary date, spoiler and rewatch flags, and every tag.*

**The transaction exists because** *"a rejected tag used to leave the log edited and every
existing tag deleted, while the member was told the save had failed."*

`review` is normalised once before the transaction: `data.review?.trim() ? trimmed : null`
— a whitespace-only review becomes SQL NULL, which keeps it out of every review list.

**Revalidation:** `revalidatePath("/show/[slug]", "layout")` (the segment-tree form,
because *"show pages are keyed by slug, which we do not have here"*), `revalidatePath("/")`,
plus the member's profile and diary.

### 6.2 The other six log actions

| Action | Validation | Behaviour |
| --- | --- | --- |
| `toggleEpisodeWatched` | `targetSchema + { watched, watchedOn? }` | **watched=true:** if any row exists, do nothing (idempotent, never duplicates). Else insert a bare mark with `watched_on = today UTC`. **watched=false:** delete only the **latest** row — *"so a rewatch history is not wiped by one mis-click."* Three rewatch rows need three clicks. |
| `markSeasonWatched` | inline schema | `ensureSeasonEpisodes` first, then **only aired episodes**: `air_date IS NOT NULL AND air_date <= today`. *"The interface already refuses to let a member tick an unaired episode one at a time; the bulk path has to agree, or 'mark season watched' claims they watched next month's finale."* One multi-row INSERT for the missing ones. |
| `unmarkSeasonWatched` | **none** | `DELETE … AND review IS NULL AND rating IS NULL`. That filter is the entire safety mechanism — a rated or reviewed episode survives. Exempt from the verification gate. |
| `markShowWatched` | **none** (bare number) | Loops `markSeasonWatched` per numbered season, then inserts a show-level log. **Each nested call re-enters `guard()`** — a 20-season show burns 21 rate-limit tokens, 21 `requireUser()` round trips and 21 revalidation passes for one click, and a mid-loop refusal is silently skipped by `if (result.ok)`. |
| `deleteLog` | **none** (bare number) | Explicit ownership check with two distinct messages: `"That entry no longer exists."` vs `"That is not your entry."` `log_tags` cascade. Exempt from the verification gate. |
| `toggleAbsoluteCinema` | `targetSchema` with season/episode **required** | A thin shell over `lib/cinema` (§8.1). |

**Two destructive actions use a two-press arm/confirm with a 4000 ms self-disarm instead of
a modal.** Delete: *"the first press arms it, the second commits, and it disarms itself
after a few seconds — a deleted log cannot be recovered."* Mark-whole-series cycles three
labels: "Mark whole series watched" → "Sure? this marks every episode" → "Series marked
watched".

### 6.3 The log dialog

One form serves all three target levels — *"the target decides which columns get filled —
and it both edits the entry a member already has and adds a second one for a rewatch.
Keeping those two paths in one surface is why the submit row has two buttons rather than
the dialog having two variants."*

Fields in order: poster + a code line (`S01E04` / `Season 2` / nothing for a series log),
`StarInput`, an **"Add to diary" checkbox that literally is the null-`watched_on`
encoding**, a `<input type="date" max={today}>` shown only when checked, three
`aria-pressed` toggles (liked / rewatch / spoilers), a review textarea, and a
comma-separated tag input.

Tag parsing client-side: split on `,`, `trim().toLowerCase().slice(0, 32)`, drop empties,
dedupe via a Set, stop at 12. *"Tags are truncated rather than rejected: the server caps
length and count, and a silent trim beats bouncing the whole form for a typo in a minor
field."*

`submit(createNew)` encodes two rules:

```ts
watchedOn: createNew ? (watchedOn ?? isoDate()) : watchedOn,   // a second viewing is dated today
isRewatch: createNew || isRewatch,                             // …and always flagged a rewatch
```

`onOpenChange` **refuses to close while a save is in flight** — *"Dismissing mid-save would
hide the outcome of a request already in flight."* Fields are re-seeded from `initial` on
**open** (not cleared on close), so an abandoned edit is discarded.

A `path: "save" | "again"` state is what stops both submit buttons reading "Saving…" at
once.

**The guest-cap refusal is rendered as an offer, not an error** — the client detects it by
`error?.includes("Create an account")` and swaps in an amber panel with `/signup` and
`/login` links. *"A refusal that says 'create an account' is not an error the member can
fix by trying again."* The trade is explicit: the client couples to the server's **wording**
because `ActionResult` has no machine-readable `code` field.

### 6.4 `initial` is the entire safety mechanism

The dialog **always posts every field**, so patch semantics do not protect it — only the
narrow controls that send one key. `getViewerShowState` therefore returns the full newest
log per target:

```ts
type ViewerLog = { id; rating; review; watchedOn; isRewatch; containsSpoilers; liked; tags };
```

> "Any control that saves a log must be primed with these real values. Priming a form with
> blanks and then saving it is how a rating click silently erases a review — the form sends
> what it was told, not what exists."

**Known defect in the shipped code:** the episode *detail page* mounts `LogDialog` with no
`initial` prop even though `viewerState.episodeLogs.get(key)` is in scope. Saving from that
page over an existing episode log writes nulls across the board — exactly the SEC-01 shape
the audit fixed everywhere else. Every other mount site passes it.

### 6.5 The narrow writers

Three call sites exploit "only write what you sent" by sending a single field:

```ts
onRate(next)  → saveLog({ showId, rating: next })   // optimistic, rollback, then router.refresh()
onLike()      → saveLog({ showId, liked: next })    // optimistic, rollback, NO refresh (nothing else depends on it)
QuickRate     → saveLog({ showId, rating, watchedOn: null })
```

> "These controls send only the field they own. `saveLog` leaves every column it was not
> given alone, so nudging a star cannot touch a written review — the quick panel
> deliberately does not carry review or diary state."

Because `StarInput.commit` sends `null` when you click your current value, clicking your
rating **clears the rating column while leaving the review, diary date and flags intact** —
"un-rate" without "un-log".

### 6.6 Progress: four formulas, and they do not agree by construction

There is no stored progress.

**1. Show-page counter.**
```ts
numberedWatched = [...watchedEpisodes].filter(k => !k.startsWith("0:")).length;
watchedCount    = show.episodeCount > 0 ? Math.min(numberedWatched, show.episodeCount)
                                        : numberedWatched;
```
*"Specials are excluded, because the denominator (TMDB's episode count) excludes them too —
counting them made '29 / 62' out of 20 real episodes plus 9 specials. Clamped for the same
honesty reason."*

**2. Season completion.** `aired.length > 0 && aired.every(e => watchedEpisodes.has(key(e)))`
where `aired` excludes null or future air dates. This also drives which season the accordion
auto-opens: the first with unwatched aired episodes.

**3. Profile / continue-watching** (`lib/stats/profile.ts`) — a completely separate SQL
path with its own `SELECT DISTINCT (show_id, season_number, episode_number)`, its own
`season_number > 0` filter, and `clampWatched(w, t) = t > 0 ? Math.min(w, t) : w` because
*"'63 of 62 episodes' reads as a bug even when the underlying logs are legitimate."*

**4. Poster bar.** `progressPercent(watched, total) = total <= 0 ? 0 : min(100, max(0,
round(watched/total*100)))` — *"so a mirror that lags behind TMDB cannot report 104%
watched."*

**Formulas 1 and 3 must be kept in agreement by hand; there is no shared helper.**

**Watch time** sums `COALESCE(e.runtime, s.episode_run_time, 0)` over the same DISTINCT
episode set — the episode's own runtime, falling back to the show's derived median, falling
back to zero.

### 6.7 Reads over `logs`

Every read returns one display-ready shape so *"components never assemble that themselves"*:

```ts
type LogEntry = {
  id; targetType; rating; review; containsSpoilers; watchedOn; isRewatch; liked; createdAt;
  seasonNumber; episodeNumber; episodeName;
  likeCount; commentCount; tags: string[];
  author: { id; username; displayName; avatarSeed };
  show:   { tmdbId; name; slug; posterPath; firstAirDate };
};
```

The base query is `logs ⋈ users ⋈ shows` plus a **LEFT JOIN to episodes on all three
columns** (left, because show- and season-level logs have nulls). Two correlated
subqueries live in the SELECT list for `likeCount` and `commentCount`. Tags are attached
with **one** extra `WHERE log_id IN (…)` query bucketed into a Map — *"one extra query
rather than one per row."*

`const notGuest = eq(users.isGuest, false)` is applied to `getReviews`, `countReviews`,
`getGlobalFeed`, `getRecentReviews` — and **deliberately not** to `getDiary`,
`getRecentLogs`, `getMemberReviews`, `getFollowingFeed`, `getLog`, because a guest's own
surfaces must read normally.

> **Porting note (§6).**
>
> **Copy verbatim:** patch semantics with the `undefined`/`null` distinction; the
> transaction around log + tags; the delete-only-the-newest-row rule; the
> `review IS NULL AND rating IS NULL` guard on bulk unmark; the two-press arm/confirm with
> self-disarm; `initial`-priming discipline; the `LogEntry` projection with correlated
> count subqueries and one-query tag attachment; the guest filter placement; optimistic
> writes with explicit rollback plus `router.refresh()` on success.
>
> **Rename and re-shape:** `targetTypeOf` flips direction (§3 porting note);
> `toggleEpisodeWatched` becomes `toggleTrackListened` — **keep the release-date gate**,
> pre-release singles make it a real state; `markSeasonWatched`/`markShowWatched` collapse
> to `markAlbumListened`/`markDiscographyListened`. The `season_number > 0` specials filter
> has no ordinal analogue — replace it with an explicit exclusion of compilations, live
> albums and deluxe bonus discs, which is *harder* than TV specials because MusicBrainz
> carries secondary types rather than a numeric sentinel (`secondary_types = '{}'` instead
> of `> 0`).
>
> **Delete outright:** `contains_spoilers` and its toggle. **Rewrite:** `episodeCode(s,e)`
> to `S03E07` has no music counterpart — pick a track locator convention (bare number,
> `1-07` for multi-disc, or vinyl-side `B3`) and pin it in a test, which `episodeCode`
> currently is not.
>
> **Watch time gets simpler:** `SUM(COALESCE(t.duration_ms, 0)) / 60000`. Spotify and
> MusicBrainz both supply reliable per-track duration, so the median fallback branch is
> unnecessary. Keep the `SELECT DISTINCT` so relistens do not inflate the total.
>
> **Timezone debt to fix while porting.** Every date is `new Date().toISOString().slice(0,
> 10)` — UTC, on both client and server, with no timezone handling anywhere. A member in
> UTC+13 logging at 09:00 local gets yesterday's date; a member in UTC−8 logging at 18:00
> can have the client send a date the server's UTC-based upper bound already considers
> future, failing the save with *"You cannot log something you have not watched yet."*

---

## 7. Discovery, taste, and recommendations

`lib/taste/` is content-based, not collaborative:

> "This is **content-based**, not collaborative: there is no population of members to find
> neighbours among."

The product surface says so to the member rather than hiding it. Every constant below was
derived from a measured regression on ten purpose-built accounts (a prestige purist, an
anime-only viewer, a sitcom comfort-watcher, a reality devotee, a contrarian, a flat rater,
a hard-SF specialist, one who rates only episodes, and two ordinary viewers). **All
arithmetic is in stored units: 1 unit = half a star.**

### 7.1 Signals: what feeds the model, and what does not

`getRatedShows(userId)` runs one statement with two CTEs and produces each show's
*effective rating*:

```sql
show_level    : DISTINCT ON (show_id) rating  WHERE target_type='show'    ORDER BY show_id, created_at DESC
episode_level : AVG(rating) GROUP BY show_id  over DISTINCT ON (show_id, season_number, episode_number)
effective     : COALESCE(show_level.rating, episode_level.rating)
```

The series rating always wins, *"because it is the more direct statement of how much they
liked the thing."*

Each rated show is reduced to: `genres[]` (names), `networks[]` (names), `year`,
`runtime` (median episode minutes), `tmdbAverage`, `tmdbVotes`, `countries[]`.

**Deliberately unused despite being mirrored:** creators, cast/credits, keywords,
season-level ratings, watch providers, tags, review text, the `liked` flag, watch dates.
*(Inference: no comment states this. Two commit messages name the metadata ceiling —
"it would need finer metadata (keywords, or a similarity graph) rather than another
coefficient" — and respond by adding the neighbour graph rather than creator affinities,
suggesting a judgement that one real similarity edge beats another sparse categorical
bucket.)*

### 7.2 `reliableAverage` — Bayesian shrinkage of the crowd score

```ts
const CONSENSUS_PRIOR = 7;
const CONSENSUS_PRIOR_WEIGHT = 400;
reliableAverage(avg, votes) = avg === null ? null : (avg * n + 7 * 400) / (n + 400);
```

Worked values, pinned by test: `(8.6, 4) → 7.016`; `(8.6, 3000) → 8.412`;
`(3, 5) → 6.951` (**a badly-rated obscure show is pulled *up* toward the prior**).

> "A show with 8.6 from 40 votes is not comparable to 8.6 from 3,000, but the raw average
> says they are identical. Without this, obscure titles with a handful of enthusiastic
> ratings outranked canonical television — an 8.58 supernatural school comedy above The
> Expanse for a hard-science-fiction viewer."

Applied in exactly three places and **always the same transform**, so the correlation
coefficient and the quantity it multiplies come from the same distribution.

### 7.3 `buildTasteProfile` — eleven fields

| Field | How |
| --- | --- |
| `sampleSize` | count |
| `seenGenres` / `seenCountries` | `Set` of everything anywhere in the history, liked or not |
| `meanRating` | arithmetic mean |
| `spread` | sample SD, n−1 denominator, 0 when fewer than 2 values |
| `crowdBaseline` | mean of `reliableAverage(...)` over rated shows — **explicitly not the member's own mean**: *"Comparing a candidate's TMDB score to the member's own mean rating instead conflated two different distributions and turned the consensus term into a blanket popularity bonus."* |
| `genres` / `networks` | `affinities(...)` — see below |
| `eraCentre` / `runtimeCentre` | `preferredCentre(...)` — see below |
| `consensusAlignment` | Pearson correlation of (own rating, shrunk crowd score); returns **0** for fewer than 3 pairs or zero variance, *"to prevent a spurious ±1"* |

**`affinities()` — leans with deviation capping and support shrinkage.**

```ts
for each rated show, for each key:  push(clamp(show.rating - meanRating, -2, +2))
raw     = mean(deviations)
lean    = raw * (n / (n + SHRINKAGE))     // SHRINKAGE = 3
support = n
sort DESCENDING BY LEAN
```

The **±2 cap is load-bearing**: *"Uncapped, a single floor rating outweighs a ceiling one,
because a mean around 7 leaves far more room below than above. That asymmetry made AMC a
NEGATIVE signal for a member whose favourite show is Breaking Bad, purely because they also
rated The Walking Dead at the bottom — and then docked Better Call Saul, its direct
spin-off, for sharing the network."*

Shrinkage: 1 rating shrinks by 1/4, 2 by 2/5, 3 by 1/2, 5 by 5/8, 10 by 10/13.

**The descending-lean sort is depended on by three consumers** and is not obviously so.

**`preferredCentre()` — only enthusiasm pulls the centre.**

```ts
w = Math.max(0, show.rating - meanRating);   // shows at or below the mean contribute nothing
return weight === 0 ? null : weighted / weight;
```

*"Only above-average ratings pull the centre; below-average ones say nothing about where
their taste sits, only where it does not."* A perfectly flat rater gets `null` for both
centres, which silently disables the era and runtime penalties.

**`leanFor()` — support-weighted, not a flat average.**

```ts
lean = Σ(entry.lean × entry.support) / Σ entry.support
```

The rejected flat mean is named: *"a member with a +1.07 Comedy lean from five comedies had
it averaged against a −1.32 Sci-Fi & Fantasy lean derived from a single show, which pushed
a genuinely good animated comedy below their own mean. Weighting by support makes the
well-evidenced attribute dominate, which is what a person would do."*

### 7.4 `predictShowRating` — the complete formula, term by term

```
reasons = []

STEP 1 — base deviation
  genre     = leanFor(candidate.genres,   profile.genres)
  network   = leanFor(candidate.networks, profile.networks)
  coverage  = clamp((genre.matched.length + network.matched.length) / 4, 0, 1)
  deviation = genre.lean * 0.7 + network.lean * 0.3
  rating    = profile.meanRating + deviation * coverage
```
Genre 0.7 / network 0.3 because *"genre is the strongest signal in practice, network a
weaker one."* Coverage saturates at **4 recognised attributes total**, mixing genres and
networks in one denominator. Without it, *"a show carrying the single tag 'Drama' took a
member's full Drama lean and was scored as though it were purely and definitively that —
which is how an ABC medical soap reached rank three for a Sopranos and Succession viewer."*

```
STEP 2 — the neighbour term (the largest single term)
  if (candidate.neighbourOf) {
    enthusiasm = clamp(neighbourOf.rating - profile.meanRating, 0, 2)
    rating += 0.3 + enthusiasm * 0.35              // range [0.3, 1.0], never negative
    reasons.push(`Viewers of ${neighbourOf.name} tend to watch this too`)
  }
```
> "Everything else — genre, network, era, runtime — moves a prediction by at most a couple
> of tenths, and candidates inside one genre pool differ by less than that, so without this
> term the ranking within a pool collapsed to TMDB's own score order."

```
STEP 3 — reason text (no score effect)
  genre   lean >  0.3 → "You rate {key} above your average"
  genre   lean < -0.3 → "You tend to rate {key} below your average"
  network lean >  0.4 → "{key} has worked for you before"

STEP 4 — two absence penalties, both keyed on the MEMBER's attributes
  evidence = min(1, profile.sampleSize / 8)
  (a) shares nothing with a readable history → rating -= 0.8 * evidence
  (b) lacks the member's signature genre (first entry with lean > 0.4 and support >= 2)
        → rating -= min(0.6, signature.lean * 0.4) * evidence
```
Both are keyed on the *member's* attributes rather than the share of the *candidate's* own
tags that are unfamiliar, because the earlier version did the latter and *"rewarded sparse
metadata twice over: a show tagged only 'Drama' paid nothing while a richly-tagged Sherlock
paid for its Mystery tag, so the blandest possible match outranked the apt one."* The
invariant: **a candidate cannot improve its score by describing itself less.**

```
STEP 5 — unfamiliar country (flat, no evidence scaling, gated on sampleSize >= 5)
  rating -= 0.5     // no reason string is emitted

STEP 6 — the crowd term, signed by MEASURED alignment
  reliable  = reliableAverage(candidate.tmdbAverage, candidate.tmdbVotes)
  deviation = reliable - profile.crowdBaseline
  weight    = alignment >= 0 ? alignment * 0.5 : alignment * 0.3
  rating   += deviation * weight
```
Negative alignment is **inverted, not clamped to zero**: *"Clamping a negative alignment to
zero discarded the clearest signal a contrarian gives us; inverting it means someone who
reliably rates canonised hits poorly is offered the overlooked instead."* The lower
coefficient is deliberate — *"disagreement is a noisier signal than agreement."*

```
STEP 7 — era pull (15-year dead zone, caps at a 39-year gap)
  if (gap > 15) rating -= min(0.6, (gap - 15) / 40)

STEP 8 — episode-length pull (15-minute dead zone, caps at a 42-minute gap; no reason string)
  if (gap > 15) rating -= min(0.45, (gap - 15) / 60)

RETURN { rating: clamp(rating, 1, 10),
         confidence: confidenceFor(profile, candidate, matchCount),
         reasons: reasons.slice(0, 3) }
```

Step 8's rationale is worth quoting because it is a general lesson: *"episode length
separates the half-hour comedy from the hour-long drama more reliably than TMDB's genre
tags do… This was computed and displayed but never scored; **a signal that exists and is
ignored is worse than one that does not exist, because it reads as covered.**"*

Reasons are pushed in a fixed order (neighbour, genre, network, shares-nothing,
not-signature, consensus, era) and truncated to three — **and the UI renders only
`reasons[0]`**, so whenever a neighbour reason exists it is the only reason a member sees.

### 7.5 Confidence — multiplicative, floored, capped at 0.90

```ts
evidence       = min(1, log10(1 + sampleSize) / log10(41));   // saturates at 40 rated shows
discrimination = clamp(spread / 2, 0, 1);                     // 1 at a 1-star SD
coverage       = clamp(attributeMatches / 4, 0, 1);
combined       = max(0.15, evidence) * max(0.1, discrimination) * max(0.25, coverage);
return round(clamp(combined * 1.25, 0, 0.9) * 100) / 100;
```

> "Summing let a member who rated forty shows all 8 out of 10 reach 0.59 — but a profile
> with no variance contains no preference, so no amount of volume or tag familiarity should
> buy confidence. Each term can veto: knowing the member (evidence), the member having said
> something (discrimination), and knowing the candidate (coverage). The floors keep a good
> signal on two axes from being annihilated by a weak third."

The 0.90 ceiling is an epistemic position, and the `/for-you` footer prints the reasoning
to the member verbatim: *"Confidence is capped at 90% — with N rated shows and no
collaborative signal, certainty would be an overclaim."*

Labels: `< 0.35` low (rose), `< 0.6` moderate (neutral), else good (teal).

### 7.6 Ranking — shrink toward the member's mean by confidence

```ts
rankingScore(profile, p) = profile.meanRating + p.confidence * (p.rating - profile.meanRating);
```

For a member whose mean is 6.5, a 0.55-confidence prediction of 7.5 scores 7.05 while a
0.18-confidence prediction of 7.6 scores 6.70 — **the well-supported lower prediction
wins.** The defect this fixed: *"Confidence was computed, displayed, and then ignored by the
sort — it only ever broke exact float ties, which averaged predictions essentially never
produce. So the list routinely led with the model's least-supported guesses."*

The displayed number stays the model's actual estimate: *"the displayed number should remain
the model's actual estimate, not a value distorted for sorting."*

### 7.7 Retrieval — seven sources, because retrieval dominated ranking

The judge verdict that drove commit `4ffbdeb`: **"43 distinct titles fill 100 slots" across
ten very different members.** After: **77 distinct across 80 slots.**

**Exclusions:** `SELECT DISTINCT show_id FROM logs WHERE user_id=$1 UNION SELECT show_id
FROM watchlist WHERE user_id=$1`.

**Genre seeds:** `weight = lean × √support`, filtered to `lean > 0 && support >= 2`, top 2.
*"A mild preference over six shows is a better seed than a strong one over two."*
**Fallback when that list is empty:** sort by `support` alone and take the top 2 — because
*"a genre present in everything a member rates has a lean of exactly zero, so their defining
lane produced no query at all"* and single-lane viewers were being served the popularity
chart.

**Network seeds:** `lean > 0.2 && support >= 2`, top 2, mapped through a hand-maintained
14-entry `FEATURED_NETWORKS` table (Netflix 213, HBO 49, Prime Video 1024, Apple TV+ 2552,
Disney+ 2739, Showtime 67, AMC 174, BBC One 4, ABC 2, NBC 6, CBS 16, FOX 19, Starz 318,
Hulu 453) — *"TMDB has no 'popular networks' endpoint."* **Only these 14 can ever become a
query.**

**Seven parallel sources in one `Promise.all`:**

1. `byGenre` — pages **1 and 2** of `discover({ genreId, sort: vote_average.desc, minVotes: 300 })` per seed
2. `byPair` — pages 1 and 2 of `discover({ genreIdsAll: [g1, g2], sort: vote_average.desc, minVotes: 150 })`. **TMDB joins `with_genres` with a comma = AND**, so this asks for Sci-Fi *and* Mystery. Lower vote floor because the intersection pool is much smaller. *"One shared tag is a weak match — a hard-science-fiction viewer and a psychological thriller both carry 'Mystery' — so requiring two of a member's genres at once is what separates them."*
3. `byNetwork` — one page per network id, `minVotes: 150`
4. `similar` — `/tv/{id}/recommendations` for each of the member's **top 3** rated shows
5. `getTrending()` 6. `getPopular()` 7. `getTopRated()`

**The neighbour provenance index is built here, not later:** *"once the pools are flattened
into one list of ids, the fact that a show arrived via The Expanse rather than via the
popularity chart is lost, and that fact is the strongest signal available."* On collision
the highest-rated source wins.

**Then:** `cacheShowSummaries(all)` → hydrate from `shows` → **two hard filters** —
`genres.length > 0` (*"Ranking something the model knows nothing about is worse than
omitting it"*; measured 53/100 → 0/100 attribute-less recommendations) and
`tmdbVoteCount >= MIN_NOTABILITY_VOTES` (150; *"Not a quality bar — a notability one. Below
this, an average is noise: one candidate carried 8.6 stars from four votes"*) → score →
sort by `rankingScore`, tie-broken by `tmdbVoteCount DESC` → **dedupe by
`name.toLowerCase() + "::" + year`** (TMDB carries separate entries for regional versions)
→ take a shortlist wider than the final list *"so re-scoring has room to reorder"* →
**detail-sync the top `DETAIL_SYNC_LIMIT = 18` in parallel and re-score** (because *"a
discovery summary carries no networks and no episode length, so for most candidates two of
the model's signals were structurally inert"*) → final sort → slice.

### 7.8 Cold start — three distinct gates, three distinct messages

| Gate | Condition | Surface |
| --- | --- | --- |
| Too few ratings | `rated.length < MIN_RATED_SHOWS (5)` | "Not enough to go on yet" + a progress bar + *"A series rating counts, and so does rating individual episodes."* |
| No variety | `profile.spread < 0.4` (checked **before any provider call**) | "Your ratings are too alike" + *"Rating the things you disliked helps more than rating the things you loved. The gaps are the signal."* |
| Cold pool | `ids.length === 0` | "Nothing new to suggest" |

> "Ten indistinguishable predictions dressed as a ranked list is worse than saying there is
> nothing to say yet."

**The thresholds are deliberately inconsistent across surfaces:** the home genre rails and
the ad-targeting affinity both need only **3** rated shows, while `/for-you` needs **5**. So
a member with 3 or 4 ratings sees personalised rails and personalised ads while being told
they have "not enough to go on."

`DEFAULT_GENRES = ['Comedy', 'Documentary', 'Sci-Fi & Fantasy']` for the rails —
*"deliberately not the most popular genres — Drama and Comedy would fill the page with the
same shows the trending rail already has."*

### 7.9 Episode-level taste is a completely separate model

`forecastEpisodes(episodes, showBaseline)` reuses none of the above.

```ts
anchor     = viewerBaseline ?? showBaseline;       // mean of the member's own ratings in THIS show
ownWeight  = min(1, ratedCount / 8);               // saturates at 8 rated episodes
tmdbWeight = 0.55 - ownWeight * 0.25;              // 0.55 cold → 0.30 fully warm

// per episode
if (viewerRating !== null) return { rating: viewerRating, predicted: false, confidence: 1 };
rating     = anchor;
confidence = 0.2 + ownWeight * 0.5;
if (episode.tmdbAverage != null && tmdbBaseline != null) {
  rating     += (episode.tmdbAverage - tmdbBaseline) * tmdbWeight;   // RELATIVE, never absolute
  confidence += 0.15;
}
return { rating: clampRating(rating), predicted: true, confidence: min(0.85, confidence) };
```

Two stated signals in priority order: (1) *"Their own ratings inside this show. By far the
stronger one… people are more consistent within a show than across their library."*
(2) *"How this episode compares to the rest of the show, per TMDB. A finale that stands well
above the show's own baseline is likely to land above their personal baseline too."*

**The crowd contributes only a relative shape** — *"the crowd's scale is not the member's."*
Real ratings are never overwritten, *"so a row reads as one continuous line."* The caller
returns `null` rather than a neutral guess when the member has fewer than 5 rated shows —
*"an unlabelled fabrication is worse than an absent feature."*

### 7.10 The evaluation loop that produced these weights

Worth reproducing as a *method*, not just a fact. `scratch/dump.ts` runs
`getRecommendations(id, 10)` for every account with an email matching `%@taste.test` and
prints top-6 titles, predicted stars, confidence, first reason, and a global **"distinct
titles across N slots"** diversity metric.

- **`857bdea`** fixed four compounding causes at once: unmapped genre ids (85% of rows
  untagged), attribute-less candidates being rankable at all, face-value crowd averages
  (introduced `reliableAverage` and the notability floor), and no cost for untouched
  categories. Measured: the anime-only account went from *Breaking Bad, NCIS, Grey's* to
  *Avatar, Arcane, Invincible, Hunter x Hunter*.
- **`d303bf3`** came from **five critics judging all 100 recommendations, then two skeptics
  attacking both the findings and the first round of fixes**. The skeptics proved the
  unseen-genre penalty had made the worst recommendation *worse*. That round introduced
  member-keyed absence signals, the ±2 cap, support-weighted leans, alignment on shrunk
  scores, `crowdBaseline`, inverted negative alignment, multiplicative confidence, the
  no-variety gate, the country penalty, scoring `runtimeCentre` for the first time, and the
  top-18 detail sync.
- **`4ffbdeb`** acted on the verdict that retrieval mattered more than ranking.

**The honest ceiling, stated twice and not fixed:** *"TMDB's genre buckets cannot separate
Law & Order: SVU from Twin Peaks under 'Mystery', or Supernatural from The Expanse under
'Sci-Fi & Fantasy'… it would need finer metadata (keywords, or a similarity graph) rather
than another coefficient."* Plus: TMDB itself lists *Behind Her Eyes* as a neighbour of
*Severance*, so the neighbour term inherits the provider's own noise. **Do not spend tuning
effort re-deriving that conclusion.**

> **Porting note (§7).**
>
> **The scoring skeleton transfers verbatim**: anchor on the member's mean, add a
> support-weighted attribute deviation scaled by coverage, add a neighbour bonus, subtract
> absence/era/length penalties, clamp. So do the exclusion set, the two withholding gates
> and their copy (*"The gaps are the signal"* is domain-free and worth keeping word for
> word), `rankingScore`, the reasons-derived-from-the-maths rule, and `forecastEpisodes`
> (which maps almost perfectly: anchor on the listener's mean among tracks they rated on
> this album; crowd shape from per-track popularity relative to the album's own mean).
>
> **Every constant is in stored half-star units.** The ±2 cap, the 0.8 penalty, the 0.5
> country penalty, the 0.4 spread gate, the 0.3–1.0 neighbour term, the 0.3/0.4 reason
> thresholds. **Rescale all of them together or the model becomes inert or unhinged.**
>
> **Retune these specifically:**
> - **Coverage denominator 4.** Music tag vocabularies run to hundreds of fine-grained
>   tags, so a candidate routinely matches 8+ and coverage saturates for everything. Raise
>   it to ~8 or normalise tags to a coarser taxonomy first.
> - **`SHRINKAGE = 3`** will underfit against noisy music tags. Raise it, or pre-filter to
>   tags above a use-count threshold.
> - **The `-0.8 * evidence` "shares nothing at all" penalty essentially never fires** once
>   `seenTags` holds hundreds of entries. Gate it on a coarse parent-genre projection.
> - **Era: a 15-year dead zone is far too wide for music** (1968 vs 1983 vs 1998 are
>   different sonic worlds). Try `min(0.6, (gap - 8) / 25)`.
> - **Runtime: rescale hard.** Mean *track* length, not album duration — the purpose is
>   format separation within a shared tag (3-minute pop single vs 9-minute post-rock vs
>   60-second hardcore). A 15-*minute* dead zone is meaningless on a 1–12 minute range; try
>   `if (gap > 1.5) rating -= min(0.45, (gap - 1.5) / 6)`. Consider adding track count
>   (EP vs double LP) as a second, TV-less signal.
> - **Country −0.5 is probably too harsh** — music is far less language-gated than
>   television. Try −0.25, or use release *language* instead, which is the actual barrier
>   for vocal music. (Note: Spotify does not expose artist country at all, so this
>   attribute forces MusicBrainz.)
>
> **Networks → labels, or artists.** A label is the closest structural analogue (a
> curatorial house with a recognisable style, a small enough set to hard-code, available as
> an id). But Spotify returns `label` as **free text with wild variation** ("4AD", "4AD
> Ltd.", "Beggars Group / 4AD"), so normalisation is required; MusicBrainz label MBIDs
> avoid it. **A strong alternative: use the ARTIST as the second attribute axis** — an
> artist affinity is arguably a stronger music signal than a label affinity, and it has no
> clean TV equivalent because a show is not made repeatedly by one named author.
>
> **`reliableAverage` is the hardest piece to port** because the shrinkage needs a
> `(score, n)` pair. Spotify `popularity` is 0–100 with no count and is recency-decayed.
> MusicBrainz ratings are sparse. Workable substitutes: Last.fm `listeners` as *n* with
> `playcount/listeners` as intensity; an external RYM/AOTY average; or **build the crowd
> score from your own members once you have any** — the option the TV app could not take.
> Keep the shape, set `PRIOR` to the middle of the chosen scale, tune `PRIOR_WEIGHT` so the
> shrink bites at typical n.
>
> **The neighbour graph is the single biggest porting risk** — it is the term that makes
> the ranking work and its source has no guaranteed music equivalent. In preference order:
> (1) Last.fm `artist.getSimilar` / album similarity, genuinely co-listening derived and
> closest in spirit; (2) MusicBrainz relationships (member-of, collaborated-with, shared
> producer) — clean but sparse and not taste-derived; (3) Spotify related-artists **(verify
> deprecation first)**; (4) an embedding index over audio features. **Without any neighbour
> graph, expect the measured collapse: every candidate in a tag pool within a few
> hundredths and ranking degenerating to crowd-score order.**
>
> **Dedup must get stricter, not merely renamed.** The TV problem was occasional regional
> duplicates. In music the same album exists as original / remaster / deluxe / 2CD /
> Japanese pressing / vinyl reissue, with different titles **and** different years — so
> title+year would dedupe almost nothing. Use the release-group MBID, falling back to
> `normalise(artist) + "::" + normalise(title)` with parenthetical suffixes stripped. Also
> exclude every other release in the same release-group as anything already logged, or the
> list fills with remasters of albums the listener already rated.
>
> **Consider raising `MIN_RATED_SHOWS` from 5 to 8–10.** Rating an album is a far
> lower-effort act than rating a 60-hour series; listeners will rate 20 in one sitting, and
> the extra evidence buys confidence directly.

---

## 8. The two signature features

### 8.1 Absolute Cinema — a quota'd honour

A member may "crown" an individual episode. Two hard rules, both enforced **server-side
against the database, never taken from the request**:

1. **Entry condition:** the member's *latest* rating for that exact episode must equal
   `MAX_RATING` (10 = five stars). Not 9, not unrated.
2. **Quota:** `ABSOLUTE_CINEMA_QUOTA = 10` marks held at once, **across all shows**.

> "An honour with no ceiling is a second 'like' — the mark only means something because an
> eleventh requires taking one back. Ten is also few enough that a member can hold the list
> in their head."

Clearing a mark frees its slot instantly; the limit is on marks *held*, never marks ever
given.

The name is not decorative: the **top bracket of the entire rating colour scale** is
literally labelled "Absolute Cinema" (score ≥ 9.25), and the badge colour
`--color-cinema: #57a3ff` is the exact top-of-band colour of that bracket. Two literals in
two files with only a comment binding them — change one and the badge silently stops
matching the heatmap's peak.

**`crownEpisode` — the exact algorithm:**

```
Step 1 (OUTSIDE the transaction) — rating gate
  latest = SELECT rating FROM logs
           WHERE user_id=? AND show_id=? AND target_type='episode'
             AND season_number=? AND episode_number=? AND rating IS NOT NULL
           ORDER BY created_at DESC LIMIT 1
  if (latest !== MAX_RATING) return { ok: false, reason: "not-five-star" }
```
The `ORDER BY created_at DESC LIMIT 1` is the whole point: *"the qualifying question is what
they think of it NOW, not whether they ever gave it five stars and later changed their
mind."*

```
Step 2 (INSIDE db.transaction)
  a. held    = SELECT count(*) FROM absolute_cinema WHERE user_id = ?
  b. already = SELECT id FROM absolute_cinema WHERE <the four target columns> LIMIT 1
  c. if (already) return { ok: true, marked: true, used: held }     ← BEFORE the quota check
  d. if (held >= 10) return { ok: false, reason: "quota-full" }
  e. INSERT; return { ok: true, marked: true, used: held + 1 }
```

**Why the idempotence check precedes the quota check:** at ten held, a naive order would
refuse the member's own tenth crown. A test exists solely to lock this.

**Why a transaction:** *"Two tabs both sitting at nine used would otherwise each read nine,
each insert, and leave the member holding eleven."* The unique index only stops duplicate
rows for the *same* episode; it does nothing about two different episodes.

**`uncrownEpisode` never checks the rating** — *"A member who has cooled on an episode must
be able to take the mark back, and requiring the five stars to still be in place would trap
the slot behind a rating they no longer agree with."* Uncrowning something never crowned is
a silent no-op.

**The five-star precondition is deliberately not a constraint**, and the profile read
deliberately does not filter on it either: *"a member who later lowers the rating should
keep the mark until they clear it themselves rather than have the database silently discard
their choice."* A crowned episode later rated 3 stays crowned and stays on the profile.

**Why a separate table rather than a `logs` column:** *"The honour belongs to the episode,
not to one viewing of it, and a member can hold several logs for the same episode after a
rewatch; and the quota is counted per member, which is one index scan here instead of a
filtered count over every log they own."*

**The client button.** `used` is a **global** count and already includes the current episode
when `marked` is true, so the optimistic arithmetic is:

```ts
held = used + (optimistic === null || optimistic === marked ? 0 : optimistic ? 1 : -1);
exhausted = !isMarked && held >= quota;
```
*"while a click is in flight it has to move locally too, or the last free slot still reads
as free."* The exhausted state **disables rather than hides** the button:

> "the button spends most of its life telling somebody they would have to give something
> up. That is the feature working, not a failure state, so the exhausted button explains
> itself rather than disappearing."

Three surfaces offer the toggle, all gated identically on `viewerRating === MAX_RATING`:
the episode page hero, the episode row on the season page, and the episode row in the show
accordion. *"Five stars is the whole entry condition, so the control does not exist anywhere
else."*

**The profile strip.** Ten crowned episodes as 16:9 **stills**, five across on large
screens so ten fills exactly two rows. *"These are hours of television rather than shows — a
list of ten frames is a better answer to 'what does this person love' than a list of ten
titles."* Unfilled slots are drawn as dashed frames **for the owner only**, because *"they
say what the quota is far more plainly than a sentence about it would"*; another member's
empty shelf renders nothing at all.

The read uses a `LEFT JOIN LATERAL` to report the current rating **without filtering on
it** — the comment is explicit that this read *"is not the place to quietly overrule them."*

Seven tests run the real functions against a throwaway PGlite database: the boundary
(10 ok, 11th refused), slot reuse, sub-five-star refusal, no-rating refusal,
latest-rating-wins, idempotence at the boundary, and no-op uncrown.

### 8.2 The episode heatmap — the signature view

Every episode of a show as one coloured cell: **seasons down the Y axis, episode numbers
across the X axis.**

**Grid construction.** Group the flat episode array by season, **skipping season 0 entirely**
(*"specials break the grid's shape"*), sort seasons ascending and episodes within each
season ascending. If the result is empty, render only *"Episode data has not been mirrored
for this show yet."*

**Layout.** A horizontally scrollable `min-w-fit` column; one flex row per season; the row
label is a fixed 2rem right-aligned mono gutter reading `S3`. Cells are **16px on mobile,
20px from `sm`**, with 4px gaps. Rows are **ragged** — each season is exactly as wide as its
own episode count, with no padding to the widest. `hover:scale-125` is a transform, so a
hovered cell overlaps its neighbours rather than reflowing the row. The hover readout is a
**fixed-height** paragraph for the same reason.

**Every cell is a real `<Link>` to the episode page.** That is what makes the grid
keyboard-navigable: `onFocus`/`onBlur` mirror `onMouseEnter`/`onMouseLeave`, and each cell
carries an `sr-only` sentence with the code, title, score and `", Absolute Cinema"` when
crowned. **Replacing the anchors with divs destroys the accessibility story.** (Note the
readout paragraph itself is not `aria-live` — screen readers get the per-cell text.)

**Four colour sources, switched not blended:**

| Source | Value | Availability |
| --- | --- | --- |
| `member` | community average for that episode | default when member data exists |
| `tmdb` | provider average | default otherwise |
| `mine` | the viewer's own rating | button **disabled** with the title *"Rate an episode to see your own colours"* |
| `predicted` | `viewerRating ?? predictedRating` | disabled with *"Rate five shows to unlock predictions"* |

Disabled rather than hidden, each with an explanatory `title`. The prediction gate is
enforced server-side (`forecastForViewer` returns `null`), not just in the UI.

A crowned cell gets `ring-2 ring-cinema` **instead of** the default `ring-1 ring-inset
ring-black/25` — the crown ring is *outset*, so it eats into the 4px gap. The background
colour is untouched: **the mark annotates the rating, it does not replace it.**

> **Porting note (§8).**
>
> **Absolute Cinema ports essentially unchanged** as "Desert Island Tracks" or "Perfect
> Songs": same quota of 10, same latest-rating-must-be-max precondition, same transactional
> count-then-insert, same idempotent unique index, same "uncrowning never re-checks the
> rating" rule, same three surfaces. Only the target tuple and the name change. Ten may need
> revisiting: a heavy listener has thousands of rated tracks versus hundreds of rated
> episodes, so consider whether ten is still scarce — a product decision, not a code one.
>
> **The heatmap is the single most important design call in the port.** Two options:
> - **(a) Per-album:** tracks across one row, one row per disc. Usually a *single row of
>   10–14 cells* — a strip, not a grid — carrying far less information than a TV run.
> - **(b) Per-artist discography:** **one row per album** (chronological, replacing
>   seasons), **one cell per track** (replacing episode numbers).
>
> **(b) is the true analogue of "the shape of the run."** It draws a career arc — the
> sophomore slump, the late-period return to form — the way the TV grid draws a show's
> quality curve. Use (b) on the artist page and keep (a) as a compact strip on the album
> page. Two consequences: rows are *raggeder* than in TV (a 22-track album beside a 6-track
> EP has no equivalent in a series whose seasons are roughly uniform), and the row label
> grows from `S3` to an album name or release year, so the fixed 2rem gutter must widen.
>
> **The season-0 exclusion maps to excluding non-album releases** — singles, live albums,
> compilations, bonus discs. Decide that filter explicitly; it is the equivalent of
> "specials break the grid's shape."
>
> **The biggest data gap in the whole port is the third colour source.** `tmdbAverage` per
> episode has no clean music equivalent: MusicBrainz per-recording ratings are sparse,
> Spotify has only track **popularity** 0–100 (which measures streams, not quality —
> **relabel the source "Popularity", do not call it a rating**). If you drop it you also
> lose the cold-start default (`hasMemberData ? member : tmdb`) and must design an
> empty-grid state. Members / Yours / Predicted alone is a defensible shipping set.
>
> **The Absolute Cinema strip does not survive intact.** Tracks have **no per-track
> artwork**, so the strip's whole visual argument — *"a list of ten frames is a better answer
> than a list of ten titles"* — collapses: every crowned track from one album shows the same
> cover. Options: square 1:1 album covers with the track title as the primary text, or a
> generated per-track visual (waveform, or an audio-feature colour from valence/energy).
>
> **Delete the air-date logic.** A track is either released with the album or it does not
> exist. Remove the "Not aired" badge, the `opacity-60` unaired styling, and the aired-only
> filters — but keep the release-date gate for *pre-release* singles.

---

## 9. The social layer

The whole layer turns individual `logs` rows into shared surfaces without ever exposing
guest accounts or private lists.

### 9.1 The follow graph

A single edge table with no surrogate key:

```sql
CREATE TABLE follows (
  follower_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX follows_followee_idx ON follows (followee_id);
```

The composite PK indexes the forward direction for free and makes a duplicate follow
impossible at the database level; the extra index serves the reverse. Directed graph — no
mutual/friend concept, no pending state, no block list.

`toggleFollow` is `guard()` → `requireMember("follow other members")` → Zod → a self-follow
check → `insert().onConflictDoNothing()` or `delete()`. Both idempotent.

**Two gaps to close in a rebuild:** it never checks the followee *exists* (an FK violation
surfaces as the generic error rather than "That member does not exist"), and it never checks
the followee is not a guest.

### 9.2 The activity feed — fan-out on read

**There is no feed table, no inbox, no notification table, and no write-time fan-out
anywhere in the schema.**

```sql
-- getFollowingFeed(userId, limit = 30)
… WHERE logs.user_id IN (SELECT followee_id FROM follows WHERE follower_id = $1)
  ORDER BY logs.created_at DESC LIMIT $2
```

Supported by `logs_user_created_idx (user_id, created_at)`.

**What is included:** everything in `logs` from followed members — show-, season- and
episode-level, with or without a rating, review or diary date, including rewatches. **No
filtering by kind, no ranking, no de-duplication, no recency decay, no per-author cap.**
Follows, likes, comments, list creations and watchlist adds do **not** appear; the feed is
logs only.

**Pagination: none.** The home feed is the 24 newest rows and that is the end of it. Only
the diary (limit/offset/year) and the show reviews page (limit/offset) paginate.

The home page substitutes the global feed when the following feed is empty. The
substitution is silent in the data but visible in the copy — the eyebrow flips between
*"From people you follow"* and *"Across Cliffhanger"*.

### 9.3 Rendering: day grouping and binge-run collapsing

Two passes over the already-sorted array.

**`groupByDay`** — single pass, keyed on `isoDate(createdAt)` (**UTC**). *"Entries arrive
newest first, so consecutive runs are already one per day."* Each day gets a sticky
`z-10` header.

**`collapseRuns`** with `RUN_THRESHOLD = 3`:

```
runnable  = targetType === "episode" && !entry.review
continues = runnable && run.length > 0
            && run[0].author.id     === entry.author.id
            && run[0].show.tmdbId   === entry.show.tmdbId
flush()   = run.length >= 3 ? emit one run row : emit each entry individually
```

Three or more consecutive, review-less, episode logs by the same author for the same show
become one row: *"Nadia rated 7 episodes of Breaking Bad · S02E05–S02E11 · avg ★"*. The
episode range is built from the **oldest and newest** entries (*"Entries are newest first,
so the last one is where the run started"*). The run's average is `Math.round(sum / count)`
on the 1–10 scale — a whole-integer approximation, not a half-star average.

**Three things break a run:** a non-adjacent position in the sorted array (one rating of a
different show mid-binge splits it), any entry with a review, and a UTC midnight boundary
(collapsing happens *per day group*).

Rows render as `ReviewCard` when a review exists, `ActivityRow` otherwise. A delete button
appears only on your own diary, positioned `opacity-0 … group-hover/entry:opacity-100`.

### 9.4 Likes — and the three meanings of "like"

```sql
CREATE TABLE likes (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type varchar(8) NOT NULL,       -- 'log' | 'list'
  target_id   integer NOT NULL,          -- NO foreign key (polymorphic)
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_type, target_id)
);
CREATE INDEX likes_target_idx ON likes (target_type, target_id);
```

The composite PK is the dedupe mechanism; the secondary index serves counting and the
popular sort. Two likeable things only. Comments cannot be liked. **There is no self-like
prevention.**

Counts are **never denormalised** — always a correlated subquery, so no counter can drift.
Viewer state comes in two shapes: `getLikedLogIds(userId, logIds)` returning a `Set` (one
query per page, called exactly once by every review-bearing page) and `hasLiked(...)` for a
single object.

Do not conflate: **(a)** `logs.liked boolean` is the author's own heart on the thing they
watched, written by `saveLog`; **(b)** the `likes` table is other members hearting a review
or list, written by `toggleLike`; **(c)** `lib/like.ts` is SQL `LIKE` escaping.

### 9.5 Comments — flat, depth exactly 1

No `parent_id`, no depth, no path. The index `comments_target_idx (target_type, target_id,
created_at)` covers exactly the read pattern. Ordered **ascending** (oldest first), unlike
every other read in the app. `MAX_BODY = 2000`, enforced in three places that must stay in
sync: the Zod schema, the textarea `maxLength`, and a character counter that appears at
1801 characters.

The composer uses `React.useOptimistic` with `id: -1` as the sentinel for an unsaved row
(no profile link, "Posting…" instead of a timestamp, `opacity-60`, no delete button).

**Two facts worth knowing before you copy this:**

1. **Nothing in the app renders a comment thread on a log.** The schema, the actions, the
   component prop type and the review card's comment count all support `target_type='log'`,
   but there is no `/log/[id]` route and the only call site is the list detail page. **The
   comment count on a review card is therefore always 0 in practice.** Either half-built or
   a deliberate deferral — decide consciously.
2. **Container-owner moderation exists server-side but is unreachable from the UI.** The
   owner of a list or log *can* delete a stranger's comment on it; the component only shows
   the trash button when `viewerId === author.id`.

### 9.6 Shared authorization: `assertVisibleTarget`

One helper both `toggleLike` and `addComment` call, and it treats the two target types
asymmetrically **on purpose**:

- **log:** existence only (logs have no privacy flag)
- **list:** must exist **and** (`isPublic || userId === viewerId`)

This is the fix for audit finding SEC-03. *If you ever add private logs, this helper is the
single place that must learn about it.*

Note the gate asymmetry that ships: `toggleFollow`, `toggleLike` and `addComment` all call
`requireMember` (guests refused, with a message naming the action), while `deleteComment`
calls `requireUser` and is verification-exempt. So a guest can delete a comment they could
never have posted, and with verification enforced an unverified member can delete but not
post.

### 9.7 Reviews: scoping and sorting

```ts
type ReviewTarget = { showId; seasonNumber?; episodeNumber?; scope?: "exact" | "any" };
```

`scope: "any"` **gathers series-, season- and episode-level reviews onto one show page** —
the show page uses it, the season and episode pages use exact scope.

Two orders only. `"popular"` is a correlated subquery **in the ORDER BY**:

```sql
ORDER BY (SELECT COUNT(*) FROM likes WHERE target_type='log' AND target_id = logs.id) DESC,
         logs.created_at DESC
```

No hot-ranking, no time decay, no reputation term, no minimum-like threshold, and no
denormalised `like_count` column. The sort runs over all matching reviews before
LIMIT/OFFSET.

`countReviews` **duplicates the entire conditions ladder** and joins `users` purely for the
guest filter, with the reason written inline: *"a '12 reviews' heading over ten visible ones
is the kind of mismatch that looks like a bug in the list."* **The two functions must be
edited together.**

### 9.8 Members directory and search

```sql
SELECT users.*, COUNT(logs.id)::int AS activity
FROM users LEFT JOIN logs ON logs.user_id = users.id
WHERE users.is_guest = false AND (<exclude viewer> OR TRUE)
GROUP BY users.id
ORDER BY COUNT(logs.id) DESC
LIMIT $limit
```

Raw log volume across all three target levels; reviews, followers and recency contribute
nothing. **No tiebreaker after the count**, so equal-count members reshuffle between
requests.

Member search wraps the ILIKE disjunction in **explicit parentheses**:

```ts
and(eq(users.isGuest, false),
    sql`(${users.username} ILIKE ${pattern} OR ${users.displayName} ILIKE ${pattern})`)
```

Without the brackets Postgres binds AND tighter than OR, so the predicate reads
`(is_guest = false AND username ILIKE …) OR (display_name ILIKE …)` — and because every
guest's display name is literally "Guest User", **searching "guest" returned all of them.**
Caught by a test, not by reading.

### 9.9 The five N+1 avoidance patterns — reproduce all of them

1. **Correlated subquery in the SELECT list**, not a per-row round trip (`likeCount`,
   `commentCount`, `itemCount`, and `containsShow` as an `EXISTS`).
2. **Collect ids → one `IN` query → bucket into a Map** (`withTags`, `attachPreviews`).
3. **Viewer state as a `Set`, fetched once per page** (`getLikedLogIds`, `viewerFollowSet`).
   Both guard the empty-array case, because `IN ()` is invalid SQL.
4. **Multiple scalars in one round trip** (`getFollowCounts` returns both counts from one
   SELECT; `getProfileStats` is four CTEs and nine scalar subqueries in one statement).
5. **`Promise.all` for independent reads**, sequential only where there is a data
   dependency (the home page fires four reads together, *then* awaits the like set because
   it needs the entry ids).

**The one surviving exception:** the members directory runs
`Promise.all(members.map(m => getProfileStats(m.id)))` — **24 executions of the heaviest
query in the app** — to display two numbers per card. Batch it or it is the slowest page.

> **Porting note (§9).** Almost everything here is domain-generic and copies verbatim: the
> follow-edge table and its two indexes, fan-out on read, the day grouping, likes and
> comments with their polymorphic targets and `assertVisibleTarget`, the review scoping
> ladder and the popular sort, the directory ranking, the optimistic-with-rollback button
> pattern, and all five N+1 techniques.
>
> **Retune `RUN_THRESHOLD = 3`.** An album is 10–14 tracks consumed in 40 minutes, so a
> listener generates runs far more often and far longer than a TV binger. 3 would collapse
> nearly every listening session; 5–6 is more likely right, or collapse to whole-album
> granularity ("Nadia played all 11 tracks of *Blue*").
>
> **`scope: "any"` is arguably *more* valuable in music**, since most writing is about a
> specific album rather than an artist's whole output. Consider a third scope tier (an album
> page rolling up its own tracks), which the target shape already supports.
>
> **`getActiveMembers` counts raw log rows.** Tracks are shorter than episodes so counts
> inflate faster; if you want a fairer ranking, weight by distinct albums.

---

## 10. Lists and collections

Four tables, all shipped in migration 0000 and **never altered since** — the only
subsystem untouched by migrations 0001–0007.

### 10.1 Model

`lists` (serial id, `title varchar(120)`, `slug text`, `description text`, `is_ranked`,
`is_public`, `cloned_from_id integer` **with no FK**, `created_at`/`updated_at`) with
indexes on `(user_id, updated_at)` and `(is_public, updated_at)` — exactly the two access
patterns.

`list_items` (serial id **never queried**, `list_id`, `show_id`, `position integer DEFAULT
0`, `note text`) with `uniqueIndex(list_id, show_id)` — **the entire duplicate-prevention
mechanism**, relied on by `onConflictDoNothing` — and `index(list_id, position)`.

**`lists.slug` has no unique constraint at any scope** and is regenerated from the title on
every update, so it is neither unique nor stable. Nothing reads it as a key:
`parseListSlug` is literally `parseShowSlug`, throwing the slug away and using only the
trailing integer. **`/list/17` is therefore a valid URL** — and the clone button relies on
it, pushing a bare-id URL with no slug at all. Do not add a uniqueness constraint in a
rebuild; it would break `updateList` for zero benefit.

### 10.2 The one authorization rule

Every list mutation uses the identical three lines, and it is the only authorization there
is:

```ts
const existing = await db.query.lists.findFirst({ where: eq(lists.id, listId) });
if (!existing) return fail("That list no longer exists.");
if (existing.userId !== user.id) return fail("That is not your list.");
```

Ownership is always compared against the **session** id, never a client-supplied one.

`cloneList` is the deliberate exception and inverts the rule: `if (!source.isPublic &&
source.userId !== user.id) return fail("That list is private.")` — a public list belonging
to anyone may be cloned.

Note the messages distinguish "gone" from "not yours", which confirms the existence of a
private list id to a non-owner calling a *write* action — asymmetric with the read path,
which 404s uniformly. Accepted, presumably because list ids are already enumerable from
public listings.

### 10.3 Position, cloning, and the quick-add path

`addToList` computes position as `SELECT max(position) … + 1` **in a separate statement,
outside any transaction** — two concurrent adds get the same position, which is legal
because the unique index is on `(list_id, show_id)`, not `(list_id, position)`.

A re-add hits `onConflictDoNothing`: the row is untouched (position and note preserved) but
`lists.updatedAt` is still bumped, reordering the list in every `desc(updatedAt)` listing.

`cloneList` copies title, description, `isRanked` and every item's position and note, sets
`clonedFromId`, and **hard-codes `isPublic: true`** regardless of the source. The clone
button returns `null` for the owner — *"Cloning your own list would just duplicate it, which
nobody means to do."*

`quickAddToList` creates-or-appends by **case-insensitive title** within the caller's own
lists (`lower(title) = lower(?)`, no supporting index) and then **calls `addToList`
directly** — so `guard()` runs twice for one user gesture: two rate-limit tokens and two
verification reads.

**Three actions have no caller anywhere in the app:** `reorderList`, `updateList` and
`clearFavorite`. There is no `/list/[slug]/edit` route and no drag-and-drop component. The
server capability exists; the UI was never built. (`reorderList` is also a sequential
`await` UPDATE per id with no transaction, capped at 500 ids, costing one rate-limit token
for up to 500 round trips.)

### 10.4 The two "collections"

**Watchlist** — PK `(user_id, show_id)`, `note` (schema-present but **never written by any
code path**), `added_at`. **There is no privacy flag: `/@anyone/watchlist` is fully public
to signed-out visitors.** If your product needs a private queue, that is new work.

**Favourites (the Top Four)** — PK **`(user_id, position)`**, positions 1–4. Keyed by
*slot*, so the database will happily let the same show occupy two slots; `setFavorite`
prevents it by DELETE-ing any row with that show for that user before the slot upsert —
**two non-transactional statements**, so a failure between them leaves the show in no slot
at all. Any second write path must repeat the delete.

### 10.5 The list card mosaic

`attachPreviews` fills a four-poster fan for every card on a page with **one** query
(`WHERE list_id IN (…) ORDER BY position ASC`) and slices to four in JavaScript. Correct but
unbounded: rendering 36 cards whose lists hold 200 items each transfers 7,200 rows to build
144 thumbnails.

Rendering: tiles at `aspect-[2/3] w-20`, each after the first offset `-ml-6` with an
increasing `zIndex` so they fan left-over-right; posters carry `alt=""` deliberately —
*"The mosaic is decorative — the list title carries the meaning."*

### 10.6 The privacy check must be duplicated

`generateMetadata` **and** the page body each independently 404 a private list for
non-owners. This was audit finding SEC-02 (HIGH): the body 404'd while the `<title>` and
`<meta description>` of every private list still rendered, allowing anonymous id
enumeration. **Any new entry point into a list route — an OG image route, an RSS feed, an
API handler — needs the same check.**

> **Porting note (§10).** Structurally generic; copy the ownership rule, the clone
> semantics, the mosaic query shape, and the duplicated privacy check.
>
> **The one real change: `list_items` must become polymorphic.** A music list of *tracks*
> (a playlist) is the obvious primary use case, whereas Cliffhanger's list items can only
> hold series. Add the same target columns `logs` has and widen the unique index to the full
> tuple. That also breaks `getListOptions`'s simple `EXISTS` membership check and the
> four-poster preview (a track has no cover of its own — borrow the album's).
>
> **Favourites become Top Four albums** (albums are the natural profile-pin unit for music,
> not artists); the slot-keyed PK and the drop-don't-merge rule transfer verbatim.

---

## 11. Statistics and Year in Review

`lib/stats/` has **no unit tests** — `npm run smoke` is its only automated coverage.

### 11.1 `getProfileStats` — nine lifetime numbers in one round trip

Four CTEs and nine scalar subqueries in a single `db.execute`:

```sql
watched  AS (SELECT DISTINCT show_id, season_number, episode_number FROM logs
             WHERE user_id = $1 AND target_type = 'episode' AND season_number > 0)
timed    AS (… JOIN shows … LEFT JOIN episodes …
             SELECT COALESCE(e.runtime, s.episode_run_time, 0) AS minutes)
per_show AS (SELECT show_id, COUNT(*)::int AS watched_count FROM watched GROUP BY show_id)
progress AS (… (s.episode_count > 0 AND p.watched_count >= s.episode_count) AS finished)
```

`DISTINCT` is the load-bearing word: **a rewatch must not count twice.** `season_number > 0`
excludes specials. A show with `episode_count = 0` can never be "finished".

The nine fields: `episodes_watched`, `minutes_watched`, `shows_started`, `shows_finished`,
`shows_in_progress`, `ratings_given`, `average_rating`, `reviews_written`, `diary_entries`.

**Note the asymmetry:** episodes/minutes/shows are DISTINCT-episode-based and specials-free,
while ratings/reviews/diary are **raw log counts across all three target levels including
season 0**.

The three nullability encodings read back as three counters:
`rating IS NOT NULL` → ratings given, `review IS NOT NULL` → reviews written,
`watched_on IS NOT NULL` → diary entries.

### 11.2 Year in Review

Nine independent queries in one `Promise.all`, nothing cached or memoised. The governing
rule is stated at the top of the file:

> "Everything here is scoped by `watched_on`, not `created_at` — the year you watched
> something is the year it belongs to, even if you logged it later. Ratings without a watch
> date are excluded from the year entirely rather than being attributed to whenever they
> were entered."

| Panel | Query shape | Notes |
| --- | --- | --- |
| Summary (10 fields) | `dated` CTE + `watched_episodes` + `timed` | `episodes_watched` counts **distinct** episodes; `shows_logged` counts *series-level diary entries*, explicitly **not completed series** |
| Monthly bars | `GROUP BY EXTRACT(MONTH …)` | **counts log rows, no `season_number > 0` filter** — deliberately different from the headline tile. Always **twelve** points, missing months zero-filled, *"so the chart keeps a full-year shape"* |
| Histogram | `GROUP BY rating` over dated logs, all target types | **No `DISTINCT ON`** — a rewatch rated twice counts twice, because it is a diary statistic |
| Top shows | `COUNT(DISTINCT (season_number, episode_number))` | a Postgres row-constructor DISTINCT; ties break **alphabetically** |
| Top episodes | plain join, `ORDER BY rating DESC, watched_on DESC LIMIT 6` | **no `DISTINCT ON`**, so an episode rated twice in a year takes two of the six slots |
| Genres | `CROSS JOIN LATERAL jsonb_array_elements(s.genres)` | a show with three genres contributes to three buckets, so counts sum above the show count |
| Longest binge | `GROUP BY (watched_on, show)` `ORDER BY episodes DESC, watched_on DESC LIMIT 1` | per-show-per-day, not total episodes in a day |
| Bookends | two parenthesised SELECTs + `UNION ALL` with a literal discriminator | with exactly one dated log, both branches return the same row and the page shows it twice |
| Platform comparison | `per_member` CTE, **no user filter, no guest filter** | `averageEpisodes` is the mean over members who logged *anything* that year; `averageRating` is a flat mean over every dated rated log platform-wide, **not** a mean of per-member means |

**The sparse-year gate** is `summary.activeDays === 0`, not `episodesWatched === 0` —
*"a year of series ratings and reviews is a real year, and the episode sections handle their
own empty cases."*

**`getLoggedYears` carries a defensive guard** that is worth copying verbatim:

```sql
… AND watched_on BETWEEN '1900-01-01' AND '2200-01-01'
```

> "Postgres accepts 'infinity' as a date, and EXTRACT then throws, which would take this
> member's diary and year pages down for every visitor. Writes are validated now; this keeps
> one bad row from being fatal."

### 11.3 Charts without a charting library

> "Plain elements with CSS widths and heights rather than a charting library: the shapes are
> simple enough that this stays fully server-rendered, with no measuring pass and no
> hydration cost."

No SVG, no canvas, no client component.

- **`MonthlyBars`** — twelve `<li>` in a flex row, each a fixed `h-32` track containing a
  bar at `height: max(MIN_BAR_PERCENT, clamp(ratio) * 100)%` with `MIN_BAR_PERCENT = 4`
  *("Floor for a non-zero month, so a single episode still reads as a bar")*. A zero month
  renders a 2px stub *("keeps the baseline unbroken")*. Labels are a visible `aria-hidden`
  single letter plus an `sr-only` full name and count.
- **`GenreSplit`** — a stacked proportional bar over a four-colour palette cycled by index,
  with `opacity: max(0.45, 1 - index * 0.07)` so *"later slices dim, so a hue coming round a
  second time still reads apart"*, and a `min-w-[3px]` per segment so a sliver stays
  visible. The legend below is the accessible copy of the same data. **The denominator is
  the sum of the six returned genres, not the member's whole year.**
- **`ComparisonRow`** — one shared scale (`max(mine, platform)`) *"so the two bars are
  directly comparable by length"*, rendered as two `Meter`s.
- **`Meter`** — the shared horizontal bar, `width: max(2%, round(ratio * 100))%`. Note the
  2% floor differs from MonthlyBars' 4%.

### 11.4 The profile

Six routed tabs (`/@name`, `/diary`, `/shows`, `/watchlist`, `/lists`, `/year/[year]`), plus
`/network` which is deliberately **not** a tab — it is reached only from the follower and
following counters in the header.

> "These are separate routes rather than tab panels, so the highlight comes from the
> pathname instead of local state — every tab is linkable and survives a reload."

Active detection: `decodeURIComponent(pathname).replace(/\/$/, "")` (the `@` is
percent-encoded), then **exact** match for the root tab so it does not light on every child,
**prefix** match for the rest so `/year/2019` still lights "Year in review".

The profile page runs **ten queries** in one `Promise.all`, then a dependent
`getLikedLogIds`. Sections in order: guest save prompt → Top Four (unfilled slots as dashed
boxes) → Absolute Cinema strip → **three separate rankings** → four stat tiles → genres +
in-progress → continue-watching rail → recent activity → lists.

The three-rankings decision has its own comment: *"a show, a season and an episode are
different things to have an opinion about, and a member's best hour of television is often
inside a show they would not put in their top four."* Their queries tie-break on
`s.tmdb_vote_count DESC` — *"so a five-star given to a landmark leads a five-star given to
something obscure instead of the order falling out of however the rows happen to be
stored."*

**Cost note:** the layout and the profile page each independently call `getProfileStats`.
`db.execute` is not React-cached, so viewing a profile runs the four-CTE aggregate **twice**.

> **Porting note (§11).** The query *shapes*, the CSS-only chart approach with its two
> different minimum-size floors, the always-twelve-months rule, the `activeDays` sparse
> gate, the `infinity` date guard, and the routed-tabs pattern all copy verbatim.
>
> Delete the `season_number > 0` specials filter and replace it with an exclusion of
> non-canonical releases from the completion denominator, or the same failure mode appears:
> bonus tracks substituting for real ones and marking a discography complete. `minutesWatched`
> becomes summed `duration_ms`; the median fallback disappears. `clampWatched` becomes *more*
> necessary, not less — a MusicBrainz release-group carries multiple releases with different
> track counts (single / deluxe / remaster / regional edition), so a listener's logged tracks
> can genuinely exceed the canonical count.
>
> Note one honesty bug worth not copying: the year page shows *"Average rating"* on the raw
> **stored 1–10 scale** with unit `/ 10`, while every other surface shows 0.5–5 stars.

---

## 12. Identity: auth, guest mode, onboarding

### 12.1 Auth.js v5 configuration — four keys, no adapter, no OAuth

```ts
NextAuth({
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
  pages:   { signIn: "/login" },
  trustHost: true,
  providers: [Credentials({ /* email+password */ }), Credentials({ id: "guest", credentials: {} })],
  callbacks: { jwt, session },
});
```

**No `adapter`, no `secret` key, no OAuth provider.** There are zero Auth.js tables —
`accounts`, `sessions`, `verification_tokens` do not exist. The entire HTTP surface is a
three-line route handler: `export const { GET, POST } = handlers`.

**14 days, not 30:**

> "these sessions are stateless JWTs with no server-side revocation list, so the token's
> lifetime is the exposure window for a stolen cookie. `updateAge` re-issues an active
> session daily, so an actual user is not logged out while a stolen token still ages out."

This was audit finding SEC-11 — it shipped at 30 days.

**The JWT carries** id, username, `avatarSeed`, `isGuest`, plus Auth.js's own defaults.
*"The JWT carries the user id and username so profile links and ownership checks never need
a database round trip."* The `isGuest` field carries an inline comment: **"Presentation
only. Anything that enforces the distinction reads the column."**

### 12.2 `authorize` and the constant-time dummy hash

```ts
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.NHqB8vBk1lqvyfrHDEqEfPmYzGDzKGa";

const parsed = credentialsSchema.safeParse(raw);      // === signInSchema, the SAME object
if (!parsed.success) return null;
const account = await db.query.users.findFirst({ where: eq(users.email, email.toLowerCase()) });
const hash    = account?.passwordHash ?? DUMMY_HASH;
const valid   = await compare(parsed.data.password, hash);
if (!account || !valid) return null;
if (account.isGuest)    return null;                  // "two defences, and the second one is readable"
```

The dummy is a **real `$2b$12$` hash**, so the timing matches a real account exactly. The
attack it closes (SEC-09): an early return *"turns this endpoint into an oracle for 'does
this person have an account here' — answerable in bulk against a breach list, with no
failed-login trail on any account."*

`authorize` deliberately does **not** check `emailVerifiedAt` (the gate is on publishing,
not on authentication) and does **not** consume any rate-limit budget — the budgets live in
the Server Action (see the gotcha in §19).

### 12.3 The session read ladder

Four gates of increasing strictness, each re-reading the database for anything it will
refuse on:

| Gate | Cost | Behaviour |
| --- | --- | --- |
| `currentUser()` | **zero DB** | Reads the JWT; returns null unless id and username are present and `Number(id)` is a safe integer. The cheap path used by ~20 pages and the header. |
| `requireUser()` | one indexed lookup | `currentUser()` or throw, then confirm the `users` row still exists. *"These are stateless JWTs valid for their full lifetime, so a token keeps asserting an identity after the row behind it is gone. Reads tolerate that; writes must not… This is also the single revocation point if account suspension is ever added."* |
| `requireMember(action?)` | two lookups | Adds a re-read of `is_guest`; throws `GuestNotAllowedError` with the message ``Create an account to ${action}. Your logs will come with you.`` Exactly three call sites: follow, like, reply. |
| `requireVerifiedUser()` | — | **Exported with zero call sites.** The verification gate is applied centrally in `guard()` instead. |

### 12.4 Guest mode — one boolean column

The entire schema footprint is `ALTER TABLE users ADD COLUMN is_guest boolean DEFAULT false
NOT NULL;` (73 bytes).

> "A real row rather than browser storage, so the diary, the heatmap, the taste model and
> every other read work unchanged — a guest is just a member whose credentials do not exist
> yet. The cost of that choice is that guests must be kept out of every public surface:
> community averages, feeds, the member directory. Those reads filter on this column."

**Creating a guest** (`createGuest(ipAddress)`):

1. `consume(BUDGETS.guestByIp, ip)` — `{ bucket: "guest:ip", limit: 20, windowSeconds: 3600 }`,
   *"set generously enough for a shared address (an office, a campus, a phone network) to
   keep working."*
2. `passwordHash = await hash(randomBytes(32).toString("hex"), 12)` — **the plaintext is
   discarded**. Not an empty string and not a fixed sentinel on purpose: *"both would let one
   leaked value authenticate as every guest at once if a login path ever stopped checking
   `is_guest`."*
3. Identity: `randomBytes(5).toString("hex")` → 10 hex chars →
   `username = "guest_<hex>"` (16 chars) and `email = "guest_<hex>@guest.invalid"`.
   **`.invalid` is an RFC 2606 reserved TLD that can never be delivered to** — chosen
   because `users.email` is NOT NULL and a guest genuinely has no address.
4. Insert with `onConflictDoNothing()` inside a **5-attempt retry loop** against the
   case-insensitive unique indexes — *"handled by retrying on the unique index rather than by
   hoping."*

**It is a Credentials provider with an empty `credentials: {}` object, not a Server
Action:**

> "there is nothing a caller can supply to become a chosen guest, and certainly not a chosen
> member. That property is why this is a provider rather than an action that signs in an id
> handed to it."

**What a guest can do:** rate and log at all three levels with diary dates, rewatch flags
and tags (**uncapped, deliberately**); watchlist; lists CRUD; pin favourites; crown Absolute
Cinema; write up to **3** reviews; have a working profile, diary, heatmap, watch-time stats
and taste model.

**What a guest cannot do:** follow, like another member's post, reply to a review (the three
`requireMember` sites); write a 4th review; sign in with a password; reset a password; be
asked to verify email; reach Settings from the UI; appear on any public surface.

**Each restriction is chosen to *be* the reason to sign up** — the blocked actions are
exactly the ones that involve other people.

**The review cap:**

```ts
GUEST_REVIEW_CAP = 3;
```
> "Three. Enough to find out what writing one here feels like — which is the only thing that
> makes an account worth having — and few enough that the wall arrives while they still care
> about the fourth. **Ratings and diary entries are NOT capped: those are the habit, and
> interrupting the habit teaches somebody to leave.**"

`countReviewsBy(userId, ignore?)` **excludes the target being edited**, so somebody at the
cap can still revise the three they wrote *"instead of being frozen out of their own
words."* The `ignore` clause branches on null per column (`isNull(x)` vs `eq(x, n)`) because
SQL `= NULL` never matches — rewriting it as a plain equality silently makes the exclusion a
no-op.

**The nudge threshold:**

```ts
GUEST_NUDGE_AFTER = 12;
```
> "Twelve, which is deliberately high. The strip used to show from the first page view,
> which is nagging somebody who has not yet got anything worth keeping — and a banner people
> learn to ignore is worse than no banner. Twelve entries is roughly a session of
> onboarding, at which point the offer is about something real they would be annoyed to
> lose. **The leaving warning is separate and fires from the FIRST entry.**"

The two thresholds are separated because the costs differ: a premature banner is noise, a
missed leaving warning is permanent data loss.

**The strip's client half** registers a `beforeunload` handler when `logCount > 0` — *"'are
you sure you want to leave' over an empty diary is the kind of prompt that teaches people to
ignore prompts."* Dismissal is per page load, and the component is **hidden, not unmounted**,
because the client half owns the leaving warning and must be armed from the first entry.

**Guest lifetime is two independent things, and neither is a row TTL.** The session is a
14-day JWT — lose the cookie and there is no way back into that row, since the credentials
provider refuses `is_guest` rows. **The row lives forever**: nothing in the repo deletes or
expires guest rows, there is no cron, and the only prune helper that exists documents that
nothing schedules it. The UI framing is deliberately more pessimistic than the truth ("Close
this tab and it is gone", "Discard and leave" behind a `window.confirm`) — signing out only
drops the cookie.

### 12.5 The two conversion paths

> "A guest is either a new person or somebody who already has an account elsewhere, and
> those need different doors."

**Path A — sign UP claims the row in place.**

```sql
UPDATE users
SET username=$, email=$, password_hash=$, display_name=$, avatar_seed=$, is_guest=false
WHERE id = $guestId AND is_guest = true
RETURNING id
```

**The `is_guest = true` predicate is inside the UPDATE, not a SELECT before it** — *"so two
concurrent claims cannot both believe they won."* Same `users.id`, so **nothing moves and
nothing can half-fail**: every log, watchlist row, list, favourite, crown and tag already
points at the right owner. *"This is what makes 'keep your logs' a fact rather than a
promise."*

If the claim returns false, sign-up still succeeds by creating a fresh row — the guest's
data is simply left behind.

**Path B — sign IN merges onto an existing account.**

The ordering constraint matters: **capture the guest id *before* authenticating**, because
signing in replaces the session. Then resolve the target from **the address that just
authenticated**, never from anything the caller sent, and run one transaction:

| Table | Policy | Why |
| --- | --- | --- |
| `logs` | `UPDATE … SET user_id = target` | *"Logs carry no per-member uniqueness — a rewatch is a second row — so they simply change owner. Their tags follow by foreign key."* |
| `watchlist` | CTE `INSERT … SELECT … ON CONFLICT (user_id, show_id) DO NOTHING RETURNING show_id`, count it, then delete the guest's rows | PK collision; **the target's note and date win** |
| `lists` | `UPDATE … SET user_id = target` | no per-user uniqueness |
| `favorites` | **DELETED, not merged** | *"Pinned favourites are keyed by slot, and the target's four are a deliberate arrangement, so a guest's pins are dropped rather than shuffled into whatever slots happen to be free."* |
| the guest row | `DELETE … WHERE id = $guest AND is_guest = true` | *"leaving behind an unreachable account is how a users table fills with debris"* |

Refusals (all returning `null`): self-merge, non-guest source, missing or guest target.

**The transaction exists because** *"a half-merged guest would leave logs stranded under a
row nobody can sign into, which is indistinguishable from losing them."*

**`/login` and `/signup` redirect only *non-guest* members** — a blanket "redirect anyone
with a session" would trap guests away from both upgrade paths. This was fixed while wiring
guest mode.

### 12.6 Password reset and email verification

Both use identical token machinery in `lib/security/tokens.ts`:

```ts
createLinkToken()  → { token: randomBytes(32).toString("base64url"),   // 43 chars, 256 bits
                       tokenHash: sha256hex(token) }
looksLikeLinkToken(v) = /^[A-Za-z0-9_-]{43}$/.test(v)
VERIFICATION_TTL_MINUTES  = 60
PASSWORD_RESET_TTL_MINUTES = 30
```

**Only the SHA-256 is stored.** A database leak then yields nothing redeemable — and
SHA-256 rather than a slow KDF because *"the token is 256 bits of CSPRNG output, so there is
nothing to brute force."*

**30 vs 60 minutes:** *"A confirmation link only proves an address; a reset link takes over
an account, so the interval in which a leaked mailbox or a forwarded message is dangerous
should be as small as is still usable."*

**Reset, end to end.**

- **Request** always answers identically — *even for an unparseable address, even when
  rate-limited by email*. The **only** branch that returns a failure is the per-IP limit.
  *"a form that says 'no account with that address' is a membership oracle answerable in
  bulk against a breach list."* Two budgets: `reset:ip` 10/hour (the anti-guessing limit)
  and `reset:email` 3/hour — the latter *"so that nobody can be made to receive a stream of
  reset mail by an attacker cycling addresses of origin — the recipient is what needs
  protecting here, not us."*
- **Issue** retires **every** outstanding token for that user in the same transaction as
  the insert.
- **Redeem** has five refusals — bad shape, no row, already consumed, expired, account gone,
  email mismatch — **all returning the same `{ ok: false, reason: "invalid" }`**, because
  distinguishing them tells a guesser which tokens were real. Then one transaction:
  consume every outstanding token and `UPDATE users SET password_hash = $, email_verified_at
  = coalesce(existing, now())`. **Redeeming a reset confirms an unverified address**, because
  *"Redeeming this proves they read mail at that address, which is the same thing email
  verification proves."*
- **The password is hashed in the *action*, not the DB module**, so the module never holds
  plaintext and cannot log it.
- **The UI never signs them in** — it shows "Your password is set. Sign in as @username."
- **The reset landing page sets `robots: noindex` and `referrer: "no-referrer"`** so the
  token never reaches a search engine or a `Referer` header.

**Verification** is the same shape with two differences: it is **redeemed on a button press
by a signed-in member, never on page load** (*"mail clients and security scanners follow
links automatically, which would burn a single-use token before the member clicked it"*),
and it additionally requires `record.userId === user.id` (*"A token belongs to the account
it was issued for, not to whoever is signed in"*).

**`REQUIRE_EMAIL_VERIFICATION` defaults OFF.** Enforcing the gate without a verified sending
domain would lock every new member out of posting with no self-service fix. The flow still
runs, so switching it on is a one-variable change — and **the banner copy changes with the
flag rather than lying**: *"Confirm {email} to post reviews, log episodes, and build
lists."* vs *"Confirm {email} when you get a chance — it secures your account."*

**Passwords:** bcrypt **cost 12** everywhere (registration, reset, the throwaway guest hash,
and the dummy). Length bounded in **BYTES, not characters** — `PASSWORD_MAX_BYTES = 72`
measured with `TextEncoder` — because bcrypt truncates at 72 bytes and `"é".repeat(72)` is
72 characters but **144 bytes**, so its first 36 characters would authenticate (SEC-16).
`signInSchema.password` deliberately uses `min(1)` (a member whose password predates the
rule must still be able to sign in) and its over-length message is the **generic** auth
failure, never a length explanation.

### 12.7 Email delivery

`lib/email/index.ts` is not a stub but degrades to one:

- `assertSingleLine(to)` and `assertSingleLine(subject)` **throw** on `[\r\n]` — header
  injection defence in depth on top of the structural defence.
- **With no `RESEND_API_KEY`** it logs a formatted block and returns `{ delivered: true, via:
  "log" }` — *"logged rather than dropped so a developer can complete the flow and so a
  missing provider in production is visible in the logs instead of looking like success."*
- Otherwise POSTs to Resend with a 10-second `AbortSignal.timeout`, logging **only the
  status** on failure (*"The provider's body can echo the request"*).

> "Deliberately narrow: callers choose from a fixed set of messages built in this module. No
> caller supplies headers, a sender, or raw HTML, which removes header injection and
> template injection as a class rather than filtering for them. **Recipients come from the
> database, never from a request.**"

**Consequence:** `delivered: true` does *not* mean the member received it. Use
`emailDeliveryConfigured()` or `result.via === "resend"` — which is exactly what the UI does,
reporting *"No email provider is configured — the reset link was written to the server log
instead of being sent."*

### 12.8 Usernames

```ts
usernameSchema = z.string()
  .min(3).max(24)                                  // the column is varchar(32), deliberately roomier
  .regex(/^[a-zA-Z0-9_]+$/)                        // allowlist, not denylist
  .refine(v => !RESERVED_USERNAMES.has(v.toLowerCase()))
  .refine(v => !v.toLowerCase().startsWith("guest_"));
```

> "Allowlist, not a denylist: anything outside this set cannot appear in a URL segment, a
> revalidation path, or a filename."

24 reserved names: admin, administrator, api, cliffhanger, dev, debug, internal, list,
lists, login, logout, me, members, moderator, root, search, settings, show, shows, signup,
staff, support, system, test. *"Profiles live at `/@name`, so a username is also a URL
segment."*

The `guest_` prefix ban exists because *"without this a member could register
`guest_ab12cd34` and be taken for one, or shadow a real guest's name in a way that makes the
two hard to tell apart in the admin panel."*

**Uniqueness is enforced by the database, not by the SELECT in sign-up** — functional unique
indexes on `lower(username)` and `lower(email)` (migration 0001, SEC-13):

> "Sign-up checked for collisions with `lower()` while the index was case-sensitive, so two
> concurrent registrations of 'bob' and 'Bob' could both commit — and since profile lookups
> resolve case-insensitively, one member's profile then became unreachable. **A unique index
> cannot lose that race.**"

**Usernames are permanent.** `updateProfile` can only write `displayName`, `bio` and
`avatarSeed`.

### 12.9 Onboarding

The landing CTA is **"Start your diary"**, and it does not go to sign-up:

> "asking for an email before anybody has seen what the app does is how the funnel ends at
> the first screen."

It opens a guest session and lands on `/start`.

`/start` fetches **24** candidates (`GRID_PAGE_SIZE`, so the grid ends on a complete row at
every breakpoint) by over-fetching **32** and dropping the poster-less ones (*"a poster-less
card in an onboarding grid is a card nobody can recognise"*), sorted by
**`vote_count.desc` with `vote_count.gte = 2000`**:

> "Popularity is whatever aired this week; vote count is how many people ever bothered to
> rate it, which is the closest thing to household familiarity the data has."

Both rejected alternatives are named in the type's own docstring. The measured output is
Game of Thrones, Breaking Bad, The Simpsons, Grey's Anatomy, The Big Bang Theory.

`cacheShowSummaries` is **mandatory here, not an optimisation**: `logs.show_id` has an FK to
`shows.tmdb_id`, so the rows must exist before a star click can log against them.

Existing ratings are prefilled, because *"an onboarding grid that offers back the shows
somebody just rated reads as though the ratings did not save."* The eyebrow counts down:
`"{n} rated · {m} more unlocks recommendations"`.

`IntroDialog` opens on arrival with the grid already rendered behind it, so **closing it is
the whole interaction**:

> "The hero used to carry a paragraph nobody reads before they have chosen anything. Here it
> arrives after 'Start your diary', which is the first point at which what this app does is
> a question the visitor is actually asking."

Its four points map exactly onto the four pillars: rate both levels, see the shape of a run,
keep a diary and a watchlist, follow people with taste. The guest-only paragraph sits in its
**own block below a rule** because *"it is a different subject, and burying it in the last
sentence of a feature list is how people miss the one thing that could cost them their
work."* No persistence — it reopens on every visit.

`QuickRate` is *"the smallest possible control: stars, and 'not seen it' to clear the card
out of the way. No dialog, no diary date, no review — those are worth discovering later, and
asking for them now is how a first session ends early."* Optimistic, because *"a star that
waits for a round trip before filling makes a grid of twenty shows feel broken."* Rollback
restores the **prop**, not the previous local value — *"Put the star back where it was rather
than showing a filled star for a rating that does not exist."*

A second guest entry point sits under the sign-in wall on the show sidebar: *"somebody is
looking at a show they have an opinion about, and the sign-in wall is exactly where they
would otherwise leave."*

> **Porting note (§12).** **This entire subsystem copies verbatim** apart from copy strings.
> Nothing in `lib/auth/index.ts`, `lib/auth/session.ts`, `lib/auth/password-reset.ts`,
> `lib/security/tokens.ts`, `app/actions/verification.ts`, `types/next-auth.d.ts` or the
> auth pages mentions television.
>
> **Edit:** `RESERVED_USERNAMES` must be regenerated from the new route tree (swap
> show/shows for album/albums, artist/artists, track/tracks, release/releases, label; swap
> the brand word; keep everything else). The `calendarDate` lower bound `"1930-01-01"` with
> the message *"That is before television."* becomes ~`"1900-01-01"` / *"That is before
> recorded music."* — and note a music app plausibly wants a `releasedOn` field too, which
> needs the same schema **minus** the future-date bound.
>
> **Re-check `GUEST_NUDGE_AFTER = 12`.** It was tuned as "roughly a session of onboarding"
> on a 24-card TV grid. A listen is a much cheaper event than watching an episode: a single
> album is 10–15 tracks, so 12 *track* logs is one album. The equivalent is probably 12
> **album** logs or ~50 track logs.
>
> **Merge policy must be re-derived per table, driven by that table's uniqueness.** A
> generic new hazard: if you add an artist-follow table that a guest can write, it needs its
> own `ON CONFLICT DO NOTHING` branch — **Cliffhanger's `absolute_cinema` was never added to
> the merge and is silently cascade-deleted with the guest row.** Every table a guest can
> write MUST appear explicitly in the merge transaction, or be deliberately listed as
> discarded.
>
> **The onboarding candidate heuristic has to be re-derived** because neither music provider
> has `vote_count`. The true equivalent of "how many people ever bothered" is **Last.fm
> listener count**, which is a better familiarity proxy than Spotify popularity ("what is
> streaming this week") — and the same popularity-versus-familiarity argument applies
> verbatim.
>
> **Ordering lesson from the migration history:** guest mode landed *after* email
> verification and password reset, which is why both needed guest special-cases retrofitted
> and why one shipped as a production bug. **Decide guest mode before shipping anything that
> touches email.**

---

## 13. Security architecture

Seventeen findings (SEC-01 … SEC-17) were closed by an adversarial audit before the product
was called done. This section is the resulting architecture; §19 is the invariant list.

### 13.1 The rate limiter

**One Postgres table, one statement per check.**

```sql
CREATE TABLE rate_limits (
  key          text PRIMARY KEY,                    -- "bucket:identity"
  window_start timestamptz NOT NULL DEFAULT now(),
  count        integer NOT NULL DEFAULT 0
);
```

> "Kept in Postgres on purpose: an in-process counter is per-instance, and serverless runs
> many instances, so an attacker spreading requests across them would face no limit at all."

```sql
INSERT INTO rate_limits (key, window_start, count) VALUES ($key, now(), 1)
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $w)
               THEN 1 ELSE rate_limits.count + 1 END,
  window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $w)
               THEN now() ELSE rate_limits.window_start END
RETURNING count, EXTRACT(EPOCH FROM (now() - window_start))::int AS age_seconds;
```

`ok = count <= limit` — **the Nth request where N equals the limit is allowed; the
(N+1)th is refused.** Any reimplementation using `count < limit` silently tightens every
budget by one.

**It fails OPEN** on any database error: *"A rate limiter that takes the whole site down
when Postgres hiccups trades a small risk for a large one; the security controls that must
fail closed are the authorization checks, not this."* Understand the corollary: **the limiter
is not a defence against an attacker who can also degrade the database.**

**Fixed windows admit up to 2× a limit across a boundary**, which the header states is
accepted and *"the limits below are set with that doubling in mind"* — so do not later
"tighten" a limit by halving it without re-reading that.

**All thirteen budgets:**

| Name | Bucket | Limit / window | Stated reason |
| --- | --- | --- | --- |
| `loginByAccount` | `login:account` | 5 / 900s | "Password guessing against one account. Deliberately tight." |
| `loginByIp` | `login:ip` | 20 / 900s | "Credential stuffing from one source, spread across many accounts." |
| `signUpByIp` | `signup:ip` | 5 / 3600s | "Mass account creation, the entry point for every other abuse." |
| `writeByUser` | `write:user` | 120 / 60s | "Generous for a person, ruinous for a script." |
| `writeByAnon` | `write:anon` | 30 / 60s | mutations attempted without a session |
| `searchByIp` | `search:ip` | 30 / 60s | "Search reaches TMDB" |
| `verifyEmailByUser` | `verify:user` | 3 / 3600s | "an account becomes a way to repeatedly deliver to one address" |
| `verifyEmailByIp` | `verify:ip` | 10 / 3600s | "a source cycling accounts becomes a way to deliver to many" |
| `passwordResetByIp` | `reset:ip` | 10 / 3600s | "the only limit standing between a guesser and unlimited attempts" |
| `passwordResetByEmail` | `reset:email` | 3 / 3600s | "the recipient is what needs protecting here, not us" |
| `guestByIp` | `guest:ip` | 20 / 3600s | a row-creating endpoint open to the world |
| `adEventByIp` | `ad:ip` | 300 / 3600s | "the counters are reporting rather than billing" |
| `tmdbOutbound` | `tmdb:global` | 600 / 60s | protects the API credential itself |

**Two limits per auth flow — one keyed by the subject, one by the source** — because the
two attacks look different, and **both are counted before bcrypt runs, so a flood cannot be
used to burn CPU either.**

`clientAddress()` takes the **left-most** `x-forwarded-for` entry, falling back to
`x-real-ip`, then the literal `"unknown"`. Its comment is explicit: *"only trustworthy
because Vercel terminates every request and overwrites it. On any other deployment this
header is attacker-controlled and this function would need to change with it."*

`retryMessage` never leaks the mechanism — a test asserts the output does not match
`/bucket|rate_limits|select|insert/i`.

**`pruneRateLimits(86_400)` exists and nothing schedules it.** Growth is bounded by distinct
`(bucket, identity)` pairs forever — **including every IP that ever searched and every email
address ever tried at sign-in.** That table is also a list of email addresses, so any
data-retention or PII review must cover it.

### 13.2 The shared Zod schema library

> "Validation lives here rather than beside each action so there is one definition per rule
> instead of one per caller. **Two of the defects found in audit came from copies drifting
> apart.**"

The module is **pure** — no `server-only`, no `next/headers` — so it is unit-testable *and*
importable from client components for `maxLength` attributes.

| Schema | Bounds |
| --- | --- |
| `usernameSchema` | 3–24, `^[a-zA-Z0-9_]+$`, not reserved, not `guest_`-prefixed |
| `passwordSchema` | ≥8 chars, ≤400 chars (*"a cheap guard so a megabyte string is rejected before it is encoded"*), **≤72 bytes** |
| `signInSchema.password` | ≥1 char, ≤400 chars, ≤72 bytes — over-length message is the **generic** auth failure |
| `calendarDate` | four layers: `^\d{4}-\d{2}-\d{2}$`; a **round-trip `Date` check** (`parsed.toISOString().slice(0,10) === value`) which is what rejects `2026-02-30`; `>= "1930-01-01"` (*"That is before television."*); `<= today UTC` (*"You cannot log something you have not watched yet."*) |
| `tagList` | ≤12 tags, each trimmed **and lowercased BEFORE measuring**, then 1–32 chars |
| `reviewBody` | ≤20,000 — *"Long enough for an essay, bounded so one row cannot be a megabyte"* |
| `showIdSchema` | positive int ≤ `MAX_DB_INT` |
| `seasonNumberSchema` / `episodeNumberSchema` | int 0–10,000 / 0–100,000 (min 0 because specials are season 0) |

**`calendarDate` is the SEC-05 fix.** Postgres accepts the literals `infinity`, `-infinity`,
`now`, `today` and `epoch` as dates; **one stored `infinity` made `EXTRACT(YEAR FROM
watched_on)` throw on that member's public diary and year pages for every visitor,
permanently, with no way to undo it from the interface.** The root cause was named as
duplicated validation: *"a validated schema in one action and an unvalidated one in
another."*

**`tagList` normalises before measuring** for a real reason: `İ` (U+0130) lowercases to two
code units, so a 17-character tag became a 33-character value and overflowed `varchar(32)`
at insert time. **Reversing the order reintroduces the bug.**

### 13.3 Browser hardening (`proxy.ts`)

Next 16 renamed Middleware to **Proxy**. The file is `proxy.ts` at the project root and
exports `proxy(request)` plus `config`.

Per request it mints a nonce (`crypto.randomUUID().replace(/-/g, "")` — *"a reused nonce is
the same as no nonce"*), sets it on **both** the forwarded request headers and the response,
and adds:

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(),
                    magnetometer=(), microphone=(), payment=(), usb=()
X-Frame-Options: DENY
Cross-Origin-Opener-Policy: same-origin
```

CSP: `default-src 'self'`; `img-src 'self' data: blob: https://image.tmdb.org`;
`font-src 'self'` (*"next/font self-hosts at build time, so no external font origin is
needed"* — this is why the fonts **must** come through `next/font` and not a stylesheet
link); `connect-src 'self'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`
(*"relevant because auth posts are forms"*); `frame-ancestors 'none'`; `frame-src 'none'`;
`worker-src 'self' blob:`; `manifest-src 'self'`; `upgrade-insecure-requests`;
`script-src 'self' 'nonce-…' 'strict-dynamic'` plus `'unsafe-eval'` **only** in development.

**`style-src` keeps `'unsafe-inline'` deliberately:** *"The interface sets style attributes
from trusted values — heatmap cell colours, avatar gradients, meter widths — and none of it
is attacker-controlled."* Blocking them would break the UI without closing a real attack
path, while the protection that matters stays strict.

**What the proxy does NOT do — and this is the load-bearing fact:** it never calls `auth()`,
never reads a cookie, never redirects, and **protects no route.** There is no matcher on
`/settings` or `/admin`. Every authorization decision happens inside the page or the action.
This matches Next's own guidance: *"Proxy is not intended for… full session management or
authorization."* **If you port the matcher regex expecting it to gate routes, you will ship
an unprotected app.**

The matcher runs on documents only and skips prefetches, *"because running this on every
asset request would cost a proxy invocation each time for no benefit."*

### 13.4 The audit findings, condensed

| ID | Severity | Finding | Root cause | Fix |
| --- | --- | --- | --- | --- |
| SEC-01 | CRITICAL | A rating click destroyed the member's own review, diary date, flags and tags | *"A write API that expressed 'replace' when callers meant 'patch'"* | patch semantics + prime forms from the real log |
| SEC-02 | HIGH | Private-list title/description leaked via `generateMetadata` | *"Two entry points into one route with the authorization check on one of them"* | the check duplicated in both |
| SEC-03 | HIGH | Writes into invisible targets (like/comment on a private list) | *"Existence and visibility treated as the same question"* | one shared `assertVisibleTarget` |
| SEC-04 | HIGH | Sign-up unbounded vs sign-in capped at 200 → accounts that could never be signed into | *"The same rule expressed twice, in two places, differently"* | one shared `passwordSchema` |
| SEC-05 | HIGH | A stored `infinity` date permanently 500'd a member's public pages | *"A validated schema in one action and an unvalidated one in another"* | shared `calendarDate` |
| SEC-06 | MEDIUM | Oversized route ids returned 500 instead of 404 | *"Route parameters treated as trusted numbers"* | `parseBoundedInt` / `parsePage` / bounded slug parsing |
| SEC-07 | MEDIUM | No rate limiting anywhere | *"No shared limiter, and no place where one was structurally required"* | Postgres fixed-window counters inside `guard()` |
| SEC-08 | MEDIUM | No CSP or hardening headers | *"Framework defaults were never revisited"* | `proxy.ts` |
| SEC-09 | MEDIUM | Account enumeration via response timing | *"An early return on the 'not found' path"* | always compare against a real bcrypt hash |
| SEC-10 | MEDIUM | Driver errors logged with SQL and bound parameters | *"Logging an unbounded object rather than chosen fields"* | `safeErrorDetail` |
| SEC-11 | MEDIUM | A 30-day stateless session outliving its account | *"Statelessness with no verification point on the write path"* | `requireUser` re-reads the row; 14-day sessions |
| SEC-12 | LOW | `?q=%` returned the entire catalogue and every member | *"Treating a search string as a pattern"* | `escapeLike` / `containsPattern` |
| SEC-13 | LOW | Case-insensitive uniqueness enforced only in application code | *"An invariant checked in a read-then-write instead of declared in the schema"* | functional unique indexes on `lower(...)` |
| SEC-14 | INFO | No password reset | accepted at audit time | **subsequently built anyway** (migration 0005) |
| SEC-15 | INFO | Registration discloses that an email is taken | accepted: the generic alternative needs a notification email, and 5/hour bounds enumeration | — |
| SEC-16 | HIGH | Password length bounded in characters, so `"é".repeat(36)` authenticated `"é".repeat(72)` | *"Measuring a limit in a different unit from the limit it enforces"* | `TextEncoder` byte bounds |
| SEC-17 | MEDIUM | No email verification | — | full hashed single-use token flow |

**Verified clean at audit time** (still useful as a checklist): injection (every query is
Drizzle with bound parameters; the one `sql.raw` interpolates a hard-coded column name),
XSS (no `dangerouslySetInnerHTML`, no markdown renderer — all member text renders as escaped
JSX children), secrets (no credential in the full git history), CSRF (Next validates Origin
against Host for every Server Action; Auth.js adds its own token; **no state-changing GET
exists** — the ad click route is a later, deliberate exception), CORS, SSRF, file upload
(none — avatars are generated), webhooks (none), payments (none), cross-user reads and
writes, cookies (`HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-`/`__Secure-` prefixed),
transport, dependencies, third-party browser scripts (**none at all** — no analytics, no tag
manager, no CDN script, no chat widget; fonts are self-hosted by `next/font` at build time).

**Two sections of `SECURITY_AUDIT.md` are now stale and must not be trusted:** the "Verified
clean" list claims *"No admin role, dashboard, or impersonation exists"* and *"Email. None
sent"* — both were true on 2026-08-11 and are now false. `SECURITY.md` similarly still says
*"There is no password reset."* **Read the code, not the docs, for those two flows.**

### 13.5 Accepted residual risks

Documented, not overlooked: no individually revocable sessions (a stolen cookie is valid up
to 14 days, and **a password reset does not invalidate existing sessions** — the JWTs have no
`jti` or version claim, so the only global revocation is rotating `AUTH_SECRET`);
registration confirms email existence; fixed-window 2× bursts; `x-forwarded-for` trust; no
alerting; the limiter fails open; seeded demo accounts share a published password; the
database role is the Neon owner rather than a least-privilege application role; no external
penetration test.

### 13.6 The dynamic probe

`npm run security:probe` is a **453-line HTTP attack harness** run against a live server
(not in CI). Six sections — headers, anonymous access, malformed input, error hygiene,
authenticated boundaries, rate limits — with 34 assertions. It drives
`/api/auth/csrf` + `/api/auth/callback/credentials` directly and asserts the session cookie
is `HttpOnly` and `SameSite`-restricted and that a 4-character mutation of the token yields
no session.

Two honest caveats in the harness itself: one rate-limit assertion is
`report(..., sawRejection || true, ...)` and therefore **always passes** (the comment
concedes it and points at the unit test), and the error-hygiene checks downgrade to
informational against a dev server. Running it **deliberately trips limits and locks out the
accounts and source address it touches** for up to an hour. Do not point it at production.

> **Porting note (§13).** The limiter, the token module, the password schemas, the
> `guard()` wrapper, the CSP and every header, the `lower()` unique indexes, and the
> `calendarDate` machinery all copy verbatim — every auth budget number included.
>
> **Change these:** the outbound budget name **and number** (`600/60s` is a TMDB figure;
> MusicBrainz's ~1 req/s means roughly **50/60s** plus a serialising queue, and Spotify
> returns `Retry-After` on 429 which this code **does not honour at all**);
> `SEASON_MAX`/`EPISODE_MAX` → disc and track bounds (note the min becomes 1, though a
> pregap track is sometimes numbered 0); `showIdSchema` → a UUID or base62 shape check;
> `RESERVED_USERNAMES`; the `img-src` host; and the probe's nine malformed-input URLs.
> Add an OAuth token-refresh path if you choose Spotify — a failure mode the TV version does
> not have.

---

## 14. Admin and moderation

A **single-role** operator panel bolted onto a member app that was designed with no
privilege tier at all. It answers exactly one authorization question: *is the signed-in
member's `users.role` column equal to the string `'admin'` right now?*

### 14.1 The role model

One column: `role varchar(16) NOT NULL DEFAULT 'member'`. Two values in use, compared as
plain strings. **No roles table, no permissions table, no per-capability grants** — every
admin has every capability.

> "Never settable through any member-facing path: there is no action that writes this
> column, so the only way to become an admin is the operator running `npm run admin:grant`.
> **Privilege escalation has to be impossible by construction, not merely unimplemented.**"

A test asserts the safe defaults on insert — a fresh user has `role: "member"`,
`plan: "free"`, `emailVerifiedAt: null`, `planUpdatedAt: null` — because *"Privilege and
paid status must never be the default, and must never be derivable from anything the client
sends at registration."*

### 14.2 `requireAdmin()` — per-request DB resolution, fail-closed

```ts
// lib/auth/admin.ts — import "server-only"
const user = await currentUser();                       // session only; SessionUser has NO role field
if (!user) throw new ForbiddenError();
const account = await db.query.users.findFirst({ where: eq(users.id, user.id),
                                                 columns: { role: true } });
if (account?.role !== "admin") throw new ForbiddenError();
return { ...user, role: "admin" as const };
```

**The role is never in the session token.** *"Throws rather than returning a flag, so a
caller cannot forget to check the result."* A test flips the answer with `UPDATE users SET
role='admin'` and back **with no re-login**, proving nothing is cached.

**If you port this and put the role in the JWT for speed, you break the single stated
invariant** — revocation must take effect on the next request, not on token expiry.

### 14.3 Granting is a CLI, not a UI

`npm run admin:grant -- <email> [--revoke]`. Case-insensitive lookup by raw SQL. On grant it
also sets `emailVerifiedAt: sql`coalesce(email_verified_at, now())`` — *"An unverified admin
would be blocked by the publishing gate"* — never clobbering a real timestamp.

No confirmation prompt, **no audit row for a grant** (the log records in-app actions only),
and no way to list current admins other than the `· admin` suffix in the accounts table.

### 14.4 Four gates for one privileged read

1. **Route.** Both admin pages open with
   `try { admin = await requireAdmin() } catch (e) { if (e instanceof ForbiddenError)
   notFound(); throw e }`. Non-Forbidden errors are **rethrown** so real failures still
   surface as 500s. *"A 403 confirms the route exists and that they found a real admin
   surface. A 404 is indistinguishable from a typo."*
2. **Metadata.** `robots: { index: false, follow: false }` and `referrer: "no-referrer"`.
3. **Query.** `listAccounts` and `listRecentAdminActions` **each call `requireAdmin()`
   themselves**:

   > "Every function here calls `requireAdmin` itself rather than trusting its caller to
   > have done so. These queries return email addresses and account state, so a page that
   > forgot the check would be a disclosure bug; **making the query refuse is the difference
   > between one mistake and a breach.**"

   The cost — three role lookups per `/admin` render — is accepted as the price of the
   property.
4. **Action.** Every mutating action calls `requireAdmin()` as its first statement inside
   `guard()`, before parsing input, so a forged `Next-Action` invocation with a valid member
   session is refused.

**Notably absent: any middleware/proxy gate.** And the self-gating is **not uniform** —
`lib/db/queries/ads.ts` (`listAds`, `adTotals`, `adDailyStats`) does *not* self-gate, only
`import "server-only"`. A future page calling `listAds()` without `requireAdmin()` would
leak ad inventory and revenue counters. **Port the `admin.ts` pattern to both.**

### 14.5 The staleness check — `expectedUsername`

All three account actions share:

```ts
targetSchema = z.object({ userId: z.number().int().positive().max(MAX_DB_INT),
                          expectedUsername: z.string().min(1).max(32) });
```

> "Echoed back from the row the admin was looking at. Compared against the database before
> acting, so a stale table or a swapped id cannot delete the wrong account — **the id alone
> is not enough.**"

Enforcement is identical in all three: re-read by id, then `"That account no longer
exists."` or `"That account has changed since the list was loaded. Reload and try again."`
The comparison is **case-sensitive**, which matters because usernames are stored
case-preserving behind a case-insensitive index.

A parse failure returns the deliberately uninformative *"That request does not look
right."* — unlike the ad creation form, which *does* surface the Zod message because it is a
form an admin is filling in.

### 14.6 The seven capabilities

| Action | Notes |
| --- | --- |
| `setAccountPlan` | free ⇄ pro. **The only writer of `users.plan` anywhere.** Idempotent no-op at the current value, which writes **no audit row** — so the log records state *changes*, not attempts. `planUpdatedAt` uses server-side `sql`now()``. |
| `deleteAccount` | Checks in a strict order: self-delete refused **before the DB read** (*"Deleting yourself would remove the only way back into this panel"*); then existence; then username match; then `role === "admin"` refused (*"Another admin has to be demoted first — deliberate friction, so one compromised admin session cannot remove the others"*). Since demotion needs DB credentials, **deleting an admin is a two-key operation.** Then one transaction: audit row **first**, then the delete. Client-side arm/confirm with a 5s self-disarm. |
| `sendAccountPasswordReset` | Three stated properties: the address is read from the database so *"this cannot be turned into a relay"*; **the reset does not change the password**, so *"an admin using this cannot take over an account without the owner's mailbox — which is why there is no 'set a new password for this member' button anywhere"*; and it is **audited before the mail is attempted**, so a failed send still leaves a record. Reports `delivered` vs `logged` honestly, because *"an admin telling somebody 'check your email' needs to know that it will not arrive."* One click — *"Sending a reset does not change the password… so one click is the right amount of friction."* |
| `createAd` | `status: "draft"` hardcoded. Indie ads require a credit: *"An indie placement without a credit is just an ad with a blue border."* |
| `setAdStatus` | idempotent no-op writes no audit row |
| `setAdWeight` | 1–100 |
| `archiveAd` | **Archive, never delete:** *"The per-day counters are the record of what ran, and deleting the ad would cascade them away — so an advertiser asking 'what did we get' a month later would be told nothing ran at all."* |

Admin actions are in `VERIFICATION_EXEMPT` because *"the verification check would only add a
way for an operator to lock themselves out of the panel"* — but they are **not** exempt from
the rate limiter, so a bulk moderation script is capped at 120 writes/minute.

A graded console side-channel exists **in addition** to the DB row: `console.info` for plan
changes, `console.warn` for deletions. These contain usernames and are **not** covered by
`safeErrorDetail` scrubbing.

### 14.7 The audit trail

`recordAction(tx, entry)` takes the **transaction handle as its first parameter** — typed as
`Parameters<Parameters<typeof db.transaction>[0]>[0]` — **so the row cannot be written
outside the transaction that applies the effect.** Actor fields always come from the
`AdminUser` returned by `requireAdmin`, never from client input.

(The ad actions use a *different*, non-transactional local `audit()` helper that runs
**after** the mutation with null target fields — an inconsistency worth resolving in a
rebuild.)

**"Append-only" is a convention, not an enforcement.** No trigger, no `REVOKE
UPDATE/DELETE`, no hash chain. Anyone with DB credentials can rewrite history — and DB
credentials are also the grant mechanism, so **the operator is fully trusted by
construction.**

There is exactly one read surface: the last 10 rows on `/admin`. No full-history view, no
filter, no export, no pagination. Anything older requires SQL access.

### 14.8 The mechanical no-escalation test

The highest-value artefact in the subsystem. A **source-level** assertion:

```ts
const allowed = new Set(["app/actions/admin.ts", "scripts/grant-admin.ts"]);
// walk app/, lib/, components/, scripts/ for .ts/.tsx, skipping the allowlist
if (/\.set\(\s*\{[\s\S]{0,400}?\b(role|plan)\s*:/.test(source)) offenders.push(path);
expect(offenders).toEqual([]);
```

> "only the admin action and the operator's grant script may write these columns. A future
> action that sets `role` or `plan` fails this test instead of quietly shipping privilege
> escalation, which is the failure mode worth catching mechanically."

**Know the limits of the guarantee you are porting:** a raw
`db.execute(sql`UPDATE users SET role...`)`, or a writer placed in `tests/` or `drizzle/`,
slips past it.

> **Porting note (§14).** Everything here is domain-generic. **Port the structural
> no-escalation test first and verbatim** — it is what keeps the invariant true over time.
> Only three things change: the enumerated child tables in the delete-confirmation copy, the
> `revalidatePath("/show/[slug]", "layout")` target, and the ad credit-block field names.

---

## 15. Monetisation: house ads

First-party rows only. **No third-party script, no ad network, no pixel — which is why the
CSP needs no holes cut in it.**

### 15.1 The one-third indie reservation

Two constants drive everything:

```ts
const INDIE_EVERY = 3;
const MAX_ADS_PER_PAGE = 2;

planKinds(slotCount, seed) {
  const count = Math.min(slotCount, MAX_ADS_PER_PAGE);
  return Array.from({ length: count }, (_, index) =>
    seedHash(`${seed}:slot:${index}`) % INDIE_EVERY === 0 ? "indie" : "general");
}
```

Each slot **independently** draws indie with probability ~1/3 from its own hash bucket.
Including the index in the hash input is what makes slot 0 and slot 1 draw differently from
the same page seed, and what makes the *reserved position* vary between pages.

**Consequences, stated explicitly in both the source and the admin UI:** indie gets a third
of all **slots**, not a third of **pages**, and not one guaranteed unit per page. On a
two-unit page roughly 4/9 of views carry no indie unit, 4/9 carry one, ~1/9 carry two. The
long-run impression share is exactly 1/3.

**The rejected alternative is named:** forcing "at least one indie slot on every page" reads
like a floor and silently yields a **50%** share on a two-unit page — half the paid inventory
given away. A test plans 2,000 pages (4,000 slots) and asserts the share is within ±0.04 of
1/3, with a comment naming exactly that bug as the one it exists to catch.

**The reservation is a preference, not a lock:** `pool = preferred.length > 0 ? preferred :
eligible`. A slot reserved for indie with no indie inventory serves a general ad, and vice
versa. A slot where nothing was eligible is **omitted**, so the page renders nothing rather
than an empty frame.

`MAX_ADS_PER_PAGE = 2` carries its own rationale:

> "A television diary is not an ad-supported content farm, and the moment a member counts
> three of these the surface is worth nothing to anybody — including the filmmaker whose
> short is sitting in the third one."

### 15.2 Deterministic selection

```ts
seedHash(input) {                                   // FNV-1a, 32-bit
  let value = 2_166_136_261;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 16_777_619);
  }
  return value >>> 0;
}
```

> "Deterministic across processes, unlike anything seeded by time."

That matters because Next renders across many serverless instances **and because impression
counting only means something if a reload does not reshuffle the page.**

The page seed is `${viewerId ?? "anon"}:${pageKey}:${hour}` where
`hour = Math.floor(Date.now() / 3_600_000)`. Three components: **who** (or the literal
"anon"), **which page**, and an **hour bucket** — stable across reloads within the hour,
rotating hourly, different per page.

`pickAd` then: filter by exclusion and slot eligibility (`ad.slot === "any" || === slot`);
prefer the drawn kind with fallback; score `Math.max(1, weight) * (genreMatch ? 2 : 1)` — **a
genre match doubles the weight, as a bonus, never a filter**; and walk a cumulative-weight
list with `cursor = seedHash(`${seed}:${slot}`) % total`. Note the **different hash
namespace** from `planKinds`, so the kind draw and the pick within a kind are uncorrelated.

`planPage` keeps a `placed` Set so a two-slot page with one ad in inventory gets **one**
unit, not the same card twice.

### 15.3 Serving-time rules

**Eligibility** is `status = 'active' AND (starts_at IS NULL OR starts_at <= now) AND
(ends_at IS NULL OR ends_at > now)` — a half-open window. Draft, paused and archived rows
never load.

**Row → candidate mapping is defensive:** `kind: row.kind === "indie" ? "indie" : "general"`
and the same for slot — anything unrecognised in those varchar columns degrades rather than
throwing.

**The Pro exemption:**

```ts
adsEnabledFor(userId) {
  if (userId === null) return true;                      // signed-out visitors DO see ads
  const account = await db.query.users.findFirst({ …, columns: { plan: true } });
  return account?.plan !== "pro";
}
```

Read from the `users` table on every serve and **never from the session token** — *"A plan is
exactly the kind of thing a client would like to assert about itself."* Guests see ads
(default `plan = 'free'`). The exemption is enforced **at the point of fetch**, so for a Pro
member **no candidate query runs at all** — not by hiding a rendered slot with CSS.

**Affinity reuses the taste model rather than building a second behavioural profile:** at
least 3 rated shows, positive lean only, top 5 genre keys, and the whole thing wrapped in a
`try/catch` whose failure mode is **an absent bonus, never a failed page.**

> "the affinity that decides which short film to show somebody is the same affinity that
> decides what to recommend them."

### 15.4 Frequency capping, such as it is

**There is no per-member impression cap and no cookie.** Capping is four structural
mechanisms: the hard per-page ceiling of 2; no repeat within a page; hourly seed rotation;
and per-page keying (`"home"`, `"show:{tmdbId}"` — *"Keyed to the show, so a member moving
between shows is not shown the same unit every time"*).

**The counters are explicitly reporting, not billing**, which is why nobody built a stricter
cap.

### 15.5 Impression and click tracking

**The impression beacon** is an invisible `absolute inset-0` span rendered as the first
child of every ad card, with a `sent` latch and an `IntersectionObserver` at
`threshold: 0.5` — **half the unit must be on screen**, *"so a sliver at the edge of the
viewport does not count."* The fetch uses `keepalive: true` so navigating away does not drop
it, and an empty `.catch(() => {})` because *"A missed count is not worth a console error on
somebody's page."* If `IntersectionObserver` is undefined it reports immediately.

> "A render is not a view — a sidebar three screens down gets rendered every time and seen
> rarely — and writing to the database while rendering would also make the page uncacheable."

**`POST /api/ads/impression`**, in order: a same-origin check (a **missing** Origin is
allowed — a same-origin navigation or a non-browser caller, covered by the rate limit; a
**wrong** Origin is 403); `adEventByIp` → 429; malformed JSON → 400; a bounded-integer check
→ 400 (*"an integer column cannot hold anything else, and a string here would be a 500 rather
than a 400"*); then record.

The threat model is stated at the top of the file: **no session is read, no cookie is set,
nothing about who saw it is stored** — *"the worst outcome is an inflated number in a
report."* That is what makes the endpoint uninteresting to attack.

**`GET /api/ads/[id]/click`** — and note the order:

```ts
if (limit.ok) await recordAdEvent(id, "click");
return NextResponse.redirect(target, 302);
```

**Over the limit the click still forwards, it is just not counted** — *"refusing to forward
somebody who clicked a link is worse than an uncounted click."* A paused, archived or
missing ad redirects to `/` — *"leaves the member somewhere real rather than on an error page
they did not ask for."*

`clickTarget` re-tests `/^https?:\/\//i` on the stored URL **before returning it**, so a
`javascript:` URL that somehow reached the column can never become a redirect (there is a
test that writes exactly that). **No open redirect is possible because the destination comes
from the row, never from the query string.**

The GET-that-writes is a deliberate documented trade: *"a click has to survive being
middle-clicked and opened in a new tab, and a form post cannot do that. The write is a single
increment with no other effect, so the usual reason to forbid it does not apply."*

### 15.6 The counter write

One statement, a CTE plus an upsert, with the column name interpolated via `sql.raw` from a
**two-valued literal** so there is no injection surface:

```sql
WITH bump AS (
  UPDATE ads SET <column> = <column> + 1, updated_at = now()
  WHERE id = $1 AND status <> 'archived'
  RETURNING id
)
INSERT INTO ad_stats (ad_id, day, <column>)
SELECT id, CURRENT_DATE, 1 FROM bump
ON CONFLICT (ad_id, day) DO UPDATE SET <column> = ad_stats.<column> + 1;
```

Because the INSERT selects **from the CTE**, an archived ad increments nothing at all.

**The privacy design is asserted mechanically.** A test records two impressions and one
click and then checks that `ad_stats` has exactly **one** row and that
`Object.keys(daily[0])` does **not** contain `"userId"`.

> "One row per ad per day rather than one row per impression: an advertiser needs a daily
> curve, and nobody needs a log of which member saw which ad. **That is a deliberate limit on
> what this table can ever be used for.**"

**There is deliberately no image column:** *"Uploads would need a bucket, and remote images
would need host allowlisting plus a review process for what those hosts serve. A headline, a
line of copy and a credit are enough, and **they cannot carry a tracking pixel.**"*

> **Porting note (§15).** The machinery is entirely generic: the reservation draw, the FNV-1a
> seeding, the weighted walk with its affinity bonus, the exclusion set, the eligibility
> window, the daily rollup with its archived-ad no-op, the beacon with its 0.5 threshold and
> `keepalive`, the click-forwards-even-when-throttled rule, the URL re-validation, and the
> plan-read-from-the-database exemption.
>
> **Only the editorial concept is domain-flavoured:** an indie-*filmmaker* spotlight becomes
> an indie-artist or independent-label spotlight. `projectKind` becomes
> `single | EP | LP | mixtape`; `festival` becomes `label` or `venue`; `creatorName` stays as
> the artist's name. The `genres jsonb` affinity bonus works identically because it is
> matched against free-text taste-profile genres.
>
> One thing to keep: **the admin UI explains the policy in prose using the real constants**
> ("One slot in 3 is drawn for the indie spotlight, so indie takes a third of all
> impressions"; "A reserved slot with no indie inventory falls back to a general ad rather
> than rendering empty"). An operator who cannot explain the reservation cannot sell it.

---

## 16. UI and the design system

### 16.1 Aesthetic direction (from the spec)

"Filmic modern", executed as a dark, poster-forward interface with restraint. *"The
reference points are title sequences and Criterion-style editorial layout, not a
skeuomorphic television set."*

### 16.2 Tailwind v4, CSS-first — every token

`globals.css` opens with `@import "tailwindcss";`. **There is no `tailwind.config.js`
anywhere.** PostCSS runs one plugin. Everything lives in an `@theme {}` block, and Tailwind
v4 turns each `--color-X` into the full utility family (`bg-X`, `text-X`, `ring-X`,
`border-X`, `X/12` opacity modifiers), each `--font-X` into `font-X`, and `--radius-card`
into `rounded-card`.

**Surfaces, darkest to lightest:**

```
--color-ink:         #08090b   /* page background, dialog scrim base */
--color-surface:     #101216   /* .card background */
--color-surface-2:   #171a20   /* inputs, chips, poster placeholder, hover fill */
--color-surface-3:   #1f232b   /* scrollbar thumb, progress track, secondary hover */
--color-line:        #262b34   /* every border and hairline */
--color-line-bright: #5b6472   /* also the empty-star track, which needs 3:1 as a
                                  meaningful graphical object */
```

**Text:**

```
--color-paper: #f2f4f7
--color-muted: #a7aeba
--color-faint: #949cab
```

`--color-faint` carries an eight-line comment worth reading in full: it was lifted from
`#6b7280`, which measured **3.26:1** on surface-3 and **4.12:1** on the base — both under the
4.5:1 that 11–13px text needs — *"and that text carries the dates and episode numbers this
product is made of."* The new value clears 4.5:1 on every surface in the palette.

**Accents:**

```
--color-amber:        #e9b44c   /* the single warm accent: rating, emphasis, focus, primary */
--color-amber-bright: #f6c968
--color-teal:         #4fd1c5   /* progress ONLY */
--color-rose:         #e2557b   /* destructive / errors */
--color-cinema:       #57a3ff   /* Absolute Cinema — the same hex as the top rating bracket,
                                   "held here so the honour and the heatmap's peak cannot
                                   drift apart" */
```

**Fonts** (note the self-referential wrapping of `next/font`'s variables):

```
--font-display: var(--font-display), ui-serif, Georgia, serif;   /* Instrument Serif 400 */
--font-sans:    var(--font-sans), ui-sans-serif, system-ui;      /* Geist */
--font-mono:    var(--font-mono), ui-monospace, monospace;       /* Geist Mono */
```

**Other tokens:** `--radius-card: 0.625rem` (the single card/poster radius) and
`--ease-out-quick: cubic-bezier(0.2, 0.8, 0.3, 1)` — the house easing.

**No custom spacing scale.** Tailwind v4's default 0.25rem step, untouched. Container widths
are hand-picked per page: the shell is `max-w-7xl`, hero content `max-w-6xl`, reviews
`max-w-3xl`, lists `max-w-5xl`, auth `max-w-sm`, error/404 `max-w-md`.

**Dark mode strategy: there is none.** `:root { color-scheme: dark; }` and nothing else. No
`dark:` variant anywhere, no toggle, no `prefers-color-scheme` query, no light palette. The
header comment says it outright: *"Dark only."*

The only non-`@theme` variable is `--heat-none: #22262e`, the unrated heatmap cell. Its
eleven-line comment explains why **the rating ramp deliberately does not live in CSS**: the
bracket sets the hue and the position inside the bracket sets the shade, *"which a fixed set
of variables cannot do."*

### 16.3 Global element styling

- **`* { border-color: var(--color-line); }`** — a global default so any `border` utility is
  the hairline colour without naming it. **This is load-bearing**: plenty of places write
  bare `border`.
- **`body { overflow-x: hidden }`** — not cosmetic. Full-bleed heroes measure against
  `100vw`, which includes the scrollbar, and would otherwise add a horizontal scrollbar
  exactly the scrollbar's own width wide. **It is the required companion to `.bleed`.**
- **Film grain** — `body::after`, fixed, `inset 0`, `z-60`, `pointer-events: none`,
  `opacity: 0.035`, an inline data-URI SVG using `<feTurbulence type="fractalNoise"
  baseFrequency="0.9" numOctaves="3"/>` on a 140×140 tile. Fixed rather than absolute *"so
  it reads as emulsion rather than texture scrolling with the content."* At z-60 it covers
  the sticky header (z-50) but sits under dialogs.
- **Focus** — one global rule: `:focus-visible { outline: 2px solid var(--color-amber);
  outline-offset: 2px; }` — *"Focus is always visible and always amber, so keyboard travel is
  legible on every surface."* Components only add `focus:outline-none` when they replace it
  with their own ring.
- **Scrollbars** — 10px, ink track, surface-3 thumb as an inset pill. Horizontal rails opt
  out with `[scrollbar-width:none] [&::-webkit-scrollbar]:hidden`.

### 16.4 The `@layer components` vocabulary — eight classes

Inside `@layer components` so Tailwind utilities still win.

| Class | What |
| --- | --- |
| `.eyebrow` | The most-used class in the app: mono, **11px**, `letter-spacing: 0.18em`, uppercase, `--color-faint`. Every section label, every form label, the 404's "404". |
| `.section-rule` | Flex with an `::after` that is a 1px `linear-gradient(to right, var(--color-line), transparent)` filling the remaining width. Used by the feed's sticky date headers. |
| `.poster` | **The key geometric primitive.** `aspect-ratio: 2/3`, `overflow: hidden`, `rounded-card`, `surface-2` background, `box-shadow: inset 0 0 0 1px var(--color-line)`, 160ms transitions. On `.group:hover .poster`: `translateY(-3px)` plus an amber inset rim and a soft drop shadow. **The `.group:hover` selector is what lets a wrapping `<Link className="group">` drive it.** Reused for non-2:3 panels too. |
| `.hero-scrim` | Two stacked gradients (to-top and to-right) *"so hero text always lands on a dark field."* |
| `.hero-vignette` | `radial-gradient(120% 80% at 50% 30%, transparent 40%, rgb(0 0 0 / 0.55) 100%)` |
| `.card` | surface + 1px line + `rounded-card`. Stat tiles, empty states, dialogs, sidebar panels. |
| `.bleed` | `margin-inline: calc(50% - 50vw)` — escapes the centred column so a backdrop reaches both window edges. Depends on the `body` overflow guard. |
| `.letterbox` | `::before`/`::after` 1px blocks bracketing a title block like film letterbox bars. |

Plus two utilities: `.text-balance` and **`.tabular`** (`font-variant-numeric: tabular-nums`)
— on every mono number so digits do not jitter.

### 16.5 Motion

- **`.stagger > *`** — `animation: rise 420ms var(--ease-out-quick) both` with six
  hard-coded 30ms delay steps and `nth-child(n + 7)` **pinned at 180ms**, *"so a 24-card grid
  does not take four seconds to land."* `rise` is `opacity 0 → 1` plus `translateY(8px) →
  none`. Baked into `PosterGrid`, so every grid gets it and rails do not.
- **`.hero-frame`** — keyframes `0%,14% { opacity: 1 } 20%,94% { opacity: 0 } 100% { opacity: 1 }`,
  with duration and delay computed inline as `frames.length * 7` seconds and
  `index * 7 - 7` seconds. With five frames that is a 35s loop: 4.9s hold, 2.1s cross-fade.
  The negative delay on frame 0 means the visible order at t=0 is frame 1.
- **Two separate reduced-motion blocks, doing different jobs.** The first kills the hero
  specifically and hides all but the first frame: *"A slow cross-fade is still motion, and
  this is decoration — there is nothing to degrade gracefully to."* The second is the blanket
  kill switch (`animation-duration: 0.001ms !important`, etc.) plus `scroll-behavior: auto`.

### 16.6 The Radix + cva primitive pattern

**Exactly four Radix packages are imported anywhere**, despite nine being installed:
`react-slot`, `react-dialog`, `react-dropdown-menu`, `react-tabs`. (Unused: avatar, label,
popover, switch, tooltip.)

The wrapper convention is consistent: `import * as Primitive`, re-export the parts that need
no styling as bare aliases, and wrap only the styled parts in a function spreading
`React.ComponentProps<typeof Primitive.Y>` merged through `cn()`. Every Radix wrapper carries
`"use client"`.

**`cva` is used exactly once, in `Button`.** Five variants — `primary` (amber on ink),
`secondary` (**the default**), `outline`, `ghost`, `danger` — and four sizes with icon sizing
done via the `[&_svg]` descendant selector *so callers just drop a lucide icon in as a child
and never size it*.

`asChild` swaps the element for `Slot`, which is how every navigation button is written:
`<Button asChild variant="primary"><Link href="/shows">Browse shows</Link></Button>`.
**`Button` has no `"use client"`** — it is a plain function component, so Server Components
render it directly, and `Slot` is used purely for prop merging.

`cn = twMerge(clsx(inputs))`. **tailwind-merge is what makes the `className` escape hatch on
every primitive actually work** — `<Button className="w-full">` overrides rather than
duplicates.

The non-Radix primitives use plain inline tone/size lookup objects instead of cva.

### 16.7 The generated avatar

**There is no image upload anywhere in the product**, so identity art is computed:

```ts
hash(input) { let v = 0; for (const ch of input) v = (v * 31 + ch.charCodeAt(0)) % 100_000; return v; }

key      = seed || username
gradient = PALETTES[hash(key) % 8]
angle    = hash(`${key}-angle`) % 360
initial  = (displayName || username).trim().slice(0, 1).toUpperCase()
style    = { backgroundImage: `linear-gradient(${angle}deg, ${from}, ${to})` }
```

Eight palettes, the first three matching the theme accents. Five sizes from `size-6` to
`size-24`.

**Guests short-circuit before any of this** and get a plain outline glyph, because *"The
generated avatar is an identity, and a guest does not have one yet — a 'G' monogram on a
coloured field would suggest a person rather than a placeholder."* The element is
`aria-hidden` in both branches; the accessible name always comes from surrounding text.

### 16.8 The shell

```
<body className="min-h-dvh antialiased">
  <a href="#main" className="sr-only focus:not-sr-only focus:fixed … focus:z-90">Skip to content</a>
  <SiteHeader/>            {/* sticky top-0 z-50 border-b bg-ink/85 backdrop-blur-md */}
  <GuestStrip/>            {/* usually null */}
  <VerifyBanner/>          {/* usually null */}
  <main id="main" className="mx-auto w-full max-w-7xl px-4 pb-24 pt-6 sm:px-6">{children}</main>
  <SiteFooter/>            {/* border-t bg-surface/40 */}
</body>
```

**The z-index ladder — five values in the whole app:** `z-10` feed date headers, `z-50`
sticky header, **`z-60` film grain (so grain sits over the header)**, `z-70` dialog overlay,
`z-80` dialog content and dropdowns, `z-90` the focused skip link.

Header nav is two links (`/shows` Browse, `/lists` Lists) plus `/for-you` **only when signed
in** — *"the page is meaningless without ratings."* The search box is hidden below `sm` and
replaced by a magnifier link.

The footer carries `/spotlight`, deliberately **not** in the header: *"the spotlight is worth
finding, but it is not one of the things somebody opens the app to do."* It also carries the
required attribution.

**Metadata:** the root sets `title.template = "%s · Cliffhanger"`, so a page's
`metadata: { title: "Search" }` renders "Search · Cliffhanger". OpenGraph is set once at the
root and never overridden. Token-bearing and admin pages add `robots: noindex` and
`referrer: "no-referrer"`.

### 16.9 Server vs Client boundaries

**The default is Server.** Exactly 33 files carry `"use client"`, and in the shell only:
`app/error.tsx` (Next requires it), the search box (needs `useState`/`useRouter`), the
account menu (Radix state + `window.confirm`), the three Radix wrappers, and `ProfileTabs`
(needs `usePathname`).

Everything else is a Server Component, **including async ones that fetch**: `SiteHeader` is
`async` and calls `currentUser()` directly, so the header re-reads the session on every
navigation rather than hydrating a client auth context.

**The split-component pattern** appears twice and is documented both times — a server half
that decides whether the thing applies and counts what it needs, and a client half that
owns dismissal and browser events. Note `GuestStrip` **always mounts the client banner even
when invisible**, because the client half owns the leaving warning.

**Suspense is used to keep slow work off the critical path** in two places: the taste-driven
home rails (*"the most valuable and the slowest, so they stream in last"*) and
`EpisodeSections` on the show page, which calls `ensureAllSeasons` (*"Isolated so their TMDB
fill cannot delay the rest of the page"*).

**The constraint that shapes the show page, and the most transferable lesson in this
section:**

> "`load()` resolves the show and nothing slow, because **this function decides the response
> status, and a `notFound()` raised after the shell has flushed would be sent as a 200.**"

**Any 404-deciding work must happen before the first Suspense boundary flushes.** Adding a
route-level `loading.tsx` to the show route would turn every 404 into a 200 with not-found
UI.

On the other side, **23 `lib/` modules import `server-only`** so they can never reach the
browser — with `lib/tmdb/images.ts` deliberately exempt.

### 16.10 Poster geometry

`PosterGrid` is `stagger grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 lg:grid-cols-6`.
`GRID_PAGE_SIZE = 24` lives **in the same file as the column classes**, with a nine-line
comment explaining that it is *"only correct as long as it agrees with them."*

`PosterRail` is a `flex snap-x overflow-x-auto` strip with fixed-width children
(`w-[132px] sm:w-[152px]`) and **vertical padding that exists specifically to leave room for
the poster hover lift**, *"which would otherwise trip the scroll container into showing a
second scrollbar."* **No arrow buttons** — *"Children keep their focusable links, so tabbing
scrolls the rail natively."*

Three overlays inside `.poster`: a teal dot with an `sr-only` "Fully watched" when complete;
a bottom gradient band holding `<Stars size="xs">` when the viewer has rated it; and a teal
progress line pinned to the bottom edge when partially watched.

The caption is two lines: a `line-clamp-2` title that goes amber on group-hover, then a
`tabular font-mono text-[0.6875rem]` row with the year and, when a member average exists,
`· ★ <stars>` with an `sr-only` " average member rating". **The browse page deliberately
passes no `memberAverage`** for provider results: *"the card's average slot is reserved for
Cliffhanger's own ratings."*

### 16.11 Typography in practice

Three families with strong role separation:

- **Display (Instrument Serif)** — headlines only, never body or UI. The wordmark, page h1s
  (`text-5xl sm:text-6xl leading-[0.95] text-balance` on the landing hero; `text-4xl` on
  profile/settings; `text-5xl leading-none` on year-in-review), section h2s, dialog titles,
  empty-state titles, and the hero's fluid `text-[clamp(2rem,6vw,4rem)]`.
- **Mono (Geist Mono)** — every label and every number: `.eyebrow`, nav links, filter chips,
  badges, tab triggers, pagination, poster year lines, stat-tile values, the error page's
  digest. The recurring literal `text-[0.6875rem]` is **11px** — the same size `.eyebrow`
  sets, and why `--color-faint` had to be lifted.
- **Sans (Geist)** — the body default, re-asserted explicitly only on poster titles.

Two tracking values in the whole system: `tracking-wider` (0.05em) on mono UI labels, and
`0.18em` on `.eyebrow`.

> **Porting note (§16).** Palette, type stack, grain, motion rules, the focus rule, the
> z-index ladder, the `@layer components` vocabulary, the Radix/cva pattern, `cn`, the
> generated avatar, the skip link, and the metadata template **all copy verbatim.**
>
> **The one hard change: album art is 1:1, not 2:3.** `.poster`'s `aspect-ratio`, every grid
> and card, the hero crop, the rail child widths, and the `GRID_PAGE_SIZE` column arithmetic
> must be re-proportioned. **And there is no backdrop image in either music provider** — the
> hero needs a different treatment (blurred/scaled cover art as its own scrim, or an artist
> image where available), which also means `.hero-scrim` and `.hero-vignette` are solving a
> problem you may not have.
>
> Rename `--color-cinema` with the honour (§8) and keep the "two literals, one comment"
> binding visible. Swap the `img-src` host and `remotePatterns` — remembering that Cover Art
> Archive redirects, so **two** origins are needed.

---

## 17. The Server Action contract and the layering doctrine

### 17.1 The layering rule

Stated in the README and the spec, and it is the organising principle of the whole
codebase:

> - Pure logic lives in `lib/ratings.ts` and `lib/tmdb/mappers.ts` and **has no I/O** and is
>   unit tested.
> - **Server Actions validate, authorize, mutate, and revalidate — nothing more.**
> - **Components receive data as props; they do not query.**
> - Each query module owns one table's reads.

```
lib/tmdb/        client, typed endpoints, mappers          (no DB, no React)
lib/ingest/      upsert show / season / episodes           (provider + DB, no React)
lib/db/          schema, connection, query modules         (no React)
lib/ratings/     rating math, histograms, colour scale     (pure)
lib/taste/       the recommender                           (pure model + DB reads)
lib/stats/       profile and year aggregation              (DB reads)
lib/auth/        Auth.js config, session helpers, guards
lib/security/    rate limits, Zod schemas, link tokens
app/actions/     Server Actions, one file per domain, Zod-validated
components/      presentational; data arrives as props
```

**Where the rule bends, and it is worth knowing:** the rules that *matter* were deliberately
pulled **out** of actions into `lib/` so they could be tested against a real database —
`lib/cinema/` exists because *"An action is a shell… and a rule that only exists inside one
is a rule nobody can prove."* Likewise `lib/auth/password-reset.ts`: *"a single-use token
that turns out to be reusable is not the kind of thing to discover in production."*

**Treat that as the sharpened version of the rule:** actions validate, authorize and
revalidate; **anything with a rule worth proving lives in `lib/` and is tested against a real
database.**

### 17.2 `ActionResult` and `guard()`

```ts
export type ActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? { data?: undefined } : { data: T }))
  | { ok: false; error: string };
```

A conditional-mapped discriminated union: when `T` is the default the success arm has an
optional absent `data`; when `T` is concrete, `data` is **required**. That is what makes
`return ok()` legal for `ActionResult` and illegal for `ActionResult<{logId: number}>`.
`fail(error): ActionResult<never>` — the `never` payload lets a failure be returned from any
typed action without a cast.

**`guard(label, body)` does three jobs, in order:**

1. **Rate limit** — `writeByUser` 120/60s for a signed-in caller, else `writeByAnon` 30/60s
   on the client address. On refusal: `console.warn("[action:rate-limited]", { label, actor })`
   and `fail(retryMessage(limit))`.

   > "The rate limit lives here rather than in each action **so a new action cannot be
   > written without one** — per-endpoint limits are the kind of control that gets forgotten
   > exactly once."

2. **The email-verification gate, default-deny by omission.** Fires only when
   `env.requireEmailVerification && user && !user.isGuest && !VERIFICATION_EXEMPT.has(label)`.

   > "anything absent from this list requires verification, so a new action is gated by
   > omission rather than by remembering to add a check."

   The 22 exempt labels fall into three groups: flows that would otherwise be unreachable
   (signIn, signUp, sendVerification, confirmVerification, resetPassword,
   requestPasswordReset); **self-scoped edits and deletions** (updateProfile, deleteLog,
   deleteComment, deleteList, removeFromList, unmarkSeasonWatched) — *"which nobody else can
   see the effects of and which should not be held hostage to slow mail"*; and admin actions,
   which are already behind a stronger gate.

   Anonymous callers are skipped because *"an anonymous request should hear 'sign in', which
   is what the action's own `requireUser` says, not 'confirm your email'."* Guests are
   skipped wholesale rather than exempting each guest-reachable action.

3. **Error conversion.** Exactly four classes become their own message —
   `UnauthorizedError`, `UnverifiedEmailError`, `GuestNotAllowedError`, `ForbiddenError`.
   Everything else is logged through `safeErrorDetail` and returned as the flat
   `"Something went wrong. Try again."`

   > "A non-admin gets the same flat refusal as a signed-out visitor: no hint about what the
   > action was or that they were close to reaching it."

**`safeErrorDetail` whitelists only `name`, `message`, `code`, `constraint`.** Do not add
`stack`, `query`, `parameters` or `detail`:

> "Driver errors carry the failing SQL and, depending on the driver, its bound parameters —
> which for this app means review bodies, email addresses, and password hashes. Logs are not
> a safe place for any of that, and Vercel logs are readable by anyone with project access."

**A new domain error class that is not added to that list disappears into a generic
message.**

### 17.3 The shape every action takes

```ts
export async function saveLog(input: SaveLogInput): Promise<ActionResult<{ logId: number }>> {
  return guard("saveLog", async () => {
    const user   = await requireUser();
    const parsed = saveLogSchema.safeParse(input);
    if (!parsed.success) return fail("That log does not look right.");
    // …authorize, mutate…
    revalidateShow(showId);
    return ok({ logId });
  });
}
```

**The Zod failure is converted to a flat human string, never `parsed.error`** — validation
detail is not leaked. (The one exception is the admin ad form, which *does* surface the first
issue message, because it is a form an admin is filling in.)

### 17.4 The client convention

No `useActionState`, no thrown-error boundaries for action failures. Twenty-plus call sites
share one shape:

```tsx
const [error, setError]        = React.useState<string | null>(null);
const [pending, startTransition] = React.useTransition();

startTransition(async () => {
  const result = await someAction(input);
  if (!result.ok) { setError(result.error); return; }   // roll back optimistic state here
  router.refresh();
});
```

rendered through a shared `<FormError message={error} />`.

> "a failure renders inline next to the control that caused it rather than replacing the page
> with an error boundary."

**Optimistic-with-rollback plus `router.refresh()` on success**, rather than `useOptimistic`
or client cache mutation, because everything derived from a write — aggregates, histograms,
progress counters, badges — **is server-rendered**, so the honest reconciliation is to
re-render the server tree. Each site says so, and `onLike` deliberately **omits** the refresh
because nothing else on the page depends on it.

### 17.5 Cache revalidation discipline

`revalidatePath("/show/[slug]", "layout")` uses the **route pattern with a type argument**,
not an interpolated concrete path — *"Show pages are keyed by slug, which we do not have
here, so revalidate the segment tree rather than one path."*

Two observations worth carrying:

- **A vestigial call ships.** `revalidatePath("/show/${showId}")` matches no rendered route
  (real URLs are `/show/<slug>-<id>`). Harmless but dead. Similarly `revalidatePath("/@[username]",
  "layout")` in `toggleFollow` matches nothing, since the `@` is part of the segment *value*.
- **Every social write calls `revalidatePath("/")`**, which busts the whole home page cache
  on any like, comment or follow anywhere on the platform. On a busy instance that makes the
  home page effectively uncached — which it already is (`export const revalidate = 0`).

> **Porting note (§17).** **This entire section copies verbatim.** The only edit is the
> `VERIFICATION_EXEMPT` label list, which must be rewritten for the renamed actions while
> preserving the default-deny property. Note the label is a free-text string with **no
> compile-time link to the function name** — a typo silently means "not exempt", which is the
> safe direction but presents as a mysterious "confirm your email" on an action that should
> be reachable.

---

## 18. Infrastructure: build, test, CI, seed, smoke

### 18.1 Every npm script

| Script | Command | Notes |
| --- | --- | --- |
| `dev` | `next dev` | |
| `build` | `tsx scripts/migrate-deploy.ts && next build` | **migrations first**; `&&` aborts the build on failure |
| `start` | `next start` | |
| `lint` | `eslint` | bare — **no `--max-warnings 0`, so warnings do not fail CI** |
| `typecheck` | `tsc --noEmit` | |
| `test` | `vitest run` | |
| `db:generate` | `drizzle-kit generate` | schema diff → new SQL file |
| `db:push` | `drizzle-kit push` | TCP only; **cannot target PGlite** |
| `db:migrate` | `drizzle-kit migrate` | apply `./drizzle` to `DATABASE_URL` |
| `db:studio` | `drizzle-kit studio` | |
| `db:deploy` | `tsx scripts/migrate-deploy.ts` | standalone |
| `db:local` | `tsx --env-file=.env.local --conditions=react-server scripts/db-local.ts` | apply `./drizzle` to PGlite |
| `db:reset` | `node -e "…rmSync('./.pglite'…)"` | **hardcodes the path — ignores `PGLITE_DATA_DIR`** |
| `seed` / `smoke` / `security:probe` / `admin:grant` | same `tsx --env-file --conditions=react-server` prefix | |
| `security:audit` | `npm audit --omit=dev --audit-level=high` | |
| `icons` | `node scripts/build-icons.mjs` | |

**Two flags matter on the operational scripts.** `--env-file=.env.local` loads the real env
without dotenv in the script. **`--conditions=react-server` is what makes the `server-only`
package resolve to its no-op export instead of throwing**, so a plain Node script can import
the query layer — the CLI equivalent of `resolve.conditions` in the Vitest config.

### 18.2 Migrations: four runners, one folder

`./drizzle` is the single source of truth for **both** drivers.

- **Generation** — `drizzle-kit generate` against `lib/db/schema.ts`, `strict: true`.
- **Local** — `scripts/db-local.ts` **refuses to run when `DATABASE_URL` is set**
  (`exit 1`), opens PGlite directly, runs `drizzle-orm/pglite/migrator`, then **prints the
  resulting `information_schema` table list** so the operator sees the schema actually
  landed rather than trusting a success message. It exists because *"`drizzle-kit push` talks
  to a Postgres server over TCP, which PGlite is not."*
- **Production, automatic** — `scripts/migrate-deploy.ts` runs inside `npm run build`:

  > "the alternative is a manual step somebody has to remember between merging a schema
  > change and the deploy that queries it — and the failure mode of forgetting is every
  > signed-in page returning 500 against a table that does not exist yet."

  A failure exits 1 and fails the build on purpose: *"A deploy whose schema did not land is
  worse than no deploy."* Safe to run every deploy because drizzle records what it applied.
  **It silently skips when `DATABASE_URL` is unset** — intentional (local `next build` must
  not need a server) but it removes the one place that would have caught a misconfigured
  deploy.
- **Tests** — each DB-backed suite creates a throwaway PGlite store in a temp dir and runs
  the same migrator.

### 18.3 How the tests run without a database

**Two kinds of test.** Four suites (`ratings`, `mappers`, `slug`, `bounds`) import only pure
modules and touch nothing. Six suites (`security`, `guest`, `ads`, `cinema`,
`password-reset`, `taste`) each create **their own throwaway Postgres**:

```ts
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cliffhanger-sec-"));
  process.env.PGLITE_DATA_DIR = dataDir;
  delete process.env.DATABASE_URL;                       // ← non-negotiable, see below
  const { PGlite }  = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const schema      = await import("@/lib/db/schema");
  const client = new PGlite(dataDir);
  await migrate(drizzle(client, { schema }), { migrationsFolder: "./drizzle" });
  await client.close();
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));
```

**Every import is dynamic** because *"the connection is chosen at import time from the
environment, so this must be set before anything pulls in the database module."* A top-level
`import { db }` in these files binds the wrong database.

**Related trap:** Vitest loads `.env.local` into `process.env`. If a developer has
`DATABASE_URL` there, `npm test` would point at **real Postgres** were it not for the
explicit `delete`. **Never remove that line.**

**Three aliases make server-only code importable:**

| Alias | Target | Why |
| --- | --- | --- |
| `server-only` | `tests/stubs/server-only.ts` (`export {}`) | *"That guard is exactly right in the app and unhelpful in a Node test runner, where importing the query and security layers directly is the point."* |
| `next/cache` | `tests/stubs/next-cache.ts` (three no-ops with matching signatures) | *"Outside a Next request that module cannot resolve, which would stop the security tests from importing an action at all."* |
| `next/server` | **the real module** | *"Auth.js imports `next/server` internally… Pointed at the real module rather than a stub, so the authorization path under test is the genuine one."* |

**The session seam.** `tests/security.test.ts` mocks **exactly one module** — `@/lib/auth`'s
`auth()` — driven by a `signInAs(user | null)` helper, with `beforeEach(() => signInAs(null))`
*"so a test that needs a session has to say so."* **Everything below that seam is genuine**,
including the database-resolved admin role: *"the authorization checks are the ones that
ship."*

**What tests cannot do:** *"Server Actions themselves need a request context and cannot be
invoked here — the HTTP-level attacks live in `scripts/security-probe.ts`."*

**Vitest config, every setting with its reason:** `environment: "node"` (nothing renders);
`testTimeout: 60_000` / `hookTimeout: 120_000` (*"The security suite drives a real database
and bcrypt"*); **`fileParallelism: false`** —

> "PGlite is a WebAssembly Postgres and reserves a sizeable heap; parallel workers each
> starting one exhausted memory on a modest machine and surfaced as 'Array buffer allocation
> failed' during migration, **which reads like a database bug rather than a resource
> limit.**"

— and `resolve.conditions: ["react-server", "node", "import"]`.

**One test-authoring lesson worth stealing:** the window-reset test ages the row with
`UPDATE rate_limits SET window_start = now() - make_interval(secs => 600)` rather than
sleeping, because *"an earlier version relied on the clock advancing between two statements
and passed locally while failing on a faster machine where both statements saw the same
`now()`."*

### 18.4 CI — three parallel jobs, read-only, no secrets

`permissions: contents: read` at the top level and no repository secrets anywhere, **which
is what makes it safe to run on pull requests from forks.** `concurrency` cancels the
previous run on the same ref.

1. **`verify`** — checkout, Node 24 with npm cache, `npm ci --ignore-scripts`, then
   **`npm rebuild esbuild`** (*"esbuild ships a platform binary via a postinstall step, which
   `--ignore-scripts` skips. Vitest needs it, so allow just that one."*), then `typecheck`,
   `lint`, `test`, and `build` **with two placeholder env vars**:

   > "Placeholder values only. The build never contacts TMDB or Postgres — every route is
   > server-rendered on demand — but `env.ts` fails loudly on a missing variable rather than
   > falling back to something insecure."

   No `DATABASE_URL`, so the migrate step inside `build` no-ops.

2. **`dependencies`** — `npm audit --omit=dev --audit-level=high` (**blocking**) plus a full
   audit that can never fail. *"Runtime dependencies are what ship."*

3. **`secrets`** — gitleaks with `fetch-depth: 0`: *"Full history, so a credential committed
   and later removed is still caught — deleting a secret from HEAD does not unpublish it."*

**Not in CI:** `smoke` (needs seeded data), `security:probe` (needs a running server),
`seed`, `icons` (needs sharp's native binary). No coverage run, no coverage threshold, no
deploy step (Vercel's Git integration handles that).

### 18.5 Environment strategy

`lib/env.ts` is 51 lines: one private `required(name)` helper that **rejects the empty string
as well as undefined** (which matters because `.env.example` ships blanks), and an object of
**getters**.

> Getters so nothing is evaluated at import (which would break `next build`); **throwing** so
> a missing value cannot silently degrade; and a message that names both the local and the
> hosted fix.

| Variable | Required? | Notes |
| --- | --- | --- |
| `DATABASE_URL` | optional | **Unset = PGlite.** Read directly by `lib/db/index.ts`, not through `env` |
| `TMDB_READ_TOKEN` | **required** | throws on first access |
| `AUTH_SECRET` | **required** by Auth.js | `env.authSecret` exists but **has zero callers** — Auth.js reads it itself |
| `WATCH_REGION` | default `"US"` | |
| `REQUIRE_EMAIL_VERIFICATION` | default off | strict `=== "true"`, so `"1"`/`"yes"` read as false |
| `RESEND_API_KEY` / `EMAIL_FROM` | optional | absent ⇒ links go to the server log |
| `NEXT_PUBLIC_SITE_URL` | optional | falls back to `AUTH_URL`, then Vercel vars, then localhost |
| `NEXT_PUBLIC_TMDB_IMAGE_BASE` | default the public host | a plain `const`, not a getter, because `NEXT_PUBLIC_*` is inlined at build |
| `PGLITE_DATA_DIR` | default `./.pglite` | read directly, not through `env` |

**Two honest gaps.** Three `env` members (`databaseUrl`, `authSecret`, `isProduction`) have
**zero call sites**. And the doctrine is only ~60% observed: `RESEND_API_KEY`, `EMAIL_FROM`,
`NEXT_PUBLIC_SITE_URL`, `AUTH_URL`, the Vercel vars and `PGLITE_DATA_DIR` all read
`process.env` directly. **There is no startup validation pass** — a missing token surfaces on
the first request that needs it.

### 18.6 The seed

> "Seeds a demo community so a fresh deployment is not an empty room. **Idempotent**:
> members are keyed by email, logs by (member, target). Running it twice changes nothing. It
> pulls real show data **through the normal ingest path**, so it needs `TMDB_READ_TOKEN` and
> `DATABASE_URL`."

Three members with written personalities (*"Prestige drama apologist. Will defend a slow
first season."*), twelve shows *"worth having ratings on: a mix of eras, networks, and
shapes"*, and — importantly — **deliberate overlaps** so aggregates have more than one vote.

Six steps: mirror the shows through `ensureShow`; upsert members (**stamped
`emailVerifiedAt: new Date()`** — *"Demo accounts arrive confirmed. Posting requires a
verified address, and these addresses do not exist to receive a link"*); log watches; pin the
first four plans as favourites; build two curated lists (one ranked, one not); and wire a
**complete follow graph** so the following feed is never empty.

**Watch dates walk backwards from today** via a module-level cursor, *"so the diary and year
charts have shape."*

**Episode ratings get deterministic ±1 jitter:**

```ts
drift = ((episode.episodeNumber * 7 + seasonNumber * 3) % 3) - 1;   // exactly {-1, 0, +1}
rating = Math.min(10, Math.max(1, base + drift));
```

*"so the heatmap has texture rather than one flat colour."* **Deterministic, not random** —
re-seeding produces identical texture, so screenshots are stable.

**Idempotency uses five different keys** — members by email, show-logs by
`(userId, showId, 'show', seasonNumber IS NULL)`, episode-logs by the full tuple, favourites
by `onConflictDoUpdate` on `(userId, position)`, lists by `lower(title)`, items and follows by
`onConflictDoNothing`. **Break any one and a second run duplicates data.**

*(Note one dead field: the seed plans carry `tags` and `logTags` is imported, but the insert
never writes them.)*

### 18.7 The smoke test

> "Most aggregates are raw SQL run through `db.execute`, whose result shape must be identical
> on both drivers. **If it ever differs, every one of those reads would silently return empty
> and the interface would look merely quiet rather than broken** — so this asserts real rows
> come back rather than printing them."

**This is the single highest-value script in the repo for a dual-driver architecture.**
Twenty-two checks covering profile stats, rating stats, **that the histogram bucket counts
sum to the rating count** (a cross-check that bucketing loses nobody), episode and season
aggregates, viewer state, in-progress, watched shows, genre breakdown, logged years, **that
`review.monthly.length === 12`**, platform comparison, diary, both feeds, reviews, most-rated,
local ILIKE search, top four, public lists, list options, and active members.

It bails immediately with *"Seed data missing: run `npm run seed` first."* and hard-depends
on seeded literals (`reelrunner`, show `1396`, the substring `"sopran"`).

### 18.8 Agent doctrine files

`AGENTS.md` carries an auto-generated block, regenerated by `next dev` on every run, warning
that this Next.js version differs from training data and instructing agents to read
`node_modules/next/dist/docs/` first. **Deleting it from a diff just recreates an uncommitted
change; commit it with your work.** `CLAUDE.md` is one line: `@AGENTS.md`.

A response-style rule is duplicated into `.github/copilot-instructions.md`, `.clinerules/`,
`.cursor/rules/`, `.opencode/` and `.windsurf/rules/`, and **explicitly exempts code,
commits and PRs** — a pattern worth copying if you use multiple agent tools.

> **Porting note (§18).** All of it is domain-free. Copy the two-driver switch, the
> build-time migration step, the four-runner/one-folder migration story, the test bootstrap
> recipe with its three aliases and single mocked seam, the CI job split, the getter-based
> env accessor, the deterministic seed with its five idempotency keys, and — especially —
> **the smoke script**, which is what proves a dual-driver architecture is actually dual.
>
> Swap `TMDB_READ_TOKEN` for `SPOTIFY_CLIENT_ID` + `SPOTIFY_CLIENT_SECRET` (or
> `MUSICBRAINZ_USER_AGENT`, which is required but not secret), `WATCH_REGION` for `MARKET`,
> and the image base. Fix the two known gaps while you are there: give `db:reset` the
> `PGLITE_DATA_DIR` it ignores, and add a startup validation pass so a missing variable fails
> at boot rather than on the first request.

---

## 19. Invariants — do not break these

Every entry below was a real defect, is guarded by a test or a comment, or both. This is the
list to paste into a rebuild's review checklist.

**Data integrity**

- **I-1. A write must only touch the columns it was given.** `undefined` means leave alone;
  an explicit `null` clears. A full-row replace made a rating click erase the member's review,
  diary date, flags and tags (SEC-01). The paired half: **any control that saves must be
  primed from the real row, never from blanks.**
- **I-2. Specials are season 0 and are excluded from `episode_count`.** Every progress and
  completion query must filter `season_number > 0`, or nine specials mark an unfinished show
  finished. The comment is copy-pasted into all three CTEs *precisely because it is easy to
  omit in a fourth.*
- **I-3. `notFound()` must be reached before anything streams.** A `notFound()` raised after
  the shell has flushed is sent as a **200**. Adding a route-level `loading.tsx` to a content
  route turns every 404 into a 200 with not-found UI.
- **I-4. Postgres accepts `infinity` as a `date`.** One stored `infinity` made
  `EXTRACT(YEAR ...)` throw on a member's public pages **for every visitor, permanently, with
  no way to undo it from the interface.** Validate with the four-layer `calendarDate`, and
  keep the defensive `BETWEEN '1900-01-01' AND '2200-01-01'` on the read side too.
- **I-5. Bound every id.** An id above int4 range raises "value out of range for type
  integer" — a **500 where a 404 belongs.** Reject by digit length *before* `Number()`.
  Parsers return null (so the caller can 404); only page numbers clamp.
- **I-6. Route all search text through `escapeLike`.** A raw `%` matched everything;
  `/search?q=%` returned the whole catalogue and every member.
- **I-7. Dedupe a bulk upsert by primary key in JS first.** Postgres refuses an
  `ON CONFLICT DO UPDATE` that touches one row twice and **fails the whole statement**, which
  here manifested as a silent no-op inside a try/catch.
- **I-8. Normalise before measuring.** `İ` lowercases to two code units, so a 17-character
  tag overflowed `varchar(32)` at insert.
- **I-9. Drizzle returns `date` columns as JS strings and `timestamptz` as `Date`s.** Mixing
  them silently produces `"Invalid Date"` or a string comparison that happens to work.

**Aggregation correctness**

- **I-10. Every community aggregate needs `DISTINCT ON (user_id …)`.** A plain `AVG` counts a
  member once per rewatch. Six queries carry the pattern independently; nothing centralises it.
- **I-11. Keep the `(rating IS NOT NULL) DESC` tiebreak.** Without it, a bare watch mark added
  after a rating silently withdraws that member's vote from the average.
- **I-12. Every public aggregate needs `u.is_guest = false`.** There is no database-level
  guard. Forgetting it on a new aggregate is a silent correctness bug that only one test
  would catch.
- **I-13. Parenthesise an OR inside an AND.** Drizzle emits unparenthesised SQL and AND binds
  tighter, so `is_guest = false AND username ILIKE x OR display_name ILIKE y` made every guest
  findable by the display name "Guest User". **Shipped; caught by a test, not by reading.**
- **I-14. A list's count query and its list query must be edited together**, or the heading
  desynchronises from the body.

**Authorization**

- **I-15. Duplicate the privacy check in `generateMetadata` and the page body.** The body
  404'd while every private list's `<title>` still rendered (SEC-02). **Any new entry point
  into a route needs the same check.**
- **I-16. Existence is not visibility.** One shared `assertVisibleTarget` for every write into
  a container (SEC-03).
- **I-17. Re-read the account row on every mutation.** Stateless JWTs keep asserting an
  identity after the row is gone (SEC-11).
- **I-18. Read `role`, `plan` and `is_guest` from the database, never from the token.** The
  token copy is presentation only.
- **I-19. Verify the target exists in the mirror before writing a log against it**, or a
  crafted call publishes a review of "S42E999" that renders on the show page, links to a 404,
  and inflates public totals.
- **I-20. Privileged queries self-gate.** *"making the query refuse is the difference between
  one mistake and a breach."*
- **I-21. A 404, not a 403, for admin routes.** *"A 403 confirms the route exists."*
- **I-22. Keep the structural no-escalation test.** It is what keeps "no member-facing write
  path to `role` or `plan`" true over time.

**Authentication**

- **I-23. Always run one bcrypt compare, against a real dummy hash when the account does not
  exist** (SEC-09).
- **I-24. Bound passwords in BYTES, not characters** (SEC-16).
- **I-25. One password schema shared by sign-up, sign-in and the provider.** Two copies
  created accounts that could not be signed into (SEC-04).
- **I-26. Declare case-insensitive uniqueness in the schema**, not in a read-then-write
  (SEC-13).
- **I-27. Store only the hash of a link token; return one identical failure reason for every
  refusal; retire outstanding tokens in the same transaction that issues or redeems one.**
- **I-28. Redeem verification on a button press, never on page load** — scanners follow links.

**Concurrency**

- **I-29. Count-then-insert against a quota must be one transaction.** Two tabs at nine each
  read nine and leave the member holding eleven.
- **I-30. Put the state predicate inside the UPDATE**, not in a SELECT before it, so two
  concurrent claims cannot both believe they won.
- **I-31. A multi-table merge is one transaction.** *"a half-merged guest would leave logs
  stranded under a row nobody can sign into, which is indistinguishable from losing them."*
- **I-32. The log write and its tag replacement are one transaction.** A rejected tag left the
  log edited and every tag deleted while the member was told the save had failed.

**Operational**

- **I-33. The rate limiter fails open, and that is deliberate** — but it means the limiter is
  no defence against an attacker who can also degrade the database.
- **I-34. `x-forwarded-for` is only trustworthy behind a proxy that overwrites it.** Off
  Vercel, every per-IP budget is bypassable with one header.
- **I-35. Log only whitelisted error fields.** Driver errors carry the SQL and its bound
  parameters.
- **I-36. Every table a guest can write must appear explicitly in the merge transaction**, or
  be deliberately listed as discarded. `absolute_cinema` is not, and is silently
  cascade-deleted.
- **I-37. The database instance is memoised at first property read.** Set env before any
  import.
- **I-38. PGlite allows one writer.** Stop the dev server before local DB scripts; disable
  file parallelism in tests.

---

## 20. Replication playbook: TV → music albums

### 20.1 The five decisions to make before writing any code

**1. How many tiers, and which are loggable?**
TV is cleanly three (series / season / episode) and all three are rateable. Music offers
artist / album / track, but MusicBrainz really has four (artist / release-group / release /
recording). **Collapse release-group and release**, and then decide whether *artist* is
loggable at all. Rating a whole artist is closer to a favourite than to a review. A
defensible answer: **two loggable tiers (album, track) with artist as a routed but
non-loggable container** — which simplifies `targetTypeOf`, the log columns and the dual
rating, at the cost of losing artist-level reviews.

**2. Integer surrogate keys, or external string ids?**
Recommended: **keep a local `serial` PK with the external id as a unique secondary column.**
It preserves the bounded-int URL parsing the audit added, keeps every FK an `integer`, and
localises the provider coupling to one column per table. The alternative — text/UUID PKs
throughout — touches nine FK columns, the slug parser and every bounds check, and does **not**
eliminate the 500-instead-of-404 class (a malformed UUID raises `invalid input syntax for
type uuid`).

**3. What is the "shape" visualisation?**
This is the product's thesis and its most valuable idea. **A per-album track strip is weak** —
one row of 10–14 cells. **A per-artist discography grid is strong** — one row per album, one
cell per track, drawing a career arc. Build (b) on the artist page and keep (a) as a compact
strip on the album page.

**4. Where does the crowd baseline come from — and is it a rating at all?**
Neither obvious provider gives you `(score, votes)`. Your options, and the honest labelling
each demands, are in the §5 and §7 porting notes. **If you cannot get a real rating with a
count, drop the baseline column rather than dressing popularity up as one.** The `label`
override prop exists precisely for this kind of honesty.

**5. Is there a neighbour graph?**
The +0.3 to +1.0 neighbour term is the largest in the model and the reason ranking works at
all. **Confirm your source before designing around it** — Spotify deprecated the obvious ones
in 2024. Without any neighbour graph, expect the measured collapse to crowd-score order.

**One more, cheap but easy to get wrong: decide guest mode before shipping anything that
touches email.**

### 20.2 The three-bucket inventory

**Copy verbatim (roughly 60% of the codebase).**

`lib/db/index.ts` · the migration runners · `lib/security/rate-limit.ts` and all thirteen
budget shapes · `lib/security/tokens.ts` · `passwordSchema` / `signInSchema` / `signUpSchema`
/ `usernameSchema` / `tagList` / `reviewBody` · `lib/auth/index.ts` (both providers, the
dummy hash, the callbacks) · `lib/auth/session.ts` · `lib/auth/guest.ts` · `lib/auth/claim.ts`
· `lib/auth/password-reset.ts` · `lib/auth/admin.ts` · `app/actions/result.ts` (`guard`,
`ActionResult`, `safeErrorDetail`, `VERIFICATION_EXEMPT`) · `app/actions/verification.ts` ·
`app/actions/password.ts` · `app/actions/profile.ts` · `lib/email/index.ts` · `proxy.ts`
(minus one host) · `lib/like.ts` · `lib/utils.ts` · `slugify` and the bounded parsers ·
`lib/view.ts` · the whole `users`/`follows`/`likes`/`comments`/`log_tags`/tokens/`rate_limits`
schema · `lib/ratings.ts` and `lib/ratings/dual.ts` (the maths) · every `components/ui/*`
primitive · the design tokens · the avatar algorithm · the whole admin subsystem · the ad
planner and serving machinery · the CI workflow · the Vitest config and test bootstrap · the
smoke-test *approach*.

**Adapt (rename, retune, re-shape).**

The content-mirror tables · `logs`' target columns · `list_items` (must become polymorphic) ·
the ingest TTLs · the provider endpoint map · the recommender's era/runtime/coverage/shrinkage
constants and its network axis · `GUEST_NUDGE_AFTER` · `RUN_THRESHOLD` · `MIN_RATED_SHOWS` ·
`RESERVED_USERNAMES` · the `calendarDate` floor · `SEASON_MAX`/`EPISODE_MAX` · the seed's
catalogue and personalities · the probe's URLs · the ad credit block · all UI copy.

**Redesign from scratch.**

The heatmap's axes (§20.1 decision 3) · the crowd-baseline source and its honest label
(decision 4) · the neighbour graph (decision 5) · the hero treatment (no backdrop image
exists) · the 1:1 poster geometry and everything downstream of it · the "progress" pillar
itself.

### 20.3 The pillars need re-justifying

This is the part a mechanical port would miss. Cliffhanger's two pillars do not both survive:

- **"Progress" barely applies to music.** Nobody is "partway through" an album the way they
  are partway through a series. **Replace it with REPLAY** — how many times, and when — which
  the `is_rewatch` column already models as `is_replay`, and which is a *stronger* signal in
  music than in TV. Or with **discography completion** at the artist level.
- **"Shape" survives and arguably gets stronger.** It exists twice: track-order quality curve
  within an album, and career arc across a discography. The second has no TV equivalent as
  clean.
- **A third pillar is available to music and not to TV: the artist as a repeated author.** A
  show is not made repeatedly by one named person the way an artist makes albums. That makes
  *artist affinity* a legitimate second attribute axis in the recommender — potentially
  stronger than the label/network analogue.

### 20.4 Suggested build order

Each phase ends somewhere shippable.

| Phase | Deliverable | Notes |
| --- | --- | --- |
| **0** | Decisions §20.1 written down | Especially the tier count and the id strategy |
| **1** | Schema + migration 0000 + the dual-driver switch + `db:local` + a smoke script that asserts nothing yet | Get `DATABASE_URL`-or-PGlite working before anything else |
| **2** | Provider client, typed endpoints, **pure mappers with fixture tests**, cache-through ingest, slugs | The mappers are where the provider's awkward cases live. Write the fixture tests here, not later |
| **3** | Rating maths + histogram + brackets + the star input, all unit tested | Pure, fast, and everything downstream depends on the scale being settled |
| **4** | Auth, sessions, the `guard()` wrapper, the shared Zod library, the rate limiter, `proxy.ts` | **Do this before feature work**, not after — the audit's root causes were mostly "the rule expressed twice" |
| **5** | `logs` + `saveLog` with patch semantics + the log dialog + the content pages | The core loop |
| **6** | `DISTINCT ON` aggregates + the consensus card + the shape visualisation | The thesis feature |
| **7** | Guest mode, both conversion paths, onboarding | **Before** email verification |
| **8** | Email verification + password reset | |
| **9** | Social: follows, feed, reviews, likes, comments, directory | |
| **10** | Lists, collections, profile stats, year in review | |
| **11** | The recommender — with the evaluation harness built *first* | See §20.5 |
| **12** | Admin, then house ads | Ads depend on the taste profile |
| **13** | Seed, full smoke, the dynamic probe, an adversarial audit pass | |

### 20.5 If you build a recommender, copy the method not the numbers

The single most transferable thing in this codebase is **how the weights were derived**:

1. **Build a fixture population of adversarial personas first** — here, ten accounts under a
   dedicated email domain: a purist, a single-genre viewer, a comfort-watcher, a contrarian, a
   flat rater, a specialist, and one who rates only at the leaf level.
2. **Build an offline harness that prints the actual output** for every persona — top N,
   predicted score, confidence, first reason — **plus one global diversity metric**
   ("distinct titles across N slots"). That metric is what caught the retrieval problem that
   no amount of ranking work would have fixed.
3. **Have critics judge the real output, then have skeptics attack both the findings and the
   proposed fixes.** The second round here proved the first round's fix had made the worst
   recommendation *worse*.
4. **Write property tests, not snapshots**: *"A recommender is the easiest kind of code to
   ship broken: it always returns a plausible-looking number, and nothing crashes when that
   number is nonsense."* Every test asserts a bound, a direction, or a monotonic relationship,
   and several test names quote the exact production defect they lock out.
5. **Prefer withholding to fabricating**, and give each withholding reason its own copy.
6. **Never invent a reason.** Emit a reason string only inside the branch that actually moved
   the score, each with its own threshold, *"so the interface never explains an adjustment too
   small to have changed a rank."*
7. **Know your ceiling and write it down.** Two commit messages state plainly that coarse
   genre buckets cannot separate the shows that matter and that no further reweighting fixes
   it. That saves the next person a week.

### 20.6 Ten things to fix while porting, rather than faithfully reproducing

The shipped code has known defects. A rebuild should not inherit them.

1. **The episode detail page mounts the log dialog with no `initial` prop**, reopening the
   SEC-01 data-loss shape on one route.
2. **Nothing renders a comment thread on a log**, so every review card's comment count is
   always 0. Either wire it or remove the affordance.
3. **The members directory runs 24 heavy aggregate queries** to display two numbers per card.
4. **The profile runs `getProfileStats` twice** per view (layout + page), because
   `db.execute` is not React-cached.
5. **`markShowWatched` re-enters `guard()` per season**, burning N+1 rate-limit tokens and
   silently discarding mid-loop failures.
6. **The sign-in rate limits live in the Server Action, not in `authorize`** — so a direct
   POST to `/api/auth/callback/credentials` reaches bcrypt with **no budget consumed**. The
   guest provider does not have this gap because its limit is inside `createGuest`.
7. **`/login?next=…` is a dead parameter** — nothing reads it, and the verify redirect drops
   the `?token=` on the way.
8. **`reorderList`, `updateList` and `clearFavorite` have no callers** and no UI.
9. **The watchlist has no privacy flag**, so `/@anyone/watchlist` is fully public.
10. **Nothing prunes** `rate_limits`, orphaned likes and comments, or abandoned guest rows.
    Add the cron the original never did.

Plus three "wrong but harmless" ones worth not copying: the dead
`revalidatePath("/show/${id}")`, the year page showing the raw 1–10 scale where everything
else shows stars, and `dislikedGenres` displaying the three *least* disliked genres because
it slices a lean-descending array.

### 20.7 A generic checklist for any other vertical

Books, films, board games, podcasts, restaurants — the method is the same. Ask:

1. **Is the domain object a tree or a leaf?** If it is a leaf (a film, a board game), you do
   not need this architecture — you need Letterboxd. **The polymorphic log table only earns
   its complexity when there are ≥2 rateable tiers.**
2. **What is the middle tier, and is it an ordinal?** If yes (seasons, book volumes, podcast
   seasons) the TV shape ports directly. If no (albums, article collections) the middle tier
   needs an id and everything typed `integer` changes.
3. **Does "progress" exist?** Series, book series and podcasts yes; albums and films no. If
   not, find the replacement pillar (replay, collection completeness, re-read).
4. **Does the catalogue have a "shape"?** A quality curve across ordered parts is what makes
   the heatmap worth building. If the parts are unordered, the grid is just a colour list.
5. **Does your provider give a `(score, count)` pair?** If not, either source one, build one
   from your own members, or drop the baseline. **Do not relabel popularity as quality.**
6. **Does your provider give a similarity graph?** If not, a content-based recommender will
   collapse to provider-score order within any tag pool.
7. **What is the asset aspect ratio, and is there a wide "backdrop"?** 2:3 + backdrop (film,
   TV), 1:1 + none (music), 2:3 + none (books) each need different hero and grid geometry.
8. **What is the natural "specials" exclusion?** Every catalogue has non-canonical items that
   corrupt completion maths: TV specials, deluxe bonus tracks, novellas, bonus episodes.
   **Decide the filter explicitly and copy-paste the comment next to every query that needs
   it.**

---

## Appendix A — Complete route table

Every route is App Router. **None declares `generateStaticParams`; there are zero statically
generated pages.** Only `/` sets a segment config (`export const revalidate = 0`); everything
else becomes dynamic implicitly by calling `currentUser()` or awaiting `params`/`searchParams`.

| Route | Params | Auth | Notes |
| --- | --- | --- | --- |
| `/` | — | mixed | `revalidate = 0`. Signed out: hero + trending/popular/top-rated rails + genre rails + recent reviews. Signed in: stat tiles, continue-watching, following feed (falling back to global), taste rails in Suspense |
| `/search` | `?q` | public | Empty `q` renders a landing box. Consumes `searchByIp`; over the limit, renders from the local mirror only. Merges local + remote via `uniqueCards`, capped at 36 |
| `/shows` | `?genre &network &decade &sort &page` | public | `page` clamped to `maxWindowPage(24)` = 416; `decade` bounded 1900–2200; `sort` whitelisted |
| `/show/[slug]` | `slug = <name>-<id>` | public | `notFound()` if the slug parse or `ensureShow` fails. Episode sections stream in a Suspense boundary |
| `/show/[slug]/reviews` | `?sort=popular\|recent &page` | public | `PAGE_SIZE = 20`, `scope: "any"` rollup |
| `/show/[slug]/season/[season]` | season bounded 0–10,000 | public | 0 = Specials. Calls `ensureSeasonEpisodes` before the lookup |
| `/show/[slug]/season/[season]/episode/[episode]` | episode bounded 0–100,000 | public | |
| `/list/[slug]` | `<slug>-<id>`; a bare id also works | public | **Private-list 404 duplicated in `generateMetadata` and the body.** The only route rendering a comment thread |
| `/lists` | `?sort=popular\|recent` | public | 36 cards, owner shown |
| `/members` | — | public | Top 24 by log count; the app's one N+1 |
| `/spotlight` | — | public | Indie ads; deliberately indexable, footer-linked only |
| `/start` | — | **none — see note** | Onboarding grid of 24. **No auth guard**: a signed-out visitor can load it and every star click fails |
| `/@[username]` | `@name`, 3–24 chars | public | Ten queries in one `Promise.all` |
| `/@[username]/diary` | `?year &page` | public | `PAGE_SIZE = 50`; the only place a log delete control exists |
| `/@[username]/shows` | `?sort=recent\|rating\|name` | public | limit 180 |
| `/@[username]/watchlist` | — | public | **No privacy flag** |
| `/@[username]/lists` | — | public | `isSelf` is the entire privacy switch |
| `/@[username]/network` | `?tab=following` | public | Not a profile tab — reached from the follower counters |
| `/@[username]/year/[year]` | year bounded **1950**–2200 | public | Note the floor differs from the diary's 1900 |
| `/for-you` | — | **redirect** `/login` | |
| `/settings` | — | **redirect** `/login` | Also redirects if the row is gone |
| `/verify` | `?token` | **redirect** `/login?next=/verify` | `noindex`, `no-referrer`. Confirmation is a button press |
| `/login` | — | redirects **non-guest** members | Guests must reach it to merge |
| `/signup` | — | redirects **non-guest** members | |
| `/forgot` | — | public | `noindex`. A sync component |
| `/reset` | `?token` | public by design | `noindex`, `no-referrer` |
| `/admin` | `?q &page` | **404** for non-admins | `PAGE_SIZE = 25`. `noindex`, `no-referrer` |
| `/admin/ads` | — | **404** for non-admins | |
| `POST /api/ads/impression` | JSON body | none | Same-origin check → 403; `adEventByIp` → 429; bad JSON or id → 400 |
| `GET /api/ads/[id]/click` | path id | none | 400 on a bad id; **redirects even when throttled**; missing/paused → 302 `/` |
| `/api/auth/[...nextauth]` | — | — | `export const { GET, POST } = handlers` |

Special files: `app/error.tsx` (client boundary), `app/not-found.tsx`, `app/layout.tsx`,
`app/[username]/layout.tsx`, `app/icon.svg` + `app/apple-icon.png` + `app/favicon.ico`.

---

## Appendix B — Every tunable constant

| Constant | Value | Where | Why that number |
| --- | --- | --- | --- |
| `MIN_RATING` / `MAX_RATING` | 1 / 10 | `lib/ratings.ts` | integers so bucketing never touches floats |
| `LOW_CONFIDENCE_THRESHOLD` | 5 | `lib/ratings.ts` | below this, lead with the provider baseline |
| Rating bracket minima | 0 / 4 / 5.5 / 6.5 / 7.5 / 8.5 / 9.25 | `lib/ratings.ts` | copied from seriesgraph for recognisability |
| `RUNNING_TTL` / `FINISHED_TTL` | 1 day / 7 days | `lib/ingest/shows.ts` | a running show gains episodes weekly |
| `CACHE_SECONDS` | 12h / 12h / 3h / 10m / 7d | `lib/tmdb/client.ts` | "content changes slowly; discovery rails change daily" |
| `TMDB_PAGE_SIZE` | 20 | `lib/tmdb/index.ts` | fixed upstream |
| `GRID_PAGE_SIZE` | 24 | `components/show/poster-grid.tsx` | divisible by 3, 4 and 6 |
| upstream page ceiling | 500 | `lib/tmdb/index.ts` | fixed upstream → `maxWindowPage(24) = 416` |
| discover vote floor | 200 (rating sorts) / 300 (genre seed) / 150 (pair, network, notability) / 2000 (onboarding) | `lib/tmdb/index.ts`, `lib/taste/recommend.ts`, `app/start/page.tsx` | "without a vote floor, rating sorts surface shows with three votes" |
| `slugify` cap | 80 chars | `lib/slug.ts` | |
| `MAX_DB_INT` | 2,147,483,647 | `lib/slug.ts`, `lib/security/schemas.ts` | **declared twice** |
| `SEASON_MAX` / `EPISODE_MAX` | 10,000 / 100,000 | `lib/security/schemas.ts` | |
| `calendarDate` range | 1930-01-01 … today UTC | `lib/security/schemas.ts` | "That is before television." |
| `reviewBody` max | 20,000 | `lib/security/schemas.ts` | |
| tag limits | 12 tags × 32 chars | `lib/security/schemas.ts` | |
| comment max | 2,000 | `app/actions/social.ts` | mirrored in **three** places |
| `PASSWORD_MAX_BYTES` | 72 | `lib/security/schemas.ts` | bcrypt truncation point |
| bcrypt cost | 12 | everywhere, incl. the dummy and guest hashes | |
| session `maxAge` / `updateAge` | 14 days / 1 day | `lib/auth/index.ts` | the exposure window for a stolen cookie |
| `VERIFICATION_TTL_MINUTES` | 60 | `lib/security/tokens.ts` | |
| `PASSWORD_RESET_TTL_MINUTES` | 30 | `lib/security/tokens.ts` | "a reset link takes over an account" |
| link token size | 32 bytes → 43 base64url chars | `lib/security/tokens.ts` | |
| `GUEST_REVIEW_CAP` | 3 | `lib/auth/guest.ts` | "the wall arrives while they still care about the fourth" |
| `GUEST_NUDGE_AFTER` | 12 | `lib/auth/guest.ts` | "roughly a session of onboarding" |
| guest id entropy | 5 bytes → 10 hex chars, 5 retries | `lib/auth/guest.ts` | |
| `ABSOLUTE_CINEMA_QUOTA` | 10 | `lib/cinema/index.ts` | "few enough that a member can hold the list in their head" |
| `MIN_RATED_SHOWS` | 5 | `lib/taste/profile.ts` | but genre rails and ad affinity need only **3** |
| no-variety gate | `spread < 0.4` | `lib/taste/recommend.ts` | vs `< 0.8` / `< 1.8` for the *display* labels |
| `SHRINKAGE` | 3 | `lib/taste/profile.ts` | |
| deviation cap | ±2 | `lib/taste/profile.ts` | the mean-near-7 asymmetry |
| genre / network weight | 0.7 / 0.3 | `lib/taste/profile.ts` | |
| coverage denominator | 4 | `lib/taste/profile.ts` | genres and networks share it |
| neighbour term | 0.3 + enthusiasm × 0.35 → [0.3, 1.0] | `lib/taste/profile.ts` | the largest single term |
| absence penalties | 0.8 × evidence; min(0.6, lean × 0.4) × evidence | `lib/taste/profile.ts` | `evidence = min(1, n/8)` |
| country penalty | 0.5 flat, gated at `sampleSize >= 5` | `lib/taste/profile.ts` | |
| consensus weight | alignment × 0.5 (agree) / × 0.3 (contrarian) | `lib/taste/profile.ts` | disagreement is noisier |
| era penalty | `min(0.6, (gap − 15) / 40)` | `lib/taste/profile.ts` | reason only above 0.2 |
| runtime penalty | `min(0.45, (gap − 15) / 60)` | `lib/taste/profile.ts` | no reason string |
| `CONSENSUS_PRIOR` / `_WEIGHT` | 7 / 400 | `lib/taste/profile.ts` | |
| `MIN_NOTABILITY_VOTES` | 150 | `lib/taste/recommend.ts` | "a notability bar, not a quality one" |
| `DETAIL_SYNC_LIMIT` | 18 | `lib/taste/recommend.ts` | |
| confidence floors / cap | 0.15, 0.1, 0.25 / ×1.25 / 0.90 | `lib/taste/profile.ts` | evidence saturates at 40 rated shows |
| episode forecast | `ownWeight = min(1, n/8)`; `tmdbWeight = 0.55 − ownWeight × 0.25`; cap 0.85 | `lib/taste/episodes.ts` | |
| `RUN_THRESHOLD` | 3 | `components/social/activity-feed.tsx` | binge collapsing |
| `INDIE_EVERY` / `MAX_ADS_PER_PAGE` | 3 / 2 | `lib/ads/plan.ts` | one third of *slots*; "not an ad-supported content farm" |
| ad genre bonus | ×2 | `lib/ads/plan.ts` | a bonus, never a filter |
| ad seed rotation | 1 hour | `lib/ads/serve.ts` | |
| impression threshold | 0.5 intersection | `components/ads/ad-impression.tsx` | |
| arm/confirm windows | 4,000 ms (log delete, mark series) / 5,000 ms (admin delete) | | |
| page sizes | 20 reviews / 25 admin / 30 feed / 50 diary / 60 followers / 120–180 shows | | |
| `MIN_BAR_PERCENT` / meter floor | 4% / 2% | `components/year/year-charts.tsx`, `primitives.tsx` | two different floors |
| stagger | 6 × 30 ms, then pinned at 180 ms | `app/globals.css` | |
| hero cycle | `frames × 7` s | `components/home/hero-cycle.tsx` | |
| motion durations | 120–180 ms, `cubic-bezier(0.2, 0.8, 0.3, 1)` | | |

---

## Appendix C — Environment variables

| Variable | Required | Default | Consequence if absent |
| --- | --- | --- | --- |
| `DATABASE_URL` | no | — | **Unset = PGlite at `./.pglite`.** Also makes the build-time migration a no-op |
| `TMDB_READ_TOKEN` | **yes** | — | Throws on the first request that reaches the client, not at boot |
| `AUTH_SECRET` | **yes** | — | Read by Auth.js itself; `env.authSecret` has no callers |
| `WATCH_REGION` | no | `US` | Scopes both the provider mapper input and the provider DELETE |
| `REQUIRE_EMAIL_VERIFICATION` | no | `false` | Strict `=== "true"`. Off by default so an unverified member is never locked out |
| `RESEND_API_KEY` | no | — | Absent ⇒ mail is written to the server log and reported `delivered: true, via: "log"` |
| `EMAIL_FROM` | no | `Cliffhanger <onboarding@resend.dev>` | Must be a verified domain in production |
| `NEXT_PUBLIC_SITE_URL` | no | `AUTH_URL` → Vercel vars → `http://localhost:3000` | Base for email links |
| `NEXT_PUBLIC_TMDB_IMAGE_BASE` | no | `https://image.tmdb.org/t/p` | **Repointing it also requires editing `next.config.ts` and the CSP** |
| `PGLITE_DATA_DIR` | no | `./.pglite` | **`npm run db:reset` ignores it** |

---

## Appendix D — Server Action inventory

Ten modules, all importing the same four symbols from `./result`. Every action is
`guard("<label>", async () => { … })`. **Bold** = in `VERIFICATION_EXEMPT`.

| Module | Actions |
| --- | --- |
| `auth.ts` | **signUp**, **signIn**, `signOutAction` (no guard) |
| `verification.ts` | **sendVerification**, **confirmVerification** |
| `password.ts` | **requestPasswordReset**, **resetPassword** |
| `profile.ts` | **updateProfile** (gated by `requireUser`, **not** `requireMember` — a guest can reach it) |
| `logs.ts` | `saveLog`, `toggleEpisodeWatched`, `markSeasonWatched`, **unmarkSeasonWatched**, `markShowWatched`, **deleteLog**, `toggleAbsoluteCinema` |
| `lists.ts` | `createList`, `updateList`\*, **deleteList**, `addToList`, **removeFromList**, `reorderList`\*, `cloneList`, `quickAddToList` |
| `collections.ts` | `toggleWatchlist`, `setFavorite`, `clearFavorite`\* |
| `social.ts` | `toggleFollow`, `toggleLike`, `addComment`, **deleteComment** |
| `admin.ts` | **setAccountPlan**, **deleteAccount**, **sendAccountPasswordReset** |
| `ads.ts` | **createAd**, **setAdStatus**, **setAdWeight**, **archiveAd** |

\* has no caller anywhere in the app.

Gate summary: `requireMember` (guests refused) on exactly three — follow, like, comment.
`requireAdmin` on seven. `requireUser` on everything else. `requireVerifiedUser` exists with
zero callers.

---

## Appendix E — Where everything lives

```
app/
  layout.tsx              root shell: skip link, header, guest strip, verify banner, main, footer
  page.tsx                home — the only route with a segment config (revalidate = 0)
  error.tsx / not-found.tsx
  actions/                ten Server Action modules + result.ts (the guard wrapper)
  api/auth/[...nextauth]/ three lines
  api/ads/                impression (POST) and click (GET redirect)
  show/[slug]/            series, /reviews, /season/[n], /season/[n]/episode/[m]
  [username]/             layout + 6 tabs (@ is part of the segment value, not a folder)
  admin/                  accounts + ads, both 404 for non-admins
  list/[slug]/  lists/  members/  search/  shows/  spotlight/  start/
  login/  signup/  forgot/  reset/  verify/  settings/
  for-you/                the recommendations page
components/
  ui/         button (the only cva), dialog, menu, tabs, avatar, field, primitives
  rating/     stars, star-input, histogram, dual-rating, consensus
  show/       poster-card, poster-grid, backdrop-hero, season-list, episode-row,
              episode-heatmap, log-dialog, show-actions, absolute-cinema, cast-rail, providers
  social/     activity-feed, review-card, comment-thread, follow-button, delete-log-button
  list/       list-card, list-actions, create-list-form, add-to-list-dialog
  profile/    profile-tabs, top-rated, absolute-cinema-strip
  auth/       auth-form, forgot-form, reset-form, verify-banner, verify-controls,
              guest-banner, guest-strip, guest-start
  onboarding/ intro-dialog, quick-rate, start-diary-button
  home/       hero-cycle, personal-rails
  year/       year-charts (MonthlyBars, GenreSplit, ComparisonRow)
  admin/      account-table, ad-manager
  ads/        ad-card, ad-slot, ad-impression
  nav/        site-header, site-footer, search-box, account-menu
  brand/      logo
lib/
  tmdb/       client, index (endpoints), mappers (pure), types, images (client-safe)
  ingest/     shows.ts — the only writer of the content mirror
  db/         index (the dual-driver Proxy), schema (714 lines), optional,
              queries/{shows,users,logs,lists,admin,ads}
  ratings.ts  + ratings/dual.ts — pure, unit tested
  taste/      profile (the model), recommend (retrieval), episodes, shared
  stats/      profile, year
  auth/       index (Auth.js config), session, admin, guest, claim, password-reset
  security/   rate-limit, schemas, tokens
  cinema/     the Absolute Cinema rule engine
  email/      Resend-or-log delivery with a fixed message catalogue
  slug.ts  like.ts  format.ts  view.ts  username.ts  env.ts  utils.ts
drizzle/      8 migrations + meta snapshots — the source of truth for BOTH drivers
scripts/      migrate-deploy, db-local, seed, smoke, security-probe, grant-admin, build-icons
tests/        10 suites + stubs/{server-only,next-cache}
proxy.ts      Next 16 middleware — headers only, gates nothing
```

**The eleven files to read first, in order**, if you are rebuilding:

1. `lib/db/schema.ts` — the whole domain in one heavily-commented file
2. `lib/db/index.ts` — the dual-driver switch
3. `app/actions/result.ts` — the action contract
4. `app/actions/logs.ts` — the core write, with every authorization layer visible
5. `lib/db/queries/shows.ts` — every `DISTINCT ON` aggregate
6. `lib/ingest/shows.ts` — cache-through ingest
7. `lib/ratings.ts` — the scale and the colour system
8. `lib/security/schemas.ts` + `rate-limit.ts` — the shared validation and limiter
9. `lib/taste/profile.ts` — the model, if you want one
10. `SECURITY_AUDIT.md` — seventeen findings with root causes
11. `scripts/smoke.ts` — what "working" means for a dual-driver architecture

---

## Closing note

The most reusable thing here is not the schema or the recommender. It is the habit visible in
almost every comment: **the code records the rejected alternative and the measurement that
rejected it.** "An amber ramp was theoretically better behaved and practically useless." "The
strip used to show from the first page view, which is nagging somebody who has not yet got
anything worth keeping." "43 distinct titles filled 100 slots."

That is what makes a codebase portable to a new domain. A constant with a number tells you
what; a constant with a rejected alternative tells you whether the number still applies when
the domain changes. Keep the habit, and most of this document rewrites itself for whatever
you build next.

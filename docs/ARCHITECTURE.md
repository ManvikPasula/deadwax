# Deadwax — Architecture

The system as it will be built. Decisions and their reasoning live in `DECISIONS.md`; this
file is the specification. Section numbers deliberately mirror
`ARCHITECTURE_AND_REPLICATION_BRIEF.md` so the two can be read side by side.

---

## 1. Stack

| Concern | Choice | Reason |
| --- | --- | --- |
| Framework | Next.js 16, App Router, TypeScript `strict` | Server Components keep provider calls server-side and let cover grids stream |
| Styling | Tailwind CSS v4, CSS-first `@theme`, **no config file** | Tokens as CSS variables |
| Primitives | Radix UI (`react-slot`, `react-dialog`, `react-dropdown-menu`, `react-tabs`) + `cva` for `Button` only | Accessible primitives to restyle |
| Database | Postgres — Neon in production, **PGlite locally**, one variable switches | Relational aggregates over ratings |
| ORM | Drizzle + raw SQL where aggregates need it | |
| Auth | Auth.js v5, Credentials provider ×2, **JWT sessions, no adapter** | Self-contained; no third-party provisioning to sign up |
| Catalogue | **Deezer** (primary, keyless) + **MusicBrainz** (optional enrichment) + **Cover Art Archive** (art fallback) + **Last.fm** (optional) | See `DECISIONS.md` §0 |
| Validation | Zod 4, one shared schema module | One definition per rule |
| Mutations | Server Actions only (+3 route handlers: auth, ad impression/click, cron) | |
| Tests | Vitest — pure suites plus real-PGlite integration suites | |
| Mail | Resend, degrading to `console.info` | Local dev completes the flow with no account anywhere |

### 1.1 The dual-driver switch — `lib/db/index.ts`

Copied from the brief §2.1 essentially verbatim, because it is "the single most portable
infrastructure decision". Four properties preserved exactly:

1. **The presence of `DATABASE_URL` is the entire switch.** No dialect fork.
   `DISTINCT ON`, lateral joins and `jsonb_array_elements` behave identically on both.
2. **A `Proxy` makes the connection lazy**, so CI runs `npm run build` with no database.
3. **The instance is memoised on `globalThis`** — so the driver choice is frozen at first
   property read. Every DB-backed test therefore sets env in `beforeAll` *before* any
   dynamic `import("@/lib/db")` (I-37).
4. **TLS verification stays on** unless the URL literally contains `sslmode=disable`.

Known caveats carried forward: PGlite writes to the local filesystem (dev and one
long-lived server only, **not** serverless) and allows **exactly one writer** — stop the dev
server before `db:local`, `seed` or `smoke` (I-38).

---

## 2. Domain model

### 2.1 The content tree is flat

```
artists (PK serial, deezer_id unique)
  ├── albums         (artist_id FK, addressed by albums.id)
  ├── tracks         (album_id FK + artist_id FK, addressed by (album_id, disc, track))
  ├── credits        (album_id FK; person data denormalised, no people table)
  └── artist_similar (artist_id FK → similar_id FK, the cached neighbour graph)
```

`tracks` carries **both** `album_id` and `artist_id` — the latter denormalised, exactly as
Cliffhanger's `episodes` carries `show_id`. It is what makes "this member's top tracks" one
join shorter and what lets the discography heatmap read tracks by artist.

The addressable identity of any content node is one of three tuples, each backed by a
unique index:

- `(artists.id)` — PK
- `(albums.id)` — PK, with `albums.deezer_id` unique as the external anchor
- `(tracks.album_id, tracks.disc_number, tracks.track_number)` — `tracks_album_disc_track_uq`

### 2.2 `logs` — one table for listening, rating, reviewing, liking and the diary

The load-bearing decision of the whole system, ported with the direction flip from
`DECISIONS.md` §1.

```sql
CREATE TABLE logs (
  id            serial PRIMARY KEY,
  user_id       integer    NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  target_type   varchar(8) NOT NULL,        -- 'artist' | 'album' | 'track'
  artist_id     integer    NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  album_id      integer             REFERENCES albums(id)  ON DELETE CASCADE,
  disc_number   integer,                    -- NULL unless target is a track
  track_number  integer,                    -- NULL unless target is a track
  rating        smallint,                   -- 1..10, NULL = "listened, not rated"
  review        text,                       -- NULL = no review
  listened_on   date,                       -- NULL = a rating not in the diary
  is_replay     boolean    NOT NULL DEFAULT false,
  liked         boolean    NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

**Three encodings carried by nullability** — unchanged from the brief:

| State | Encoding |
| --- | --- |
| Listen mark | a row with `rating IS NULL` |
| A rating that never entered the diary | `listened_on IS NULL` |
| A replay | **a second row**, not a mutation |

**Seven indexes, zero unique constraints:**

```sql
logs_user_created_idx   (user_id, created_at)                                 -- feed, profile
logs_user_listened_idx  (user_id, listened_on)                                -- diary
logs_target_user_idx    (album_id, disc_number, track_number, user_id, created_at)
logs_target_rating_idx  (album_id, target_type, disc_number, track_number, rating)
logs_artist_target_idx  (artist_id, target_type, user_id, created_at)
logs_artist_idx         (artist_id)
logs_album_idx          (album_id)
```

**The absence of uniqueness is the feature** (a replay is a real, separately-dated event) and
the cost is paid at read time by `DISTINCT ON` (§4.2). It matters **more** here than in TV:
relistening is the norm, so a member may hold dozens of logs for one track.

**There is no `listened` boolean.** At track level, "listened" means *a track-targeted log
row exists* — regardless of `listened_on`.

`log_tags(log_id, tag varchar(32))`, composite PK, cascade from `logs`.

**Nothing enforces `target_type` ↔ NULL consistency** — no CHECK constraints anywhere, as in
the original. The invariant is maintained in three places instead:

1. `targetTypeOf(input)` **derives** the type and never accepts it from the client.
2. `saveLog` verifies the target exists in the mirror before writing.
3. Every read builds the matching `IS NULL` predicates explicitly rather than omitting the
   column from the `WHERE` clause.

### 2.3 Complete table catalogue — 22 tables

**Content mirror (5).**

| Table | PK | Notes |
| --- | --- | --- |
| `artists` | `serial` | `deezer_id text NOT NULL UNIQUE`, `mbid text UNIQUE` (nullable), `name varchar(200)`, `slug text` (indexed, **not unique**), `picture_path text`, `bio text`, `country varchar(2)`, `began_on`/`ended_on date`, `genres`/`tags `jsonb NOT NULL DEFAULT '[]'`, `fans integer` (Deezer `nb_fan` — popularity, **not** a rating), `album_count integer`, `is_active boolean` (a release in the last 18 months → the `in_production` analogue, drives TTL), `synced_at timestamptz NOT NULL DEFAULT now()`, `mb_synced_at timestamptz` (**nullable** — null means never enriched). Indexes on `slug`, `fans`, `name`. |
| `albums` | `serial` | `deezer_id text NOT NULL UNIQUE`, `mbid text` (**release-group** MBID), `artist_id` FK, `title varchar(300)`, `slug text`, `cover_path text`, `release_date date`, `original_release_date date` (MB first-release-date — the reissue fix), `record_type varchar(12)` album\|single\|ep\|compilation, `secondary_types jsonb`, **`is_canonical boolean`** (the specials exclusion), `label varchar(200)`, `upc varchar(20)`, `explicit boolean`, `genres`/`tags` jsonb, `track_count`, `disc_count`, **`duration_ms integer`** and **`mean_track_ms integer`** (both computed by SQL at ingest), `fans integer`, `popularity integer` (Deezer `rank`, normalised 0–100), **`critic_score real`** (MusicBrainz `rating.value × 2` → the stored 0–10 scale; NULL = none) and **`critic_votes integer`**, `synced_at`, `tracks_synced_at timestamptz` (**nullable** — null means tracklist never fetched), `mb_synced_at`. Indexes on `artist_id`, `slug`, `popularity`, `release_date`, `(artist_id, release_date)`, `(is_canonical, popularity)`. |
| `tracks` | `serial` | `uniqueIndex(album_id, disc_number, track_number)` + `index(album_id)` + `index(artist_id)`. `deezer_id text`, `disc_number integer NOT NULL DEFAULT 1`, `track_number integer NOT NULL`, `title varchar(300)`, `duration_ms integer`, `isrc varchar(15)`, `explicit boolean`, `preview_url text` (Deezer 30s mp3 — **signed and expiring**, refreshed on every album sync), `popularity integer`, `critic_score real` / `critic_votes integer` (MB per-recording; usually NULL), `artist_name varchar(200)` (featured-artist display). |
| `credits` | `serial` | No `people` table; `person_id text`, `name`, `picture_path` denormalised per row. `kind varchar(8)` artist\|crew, `role varchar(40)` **nullable**, `order integer DEFAULT 999`. `uniqueIndex(album_id, person_id, kind, role)` — **`role` is nullable, so Postgres treats NULLs as distinct and this does NOT dedupe.** Ingest therefore DELETEs all credits for the album before inserting. **Do not "optimise" that DELETE into a pure upsert** (brief §4.4 trap). |
| `artist_similar` | PK `(artist_id, similar_id)` | `position integer`, `source varchar(12)` deezer\|lastfm, `synced_at`. + `index(artist_id, position)`. The cached neighbour graph. |

**Member data (11).**

| Table | Key | Notes |
| --- | --- | --- |
| `users` | `serial`, + `uniqueIndex(lower(username))`, `uniqueIndex(lower(email))` | `username varchar(32)`, `email varchar(255)`, `password_hash text`, `display_name varchar(64)`, `bio text`, `avatar_seed varchar(32)`, `email_verified_at`, `role varchar(16) DEFAULT 'member'`, `is_guest boolean DEFAULT false`, `plan varchar(16) DEFAULT 'free'`, `plan_updated_at`, **`wantlist_private boolean DEFAULT false`** (brief defect #9). |
| `logs` | `serial`, no unique | §2.2 |
| `log_tags` | PK `(log_id, tag)` | + `index(tag)` |
| `wantlist` | PK `(user_id, album_id)` | `note text`, `added_at`. + `index(user_id, added_at)` |
| `favorites` | PK **`(user_id, position)`** | The pinned Top Four **albums**, `position smallint` 1–4. Keyed by **slot, not by album** — so the DB permits one album in two slots; `setFavorite` prevents it by deleting first. |
| `desert_island` | `serial` + `uniqueIndex(user_id, album_id, disc_number, track_number)` | + `index(user_id, created_at)`. §5.1. Tracks only, so every key column is non-null and a plain unique index dedupes correctly. |
| `follows` | PK `(follower_id, followee_id)` | + `index(followee_id)` so the reverse direction is indexed. Directed graph; no mutual/pending/block. |
| `lists` | `serial` | `title varchar(120)`, `slug text` **not unique at any scope** (deliberately — `parseListSlug` throws it away and uses the trailing id, so `/list/17` is a valid URL and adding uniqueness would break `updateList` for zero benefit), `is_ranked`, `is_public`, `cloned_from_id integer` **with no FK**. Indexes `(user_id, updated_at)`, `(is_public, updated_at)`. |
| `list_items` | `serial` + the expression unique index below | **Polymorphic** (brief §10 porting note): `target_type`, `artist_id NOT NULL`, `album_id`, `disc_number`, `track_number`, `position integer DEFAULT 0`, `note text`. + `index(list_id, position)`. |
| `likes` | PK `(user_id, target_type, target_id)` | `target_type` ∈ log\|list. `target_id` has **no FK** (polymorphic). + `index(target_type, target_id)`. |
| `comments` | `serial` | Same polymorphic target, no FK. `index(target_type, target_id, created_at)`. **Flat — no `parent_id`, depth exactly 1.** |

**`list_items` uniqueness — a trap the original does not have.** `unique(list_id,
target_type, artist_id, album_id, disc_number, track_number)` would **not** dedupe
album-level items, because `disc_number`/`track_number` are NULL there and Postgres treats
NULLs as distinct. Hence an expression index:

```sql
CREATE UNIQUE INDEX list_items_target_uq ON list_items (
  list_id, target_type, artist_id,
  COALESCE(album_id, 0), COALESCE(disc_number, 0), COALESCE(track_number, 0)
);
```

Behaves identically on both drivers, and `onConflictDoNothing()` (untargeted) still carries
the whole duplicate-prevention mechanism.

**Operational (6).** `email_verification_tokens`, `password_reset_tokens` (structurally
identical, **deliberately a second table** so a bug in one flow cannot redeem a token minted
by the other), `admin_audit_log` (`actor_id` **no FK**, `actor_username varchar(32) NOT NULL`
copied at write time — an audit trail that vanishes with the account it describes is not an
audit trail), `rate_limits`, `ads`, `ad_stats`. All copied from the brief.

`ads` field renames only: `kind` general\|indie (indie = independent artist / small-label
spotlight), `project_kind` single\|ep\|lp\|mixtape (was `projectKind` film types),
`label varchar(120)` (was `festival`), `creator_name` stays. **No image column, by design** —
"they cannot carry a tracking pixel".

### 2.4 Foreign keys and cascades

All `ON UPDATE no action`. **Every FK is `ON DELETE cascade` except exactly one
`SET NULL`** (`ads.created_by`) — the same shape as the original.

- **Into `artists(id)`:** albums, tracks, credits, artist_similar ×2, logs, list_items.
- **Into `albums(id)`:** tracks, credits, logs, wantlist, favorites, list_items,
  desert_island.
- **Into `users(id)`:** logs, lists, wantlist, favorites, follows ×2, likes, comments,
  desert_island, both token tables — but **`admin_audit_log` rows survive** (no FK, username
  copied at write time).
- **Deliberately unreferenced:** `likes.target_id`, `comments.target_id`,
  `lists.cloned_from_id`, `admin_audit_log.actor_id`/`target_id`, `credits.person_id`.
- **Outside the graph entirely:** `rate_limits`, `admin_audit_log`.

Every DB-backed suite resets with `TRUNCATE users, artists RESTART IDENTITY CASCADE`.

**Consequence to plan for** (unchanged from the original): deleting a log removes the row
only. Its likes and comments become orphans with nothing to prune them — which is why
`/api/cron/prune` exists here and did not there.

### 2.5 No enums, no check constraints

Every closed value set is a `varchar(n)` documented in a comment, enforced by Zod at the
action boundary. Adding an enum value is DDL; `varchar` costs nothing; and a database check
would be a second copy of a rule that already exists once.

**Widths that sit exactly at their longest legal value** — adding a value one character
longer fails at INSERT, not at review time:

| Column | Width | Longest legal value |
| --- | --- | --- |
| `logs.target_type` | `varchar(8)` | `'artist'` (6) |
| `list_items.target_type` | `varchar(8)` | `'artist'` (6) |
| `likes.target_type` | `varchar(8)` | `'list'` (4) |
| `ads.status` | `varchar(8)` | `'archived'` (8) — **at the limit** |
| `albums.record_type` | `varchar(12)` | `'compilation'` (11) |
| `artist_similar.source` | `varchar(12)` | `'musicbrainz'` (11) |

---

## 3. Content ingestion

Three modules, mirroring the brief's boundary: `lib/providers/` (HTTP + typed endpoints +
**pure** mappers), `lib/ingest/` (cache-through upserts), `lib/slug.ts` (URL grammar).
**No component ever sees a raw provider shape.**

### 3.1 The model: cache-through, not a crawler

> The database is the read path, the providers are the fill path. Nothing crawls. An album is
> mirrored the first time somebody looks at it, and refreshed when the mirror goes stale. An
> active artist refreshes daily; an album's tracklist, once fetched, effectively never
> refreshes — a released tracklist is immutable.

Member aggregates (rating histograms, `DISTINCT ON` per-member votes, listening-time sums,
the heatmap) are SQL joins against artist/album/track rows. Without a local mirror every
aggregate would need a network call.

### 3.2 The HTTP clients — order of operations

`deezerFetch<T>(path, options)` and `mbFetch<T>(path, options)` are the only egress points.
Both follow the brief §4.2 order exactly:

1. **Budget first, before any network work.** `consume(BUDGETS.deezerOutbound, "all")` —
   `{bucket: "deezer:global", limit: 400, windowSeconds: 60}`; MusicBrainz
   `{bucket: "musicbrainz:global", limit: 45, windowSeconds: 60}`. The identity is the
   literal `"all"` — one platform-wide counter, because **the provider relationship is the
   scarce resource**, and being throttled takes the data source down for everyone. On
   rejection: log and throw `ProviderBudgetError`.
2. **URL assembly.** `new URL(BASE + path)`; params set with `searchParams.set`, any
   `undefined` value **skipped entirely** — which is what lets every endpoint pass optional
   filters straight through with no conditional object building. Only the path is
   interpolated, so there is no SSRF surface.
3. **Headers + caching.** Deezer needs none. MusicBrainz requires a descriptive
   `User-Agent` (`Deadwax/<version> ( <site url> )`) and `Accept: application/json`, and is
   additionally routed through a **serialising queue** that spaces requests ≥1100 ms
   (`lib/providers/musicbrainz/queue.ts`). Both attach `next: { revalidate, tags }`.
4. **Errors.** Non-2xx throws `ProviderError(status, path, message)`, body truncated to
   **200 characters** so an HTML error page cannot flood the log. **Deezer signals errors
   inside a 200 body** (`{"error":{"type":"DataException","message":"no data"}}`) — so the
   client inspects the parsed payload and converts that into the same `ProviderError`,
   mapping `DataException` to status 404. MusicBrainz's
   `{"error":"The MusicBrainz web server is currently busy"}` maps to 503.
5. **The degrading variant.** `deezerFetchOptional` / `mbFetchOptional` wrap the above, log,
   and return `null`. The rule and its prohibition are written in the docblock:
   *"Never use it where the caller needs to distinguish 'missing' from 'broken'."*
   So `getAlbumDetail` and `getArtistDetail` use the **throwing** form (ingest must tell a
   404 from an outage and keep the stale mirror), while **every MusicBrainz call and every
   discovery/search/chart call uses the optional form** and coalesces to `[]`/`null`.

**Deezer returns HTTP 429 with a `Retry-After` header.** Unlike the original — which honours
nothing — the client reads it, and a single retry is attempted after the advertised delay if
it is ≤2 s; otherwise the error propagates. Rate handling remains primarily preventative.

### 3.3 Cache TTLs and the tag namespace

```ts
const CACHE_SECONDS = {
  albumDetail:  60 * 60 * 24 * 30,  // 2,592,000s — a released tracklist is immutable
  artistDetail: 60 * 60 * 24,       //    86,400s — so new releases appear
  discovery:    60 * 60 * 6,        //    21,600s — charts, genre browse, new releases
  search:       60 * 10,            //       600s
  similar:      60 * 60 * 24 * 7,   //   604,800s — the neighbour graph moves slowly
  musicbrainz:  60 * 60 * 24 * 30,  // 2,592,000s — flaky endpoint, cache hard
  static:       60 * 60 * 24 * 7,   //   604,800s — the genre list
};
```

Tags: `dz:album:{id}`, `dz:artist:{id}` (album tags **also** carry the artist tag, so purging
an artist purges its albums), `dz:discovery`, `dz:genres`, `mb:rg:{mbid}`. Search passes no
tags.

**Unlike the original, the tag namespace is live**: `revalidateTag` is called by the admin
"force resync" action. The brief's caveat — that the TV app's tag namespace is
forward-looking and TTL expiry is the only invalidation — does not apply.

### 3.4 The mapper layer — pure, unit-tested against captured fixtures

`lib/providers/deezer/mappers.ts` and `.../musicbrainz/mappers.ts` import only insert types
and `slugify`. No `db`, no `fetch`, no React. Fixtures are captured real payloads in
`tests/fixtures/`.

Every non-obvious transform, each a real data-quality workaround:

- **`nullableDate(value)`** accepts `YYYY-MM-DD`, **and also `YYYY` and `YYYY-MM`**,
  normalising the latter two to `-01-01` / `-01`. The original's strict
  `^\d{4}-\d{2}-\d{2}$` would silently null a large fraction of a music catalogue (the brief
  flags this as a sharp hazard). **The `infinity` guard is kept** — Postgres accepts
  `infinity` as a valid `date` and `EXTRACT(YEAR ...)` then throws (I-4).
- **`releaseDateOf(album, mb)`** prefers the **release-group first-release-date** over the
  Deezer `release_date`, *"or every remaster reads as a recent album"*. Both are stored;
  `release_date` is what displays, `original_release_date` is what the recommender's era term
  uses.
- Whitespace-only `bio` / `label` become `null`.
- **`pickImage(sizes, minWidth)`** replaces `posterUrl(path, size)`. Deezer returns a
  pre-rendered set (`cover_small` 56, `cover_medium` 250, `cover_big` 500, `cover_xl` 1000),
  so there is no path concatenation. Returns **null, not a placeholder**, so every call site
  branches.
- **`mapAlbumSummary` poisons two fields on purpose**: `trackCount: 0, discCount: 1`
  (a summary does not know the counts, and overwriting a detailed row with zeros would
  corrupt completion maths) and **`syncedAt: new Date(0)`** — the Unix epoch as a
  permanent-stale sentinel.
- **`mapAlbumDetail` deliberately omits `mbSyncedAt`**, which is what preserves an album's
  MusicBrainz enrichment stamp across a Deezer refresh (the analogue of the brief's
  `mapSeasonSummary` omitting `syncedAt`).
- **`mapTrack`**: `popularity = normaliseRank(rank)` where
  `normaliseRank(r) = clamp(round(r / 10_000), 0, 100)` — Deezer `rank` runs to ~1,000,000.
  `criticScore = votes > 0 ? value * 2 : null` — **a release with zero votes reports no
  score rather than a 0**, which keeps it out of the heatmap rather than painting it as
  terrible (the brief's `mapEpisode` rule, transplanted).
- **`mapCredits`**: album `contributors[]` become `kind: 'artist'` rows with
  `role: 'Main' | 'Featured'`; per-track contributors are folded in and deduped, sorted by
  appearance count descending (`order: 999 - appearances`) and sliced to 20 — because
  contributor lists are dominated by one-track guests.
- **`normaliseLabel(value)`** strips legal suffixes (`Ltd.`, `Inc.`, `LLC`, `Records`,
  `Recordings`, `Group`), splits on `/` and `-` and takes the longest surviving token, and
  returns `null` if nothing survives. `"Daft Life Ltd./ADA France"` → `"Daft Life"`. The
  brief predicted this variation; Deezer confirmed it.
- **`mbTagsToAttributes(tags)`** filters to `count >= 2`, lowercases, drops a stoplist of
  non-descriptive tags (`owned`, years, `male vocalist`, Discogs list names) and slices to
  25. Without the count filter, one album carried 60+ tags including `"apathetic"` and
  `"discogs/the most popular album released every year from 1950 to 2020"`.

### 3.5 The ingest algorithm

```ts
const DAY_MS = 86_400_000;
const ARTIST_ACTIVE_TTL   = DAY_MS;
const ARTIST_INACTIVE_TTL = 14 * DAY_MS;
const ALBUM_TTL           = 30 * DAY_MS;

function isStale(row, ttl) {
  if (row.syncedAt.getTime() === 0) return true;   // the epoch sentinel
  return Date.now() - row.syncedAt.getTime() > ttl;
}
```

The rejected alternative is the same one the brief names: **not** `trackCount === 0`, which
is also the honest value for an announced album with no tracklist yet and would pin such a
row as permanently stale, re-running the whole non-transactional write path on every view.

`ensureArtist = cache(ensureArtistUncached)` and `ensureAlbum = cache(ensureAlbumUncached)` —
React's per-request `cache()`, because `generateMetadata` and the page body both need the
row, and without it every stale album ran the whole non-transactional sync twice per page
view, including two DELETE-then-INSERT cycles over its credits.

**`ensureAlbumUncached(deezerId)`:**

1. `db.query.albums.findFirst`. If present and not stale, **return it. This is the only path
   that avoids the provider entirely.**
2. `getAlbumDetail(deezerId)` (throwing variant), **then `getAlbumTracks(deezerId)`**.

   **Correction to an earlier assumption, found by probing rather than by reading docs.**
   `GET /album/{id}` *does* embed a `tracks.data[]` array — but that embedded shape
   **omits `track_position`, `disk_number` and `isrc`**. Only the dedicated
   `GET /album/{id}/tracks` returns them. Verified against *Discovery* and *The Wall*:
   the embedded array has keys
   `id, readable, title, title_short, title_version, link, duration, rank, explicit_*, preview, md5_image, artist, album, type`,
   while the dedicated endpoint adds `isrc, track_position, disk_number`.

   Since `(album_id, disc_number, track_number)` **is** a track's addressable identity and
   the unique index depends on it, deriving positions from array order is not acceptable as
   the primary path. So album ingest is **two requests cold** (metadata + tracklist), plus
   one per additional 100 tracks. The embedded array is retained as a **degraded fallback**
   only — used when the tracklist call fails, with positions derived from array index and a
   comment saying exactly that.

   This is also why the disc dimension was kept rather than collapsed: *The Wall* really is
   `{disc 1: 13 tracks, disc 2: 13 tracks}`, so a single `position` would have to invent an
   ordering across a boundary the provider reports explicitly.
3. `ensureArtist(album.artist.id)` first, so the FK exists.
4. **Albums upsert: full-row overwrite** on `deezer_id` — a detail payload is authoritative
   for every column including `slug`, so a retitled album gets a new slug here. `mb_*`
   columns are omitted from the `set`.
5. **Tracks upsert on `(album_id, disc_number, track_number)`**, setting title, duration,
   isrc, explicit, `preview_url`, popularity via `sqlExcluded` and **conspicuously omitting
   `critic_score`/`critic_votes`** (MusicBrainz owns those).
6. **Credits: DELETE by `album_id`, then INSERT `onConflictDoNothing`** — see the nullable
   `role` trap in §2.3.
7. **Derived columns, one statement:**
   ```sql
   UPDATE albums SET
     duration_ms   = t.total,
     mean_track_ms = t.mean,
     track_count   = t.n,
     disc_count    = t.discs
   FROM (SELECT COALESCE(SUM(duration_ms),0)::int AS total,
                COALESCE(AVG(duration_ms),0)::int AS mean,
                COUNT(*)::int                     AS n,
                COALESCE(MAX(disc_number),1)::int AS discs
         FROM tracks WHERE album_id = $1) AS t
   WHERE albums.id = $1;
   ```
   This is the replacement for the brief's `backfillEpisodeRunTime`, which it explicitly says
   **should not be ported** because it is a TMDB data-quality workaround. Every Deezer track
   carries a reliable `duration`, so a deterministic `SUM` at ingest is the equivalent.
8. **`enrichAlbumFromMusicBrainz(album)` — fire-and-await-optionally.** Runs only when
   `mb_synced_at` is null or older than 30 days, always through the *optional* client, and
   **its failure never fails the caller**. It writes `mbid`, `critic_score`, `critic_votes`,
   `tags`, `original_release_date`, `secondary_types` and recomputes `is_canonical`.
9. On error: log and **return the existing mirror**. *"A provider failure does not fail the
   caller when a mirror already exists — the page renders slightly stale rather than not at
   all. Only a cold miss can return null."*

The whole sequence is **non-transactional**, as in the original: a crash between the credits
DELETE and INSERT leaves an album with zero credits until the next stale window. This is
accepted for the same reason.

**`ensureDiscography(artist)`** — the latency optimisation, replacing `ensureAllSeasons`:

```
albums  = GET /artist/{id}/albums   (one request, paged at 100)
pending = albums.filter(a => a.tracksSyncedAt === null
                          || (artist.isActive && a.releaseDate >= 18-months-ago))
for (const album of pending) await ensureAlbum(album.deezerId)   // sequential on purpose
```

Two things to preserve from the brief: **non-canonical releases are never bulk-filled** (only
on direct navigation), and the loop is `await`ed **sequentially** — a 30-album discography
would otherwise fire 30 parallel requests on a cold page. It is additionally **capped at 12
albums per request** with the remainder left for the next view, and it `log()`s what it
dropped, because a silent cap reads as "covered everything" when it did not.

### 3.6 `cacheAlbumSummaries` — the asymmetric backfill upsert

The write path for every discovery surface. Three details, each a bug postmortem the brief
records:

1. **Resolve genre ids to names** via the 7-day-cached `/genre` list. Without it a summary
   row is stored with no genres and the recommender cannot see the album at all — the brief
   measured **370 of 433 mirrored shows (85%) untagged** from exactly this.
2. **Dedupe by external id in JS before the bulk insert.** Postgres refuses an
   `ON CONFLICT DO UPDATE` that would touch the same row twice in one statement and **fails
   the whole batch**, which in the original manifested as a silent no-op inside a try/catch
   (I-7).
3. **The upsert touches only five columns, and only rows with nothing to lose:**

```ts
.onConflictDoUpdate({
  target: albums.deezerId,
  set: { genres: sqlExcluded("genres"), popularity: sqlExcluded("popularity"),
         fans: sqlExcluded("fans"), coverPath: sqlExcluded("cover_path"),
         recordType: sqlExcluded("record_type") },
  setWhere: sql`albums.genres = '[]'::jsonb`,
})
```

*A detail sync knows more than a summary does — its track counts, label and credits must not
be overwritten by this path — but a row with no genres has nothing to lose.* **Consequence:
once a row has genres, this path can never refresh its popularity. Only a detail sync can.**

### 3.7 The two entry shapes

**A. Id-first, DB-backed.** `parseAlbumSlug` → `ensureAlbum` → `notFound()` on null. Used by
every content route and — importantly — by Server Actions as an **existence and foreign-key
guard before writing member data**. `saveLog`, `addToList` and the collection actions all
call `ensureAlbum`/`ensureArtist` first. Ingest is load-bearing for integrity, not display.

**B. Summary-first, render-then-mirror.** A discovery surface fetches provider summaries,
renders them through `cardFromSummary` (computing the slug on the fly so the cover still
links correctly), and `await`s `cacheAlbumSummaries` so the row exists by the time the link
is clicked.

`/search` carries a second budget, `BUDGETS.searchByIp` at 30/60s; over the limit it
substitutes `Promise.resolve([])` for the remote search and renders from the local mirror
alone — *a scraper gets far less than they asked for, a person hitting the limit barely
notices.*

### 3.8 Pagination

Deezer accepts arbitrary `limit` and `index`, so **the brief's 20-into-24 stitching problem
is deleted**, which it names as the simplest port. `GRID_PAGE_SIZE = 24` stays (divisible by
3, 4 and 6 — every breakpoint's column count), requests are `limit=25, index=offset`
(**one past the window, so a full window is distinguishable from the end**), results are
deduped by id in a `Set`, and a short page ends the walk. The test asserting
`GRID_PAGE_SIZE % columns === 0` for `[3, 4, 6]` is kept so a new breakpoint cannot silently
reintroduce a ragged final row.

### 3.9 Slugs

```
/artist/radiohead-7
/album/kid-a-42
/album/kid-a-42/track/3          — disc 1
/album/the-wall-91/track/2-5     — disc 2, track 5
```

`slugify(input)` is the brief's ordered pipeline, unchanged: NFKD normalise, strip combining
marks, lowercase, **delete** `'` and `’` outright, collapse every non-alphanumeric run to one
hyphen, trim edge hyphens, `slice(0, 80)`, trim again (the slice can land mid-hyphen), and
fall back to a literal. The fallbacks are `"album"` / `"artist"`, so `slugify("日本語")` is
`"album"`.

**No collision handling and no unique constraint on `slug`, by design.** Two albums named
"Greatest Hits" both store `greatest-hits` and are distinguished purely by the id suffix. The
slug is recomputed on every detail sync, so a retitle changes it — and old URLs keep working
because the parser ignores everything before the trailing id.

The parsers are hardened and **the order matters**:

```ts
const MAX_DB_INT = 2_147_483_647;               // declared ONCE, in lib/slug.ts

parseIdSlug(slug) {
  const match  = /-(\d+)$/.exec(slug);
  const digits = match ? match[1] : (/^\d+$/.test(slug) ? slug : null);
  if (digits === null)     return null;
  if (digits.length > 10)  return null;          // BEFORE Number()
  const id = Number(digits);
  return Number.isSafeInteger(id) && id > 0 && id <= MAX_DB_INT ? id : null;
}
```

The length check precedes `Number()` *so a 30-digit segment cannot round to something valid*.
`parseBoundedInt(value, {min, max})` requires `^\d{1,10}$` — rejecting `"1e30"`, `"0x10"`,
`" 5 "`, `"-1"` — and returns **null rather than clamping**, so the caller can 404.
`parsePage` is the single exception: it clamps to 1, because *a silly `?page=` should not
break a link*. Both bounds exist because of real production 500s (I-5).

`parseTrackLocator(segment)` is **new and is unit-tested** — the brief notes `episodeCode` is
not:

```ts
// "7" → {disc: 1, track: 7}     "2-5" → {disc: 2, track: 5}
// Rejects "-5", "2-", "2-5-1", "", "1e3", and anything out of DISC_MAX/TRACK_MAX bounds.
```

The mirrored formatter `trackLocator({disc, track, discCount})` renders `07` when
`discCount === 1` and `2-05` otherwise, so a single-disc album never shows a redundant `1-`.

### 3.10 Images

`lib/providers/images.ts` is the only provider module without `import "server-only"` —
client-safe, because only public CDN URLs are used and there is no credential anywhere in
this stack at all.

Deezer returns **absolute URLs**, so there is no base to configure and
`NEXT_PUBLIC_*_IMAGE_BASE` has no analogue. `next.config.ts` allowlists exactly four remote
patterns, and **the CSP must move in lockstep**:

```
cdn-images.dzcdn.net      Deezer covers and artist pictures
e-cdns-images.dzcdn.net   Deezer legacy CDN host
coverartarchive.org       the fallback art origin
*.archive.org             where Cover Art Archive 302-redirects (verified: dn710905.ca.archive.org)
```

Cover sizes: `56 | 250 | 500 | 1000`. `CoverCard` pairs each card size with one CDN width —
*no point shipping 1000px into a 132px rail.*

---

## 4. The rating system

`lib/ratings.ts`, `lib/ratings/dual.ts` and `components/rating/*` are pure — no I/O, no React
— which is why they are the unit-tested layer.

### 4.1 Storage: integers 1–10, displayed as 0.5–5 stars

```ts
const MIN_RATING = 1;
const MAX_RATING = 10;
const LOW_CONFIDENCE_THRESHOLD = 5;

starsToInt(stars)   = Math.min(10, Math.max(1, Math.round(stars * 2)));
intToStars(value)   = value / 2;
criticToStars(v)    = Math.round((v / 2) * 10) / 10;    // v is already on the stored 0..10 scale
mbRatingToStored(v) = Math.round(v * 2 * 10) / 10;      // MusicBrainz 0..5 → stored 0..10. The ONE bridge.
formatStars(stars)  = Number.isInteger(stars) ? String(stars) : stars.toFixed(1);
formatRating(value) = value == null ? "—" : formatStars(intToStars(value));
```

**Why integers:** so histogram bucketing and equality comparisons never touch floating point.
A stored 7 is exactly 3.5 stars, `counts[rating - 1]` is an exact array index, and
`shown === halfValue` in the star input is a safe strict equality.

**There is no 0.** Zero stars is unrepresentable; "no rating" is SQL NULL. `starsToInt(0)`
and `starsToInt(-4)` both return 1. Any UI offering "0 stars" is a bug — clearing sends
`null`.

**`mbRatingToStored` is the single place the two provider scales meet**, and a test pins it
(`DECISIONS.md` §1 Decision 4). The brief calls this the sharpest hazard in the port; it is
closed by having exactly one conversion site and asserting it.

**Three scales, guarded by branded types.** The original flows stored units (1–10 int), stars
(0.5–5) and community averages (float on 0–10) through code typed `number`, so passing 4.5
where 9 is expected renders a 2.25-star bar with no error. Deadwax brands the two that get
confused:

```ts
type Stored = number & { readonly __brand: "stored" };   // 1..10 integers, and float means on that scale
type Stars  = number & { readonly __brand: "stars"  };   // 0.5..5
```

Branding is applied at the four transform boundaries only, so the churn is contained.

### 4.2 Histograms — always ten buckets

`HistogramBucket = {value: Stored, stars: Stars, count: number, ratio: number}`.

Two constructors with identical output: `histogram(ratings[])` (increments, drops
out-of-range values silently) and `histogramFromCounts(rows)` (assigns, because SQL already
grouped). Both allocate `new Array(10).fill(0)`, compute `peak = Math.max(...counts, 0)`
(**the `, 0` seed prevents `-Infinity` on empty**), and emit `ratio = peak === 0 ? 0 : count / peak`.

**Always exactly ten buckets, even for zero ratings**, so the chart keeps a stable shape and
the silhouette of an album with twelve ratings stays comparable to one with twelve thousand.
Bars are floored at `max(2px, ratio%)` — a 2px floor keeps an unused bucket legible as a
bucket.

### 4.3 The seven-bracket colour scale — hue, not lightness

Hexes and bounds copied unchanged; only the top label changes.

| key | label | min (inclusive, 0–10) | from | to |
| --- | --- | --- | --- | --- |
| `garbage` | Garbage | 0 | `#5b3f8f` | `#8a67cf` |
| `bad` | Bad | 4 | `#c22f22` | `#ef4a35` |
| `average` | Average | 5.5 | `#d9791a` | `#fba52a` |
| `good` | Good | 6.5 | `#dfbb1b` | `#ffe155` |
| `great` | Great | 7.5 | `#249a45` | `#48d76c` |
| `awesome` | Awesome | 8.5 | `#0f5c30` | `#1c8a49` |
| `desertIsland` | **Desert Island** | 9.25 | `#2570e0` | `#57a3ff` |

The order is deliberately not a spectrum: dark green ("Awesome") outranks bright green
("Great"), and blue sits above both.

Unrated is the CSS string `var(--heat-none)` (`#22262e`) — **not a hex**, so anything parsing
the return value must not be handed a null score. `ratingBracket(NaN)` is `"none"`, not
`"garbage"`.

```ts
ratingBracket(score)   // walks the array DOWNWARDS; the highest satisfied `min` wins
ratingColor(score) {
  const band     = bracketFor(score);
  const ceiling  = nextBand?.min ?? 10;
  const span     = ceiling - band.min;
  const position = span <= 0 ? 1 : (Math.min(score, 10) - band.min) / span;
  return mix(band.from, band.to, clamp(position, 0, 1));   // straight sRGB lerp
}
```

*The brackets carry the meaning; the gradient carries the precision.* `bracketLegend()`
reverses the array (best first) and samples each swatch at the **midpoint** of its range, so
a swatch is not the shade sitting next to the neighbouring bracket.

**Two regression tests are ported verbatim in intent:** `ratingColor(7.4) !== ratingColor(7.6)`
**and** the red channel *falls* across that boundary (a hue move, not a brightness move); and
within-bracket shading while `bracketLabel` stays "Great" for both.

### 4.4 Consensus — two numbers, never merged

> An album with six member ratings must not borrow the authority of MusicBrainz's seventy, so
> each number keeps its attribution and its vote count. **The two numbers are never averaged
> together into one unattributed score.**

A two-column card, MusicBrainz on the **left** (that is how "leads with the baseline" is
expressed physically), member on the right. `LOW_CONFIDENCE_THRESHOLD = 5`; below it the
member column gets `opacity-60` and the footer reads exactly *"Too few member ratings —
showing the MusicBrainz baseline as the reference."* The member average is forced to `null`
when `count === 0` regardless of what was passed.

**Deadwax adds one honesty rule the original did not need:** when `critic_votes === 0` the
provider column is **not rendered at all** and the card collapses to one column with a
`"No critic baseline for this release"` footnote. Greying out a zero would imply a measured
zero.

**Second correction from probing: artists carry real MusicBrainz ratings too** — Radiohead
returns `{value: 4.5, votes-count: 80}`. The plan assumed there was no artist-level rating and
that the artist page would have to show a mean of that artist's rated albums under a
`label="MusicBrainz album average"` override. It does not: `artists.critic_score` /
`artists.critic_votes` hold a genuine attributed figure, normalised through the same single
bridge. The `label` override prop is retained for the *tracks* case, where per-recording
ratings are genuinely sparse.

**Third finding: prefer MusicBrainz `genres` over raw `tags`.** The `genres` array is
curated and count-weighted (`alternative rock(42)`, `art rock(29)` for Radiohead), while
`tags` is unmoderated free text — Kid A carries **60** tags including `"apathetic"` and
`"discogs/the most popular album released every year from 1950 to 2020"`, of which 39 survive
a `count >= 2` filter. So `genres` is the primary fine-grained attribute source and `tags`
only supplements it.

**The heatmap generalises this to a source switch rather than a blend:** four sources
(`member` / `critic` / `mine` / `predicted`), each returning exactly one number — *switching
source rather than blending them keeps each number attributable.*

**Nothing in the codebase combines the two into one score.** No Bayesian prior on display, no
shrinkage toward the provider mean, no vote-weighted blend. Provider consensus enters a
computed number only in the taste model, where *measured agreement* weights predictions —
never a displayed community average.

### 4.5 `DISTINCT ON` — one vote per member

Because a replay is a new row, a naive `AVG(rating)` would let one enthusiastic member vote
fifty times. **Every aggregate collapses to one row per member first.** The canonical form:

```sql
WITH scoped AS (
  SELECT DISTINCT ON (l.user_id) l.user_id, l.rating, l.liked
  FROM logs l
  JOIN users u ON u.id = l.user_id
  WHERE l.target_type   = $targetType             -- 'artist' | 'album' | 'track'
    AND <l.artist_id = $id | l.album_id = $id>
    AND <l.disc_number  IS NULL | = $d>
    AND <l.track_number IS NULL | = $t>
    AND u.is_guest = false
  ORDER BY l.user_id, (l.rating IS NOT NULL) DESC, l.created_at DESC
)
SELECT rating,
       COUNT(*) FILTER (WHERE rating IS NOT NULL)::int AS rating_count,
       COUNT(*)::int                                   AS listened_by,
       COUNT(*) FILTER (WHERE liked)::int              AS likes
FROM scoped GROUP BY rating;
```

**Three details, each load-bearing:**

1. `ORDER BY ..., (l.rating IS NOT NULL) DESC, l.created_at DESC` — Postgres sorts
   `false < true`, so DESC puts *rated* logs first. **A member's rating survives a later
   unrated replay mark.** Without this clause, playing a track again after rating it silently
   withdraws the rating from the community average (I-11). **This matters more here than in
   TV**, because relistening is the norm.
2. `AND u.is_guest = false` on **every** public aggregate (I-12). *One click of a guest's must
   not move a figure members read as consensus.*
3. An omitted disc/track becomes an **explicit `IS NULL`**, not an omitted predicate —
   otherwise an album-level query would sweep in every track row.

The average is computed in TypeScript as a genuine weighted mean (`Σ(rating × count) / Σcount`),
not SQL `AVG`.

**Six variants exist and each carries the pattern independently** (nothing centralises it, as
in the original — and changing one without the others makes a rating vanish from one surface
while persisting on another):

| Query | `DISTINCT ON` key |
| --- | --- |
| `getRatingStats` | `(user_id)` — the canonical form |
| `getTrackAggregates` | `(user_id, album_id, disc_number, track_number)` — pre-filters `rating IS NOT NULL`; feeds the heatmap |
| `getAlbumAggregates` | `(user_id, album_id)` |
| `getMostRatedAlbums` | `(user_id, album_id)` then `GROUP BY album_id ORDER BY rating_count DESC` |
| `getTopArtists/Albums/Tracks` | widening keys; no guest filter (own profile); ties break on `albums.fans DESC` |
| `getRatedAlbums` (taste) | `(album_id)` — single member, so no join needed |

**Two deliberate exceptions**, both ported: `getViewerAlbumState` does *not* use `DISTINCT ON`
(it pulls every log for one album `ORDER BY created_at DESC` and reduces in TypeScript, because
an album's logs for one member are small); and the year-in-review histogram deliberately has
no `DISTINCT ON` at all — *a replay rated twice in one year counts twice, because it is a
diary statistic, not a consensus figure.*

### 4.6 Dual rating — a verdict on the whole, beside the mean of the parts

```ts
type DualRating = {
  wholeRating:  Stored | null;  // their verdict on the album (or artist), 1..10
  partAverage:  number | null;  // unweighted mean of the parts they rated
  partsRated:   number;
  divergence:   number | null;  // wholeRating − partAverage, signed, stored units
};
```

The rationale transplants almost unchanged:

> An album rating is a judgement of the whole thing: how much they enjoyed it as a record,
> including its sequencing and how it closes. A track average is the mean of the tracks they
> actually rated. It answers a different question. They diverge for real reasons, and the
> divergence is interesting rather than an error: a record of consistently fine songs that
> fumbles its last three rates lower as a whole than its tracks average, and a patchy record
> with three transcendent songs often rates higher as a whole than its mean track.

`dualRating` takes an **Iterable**, not an array, so callers hand it `Map.values()` directly.
Out-of-range part ratings are skipped rather than skewing the mean.

`divergenceNote` speaks only when **both** gates pass: `partsRated >= 4` and
`|divergence| >= 1.5`. The threshold is in **stored units — 1.5 is three quarters of a star**,
and an inline comment exists purely to prevent that misreading. The parts gate is raised from
3 to **4** because 3 of 12 tracks is a much lower bar than 3 of 62 episodes.

Copy: `"You rate the whole more highly than its parts."` (verbatim reusable) /
`"Strong tracks, weaker as an album."`

The panel labels the right-hand figure *"Derived from N tracks"* and gives it no control — *so
nobody looks for a control to set it.*

**Applied at two scopes**, which is the music-specific gain (`DECISIONS.md` §1):
`scope="album"` (album verdict vs. its tracks) is the **default**, and `scope="artist"`
(artist verdict vs. mean of their rated albums) draws the career statement. Reusing the
album-wide average on an artist page is the named rejected alternative: it would produce
*an album statistic wearing an artist's label*.

Dual rating is **viewer-private**. It is never computed for the community.

### 4.7 The star input

Ten hit targets across five stars. Hovering previews, clicking commits, and **clicking the
value you already have clears it** — the same gesture Letterboxd uses. Arrow keys step by half
a star.

- Five dim `★` glyphs with an absolutely-positioned amber overlay clipped by a percentage
  width, so half stars always align and fractional averages render continuously.
- Two invisible half-width buttons per star (`tabIndex={-1}`) drive hover and click.
  `fullValue = star * 2`, `halfValue = fullValue - 1`.
- `commit(next) { onChange(next === value ? null : next) }`.
- Keyboard on the wrapper: Right/Up → `min(10, current + 1)`; Left/Down → `next < 1 ? null : next`
  (**stepping below half a star clears rather than clamping**); Backspace/Delete → null.
- A11y: the wrapper `<div>` is the control — `role="slider"`, `aria-valuemin={0}`,
  `aria-valuemax={5}`, `aria-valuenow={intToStars(shown)}`. **The contract is expressed in
  stars, not stored units**, and `aria-valuenow` tracks the hover preview.
- **One deviation from the original: a 250 ms debounce on the network write.** The original
  fires one Server Action round trip plus a `router.refresh()` per keystroke, which on a
  12-track album is visibly worse than on a show page. Optimistic state updates immediately;
  only the write is debounced, and the debounce is flushed on blur and on unmount.

### 4.8 `escapeLike`

```ts
escapeLike(v)      = v.replace(/[\\%_]/g, (c) => "\\" + c);
containsPattern(v) = `%${escapeLike(v)}%`;      // escape FIRST, then wrap
```

Without this, `%` matches every row (I-6) and a title containing `_` or `%` can never be
found by typing it. **Music titles contain `_` and `%` far more often than TV episode titles
do** (`"100%"`, `"_______"`), so this matters more here. Used by `searchLocalAlbums`,
`searchLocalArtists`, `searchUsers` and the admin account search.

**Naming trap, carried over: three unrelated meanings of "like".** (a) `lib/like.ts` is SQL
`LIKE` escaping. (b) `logs.liked boolean` is the *author's own* heart on the thing they
played. (c) The `likes` table is *other members* hearting a review or a list.

---

## 5. The two signature features

### 5.1 Desert Island — a quota'd honour

A member may crown an individual **track**. Two hard rules, both enforced **server-side
against the database, never taken from the request**:

1. **Entry condition:** the member's *latest* rating for that exact track must equal
   `MAX_RATING` (10 = five stars). Not 9, not unrated.
2. **Quota:** `DESERT_ISLAND_QUOTA = 10` marks held at once, **across all artists**.

> An honour with no ceiling is a second "like" — the mark only means something because an
> eleventh requires taking one back. Ten is also few enough that a member can hold the list in
> their head.

Clearing a mark frees its slot instantly; the limit is on marks *held*, never marks ever
given.

The name is not decorative: the **top bracket of the entire rating colour scale** is labelled
"Desert Island" (score ≥ 9.25) and `--color-desert: #57a3ff` is the exact top-of-band colour
of that bracket. Two literals in two files with only a comment binding them.

**`crownTrack` — the exact algorithm:**

```
Step 1 (OUTSIDE the transaction) — rating gate
  latest = SELECT rating FROM logs
           WHERE user_id=? AND album_id=? AND target_type='track'
             AND disc_number=? AND track_number=? AND rating IS NOT NULL
           ORDER BY created_at DESC LIMIT 1
  if (latest !== MAX_RATING) return { ok: false, reason: "not-five-star" }
```

The `ORDER BY created_at DESC LIMIT 1` is the whole point: *the qualifying question is what
they think of it NOW, not whether they ever gave it five stars and later changed their mind.*

```
Step 2 (INSIDE db.transaction)
  a. held    = SELECT count(*) FROM desert_island WHERE user_id = ?
  b. already = SELECT id FROM desert_island WHERE <the four target columns> LIMIT 1
  c. if (already) return { ok: true, marked: true, used: held }     ← BEFORE the quota check
  d. if (held >= 10) return { ok: false, reason: "quota-full" }
  e. INSERT; return { ok: true, marked: true, used: held + 1 }
```

**The idempotence check precedes the quota check** because at ten held a naive order would
refuse the member's own tenth crown. A test exists solely to lock this.

**The transaction exists because** two tabs both sitting at nine would otherwise each read
nine, each insert, and leave the member holding eleven (I-29). The unique index only stops
duplicate rows for the *same* track.

**`uncrownTrack` never checks the rating** — a member who has cooled on a song must be able to
take the mark back, and requiring the five stars to still be in place would trap the slot
behind a rating they no longer agree with. Uncrowning something never crowned is a silent
no-op.

**The five-star precondition is deliberately not a constraint**, and the profile read
deliberately does not filter on it either: *a member who later lowers the rating should keep
the mark until they clear it themselves rather than have the database silently discard their
choice.* The read uses a `LEFT JOIN LATERAL` to report the current rating **without filtering
on it**.

**Why a separate table rather than a `logs` column:** the honour belongs to the track, not to
one play of it; a member can hold many logs for the same track after a replay; and the quota
is counted per member, which is one index scan here instead of a filtered count over every log
they own.

**The client button.** `used` is a **global** count and already includes the current track
when `marked` is true:

```ts
held = used + (optimistic === null || optimistic === marked ? 0 : optimistic ? 1 : -1);
exhausted = !isMarked && held >= quota;
```

*While a click is in flight it has to move locally too, or the last free slot still reads as
free.* The exhausted state **disables rather than hides** the button, because *the button
spends most of its life telling somebody they would have to give something up. That is the
feature working, not a failure state.*

Three surfaces offer the toggle, all gated identically on `viewerRating === MAX_RATING`: the
track page hero, the track row on the album page, and the track row in the discography
accordion. *Five stars is the whole entry condition, so the control does not exist anywhere
else.*

**The profile strip — the one place the brief says the feature does not survive intact.**
Tracks have no per-track artwork, so the TV version's argument (*"a list of ten frames is a
better answer to 'what does this person love' than a list of ten titles"*) collapses: every
crowned track from one album would show the same cover. The resolution: **1:1 album covers at
`size-20`, dimmed to `opacity-40`, with the track title as the primary text in display serif
over them and the album/artist in mono beneath.** The cover is scenery; the title is the
content. Ten crowned tracks, five across on large screens so ten fills exactly two rows.
Unfilled slots are drawn as dashed frames **for the owner only** — they say what the quota is
far more plainly than a sentence would; another member's empty shelf renders nothing at all.

### 5.2 The heatmaps — the signature view

**`DiscographyHeatmap`** (artist page) — **one row per album, one cell per track.**

- **Grid construction.** Group tracks by album, **skipping non-canonical albums entirely**
  (`is_canonical = false`; the equivalent of *"specials break the grid's shape"*), sort albums
  by `original_release_date ?? release_date` ascending and tracks within each album by
  `(disc_number, track_number)` ascending. If the result is empty, render only
  *"Track data has not been mirrored for this artist yet."*
- **Layout.** A horizontally scrollable `min-w-fit` column; one flex row per album; the row
  label is a fixed **`10rem`** left-aligned gutter (widened from the TV version's `2rem` `S3`,
  because an album title is not an ordinal) holding a `truncate` title plus a mono year. Cells
  are **16px on mobile, 20px from `sm`**, with 4px gaps. Rows are **ragged** — each album is
  exactly as wide as its own track count, with no padding to the widest.
- `hover:scale-125` is a transform, so a hovered cell overlaps its neighbours rather than
  reflowing the row. The hover readout is a **fixed-height** paragraph for the same reason.
- **Every cell is a real `<Link>` to the track page.** That is what makes the grid
  keyboard-navigable: `onFocus`/`onBlur` mirror `onMouseEnter`/`onMouseLeave`, and each cell
  carries an `sr-only` sentence with the locator, title, score and `", Desert Island"` when
  crowned. **Replacing the anchors with divs destroys the accessibility story.**

**`TrackStrip`** (album page) — the same cell vocabulary in a single row per disc, rendered
beside the tracklist.

**Four colour sources, switched not blended:**

| Source | Value | Availability |
| --- | --- | --- |
| `member` | community average for that track | default when member data exists |
| `critic` | MusicBrainz per-recording score | **often absent** — button disabled with *"No critic scores for this release"* |
| `mine` | the viewer's own rating | disabled with *"Rate a track to see your own colours"* |
| `predicted` | `viewerRating ?? predictedRating` | disabled with *"Rate eight albums to unlock predictions"* |

Disabled rather than hidden, each with an explanatory `title`. The prediction gate is enforced
**server-side** (`forecastForViewer` returns `null`), not just in the UI.

**The brief's warning about the third source is taken seriously.** MusicBrainz per-recording
ratings are sparse, so `critic` will usually be unavailable — which means the cold-start
default `hasMemberData ? member : critic` cannot be relied on. The empty-grid state is
therefore designed rather than inherited: with no member data and no critic data the grid
renders all cells at `--heat-none` above the line *"Nothing rated yet — be the first."*
**Deezer track `popularity` is deliberately NOT offered as a colour source**: it measures
streams, not quality, and colouring a quality grid by streams is precisely the dishonesty the
brief forbids. It appears instead as a separate, labelled "Popularity" meter in the track row.

A crowned cell gets `ring-2 ring-desert` **instead of** the default `ring-1 ring-inset
ring-black/25` — the crown ring is *outset*, so it eats into the 4px gap. The background
colour is untouched: **the mark annotates the rating, it does not replace it.**

**Air-date logic is deleted.** A track is either released with the album or it does not exist.
The "Not aired" badge, the `opacity-60` unaired styling and the aired-only filters all go —
**but the release-date gate is kept for pre-release singles**, which is a real state
(`release_date > today` ⇒ not loggable).

---

## 6. Discovery, taste, and recommendations

`lib/taste/` is content-based, not collaborative, and the product surface says so to the
member rather than hiding it. **All arithmetic is in stored units: 1 unit = half a star.**

### 6.1 Signals

`getRatedAlbums(userId)` runs one statement with two CTEs and produces each album's
*effective rating*:

```sql
album_level : DISTINCT ON (album_id) rating WHERE target_type='album' ORDER BY album_id, created_at DESC
track_level : AVG(rating) GROUP BY album_id over DISTINCT ON (album_id, disc_number, track_number)
effective   : COALESCE(album_level.rating, track_level.rating)
```

The album rating always wins, *because it is the more direct statement of how much they liked
the thing.*

Each rated album reduces to: `genres[]` (Deezer coarse), `tags[]` (MusicBrainz fine,
count-filtered), `artistId` + `artistName`, `label`, `year` (from
`original_release_date ?? release_date`), `meanTrackMinutes`, `trackCount`, `criticScore`,
`criticVotes`, `country`.

**Deliberately unused despite being mirrored:** credits/contributors, `isrc`, `upc`,
per-track popularity, review text, the `liked` flag, listen dates, `explicit`. The brief's
inference applies: one real similarity edge beats another sparse categorical bucket.

### 6.2 `reliableAverage` — Bayesian shrinkage of the crowd score

```ts
const CONSENSUS_PRIOR = 7;
const CONSENSUS_PRIOR_WEIGHT = 40;      // NOT 400 — see below
reliableAverage(avg, votes) = avg === null ? null : (avg * n + 7 * 40) / (n + 40);
```

> An album with 8.6 from 4 votes is not comparable to 8.6 from 300, but the raw average says
> they are identical. Without this, obscure titles with a handful of enthusiastic ratings
> outrank canonical records.

**The weight is 40, not the brief's 400, and this is the most important retune in the model.**
MusicBrainz vote counts are two orders of magnitude below TMDB's — Kid A carries **72** votes,
where a TMDB show carries 20,000. At weight 400, `(9 × 72 + 7 × 400) / 472 = 7.30` — every
album in the catalogue would shrink to approximately the prior and the term would go inert.
At 40: `(9 × 72 + 7 × 40) / 112 = 8.29`, while a 4-vote 9.0 gives `7.18`. The shrink bites at
typical *n*, which is the stated purpose.

Worked values pinned by test: `(8.6, 4) → 7.15`; `(8.6, 300) → 8.41`; `(3, 5) → 6.56`
(**a badly-rated obscure release is pulled *up* toward the prior**).

Applied in exactly three places and **always the same transform**, so the correlation
coefficient and the quantity it multiplies come from the same distribution.

### 6.3 `buildTasteProfile` — twelve fields

| Field | How |
| --- | --- |
| `sampleSize` | count |
| `seenGenres` / `seenCountries` | `Set` of everything anywhere in the history, liked or not |
| `meanRating` | arithmetic mean |
| `spread` | sample SD, n−1 denominator, 0 when fewer than 2 values |
| `crowdBaseline` | mean of `reliableAverage(...)` over rated albums — **explicitly not the member's own mean**: comparing a candidate's provider score to the member's own mean conflates two distributions and turns the consensus term into a blanket popularity bonus |
| `genres` / `tags` / `artists` / `labels` | `affinities(...)` — below |
| `eraCentre` / `trackLengthCentre` / `trackCountCentre` | `preferredCentre(...)` — below |
| `consensusAlignment` | Pearson correlation of (own rating, shrunk crowd score); returns **0** for fewer than 3 pairs or zero variance, *to prevent a spurious ±1* |

**`affinities()` — leans with deviation capping and support shrinkage.**

```ts
for each rated album, for each key:  push(clamp(album.rating - meanRating, -2, +2))
raw     = mean(deviations)
lean    = raw * (n / (n + SHRINKAGE))     // SHRINKAGE = 5
support = n
sort DESCENDING BY LEAN
```

**The ±2 cap is load-bearing.** Uncapped, a single floor rating outweighs a ceiling one,
because a mean around 7 leaves far more room below than above. In the TV version that
asymmetry made AMC a negative signal for a Breaking Bad fan who also rated The Walking Dead
at the bottom, and then docked Better Call Saul for sharing the network. **The music analogue
is worse, not better**: a member who loves three Kanye albums and rates *Donda* 2 would have
the artist axis — their strongest signal — inverted.

**The descending-lean sort is depended on by four consumers** and is not obviously so.

**`preferredCentre()` — only enthusiasm pulls the centre.**

```ts
w = Math.max(0, album.rating - meanRating);   // albums at or below the mean contribute nothing
return weight === 0 ? null : weighted / weight;
```

*Only above-average ratings pull the centre; below-average ones say nothing about where their
taste sits, only where it does not.* A perfectly flat rater gets `null` for all three centres,
which silently disables the era, length and count penalties.

**`leanFor()` — support-weighted, not a flat average.**

```ts
lean = Σ(entry.lean × entry.support) / Σ entry.support
```

The rejected flat mean is named in the brief: a +1.07 lean from five records averaged against
a −1.32 lean derived from a single record pushed a genuinely good candidate below the member's
own mean. *Weighting by support makes the well-evidenced attribute dominate, which is what a
person would do.*

### 6.4 `predictAlbumRating` — the complete formula

```
reasons = []

STEP 1 — base deviation (three axes, not two)
  genre  = leanFor(candidate.genres, profile.genres)        // Deezer coarse + MB fine, merged
  artist = leanFor([candidate.artistId], profile.artists)
  label  = leanFor([candidate.label],    profile.labels)
  coverage  = clamp((genre.matched.length + artist.matched.length + label.matched.length) / 6, 0, 1)
  deviation = genre.lean * 0.55 + artist.lean * 0.30 + label.lean * 0.15
  rating    = profile.meanRating + deviation * coverage
```

Weights per `DECISIONS.md` §2: genre is still the broadest signal, but **artist replaces
network as the second axis** because an artist is a repeated author in a way a TV network is
not. Coverage saturates at **6** recognised attributes total, mixing all three axes in one
denominator. Without coverage, an album carrying the single tag "Rock" takes a member's full
Rock lean and is scored as though it were purely and definitively that.

```
STEP 2 — the neighbour term (the largest single term)
  if (candidate.neighbourOf) {
    enthusiasm = clamp(neighbourOf.rating - profile.meanRating, 0, 2)
    rating += 0.3 + enthusiasm * 0.35              // range [0.3, 1.0], never negative
    reasons.push(`Listeners of ${neighbourOf.name} tend to play this too`)
  }
```

> Everything else — genre, artist, era, track length — moves a prediction by at most a couple
> of tenths, and candidates inside one genre pool differ by less than that, so without this
> term the ranking within a pool collapses to the provider's own popularity order.

Sourced from `artist_similar` (Deezer `/artist/{id}/related`, cached), optionally unioned with
Last.fm `artist.getSimilar`.

```
STEP 3 — reason text (no score effect)
  genre  lean >  0.3 → "You rate {key} above your average"
  genre  lean < -0.3 → "You tend to rate {key} below your average"
  artist lean >  0.4 → "{key} has worked for you before"
  label  lean >  0.5 → "You have liked other {key} releases"

STEP 4 — two absence penalties, both keyed on the MEMBER's attributes,
          and BOTH computed against the COARSE genre projection only
  evidence = min(1, profile.sampleSize / 8)
  (a) shares no coarse genre with a readable history → rating -= 0.8 * evidence
  (b) lacks the member's signature genre (first entry with lean > 0.4 and support >= 2)
        → rating -= min(0.6, signature.lean * 0.4) * evidence
```

Both are keyed on the *member's* attributes rather than the share of the *candidate's* own
tags that are unfamiliar. The earlier TV version did the latter and *rewarded sparse metadata
twice over: a show tagged only 'Drama' paid nothing while a richly-tagged Sherlock paid for
its Mystery tag, so the blandest possible match outranked the apt one.* The invariant: **a
candidate cannot improve its score by describing itself less.**

**The coarse-only restriction is a Deadwax-specific fix** the brief predicts: once `seenTags`
holds hundreds of MusicBrainz tags, penalty (a) *never fires*. Computing it against the
28-entry Deezer genre vocabulary keeps it alive.

```
STEP 5 — unfamiliar country (flat, no evidence scaling, gated on sampleSize >= 5)
  rating -= 0.25         // halved from TV's 0.5 — music is far less language-gated
                         // no reason string is emitted

STEP 6 — the crowd term, signed by MEASURED alignment
  reliable  = reliableAverage(candidate.criticScore, candidate.criticVotes)
  if (reliable !== null) {
    deviation = reliable - profile.crowdBaseline
    weight    = alignment >= 0 ? alignment * 0.5 : alignment * 0.3
    rating   += deviation * weight
  }
```

Negative alignment is **inverted, not clamped to zero**: *clamping a negative alignment to
zero discards the clearest signal a contrarian gives us; inverting it means someone who
reliably rates canonised classics poorly is offered the overlooked instead.* The lower
coefficient is deliberate — *disagreement is a noisier signal than agreement.* The term is
**skipped entirely when the candidate has no critic score**, rather than substituting a
neutral value, because a substituted neutral is a fabrication.

```
STEP 7 — era pull (8-year dead zone, caps at a 23-year gap)
  if (gap > 8) rating -= min(0.6, (gap - 8) / 25)

STEP 8 — mean-track-length pull (1.5-minute dead zone; no reason string)
  if (gap > 1.5) rating -= min(0.45, (gap - 1.5) / 6)

STEP 9 — track-count pull (NEW; EP vs double LP; no reason string)
  if (gap > 6) rating -= min(0.3, (gap - 6) / 20)

RETURN { rating: clamp(rating, 1, 10),
         confidence: confidenceFor(profile, candidate, matchCount),
         reasons: reasons.slice(0, 3) }
```

Step 8's rationale generalises the brief's lesson about episode length: *mean track length
separates the three-minute pop single from the nine-minute post-rock piece more reliably than
a genre tag does… **a signal that exists and is ignored is worse than one that does not exist,
because it reads as covered.***

Reasons are pushed in a fixed order (neighbour, genre, artist, label, shares-nothing,
not-signature, consensus, era) and truncated to three. **Unlike the original, the UI renders
up to two** — the TV version renders only `reasons[0]`, so whenever a neighbour reason exists
it is the only reason a member ever sees, which wastes the attribute reasons entirely.

### 6.5 Confidence — multiplicative, floored, capped at 0.90

```ts
evidence       = min(1, log10(1 + sampleSize) / log10(41));   // saturates at 40 rated albums
discrimination = clamp(spread / 2, 0, 1);                     // 1 at a 1-star SD
coverage       = clamp(attributeMatches / 6, 0, 1);
combined       = max(0.15, evidence) * max(0.1, discrimination) * max(0.25, coverage);
return round(clamp(combined * 1.25, 0, 0.9) * 100) / 100;
```

> Summing let a member who rated forty albums all 8 out of 10 reach 0.59 — but a profile with
> no variance contains no preference, so no amount of volume or tag familiarity should buy
> confidence. Each term can veto: knowing the member (evidence), the member having said
> something (discrimination), and knowing the candidate (coverage). The floors keep a good
> signal on two axes from being annihilated by a weak third.

The 0.90 ceiling is an epistemic position, and the `/for-you` footer prints the reasoning
verbatim: *"Confidence is capped at 90% — with N rated albums and no collaborative signal,
certainty would be an overclaim."*

Labels: `< 0.35` low (rose), `< 0.6` moderate (neutral), else good (teal).

### 6.6 Ranking — shrink toward the member's mean by confidence

```ts
rankingScore(profile, p) = profile.meanRating + p.confidence * (p.rating - profile.meanRating);
```

For a member whose mean is 6.5, a 0.55-confidence prediction of 7.5 scores 7.05 while a
0.18-confidence prediction of 7.6 scores 6.70 — **the well-supported lower prediction wins.**
The defect this fixes: in the TV version confidence was computed, displayed, and then ignored
by the sort, so the list routinely led with the model's least-supported guesses.

**The displayed number stays the model's actual estimate**, not a value distorted for sorting.

### 6.7 Retrieval — seven sources, because retrieval dominates ranking

The brief's measured verdict: **43 distinct titles filled 100 slots** before the retrieval
rewrite; 77 distinct across 80 slots after. Retrieval gets the same weight here.

**Exclusions:** `SELECT DISTINCT album_id FROM logs WHERE user_id=$1 UNION SELECT album_id
FROM wantlist WHERE user_id=$1` — **plus every album sharing an `albumIdentity` with one of
them** (`DECISIONS.md` §4), or the list fills with remasters of records already rated.

**Genre seeds:** `weight = lean × √support`, filtered to `lean > 0 && support >= 2`, top 2.
*A mild preference over six records is a better seed than a strong one over two.*
**Fallback when that list is empty:** sort by `support` alone and take the top 2 — because *a
genre present in everything a member rates has a lean of exactly zero, so their defining lane
produces no query at all* and single-lane listeners get served the chart.

**Artist seeds:** the member's top 3 rated albums' artists, expanded through `artist_similar`.

**Seven parallel sources in one `Promise.all`:**

1. `byGenre` — `/chart/{genreId}/albums` pages 1–2 per genre seed
2. `byGenreArtists` — `/genre/{id}/artists` → each artist's top albums (the intersection
   substitute: **Deezer has no `with_genres` AND-join**, which the brief predicts, so the
   two-genre intersection becomes post-filtering on the mirrored `genres` jsonb)
3. `bySimilarArtist` — `artist_similar` rows for the member's top 3 artists → `/artist/{id}/albums`
4. `byLabel` — mirrored `albums` where `label` matches a positive-lean label (local SQL, no
   provider call; **Deezer has no label endpoint**, which is why this axis is weighted lowest)
5. `chartAlbums` — `/chart/0/albums`
6. `chartArtists` → their top albums
7. `localHighRated` — mirrored albums with `rating_count >= 3` the member has not logged
   (**a source the TV version could not have**: it is the member community as a retrieval
   source, and it improves as the instance grows)

**The neighbour provenance index is built here, not later:** *once the pools are flattened
into one list of ids, the fact that an album arrived via Aphex Twin rather than via the chart
is lost, and that fact is the strongest signal available.* On collision the highest-rated
source wins.

**Then:** `cacheAlbumSummaries(all)` → hydrate from `albums` → **three hard filters** —
`genres.length > 0` (*ranking something the model knows nothing about is worse than omitting
it*), `fans >= MIN_NOTABILITY_FANS` (5000; **not a quality bar — a notability one**), and
`is_canonical = true` → score → sort by `rankingScore`, tie-broken by `fans DESC` → **dedupe
by `albumIdentity`** → take a shortlist wider than the final list *so re-scoring has room to
reorder* → **detail-sync the top `DETAIL_SYNC_LIMIT = 8` sequentially and re-score** (because
a summary carries no label, no mean track length and no critic score, so three of the model's
signals would be structurally inert) → final sort → slice.

### 6.8 Cold start — three distinct gates, three distinct messages

| Gate | Condition | Surface |
| --- | --- | --- |
| Too few ratings | `rated.length < MIN_RATED_ALBUMS (8)` | "Not enough to go on yet" + a progress bar + *"An album rating counts, and so does rating individual tracks."* |
| No variety | `profile.spread < 0.4` (checked **before any provider call**) | "Your ratings are too alike" + *"Rating the things you disliked helps more than rating the things you loved. The gaps are the signal."* |
| Cold pool | `ids.length === 0` | "Nothing new to suggest" |

> Ten indistinguishable predictions dressed as a ranked list is worse than saying there is
> nothing to say yet.

*"The gaps are the signal"* is domain-free and kept word for word.

**Unlike the original, the thresholds are consistent across surfaces** — home genre rails, ad
affinity and `/for-you` all require 5, 5 and 8 respectively with 5 being the *profile
readability* floor and 8 the *recommendation* floor, documented as two different questions
rather than the original's accidental 3-vs-5 split.

`DEFAULT_GENRES = ['Alternative', 'Jazz', 'Electro']` for the signed-out rails —
**deliberately not the most popular genres**, because Pop and Rap/Hip Hop would fill the page
with the same records the chart rail already has.

### 6.9 Track-level taste is a completely separate model

`forecastTracks(tracks, albumBaseline)` reuses none of the above.

```ts
anchor       = viewerBaseline ?? albumBaseline;   // mean of the member's own ratings on THIS album
ownWeight    = min(1, ratedCount / 6);            // saturates at 6 rated tracks (was 8 episodes)
criticWeight = 0.55 - ownWeight * 0.25;           // 0.55 cold → 0.30 fully warm

// per track
if (viewerRating !== null) return { rating: viewerRating, predicted: false, confidence: 1 };
rating     = anchor;
confidence = 0.2 + ownWeight * 0.5;
if (track.criticScore != null && criticBaseline != null) {
  rating     += (track.criticScore - criticBaseline) * criticWeight;   // RELATIVE, never absolute
  confidence += 0.15;
}
return { rating: clampRating(rating), predicted: true, confidence: min(0.85, confidence) };
```

Two signals in priority order: (1) *their own ratings inside this album — by far the stronger
one; people are more consistent within a record than across their library*; (2) *how this
track compares to the rest of the album.* `ownWeight` saturates at **6** rather than 8 because
an album has 10–14 parts, not 62.

**The crowd contributes only a relative shape** — *the crowd's scale is not the member's.*
Real ratings are never overwritten, *so a row reads as one continuous line.* The caller
returns `null` rather than a neutral guess below `MIN_RATED_ALBUMS` — *an unlabelled
fabrication is worse than an absent feature.*

### 6.10 The evaluation harness — built FIRST (§20.5)

The brief is emphatic that the transferable thing is the *method*, not the numbers. So, before
any weight is tuned:

1. **A fixture population of ten adversarial personas** under a dedicated `@taste.test`
   email domain: a canon purist, a single-genre specialist (metal only), a pop comfort
   listener, a contrarian who rates canonised classics low, a flat rater (everything 7–8), an
   electronic-only listener, one who rates **only tracks** and never albums, one who rates
   only albums, a completist of one artist, and two ordinary listeners.
2. **`scripts/taste-eval.ts`** prints, per persona: top 6 titles, predicted stars, confidence,
   first reason — **plus one global diversity metric, "distinct titles across N slots"**. That
   metric is what caught the retrieval problem in the TV version that no amount of ranking
   work would have fixed.
3. **Property tests, not snapshots.** *A recommender is the easiest kind of code to ship
   broken: it always returns a plausible-looking number, and nothing crashes when that number
   is nonsense.* Every test asserts a bound, a direction, or a monotonic relationship, and
   test names quote the production defect they lock out.
4. **Prefer withholding to fabricating**, and give each withholding reason its own copy.
5. **Never invent a reason.** A reason string is emitted only inside the branch that actually
   moved the score.
6. **Know the ceiling and write it down.** Deadwax's stated ceiling: Deezer's 28 coarse genres
   cannot separate a doom metal record from a power metal one, and MusicBrainz tags are
   present for popular releases and absent for the long tail — so the model is sharpest
   exactly where it is least needed. Fixing that needs an audio-feature or co-listen
   embedding, not another coefficient. **Do not spend tuning effort re-deriving this.**

---

## 7. The social layer

Almost everything in the brief's §9 is domain-generic and is copied: the follow-edge table
and its two indexes, **fan-out on read** (no feed table, no inbox, no write-time fan-out), day
grouping, likes and comments with their polymorphic targets and `assertVisibleTarget`, the
review scoping ladder and the popular sort, the directory ranking, optimistic-with-rollback,
and all five N+1 techniques.

**Changes:**

- **`RUN_THRESHOLD = 5`** (from 3). An album is 10–14 tracks in 40 minutes, so 3 would
  collapse nearly every listening session. A run is `targetType === "track" && !entry.review`
  by the same author on the same **album**; five or more consecutive such logs collapse to
  *"Nadia rated 11 tracks of Blue · 1–11 · avg ★"*. Three things break a run, unchanged: a
  non-adjacent position in the sorted array, any entry with a review, and a day boundary.
- **The day boundary is the member's local date**, not UTC (see `DECISIONS.md` §5).
- **`scope: "any"` gains a third tier.** The brief notes this is *more* valuable in music. An
  album page rolls up its own tracks' reviews (`scope: "any"` at album level); an artist page
  rolls up albums **and** tracks. The `ReviewTarget` shape already supports it.
- **`getActiveMembers` weights by distinct albums**, not raw log rows — tracks are shorter
  than episodes so raw counts inflate faster.
- **Two gaps the brief says to close are closed:** `toggleFollow` checks the followee
  **exists** (so an FK violation is a real message, not the generic one) and that the followee
  **is not a guest**.
- **The N+1 the brief leaves in is removed:** `getMemberCardStats(ids[])` replaces
  `Promise.all(members.map(getProfileStats))`.

`assertVisibleTarget` treats the two target types asymmetrically **on purpose** — a log needs
existence only (logs have no privacy flag), a list must exist **and** be
`isPublic || owner === viewer`. *If you ever add private logs, this helper is the single place
that must learn about it.*

**The gate asymmetry the brief documents is fixed rather than reproduced:** in the original a
guest can `deleteComment` (which calls `requireUser`) but not post one (`requireMember`). Here
`deleteComment` also requires the author or container owner, and guests who never posted have
nothing to delete.

---

## 8. Lists, collections, statistics

**Lists** copy the brief §10 structurally: the identical three-line ownership rule compared
against the **session** id, `cloneList` inverting it for public lists and hard-coding
`isPublic: true`, position as `max(position) + 1` outside a transaction (legal because the
unique index is on the target tuple, not on position), the four-cover mosaic filled by **one**
query bucketed in JS, and **the privacy check duplicated in `generateMetadata` and the page
body** (I-15, SEC-02).

**The one real change: `list_items` is polymorphic** (§2.3). Consequences the brief flags,
each handled: `getListOptions`' membership `EXISTS` widens to the full tuple; the mosaic
borrows the album cover for a track item and the artist picture for an artist item; and a
list can now be a playlist, which is the obvious primary use case.

**Favourites become Top Four albums.** The slot-keyed PK and the drop-don't-merge rule
transfer verbatim.

**Wantlist** replaces the watchlist, PK `(user_id, album_id)`, **plus the privacy flag the
original lacks.**

**`getProfileStats`** — nine lifetime numbers in one round trip, four CTEs and nine scalar
subqueries, **wrapped in React `cache()`** (brief defect #4):

```sql
listened AS (SELECT DISTINCT album_id, disc_number, track_number FROM logs
             WHERE user_id = $1 AND target_type = 'track')
timed    AS (… JOIN tracks … SELECT COALESCE(t.duration_ms, 0) AS ms)
per_album AS (SELECT album_id, COUNT(*)::int AS listened_count FROM listened GROUP BY album_id)
progress  AS (… (a.track_count > 0 AND p.listened_count >= a.track_count) AS complete)
```

`DISTINCT` is the load-bearing word: **a replay must not count twice.** An album with
`track_count = 0` can never be "complete". **`clampListened(l, t) = t > 0 ? Math.min(l, t) : l`
is *more* necessary here than in TV**, because a release group genuinely carries different
track counts across editions, so a listener's logged tracks can legitimately exceed the
canonical count.

The nine fields: `tracks_played`, `minutes_played`, `albums_started`, `albums_completed`,
`artists_touched`, `ratings_given`, `average_rating`, `reviews_written`, `diary_entries`.
**Listening time is `SUM(duration_ms) / 60000`** — no median fallback branch, because every
Deezer track carries a reliable duration (the brief says the TMDB workaround should not be
ported).

**Year in Review** — nine independent queries in one `Promise.all`, everything scoped by
`listened_on`, **not** `created_at`:

> The year you played something is the year it belongs to, even if you logged it later.
> Ratings without a listen date are excluded from the year entirely rather than being
> attributed to whenever they were entered.

`getLoggedYears` keeps the defensive guard verbatim, because it is I-4:

```sql
… AND listened_on BETWEEN '1900-01-01' AND '2200-01-01'
```

> Postgres accepts 'infinity' as a date, and EXTRACT then throws, which would take this
> member's diary and year pages down for every visitor.

The sparse-year gate is `summary.activeDays === 0`, not `tracksPlayed === 0`. Monthly bars are
**always twelve points**, missing months zero-filled, *so the chart keeps a full-year shape*.
The histogram deliberately has **no `DISTINCT ON`** — a replay rated twice in one year counts
twice, because it is a diary statistic. Genres use `CROSS JOIN LATERAL jsonb_array_elements`.
**And the average rating renders as stars, not `/10`** (brief defect +b).

**Charts without a charting library** — plain elements with CSS widths and heights, fully
server-rendered, no SVG, no canvas, no client component. `MIN_BAR_PERCENT = 4` for monthly
bars (*a single play still reads as a bar*), a 2px stub for a zero month (*keeps the baseline
unbroken*), a 2% floor on `Meter`. **The two different floors are deliberate and are kept.**

---

## 9. Identity

### 9.1 Auth.js v5 — four keys, no adapter, no OAuth

```ts
NextAuth({
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
  pages:   { signIn: "/login" },
  trustHost: true,
  providers: [Credentials({ /* email+password */ }), Credentials({ id: "guest", credentials: {} })],
  callbacks: { jwt, session },
});
```

**14 days, not 30** — these are stateless JWTs with no server-side revocation list, so the
token's lifetime is the exposure window for a stolen cookie; `updateAge` re-issues an active
session daily so a real user is not logged out while a stolen token still ages out.

The JWT carries id, username, `avatarSeed`, `isGuest`. The `isGuest` field carries an inline
comment: **"Presentation only. Anything that enforces the distinction reads the column."**
(I-18.)

**`authorize`, with the brief's defect #6 fixed:**

```ts
const DUMMY_HASH = "$2b$12$…";                  // a REAL bcrypt hash, so timing matches

// Deadwax change: BOTH budgets are consumed HERE, before bcrypt, so a direct POST to
// /api/auth/callback/credentials cannot reach the compare with no budget spent.
await consume(BUDGETS.loginByIp, clientAddress());
await consume(BUDGETS.loginByAccount, email.toLowerCase());

const parsed  = signInSchema.safeParse(raw);     // the SAME object as the action uses (I-25)
if (!parsed.success) return null;
const account = await findUserByEmail(email);
const hash    = account?.passwordHash ?? DUMMY_HASH;
const valid   = await compare(parsed.data.password, hash);
if (!account || !valid) return null;
if (account.isGuest)    return null;             // two defences, and the second one is readable
```

**Always run one bcrypt compare against a real dummy hash** (I-23, SEC-09) — an early return
turns this endpoint into an oracle for "does this person have an account here", answerable in
bulk against a breach list with no failed-login trail on any account.

`authorize` deliberately does **not** check `emailVerifiedAt` — the gate is on publishing, not
on authentication.

### 9.2 The session read ladder

| Gate | Cost | Behaviour |
| --- | --- | --- |
| `currentUser()` | **zero DB** | Reads the JWT; null unless id and username are present and `Number(id)` is a safe integer |
| `requireUser()` | one indexed lookup | Confirms the `users` row still exists (I-17) — *a token keeps asserting an identity after the row behind it is gone. Reads tolerate that; writes must not.* Also the single revocation point |
| `requireMember(action?)` | two lookups | Adds a re-read of `is_guest`; throws `GuestNotAllowedError` with ``Create an account to ${action}. Your logs will come with you.`` |
| `requireAdmin()` | one lookup | **Role read from the DB, never the token** (I-18, §10) |

### 9.3 Guest mode — one boolean column

`ALTER TABLE users ADD COLUMN is_guest boolean DEFAULT false NOT NULL;` is the entire schema
footprint.

> A real row rather than browser storage, so the diary, the heatmap, the taste model and every
> other read work unchanged — a guest is just a member whose credentials do not exist yet. The
> cost of that choice is that guests must be kept out of every public surface.

`createGuest(ip)`: `consume(BUDGETS.guestByIp, ip)` (20/3600s, *set generously enough for a
shared address — an office, a campus, a phone network — to keep working*);
`hash(randomBytes(32).toString("hex"), 12)` with **the plaintext discarded** (not an empty
string and not a fixed sentinel — both would let one leaked value authenticate as every guest
at once if a login path ever stopped checking `is_guest`); identity
`guest_<10 hex>` / `guest_<10 hex>@guest.invalid` (**`.invalid` is an RFC 2606 reserved TLD
that can never be delivered to**); insert `onConflictDoNothing()` inside a **5-attempt retry
loop** against the case-insensitive unique indexes.

**It is a Credentials provider with an empty `credentials: {}`, not a Server Action** —
*there is nothing a caller can supply to become a chosen guest, and certainly not a chosen
member. That property is why this is a provider rather than an action that signs in an id
handed to it.*

**What a guest can do:** rate and log at all three levels with diary dates, replay flags and
tags (**uncapped, deliberately**); wantlist; lists CRUD; pin favourites; crown Desert Island;
write up to **3** reviews; have a working profile, diary, heatmaps, listening stats and taste
model.

**What a guest cannot do:** follow, like another member's post, reply to a review; write a 4th
review; sign in with a password; reset a password; be asked to verify email; reach Settings;
appear on any public surface. **Each restriction is chosen to *be* the reason to sign up** —
the blocked actions are exactly the ones that involve other people.

> `GUEST_REVIEW_CAP = 3`. Three. Enough to find out what writing one here feels like — which
> is the only thing that makes an account worth having — and few enough that the wall arrives
> while they still care about the fourth. **Ratings and diary entries are NOT capped: those
> are the habit, and interrupting the habit teaches somebody to leave.**

`countReviewsBy(userId, ignore?)` **excludes the target being edited**, so somebody at the cap
can still revise the three they wrote *instead of being frozen out of their own words*. The
`ignore` clause branches on null per column (`isNull(x)` vs `eq(x, n)`) because SQL `= NULL`
never matches.

`GUEST_NUDGE_AFTER = 12` **distinct albums** (`DECISIONS.md` §3). **The leaving warning is
separate and fires from the FIRST entry** — a `beforeunload` handler registered when
`logCount > 0`, because *"are you sure you want to leave" over an empty diary is the kind of
prompt that teaches people to ignore prompts.* The component is **hidden, not unmounted**,
because the client half owns that warning.

**The two conversion paths.**

*Path A — sign UP claims the row in place.*

```sql
UPDATE users SET username=$, email=$, password_hash=$, display_name=$, avatar_seed=$, is_guest=false
WHERE id = $guestId AND is_guest = true
RETURNING id
```

**The `is_guest = true` predicate is inside the UPDATE, not a SELECT before it** (I-30) — *so
two concurrent claims cannot both believe they won.* Same `users.id`, so **nothing moves and
nothing can half-fail.** *This is what makes "keep your logs" a fact rather than a promise.*

*Path B — sign IN merges onto an existing account.* Capture the guest id **before**
authenticating (signing in replaces the session), resolve the target from **the address that
just authenticated** (never from anything the caller sent), and run **one transaction**
(I-31):

| Table | Policy | Why |
| --- | --- | --- |
| `logs` | `UPDATE … SET user_id = target` | no per-member uniqueness — a replay is a second row — so they change owner; tags follow by FK |
| `wantlist` | CTE insert-select `ON CONFLICT (user_id, album_id) DO NOTHING RETURNING`, count, then delete the guest's | PK collision; **the target's note and date win** |
| `lists` | `UPDATE … SET user_id = target` | no per-user uniqueness |
| **`desert_island`** | **insert-select `ON CONFLICT DO NOTHING`, then delete the guest's, capped at the quota** | **The table the original forgot** (I-36). Merging must respect the quota, so the target's existing marks are counted first and only the free slots are filled, oldest-first. |
| `favorites` | **DELETED, not merged** | *pinned favourites are keyed by slot, and the target's four are a deliberate arrangement, so a guest's pins are dropped rather than shuffled into whatever slots happen to be free* |
| the guest row | `DELETE … WHERE id = $guest AND is_guest = true` | *leaving behind an unreachable account is how a users table fills with debris* |

**Every table a guest can write appears explicitly above, or is deliberately listed as
discarded** (I-36).

`/login` and `/signup` redirect only **non-guest** members — a blanket "redirect anyone with a
session" would trap guests away from both upgrade paths.

### 9.4 Tokens, reset, verification

`createLinkToken() → {token: randomBytes(32).toString("base64url") /* 43 chars, 256 bits */,
tokenHash: sha256hex(token)}`; `looksLikeLinkToken = /^[A-Za-z0-9_-]{43}$/`;
`VERIFICATION_TTL_MINUTES = 60`, `PASSWORD_RESET_TTL_MINUTES = 30`.

**Only the SHA-256 is stored** (I-27) — a database leak yields nothing redeemable. SHA-256
rather than a slow KDF because *the token is 256 bits of CSPRNG output, so there is nothing to
brute force.*

**30 vs 60 minutes:** *a confirmation link only proves an address; a reset link takes over an
account, so the interval in which a leaked mailbox is dangerous should be as small as is still
usable.*

**Reset request always answers identically** — even for an unparseable address, even when
rate-limited by email. The **only** branch returning a failure is the per-IP limit, because *a
form that says "no account with that address" is a membership oracle answerable in bulk
against a breach list.* Two budgets: `reset:ip` 10/hour and `reset:email` 3/hour — the latter
*so that nobody can be made to receive a stream of reset mail by an attacker cycling addresses
of origin — the recipient is what needs protecting here, not us.*

**Issue retires every outstanding token for that user in the same transaction as the insert.
Redeem has five refusals — bad shape, no row, already consumed, expired, account gone, email
mismatch — all returning the same `{ok: false, reason: "invalid"}`**, because distinguishing
them tells a guesser which tokens were real.

**Redeeming a reset confirms an unverified address** — *redeeming this proves they read mail
at that address, which is the same thing email verification proves.* **The password is hashed
in the *action*, not the DB module**, so the module never holds plaintext and cannot log it.
**The UI never signs them in.** The landing page sets `robots: noindex` and
`referrer: "no-referrer"` so the token never reaches a search engine or a `Referer` header.

**Verification is redeemed on a button press by a signed-in member, never on page load**
(I-28) — *mail clients and security scanners follow links automatically, which would burn a
single-use token before the member clicked it* — and additionally requires
`record.userId === user.id`, because *a token belongs to the account it was issued for, not to
whoever is signed in.*

**`REQUIRE_EMAIL_VERIFICATION` defaults OFF**, and **the banner copy changes with the flag
rather than lying.**

**Passwords:** bcrypt **cost 12** everywhere. Length bounded in **BYTES, not characters** —
`PASSWORD_MAX_BYTES = 72` measured with `TextEncoder` (I-24, SEC-16) — because bcrypt
truncates at 72 bytes and `"é".repeat(72)` is 72 characters but 144 bytes, so its first 36
characters would authenticate. `signInSchema.password` uses `min(1)` and its over-length
message is the **generic** auth failure.

### 9.5 Usernames

```ts
usernameSchema = z.string().min(3).max(24)      // the column is varchar(32), deliberately roomier
  .regex(/^[a-zA-Z0-9_]+$/)                     // allowlist, not denylist
  .refine(v => !RESERVED_USERNAMES.has(v.toLowerCase()))
  .refine(v => !v.toLowerCase().startsWith("guest_"));
```

*Allowlist, not a denylist: anything outside this set cannot appear in a URL segment, a
revalidation path, or a filename.*

`RESERVED_USERNAMES` is **regenerated from Deadwax's route tree**: admin, administrator, api,
album, albums, artist, artists, deadwax, dev, debug, internal, label, labels, list, lists,
log, login, logout, me, members, moderator, root, search, settings, signup, spotlight, staff,
start, support, system, test, track, tracks.

The `guest_` prefix ban exists because *without this a member could register
`guest_ab12cd34` and be taken for one.*

**Uniqueness is enforced by the database, not by the SELECT in sign-up** — functional unique
indexes on `lower(username)` and `lower(email)` (I-26, SEC-13). *A unique index cannot lose
that race.* **Usernames are permanent**; `updateProfile` writes only `displayName`, `bio`,
`avatarSeed` and `wantlistPrivate`.

### 9.6 Onboarding

The landing CTA is **"Start your diary"**, and it does not go to sign-up — *asking for an
email before anybody has seen what the app does is how the funnel ends at the first screen.*
It opens a guest session and lands on `/start`.

`/start` fetches **24** candidates (`GRID_PAGE_SIZE`, so the grid ends on a complete row at
every breakpoint) by over-fetching **32** and dropping the cover-less ones — *a cover-less
card in an onboarding grid is a card nobody can recognise.*

**The familiarity heuristic is re-derived, because neither provider has `vote_count`.** The
brief's principle is kept verbatim — *popularity is whatever is streaming this week; vote count
is how many people ever bothered, which is the closest thing to household familiarity the data
has* — and the closest available proxy is used:

1. **`LASTFM_API_KEY` present** → Last.fm `listeners`, which is the true equivalent.
2. **Absent** → **Deezer album `fans`** (a cumulative favourite count, not a streaming
   counter) over a **fixed curated seed of 60 canonical albums across eras and genres**,
   ordered by `fans DESC`. A curated seed is used rather than the chart because the chart is
   definitionally "this week", which is the alternative the brief rejects.

`cacheAlbumSummaries` is **mandatory here, not an optimisation**: `logs.album_id` has an FK to
`albums.id`, so the rows must exist before a star click can log against them.

Existing ratings are prefilled, because *an onboarding grid that offers back the albums
somebody just rated reads as though the ratings did not save.* The eyebrow counts down:
`"{n} rated · {m} more unlocks recommendations"`.

`IntroDialog` opens on arrival with the grid already rendered behind it, so **closing it is the
whole interaction.** Its four points map onto the four pillars: rate albums and tracks, see the
shape of a discography, keep a diary and a wantlist, follow people with taste. The guest-only
paragraph sits in its **own block below a rule** because *it is a different subject, and
burying it in the last sentence of a feature list is how people miss the one thing that could
cost them their work.*

`QuickRate` is *the smallest possible control: stars, and "not heard it" to clear the card out
of the way.* Optimistic, because *a star that waits for a round trip before filling makes a
grid of twenty albums feel broken.* Rollback restores the **prop**, not the previous local
value.

---

## 10. Security

### 10.1 The rate limiter

One Postgres table, one statement per check.

```sql
CREATE TABLE rate_limits (
  key text PRIMARY KEY,                          -- "bucket:identity"
  window_start timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 0
);
```

> Kept in Postgres on purpose: an in-process counter is per-instance, and serverless runs many
> instances, so an attacker spreading requests across them would face no limit at all.

```sql
INSERT INTO rate_limits (key, window_start, count) VALUES ($key, now(), 1)
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $w)
               THEN 1 ELSE rate_limits.count + 1 END,
  window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $w)
               THEN now() ELSE rate_limits.window_start END
RETURNING count, EXTRACT(EPOCH FROM (now() - window_start))::int AS age_seconds;
```

`ok = count <= limit` — **the Nth request where N equals the limit is allowed; the (N+1)th is
refused.** Any reimplementation using `count < limit` silently tightens every budget by one.

**It fails OPEN** on any database error (I-33): *a rate limiter that takes the whole site down
when Postgres hiccups trades a small risk for a large one; the security controls that must fail
closed are the authorization checks, not this.* The corollary: **the limiter is no defence
against an attacker who can also degrade the database.**

**Fixed windows admit up to 2× a limit across a boundary.** Accepted, and *the limits below are
set with that doubling in mind* — so do not later "tighten" a limit by halving it.

**All fifteen budgets** (thirteen ported with their numbers, two new):

| Name | Bucket | Limit / window | Reason |
| --- | --- | --- | --- |
| `loginByAccount` | `login:account` | 5 / 900s | password guessing against one account; deliberately tight |
| `loginByIp` | `login:ip` | 20 / 900s | credential stuffing from one source across many accounts |
| `signUpByIp` | `signup:ip` | 5 / 3600s | mass account creation, the entry point for every other abuse |
| `writeByUser` | `write:user` | 120 / 60s | generous for a person, ruinous for a script |
| `writeByAnon` | `write:anon` | 30 / 60s | mutations attempted without a session |
| `searchByIp` | `search:ip` | 30 / 60s | search reaches a provider |
| `verifyEmailByUser` | `verify:user` | 3 / 3600s | an account becomes a way to repeatedly deliver to one address |
| `verifyEmailByIp` | `verify:ip` | 10 / 3600s | a source cycling accounts becomes a way to deliver to many |
| `passwordResetByIp` | `reset:ip` | 10 / 3600s | the only limit between a guesser and unlimited attempts |
| `passwordResetByEmail` | `reset:email` | 3 / 3600s | the recipient is what needs protecting here, not us |
| `guestByIp` | `guest:ip` | 20 / 3600s | a row-creating endpoint open to the world |
| `adEventByIp` | `ad:ip` | 300 / 3600s | the counters are reporting rather than billing |
| **`deezerOutbound`** | `deezer:global` | **400 / 60s** | protects the provider relationship |
| **`musicbrainzOutbound`** | `musicbrainz:global` | **45 / 60s** | their published policy is ~1 req/s |
| **`lastfmOutbound`** | `lastfm:global` | **250 / 60s** | when a key is configured |

**Two limits per auth flow — one keyed by the subject, one by the source** — because the two
attacks look different, and **both are counted before bcrypt runs**, so a flood cannot be used
to burn CPU either.

`clientAddress()` takes the **left-most** `x-forwarded-for` entry, falling back to
`x-real-ip`, then the literal `"unknown"`, with the comment kept verbatim: *only trustworthy
because Vercel terminates every request and overwrites it. On any other deployment this header
is attacker-controlled and this function would need to change with it* (I-34).

`retryMessage` never leaks the mechanism — a test asserts the output does not match
`/bucket|rate_limits|select|insert/i`.

**`pruneRateLimits` is scheduled** (brief defect #10). That table is also a list of email
addresses, so any data-retention review must cover it.

### 10.2 The shared Zod schema library

> Validation lives here rather than beside each action so there is one definition per rule
> instead of one per caller. **Two of the defects found in the original audit came from copies
> drifting apart.**

The module is **pure** — no `server-only`, no `next/headers` — so it is unit-testable *and*
importable from client components for `maxLength` attributes.

| Schema | Bounds |
| --- | --- |
| `usernameSchema` | 3–24, `^[a-zA-Z0-9_]+$`, not reserved, not `guest_`-prefixed |
| `passwordSchema` | ≥8 chars, ≤400 chars (*a cheap guard so a megabyte string is rejected before it is encoded*), **≤72 bytes** |
| `signInSchema.password` | ≥1, ≤400 chars, ≤72 bytes — over-length message is the **generic** auth failure |
| `calendarDate` | **five** layers: `^\d{4}-\d{2}-\d{2}$`; a **round-trip `Date` check** (`parsed.toISOString().slice(0,10) === value`) which is what rejects `2026-02-30`; `>= "1900-01-01"` (*"That is before recorded music."*); `<= UTC today + 1 day` (*"You cannot log something you have not heard yet."* — the +1 is the timezone fix); and **an explicit rejection of the literals `infinity`, `-infinity`, `now`, `today`, `epoch`** which Postgres accepts as dates (I-4, SEC-05) |
| `tagList` | ≤12 tags, each trimmed **and lowercased BEFORE measuring**, then 1–32 chars |
| `reviewBody` | ≤20,000 — *long enough for an essay, bounded so one row cannot be a megabyte* |
| `artistIdSchema` / `albumIdSchema` | positive int ≤ `MAX_DB_INT` |
| `discNumberSchema` / `trackNumberSchema` | int 0–50 / 0–500 (**min 0** because a pregap or hidden track is legitimately numbered 0) |
| `commentBody` | ≤2,000 — mirrored in **three** places that must stay in sync: the schema, the textarea `maxLength`, and the counter that appears at 1,801 |

**`tagList` normalises before measuring** for a real reason: `İ` (U+0130) lowercases to two
code units, so a 17-character tag became a 33-character value and overflowed `varchar(32)` at
insert (I-8). **Reversing the order reintroduces the bug.**

### 10.3 Browser hardening (`proxy.ts`)

Next 16 renamed Middleware to **Proxy**. Per request it mints a nonce
(`crypto.randomUUID().replace(/-/g, "")` — *a reused nonce is the same as no nonce*), sets it
on **both** the forwarded request headers and the response, and adds HSTS (`max-age=63072000;
includeSubDomains; preload`), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, a `Permissions-Policy` denying eight
features, `X-Frame-Options: DENY` and `Cross-Origin-Opener-Policy: same-origin`.

CSP, with the two music-specific changes:

```
default-src 'self';
img-src     'self' data: blob: https://cdn-images.dzcdn.net https://e-cdns-images.dzcdn.net
                              https://coverartarchive.org https://*.archive.org;
media-src   'self' https://cdnt-preview.dzcdn.net;      /* NEW — the 30s preview player */
font-src    'self';                                      /* next/font self-hosts at build time */
connect-src 'self';
object-src  'none'; base-uri 'self'; form-action 'self';
frame-ancestors 'none'; frame-src 'none';
worker-src  'self' blob:; manifest-src 'self';
upgrade-insecure-requests;
script-src  'self' 'nonce-…' 'strict-dynamic';           /* + 'unsafe-eval' in development only */
```

`font-src 'self'` is why the fonts **must** come through `next/font` and not a stylesheet link.
**`*.archive.org` is required** because Cover Art Archive 302-redirects there (verified).

**`style-src` keeps `'unsafe-inline'` deliberately:** *the interface sets style attributes from
trusted values — heatmap cell colours, avatar gradients, meter widths — and none of it is
attacker-controlled.* Blocking them would break the UI without closing a real attack path.

**What the proxy does NOT do, and this is load-bearing:** it never calls `auth()`, never reads
a cookie, never redirects, and **protects no route.** There is no matcher on `/settings` or
`/admin`. Every authorization decision happens inside the page or the action. **If you port the
matcher regex expecting it to gate routes, you ship an unprotected app.** The matcher runs on
documents only and skips prefetches.

### 10.4 The action contract

```ts
export type ActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? { data?: undefined } : { data: T }))
  | { ok: false; error: string };
```

A conditional-mapped discriminated union, so `return ok()` is legal for `ActionResult` and
illegal for `ActionResult<{logId: number}>`. `fail(error): ActionResult<never>` — the `never`
payload lets a failure be returned from any typed action without a cast.

**`guard(label, body)` does three jobs, in order:**

1. **Rate limit** — `writeByUser` 120/60s for a signed-in caller, else `writeByAnon` 30/60s on
   the client address. *The rate limit lives here rather than in each action **so a new action
   cannot be written without one** — per-endpoint limits are the kind of control that gets
   forgotten exactly once.*
2. **The email-verification gate, default-deny by omission.** Fires only when
   `env.requireEmailVerification && user && !user.isGuest && !VERIFICATION_EXEMPT.has(label)`.
   *Anything absent from this list requires verification, so a new action is gated by omission
   rather than by remembering to add a check.* The exempt labels fall into three groups: flows
   that would otherwise be unreachable; **self-scoped edits and deletions** — *which nobody
   else can see the effects of and which should not be held hostage to slow mail*; and admin
   actions, already behind a stronger gate. Anonymous callers are skipped because *an anonymous
   request should hear "sign in", which is what the action's own `requireUser` says.*
3. **Error conversion.** Exactly four classes become their own message — `UnauthorizedError`,
   `UnverifiedEmailError`, `GuestNotAllowedError`, `ForbiddenError`. Everything else is logged
   through `safeErrorDetail` and returned as the flat `"Something went wrong. Try again."` — *a
   non-admin gets the same flat refusal as a signed-out visitor: no hint about what the action
   was or that they were close to reaching it.* **A new domain error class not added to that
   list disappears into a generic message.**

**`safeErrorDetail` whitelists only `name`, `message`, `code`, `constraint`** (I-35). Do not
add `stack`, `query`, `parameters` or `detail`: *driver errors carry the failing SQL and,
depending on the driver, its bound parameters — which for this app means review bodies, email
addresses, and password hashes. Logs are not a safe place for any of that, and Vercel logs are
readable by anyone with project access.*

**Deadwax addition:** `VERIFICATION_EXEMPT` is typed as `Set<ActionLabel>` where `ActionLabel`
is a union of literal strings, and every `guard()` call site takes that type. The brief notes
the original's label is free text with no compile-time link to the function name, so a typo
silently means "not exempt". Typing the union makes the typo a compile error.

**`saveLog` — the single write.** Authorization strictly in this order:

1. **`guard()`** consumes a rate-limit token *before anything else, including before
   `requireUser()`*. `saveLog` is **not** exempt.
2. **`requireUser()`** — re-reads the row, so a JWT for a deleted account cannot write.
3. **`ensureAlbum(albumId)` / `ensureArtist(artistId)`** — the target must exist locally or be
   fetchable. **`artist_id` is resolved from the album row here, never from the request.**
4. **Guest review cap** — if a review is present and the caller is a guest, count their
   existing reviews *excluding this target* and refuse at 3.
5. **Target existence** (I-19). For a track target, verify the exact
   `(album_id, disc_number, track_number)` row exists. *Without this, a crafted call publishes
   a review of a track that does not exist, which renders on the album page, links to a 404,
   and inflates the author's public track and listening-time totals.*
6. **Release-date gate** — refuse a log against an album whose `release_date > today` (the
   pre-release-single state the brief says to keep).

**The mutation, inside one `db.transaction`** (I-32), with **patch semantics** (I-1, SEC-01):

```ts
const patch = { updatedAt: new Date() };
if (data.rating     !== undefined) patch.rating     = data.rating;
if (data.review     !== undefined) patch.review     = review;
if (data.listenedOn !== undefined) patch.listenedOn = data.listenedOn;
if (data.isReplay   !== undefined) patch.isReplay   = data.isReplay;
if (data.liked      !== undefined) patch.liked      = data.liked;
await tx.update(logs).set(patch).where(eq(logs.id, existing.id));

if (data.tags) {                                  // a full replace, not a merge
  await tx.delete(logTags).where(eq(logTags.logId, id));
  const cleaned = [...new Set(data.tags)].filter(Boolean);
  if (cleaned.length) await tx.insert(logTags).values(cleaned.map(tag => ({ logId: id, tag })));
}
```

**`undefined` means "leave alone"; an explicit `null` still clears the column.** Before this
fix in the original, clicking Like or a star on an album you had reviewed destroyed your own
review, diary date, flags and every tag. **The paired half: any control that saves must be
primed from the real row, never from blanks** — which is why `LogDialog`'s `initial` prop is
**required**, not optional (brief defect #1).

`review` is normalised once before the transaction (`data.review?.trim() ? trimmed : null`), so
a whitespace-only review becomes SQL NULL and stays out of every review list.

**The other log actions:**

| Action | Behaviour |
| --- | --- |
| `toggleTrackListened` | **true:** if any row exists, do nothing (idempotent). Else insert a bare mark dated the member's local today. **false:** delete only the **latest** row — *so a replay history is not wiped by one mis-click.* Three replay rows need three clicks. |
| `markAlbumListened` | Only **released** tracks (`albums.release_date <= today`). *The interface already refuses to let a member tick an unreleased track one at a time; the bulk path has to agree.* One multi-row INSERT for the missing ones. |
| `unmarkAlbumListened` | `DELETE … AND review IS NULL AND rating IS NULL`. That filter is the entire safety mechanism. Verification-exempt. |
| `markDiscographyListened` | **Fixed** (brief defect #5): the whole loop runs inside **one** `guard()` against internal unguarded helpers, so one click costs one token, and a partial failure is **reported**, not silently skipped. |
| `deleteLog` | Explicit ownership check with two distinct messages: `"That entry no longer exists."` vs `"That is not your entry."` Verification-exempt. |
| `toggleDesertIsland` | A thin shell over `lib/desert-island` (§5.1). |

**Two destructive actions use a two-press arm/confirm with a 4000 ms self-disarm instead of a
modal.** Delete: *the first press arms it, the second commits, and it disarms itself after a
few seconds — a deleted log cannot be recovered.*

**Revalidation discipline.** `revalidatePath("/album/[slug]", "layout")` uses the **route
pattern with a type argument**, not an interpolated concrete path — *album pages are keyed by
slug, which we do not have here, so revalidate the segment tree rather than one path.* **No
dead paths are carried** (brief defect +a).

### 10.5 The layering doctrine

```
lib/providers/  clients, typed endpoints, pure mappers      (no DB, no React)
lib/ingest/     upsert artist / album / tracks              (provider + DB, no React)
lib/db/         schema, connection, query modules           (no React)
lib/ratings/    rating math, histograms, colour scale       (pure)
lib/taste/      the recommender                             (pure model + DB reads)
lib/stats/      profile and year aggregation                (DB reads)
lib/auth/       Auth.js config, session helpers, guards
lib/security/   rate limits, Zod schemas, link tokens
lib/desert-island/  the quota rule engine
app/actions/    Server Actions, one file per domain, Zod-validated
components/     presentational; data arrives as props
```

> Pure logic has **no I/O** and is unit tested. **Server Actions validate, authorize, mutate
> and revalidate — nothing more.** **Components receive data as props; they do not query.**
> Each query module owns one table's reads.

**The sharpened version of the rule, which the brief extracts and this build adopts:** actions
validate, authorize and revalidate; **anything with a rule worth proving lives in `lib/` and is
tested against a real database.** That is why `lib/desert-island/` and
`lib/auth/password-reset.ts` exist as modules rather than as action bodies — *an action is a
shell, and a rule that only exists inside one is a rule nobody can prove.*

**The client convention** — no `useActionState`, no error boundaries for action failures:

```tsx
const [error, setError] = React.useState<string | null>(null);
const [pending, startTransition] = React.useTransition();

startTransition(async () => {
  const result = await someAction(input);
  if (!result.ok) { setError(result.error); return; }   // roll back optimistic state here
  router.refresh();
});
```

rendered through a shared `<FormError message={error} />`, because *a failure renders inline
next to the control that caused it rather than replacing the page with an error boundary.*
**Optimistic-with-rollback plus `router.refresh()` on success**, because everything derived
from a write — aggregates, histograms, replay counts, badges — is server-rendered, so the
honest reconciliation is to re-render the server tree.

### 10.6 Admin

A **single-role** operator panel. One column: `role varchar(16) NOT NULL DEFAULT 'member'`.
**No roles table, no permissions table, no per-capability grants.**

> Never settable through any member-facing path: there is no action that writes this column, so
> the only way to become an admin is the operator running `npm run admin:grant`. **Privilege
> escalation has to be impossible by construction, not merely unimplemented.**

`requireAdmin()` resolves the role **from the database on every request** and **throws rather
than returning a flag, so a caller cannot forget to check the result** (I-18). **If you put the
role in the JWT for speed, you break the single stated invariant** — revocation must take
effect on the next request, not on token expiry.

**Four gates for one privileged read:** the route (`notFound()` on `ForbiddenError`,
**rethrowing everything else** so real failures still surface as 500s — *a 403 confirms the
route exists and that they found a real admin surface; a 404 is indistinguishable from a typo*,
I-21); the metadata (`robots: noindex`, `referrer: no-referrer`); **the query, which self-gates**
(I-20 — *making the query refuse is the difference between one mistake and a breach*); and the
action, which calls `requireAdmin()` as its first statement inside `guard()`.

**The brief's non-uniformity is fixed:** `lib/db/queries/ads.ts` self-gates too, which in the
original it does not.

**`expectedUsername` staleness check** on all three account actions: *echoed back from the row
the admin was looking at, compared against the database before acting, so a stale table or a
swapped id cannot delete the wrong account — **the id alone is not enough.*** The comparison is
**case-sensitive**, which matters because usernames are stored case-preserving behind a
case-insensitive index.

**Capabilities:** `setAccountPlan` (the **only** writer of `users.plan`; an idempotent no-op
writes **no** audit row, so the log records state *changes*), `deleteAccount` (self-delete
refused **before the DB read**; then existence; then username match; then
`role === 'admin'` refused — *another admin has to be demoted first, so **deleting an admin is
a two-key operation***; then one transaction with the **audit row first**),
`sendAccountPasswordReset` (address read from the database so *this cannot be turned into a
relay*; **the reset does not change the password**, so *an admin using this cannot take over an
account without the owner's mailbox — which is why there is no "set a new password for this
member" button anywhere*; **audited before the mail is attempted**), `createAd` (`status:
"draft"` hardcoded; indie ads require a credit — *an indie placement without a credit is just
an ad with a blue border*), `setAdStatus`, `setAdWeight`, `archiveAd` (**archive, never
delete** — *the per-day counters are the record of what ran*), and **`resyncAlbum`** (new — the
`revalidateTag` caller).

`recordAction(tx, entry)` takes the **transaction handle as its first parameter**, so the audit
row cannot be written outside the transaction that applies the effect. **Deadwax fixes the
brief's inconsistency**: the ad actions use the same transactional helper, not a separate
non-transactional one.

**"Append-only" is a convention, not an enforcement** — no trigger, no `REVOKE`, no hash chain.
Anyone with DB credentials can rewrite history, and DB credentials are also the grant
mechanism, so **the operator is fully trusted by construction.**

**The mechanical no-escalation test** is ported first and verbatim (I-22) — a **source-level**
assertion that only `app/actions/admin.ts` and `scripts/grant-admin.ts` may write `role` or
`plan`. *A future action that sets `role` or `plan` fails this test instead of quietly shipping
privilege escalation.* **Know the limits of the guarantee:** a raw `db.execute(sql\`UPDATE users
SET role…\`)`, or a writer placed in `tests/` or `drizzle/`, slips past it — so the Deadwax
version additionally greps for `UPDATE users` with `role`/`plan` in raw SQL.

### 10.7 House ads

First-party rows only. **No third-party script, no ad network, no pixel — which is why the CSP
needs no holes cut in it.**

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
Including the index in the hash input is what makes slot 0 and slot 1 draw differently from the
same page seed, and what makes the *reserved position* vary between pages.

**Indie gets a third of all slots, not a third of pages.** On a two-unit page roughly 4/9 of
views carry no indie unit, 4/9 carry one, ~1/9 carry two; the long-run impression share is
exactly 1/3. **The rejected alternative is named:** forcing "at least one indie slot on every
page" reads like a floor and silently yields a **50%** share on a two-unit page — half the paid
inventory given away. A test plans 2,000 pages (4,000 slots) and asserts the share is within
±0.04 of 1/3, with a comment naming exactly that bug.

`MAX_ADS_PER_PAGE = 2` keeps its rationale, re-pointed: *a record diary is not an ad-supported
content farm, and the moment a member counts three of these the surface is worth nothing to
anybody — including the artist whose EP is sitting in the third one.*

**The reservation is a preference, not a lock:** `pool = preferred.length > 0 ? preferred :
eligible`. A slot where nothing was eligible is **omitted**, so the page renders nothing rather
than an empty frame.

`seedHash` is FNV-1a 32-bit — *deterministic across processes, unlike anything seeded by time*,
which matters because Next renders across many serverless instances **and because impression
counting only means something if a reload does not reshuffle the page.** The page seed is
`${viewerId ?? "anon"}:${pageKey}:${hour}` — **who**, **which page**, and an **hour bucket**.
`pickAd` uses a **different hash namespace** from `planKinds`, so the kind draw and the pick
within a kind are uncorrelated; it scores `max(1, weight) * (genreMatch ? 2 : 1)` — **a genre
match doubles the weight, as a bonus, never a filter** — and walks a cumulative-weight list.
`planPage` keeps a `placed` Set so a two-slot page with one ad in inventory gets **one** unit.

**Eligibility** is `status='active' AND (starts_at IS NULL OR starts_at <= now) AND (ends_at IS
NULL OR ends_at > now)` — a half-open window. **Row → candidate mapping is defensive**, so
anything unrecognised in those varchar columns degrades rather than throwing.

**The Pro exemption** reads `users.plan` from the table on every serve and **never from the
session token** — *a plan is exactly the kind of thing a client would like to assert about
itself.* It is enforced **at the point of fetch**, so for a Pro member **no candidate query
runs at all**. Guests see ads.

**Affinity reuses the taste model rather than building a second behavioural profile** — *the
affinity that decides which EP to show somebody is the same affinity that decides what to
recommend them* — wrapped in a `try/catch` whose failure mode is **an absent bonus, never a
failed page.**

**Frequency capping is four structural mechanisms, not a cookie:** the hard per-page ceiling of
2, no repeat within a page, hourly seed rotation, and per-page keying (`"home"`,
`"album:{id}"`). **The counters are explicitly reporting, not billing.**

**The impression beacon** is an invisible `absolute inset-0` span with a `sent` latch and an
`IntersectionObserver` at `threshold: 0.5` — **half the unit must be on screen**, *so a sliver
at the edge of the viewport does not count.* `keepalive: true` so navigating away does not drop
it, and an empty `.catch(() => {})` because *a missed count is not worth a console error on
somebody's page.* If `IntersectionObserver` is undefined it reports immediately. *A render is
not a view — a sidebar three screens down gets rendered every time and seen rarely — and
writing to the database while rendering would also make the page uncacheable.*

`POST /api/ads/impression`, in order: a same-origin check (**missing** Origin allowed, **wrong**
Origin 403); `adEventByIp` → 429; malformed JSON → 400; a bounded-integer check → 400; then
record. **No session is read, no cookie is set, nothing about who saw it is stored** — *the
worst outcome is an inflated number in a report*, which is what makes the endpoint
uninteresting to attack.

`GET /api/ads/[id]/click` — **over the limit the click still forwards, it is just not
counted**, because *refusing to forward somebody who clicked a link is worse than an uncounted
click.* `clickTarget` re-tests `/^https?:\/\//i` on the stored URL **before returning it**, so a
`javascript:` URL that somehow reached the column can never become a redirect (a test writes
exactly that). **No open redirect is possible because the destination comes from the row, never
from the query string.** The GET-that-writes is a deliberate documented trade: *a click has to
survive being middle-clicked and opened in a new tab, and a form post cannot do that.*

**The counter write** is one statement — a CTE plus an upsert, with the column name
interpolated via `sql.raw` from a **two-valued literal** so there is no injection surface — and
because the INSERT selects **from the CTE**, an archived ad increments nothing at all.
**One row per ad per day, never per impression**: *an advertiser needs a daily curve, and
nobody needs a log of which member saw which ad. That is a deliberate limit on what this table
can ever be used for.* A test asserts `ad_stats` has exactly one row after two impressions and
that its keys do **not** include `userId`.

**There is deliberately no image column:** *uploads would need a bucket, and remote images
would need host allowlisting plus a review process for what those hosts serve. A headline, a
line of copy and a credit are enough, and **they cannot carry a tracking pixel.***

The admin UI **explains the policy in prose using the real constants** — *an operator who
cannot explain the reservation cannot sell it.*

---

## 11. UI and the design system

### 11.1 Tokens

Tailwind v4, CSS-first. `globals.css` opens with `@import "tailwindcss";`. **There is no
`tailwind.config.js`.** Everything lives in `@theme {}`.

```
--color-ink:         #08090b   /* page background, dialog scrim base */
--color-surface:     #101216   /* .card background */
--color-surface-2:   #171a20   /* inputs, chips, cover placeholder, hover fill */
--color-surface-3:   #1f232b   /* scrollbar thumb, meter track, secondary hover */
--color-line:        #262b34   /* every border and hairline */
--color-line-bright: #5b6472   /* also the empty-star track, which needs 3:1 as a
                                  meaningful graphical object */
--color-paper:       #f2f4f7
--color-muted:       #a7aeba
--color-faint:       #949cab   /* NOT #6b7280 — see below */
--color-amber:       #e9b44c   /* the single warm accent: rating, emphasis, focus, primary */
--color-amber-bright:#f6c968
--color-teal:        #4fd1c5   /* replay / completion ONLY */
--color-rose:        #e2557b   /* destructive / errors */
--color-desert:      #57a3ff   /* Desert Island — the same hex as the top rating bracket,
                                  held here so the honour and the heatmap's peak cannot drift apart */
--radius-card:       0.625rem
--ease-out-quick:    cubic-bezier(0.2, 0.8, 0.3, 1)
```

**`--color-faint` is a measured value, not a taste one.** `#6b7280` measures **3.26:1** on
surface-3 and **4.12:1** on the base — both under the 4.5:1 that 11–13px text needs — *and that
text carries the dates and track numbers this product is made of.* `#949cab` clears 4.5:1 on
every surface in the palette. The comment is kept.

Fonts through `next/font` (self-hosted at build time, which is what lets `font-src` stay
`'self'`): **Instrument Serif** display, **Geist** sans, **Geist Mono** mono.

**No custom spacing scale.** Container widths are hand-picked per page: shell `max-w-7xl`, hero
`max-w-6xl`, reviews `max-w-3xl`, lists `max-w-5xl`, auth `max-w-sm`, error/404 `max-w-md`.

**Dark mode strategy: there is none.** `:root { color-scheme: dark; }` and nothing else. *Dark
only.*

The only non-`@theme` variable is `--heat-none: #22262e`. **The rating ramp deliberately does
not live in CSS**: the bracket sets the hue and the position inside the bracket sets the shade,
*which a fixed set of variables cannot do.*

### 11.2 Global element styling

- **`* { border-color: var(--color-line); }`** — a global default so any `border` utility is the
  hairline colour without naming it. **Load-bearing**: plenty of places write bare `border`.
- **`body { overflow-x: hidden }`** — not cosmetic. Full-bleed heroes measure against `100vw`,
  which includes the scrollbar. **It is the required companion to `.bleed`.**
- **Film grain** — `body::after`, fixed, `inset 0`, `z-60`, `pointer-events: none`,
  `opacity: 0.035`, an inline data-URI SVG `<feTurbulence type="fractalNoise"
  baseFrequency="0.9" numOctaves="3"/>` on a 140×140 tile. Fixed rather than absolute *so it
  reads as emulsion rather than texture scrolling with the content.* At z-60 it covers the
  sticky header (z-50) and sits under dialogs.
- **Focus** — one global rule: `:focus-visible { outline: 2px solid var(--color-amber);
  outline-offset: 2px; }` — *focus is always visible and always amber, so keyboard travel is
  legible on every surface.*
- **Scrollbars** — 10px, ink track, surface-3 thumb as an inset pill; horizontal rails opt out.

### 11.3 The `@layer components` vocabulary

Inside `@layer components` so Tailwind utilities still win.

| Class | What |
| --- | --- |
| `.eyebrow` | The most-used class: mono, **11px**, `letter-spacing: 0.18em`, uppercase, `--color-faint`. |
| `.section-rule` | Flex with an `::after` 1px `linear-gradient(to right, var(--color-line), transparent)` filling the remaining width. |
| **`.sleeve`** | **The key geometric primitive — `aspect-ratio: 1/1`, not 2/3.** `overflow: hidden`, `rounded-card`, `surface-2` background, `box-shadow: inset 0 0 0 1px var(--color-line)`, 160ms transitions. On `.group:hover .sleeve`: `translateY(-3px)` plus an amber inset rim and a soft drop shadow. **The `.group:hover` selector is what lets a wrapping `<Link className="group">` drive it.** |
| `.hero-scrim` | Two stacked gradients (to-top, to-right) *so hero text always lands on a dark field.* |
| `.hero-vignette` | `radial-gradient(120% 80% at 50% 30%, transparent 40%, rgb(0 0 0 / 0.55) 100%)` |
| `.card` | surface + 1px line + `rounded-card`. |
| `.bleed` | `margin-inline: calc(50% - 50vw)`. Depends on the `body` overflow guard. |
| `.letterbox` | `::before`/`::after` 1px blocks bracketing a title block. |

Plus `.text-balance` and **`.tabular`** (`font-variant-numeric: tabular-nums`) — on every mono
number so digits do not jitter.

**The 1:1 change and everything downstream of it** (the brief calls this "the one hard change"):
`.sleeve` replaces `.poster`; `CoverGrid` is `grid-cols-3 sm:grid-cols-4 lg:grid-cols-6` with
`gap-y-6` reduced to `gap-y-5` (a square loses the extra vertical rhythm a 2:3 poster needs);
`CoverRail` children are `w-[132px] sm:w-[152px]` unchanged, but the rail's vertical padding
that exists *specifically to leave room for the hover lift* is retained (*which would otherwise
trip the scroll container into showing a second scrollbar*).

**The hero has no backdrop image to work with, in either provider.** The treatment: the cover
itself, scaled to `140%`, blurred `blur-2xl`, `opacity-35`, `saturate-150`, positioned behind
the content as its own scrim, with `.hero-scrim` and `.hero-vignette` layered over it. On the
artist page, Deezer's `picture_xl` is used instead — a real wide-ish image where one exists.

### 11.4 Motion

- **`.stagger > *`** — `animation: rise 420ms var(--ease-out-quick) both` with six hard-coded
  30ms delay steps and `nth-child(n + 7)` **pinned at 180ms**, *so a 24-card grid does not take
  four seconds to land.* Baked into `CoverGrid`, so every grid gets it and rails do not.
- **`.hero-frame`** — keyframes `0%,14% {opacity: 1} 20%,94% {opacity: 0} 100% {opacity: 1}`,
  duration and delay computed inline as `frames.length * 7`s and `index * 7 - 7`s.
- **Two separate reduced-motion blocks, doing different jobs.** The first kills the hero
  specifically and hides all but the first frame: *a slow cross-fade is still motion, and this
  is decoration — there is nothing to degrade gracefully to.* The second is the blanket kill
  switch plus `scroll-behavior: auto`.

### 11.5 Primitives, avatar, shell

**Exactly four Radix packages**: `react-slot`, `react-dialog`, `react-dropdown-menu`,
`react-tabs`. The convention: `import * as Primitive`, re-export unstyled parts as bare
aliases, wrap only the styled parts spreading `React.ComponentProps<typeof Primitive.Y>` through
`cn()`. Every Radix wrapper carries `"use client"`.

**`cva` is used exactly once, in `Button`** — five variants (`primary`, `secondary` (**the
default**), `outline`, `ghost`, `danger`) and four sizes, with icon sizing via the `[&_svg]`
descendant selector *so callers just drop a lucide icon in as a child and never size it*.
`asChild` swaps the element for `Slot`. **`Button` has no `"use client"`** — a plain function
component, so Server Components render it directly. `cn = twMerge(clsx(inputs))`;
**tailwind-merge is what makes the `className` escape hatch actually work.**

**The generated avatar** — there is no image upload anywhere in the product, so identity art is
computed: `gradient = PALETTES[hash(key) % 8]`, `angle = hash(\`${key}-angle\`) % 360`,
`initial = (displayName || username)[0].toUpperCase()`. **Guests short-circuit before any of
this** and get a plain outline glyph, because *the generated avatar is an identity, and a guest
does not have one yet — a "G" monogram on a coloured field would suggest a person rather than a
placeholder.* `aria-hidden` in both branches; the accessible name always comes from surrounding
text.

**The shell:** skip link → sticky header (`z-50`, `bg-ink/85 backdrop-blur-md`) → `GuestStrip`
→ `VerifyBanner` → `main#main` → footer. **The z-index ladder — five values in the whole app:**
`z-10` feed date headers, `z-50` sticky header, **`z-60` film grain (so grain sits over the
header)**, `z-70` dialog overlay, `z-80` dialog content and dropdowns, `z-90` the focused skip
link.

Header nav: `/albums` Browse, `/artists` Artists, `/lists` Lists, plus `/for-you` **only when
signed in** — *the page is meaningless without ratings.* The footer carries `/spotlight`,
deliberately **not** in the header: *the spotlight is worth finding, but it is not one of the
things somebody opens the app to do.* It also carries the provider attribution Deezer and
MusicBrainz require.

**Metadata:** the root sets `title.template = "%s · Deadwax"`. OpenGraph set once at the root.
Token-bearing and admin pages add `robots: noindex` and `referrer: "no-referrer"`.

### 11.6 Server vs Client boundaries

**The default is Server.** `"use client"` appears only where it must: `app/error.tsx`, the
search box, the account menu, the Radix wrappers, `ProfileTabs`, the star input, the log dialog,
the heatmap source switch, the ad beacon, the preview player, and the optimistic buttons.

Everything else is a Server Component, **including async ones that fetch**: `SiteHeader` is
`async` and calls `currentUser()` directly, so the header re-reads the session on every
navigation rather than hydrating a client auth context.

**The split-component pattern** — a server half that decides whether the thing applies and
counts what it needs, and a client half that owns dismissal and browser events. `GuestStrip`
**always mounts the client banner even when invisible**, because the client half owns the
leaving warning.

**Suspense keeps slow work off the critical path** in two places: the taste-driven home rails
(*the most valuable and the slowest, so they stream in last*) and the artist page's discography
fill (*isolated so their provider fill cannot delay the rest of the page*).

**The constraint that shapes every content page, and the most transferable lesson in the
section** (I-3):

> `load()` resolves the album and nothing slow, because **this function decides the response
> status, and a `notFound()` raised after the shell has flushed would be sent as a 200.**

**Any 404-deciding work must happen before the first Suspense boundary flushes.** Adding a
route-level `loading.tsx` to a content route would turn every 404 into a 200 with not-found UI.

On the other side, `lib/` modules import `server-only` so they can never reach the browser —
with `lib/providers/images.ts` and `lib/listen.ts` deliberately exempt.

### 11.7 Typography

- **Display (Instrument Serif)** — headlines only, never body or UI.
- **Mono (Geist Mono)** — every label and every number: `.eyebrow`, nav links, filter chips,
  badges, tab triggers, pagination, cover year lines, stat-tile values, **track locators and
  durations**. The recurring literal `text-[0.6875rem]` is **11px** — the same size `.eyebrow`
  sets, and why `--color-faint` had to be lifted.
- **Sans (Geist)** — the body default, re-asserted explicitly only on cover titles.

Two tracking values in the whole system: `tracking-wider` (0.05em) on mono UI labels, and
`0.18em` on `.eyebrow`.

---

## 12. Routes

Every route is App Router. **None declares `generateStaticParams`.** Only `/` sets a segment
config (`export const revalidate = 0`).

| Route | Params | Auth | Notes |
| --- | --- | --- | --- |
| `/` | — | mixed | `revalidate = 0`. Signed out: hero + chart/new/top rails + genre rails + recent reviews. Signed in: stat tiles, recent plays, following feed (falling back to global), taste rails in Suspense |
| `/search` | `?q` | public | Empty `q` renders a landing box. Consumes `searchByIp`; over the limit, renders from the local mirror only. Merges local + remote, capped at 36 |
| `/albums` | `?genre &decade &sort &page` | public | `decade` bounded 1900–2200; `sort` whitelisted |
| `/artists` | `?genre &sort &page` | public | |
| `/album/[slug]` | `<title>-<id>` | public | `notFound()` if the slug parse or `ensureAlbum` fails |
| `/album/[slug]/reviews` | `?sort=popular\|recent &page` | public | `PAGE_SIZE = 20`, `scope: "any"` rollup over its tracks |
| `/album/[slug]/track/[track]` | `<n>` or `<disc>-<n>` | public | `parseTrackLocator`, bounded |
| `/artist/[slug]` | `<name>-<id>` | public | The discography heatmap. Discography fill in a Suspense boundary |
| `/artist/[slug]/albums` | `?type &sort` | public | |
| `/artist/[slug]/reviews` | `?sort &page` | public | `scope: "any"` over albums **and** tracks |
| `/list/[slug]` | `<slug>-<id>`; a bare id works | public | **Private-list 404 duplicated in `generateMetadata` and the body** |
| `/list/[slug]/edit` | | owner only | **New** — rename/describe/reorder (brief defect #8) |
| `/lists` | `?sort=popular\|recent` | public | |
| `/log/[id]` | | public | **New** — the comment thread on a log (brief defect #2) |
| `/members` | — | public | Top 24, **one batched stats query** (brief defect #3) |
| `/spotlight` | — | public | Indie ads; deliberately indexable, footer-linked only |
| `/start` | — | **guest-gated** | **Fixed**: the original has no auth guard, so a signed-out visitor loads it and every star click fails. Here it creates a guest session or redirects |
| `/@[username]` | `@name`, 3–24 chars | public | Ten queries in one `Promise.all` |
| `/@[username]/diary` | `?year &page` | public | `PAGE_SIZE = 50`; the only place a log delete control exists |
| `/@[username]/albums` | `?sort=recent\|rating\|name\|replays` | public | |
| `/@[username]/wantlist` | — | public **unless private** | `wantlist_private` checked in **both** `generateMetadata` and the body |
| `/@[username]/lists` | — | public | `isSelf` is the entire privacy switch |
| `/@[username]/network` | `?tab=following` | public | Not a profile tab — reached from the follower counters |
| `/@[username]/year/[year]` | year bounded **1900**–2200 | public | Floor matches the diary's, unlike the original |
| `/for-you` | — | **redirect** `/login` | |
| `/settings` | — | **redirect** `/login` | |
| `/verify` | `?token` | **redirect** `/login?next=/verify` | `noindex`, `no-referrer`. Confirmation is a button press. **`next` is honoured** (brief defect #7) |
| `/login` `/signup` | `?next` | redirect **non-guest** members | Guests must reach these to convert |
| `/forgot` `/reset` | `?token` | public | `noindex`, `no-referrer` |
| `/admin` `/admin/ads` | `?q &page` | **404** for non-admins | `noindex`, `no-referrer` |
| `POST /api/ads/impression` | JSON | none | same-origin → 403; `adEventByIp` → 429; bad JSON/id → 400 |
| `GET /api/ads/[id]/click` | path id | none | redirects even when throttled |
| `GET /api/cron/prune` | — | `CRON_SECRET` bearer | **New** (brief defect #10) |
| `/api/auth/[...nextauth]` | — | — | `export const { GET, POST } = handlers` |

---

## 13. Infrastructure

### 13.1 Scripts

| Script | Command |
| --- | --- |
| `dev` | `next dev` |
| `build` | `tsx scripts/migrate-deploy.ts && next build` — **migrations first**; `&&` aborts the build on failure |
| `lint` | `eslint --max-warnings 0` — **tightened**; the original's bare `eslint` lets warnings through CI |
| `typecheck` | `tsc --noEmit` |
| `test` | `vitest run` |
| `db:generate` / `db:migrate` / `db:studio` / `db:deploy` | drizzle-kit + the deploy runner |
| `db:local` | `tsx --env-file=.env.local --conditions=react-server scripts/db-local.ts` |
| `db:reset` | **honours `PGLITE_DATA_DIR`** (the original hardcodes the path) |
| `seed` / `smoke` / `taste-eval` / `security:probe` / `admin:grant` | same `tsx --env-file --conditions=react-server` prefix |
| `security:audit` | `npm audit --omit=dev --audit-level=high` |

**Two flags matter.** `--env-file=.env.local` loads real env without dotenv in the script.
**`--conditions=react-server` is what makes the `server-only` package resolve to its no-op
export instead of throwing**, so a plain Node script can import the query layer — the CLI
equivalent of `resolve.conditions` in the Vitest config.

### 13.2 Migrations — four runners, one folder

`./drizzle` is the single source of truth for **both** drivers.

- **Generation** — `drizzle-kit generate`, `strict: true`.
- **Local** — `scripts/db-local.ts` **refuses to run when `DATABASE_URL` is set** (`exit 1`),
  opens PGlite directly, runs the pglite migrator, then **prints the resulting
  `information_schema` table list** so the operator sees the schema actually landed rather than
  trusting a success message.
- **Production, automatic** — `scripts/migrate-deploy.ts` runs inside `npm run build`, because
  *the alternative is a manual step somebody has to remember between merging a schema change and
  the deploy that queries it — and the failure mode of forgetting is every signed-in page
  returning 500 against a table that does not exist yet.* A failure exits 1 and fails the build
  on purpose: *a deploy whose schema did not land is worse than no deploy.*
- **Tests** — each DB-backed suite creates a throwaway PGlite store in a temp dir and runs the
  same migrator.

**Migrations are never squashed.** Each intermediate state is what a test was written against.

### 13.3 Tests

**Two kinds.** Pure suites (`ratings`, `mappers`, `slug`, `bounds`, `listen`, `ads-plan`,
`canonical`) import only pure modules and touch nothing. Integration suites (`security`,
`guest`, `ads`, `desert-island`, `password-reset`, `taste`, `aggregates`, `no-escalation`) each
create **their own throwaway Postgres**:

```ts
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "deadwax-sec-"));
  process.env.PGLITE_DATA_DIR = dataDir;
  delete process.env.DATABASE_URL;                       // ← non-negotiable
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

**Every import is dynamic** because the connection is chosen at import time from the
environment (I-37). A top-level `import { db }` in these files binds the wrong database.

**Related trap:** Vitest loads `.env.local` into `process.env`. If a developer has
`DATABASE_URL` there, `npm test` would point at **real Postgres** were it not for the explicit
`delete`. **Never remove that line.**

**Three aliases make server-only code importable:** `server-only` → a no-op stub (*that guard is
exactly right in the app and unhelpful in a Node test runner*); `next/cache` → three no-ops with
matching signatures (*outside a Next request that module cannot resolve*); and `next/server` →
**the real module**, because Auth.js imports it internally and *the authorization path under
test should be the genuine one.*

**The session seam.** `tests/security.test.ts` mocks **exactly one module** — `@/lib/auth`'s
`auth()` — driven by `signInAs(user | null)`, with `beforeEach(() => signInAs(null))` *so a test
that needs a session has to say so.* **Everything below that seam is genuine**, including the
database-resolved admin role.

**Vitest config, every setting with its reason:** `environment: "node"`; `testTimeout: 60_000` /
`hookTimeout: 120_000` (*the security suite drives a real database and bcrypt*);
**`fileParallelism: false`** — *PGlite is a WebAssembly Postgres and reserves a sizeable heap;
parallel workers each starting one exhausted memory and surfaced as "Array buffer allocation
failed" during migration, **which reads like a database bug rather than a resource limit***
(I-38); and `resolve.conditions: ["react-server", "node", "import"]`.

**One test-authoring lesson stolen verbatim:** the window-reset test ages the row with
`UPDATE rate_limits SET window_start = now() - make_interval(secs => 600)` rather than sleeping,
because *an earlier version relied on the clock advancing between two statements and passed
locally while failing on a faster machine where both statements saw the same `now()`.*

### 13.4 CI — three parallel jobs, read-only, no secrets

`permissions: contents: read` and **no repository secrets anywhere**, which is what makes it
safe on pull requests from forks. `concurrency` cancels the previous run on the same ref.

1. **`verify`** — `npm ci --ignore-scripts`, then **`npm rebuild esbuild`** (*esbuild ships a
   platform binary via a postinstall step, which `--ignore-scripts` skips; Vitest needs it, so
   allow just that one*), then `typecheck`, `lint`, `test`, `build`. **Deadwax needs no
   placeholder provider token** — the build contacts nothing and the catalogue needs no
   credential. Only `AUTH_SECRET` is passed, as a placeholder. No `DATABASE_URL`, so the migrate
   step inside `build` no-ops.
2. **`dependencies`** — `npm audit --omit=dev --audit-level=high` (**blocking**). *Runtime
   dependencies are what ship.*
3. **`secrets`** — gitleaks with `fetch-depth: 0`: *full history, so a credential committed and
   later removed is still caught — deleting a secret from HEAD does not unpublish it.*

### 13.5 Environment

`lib/env.ts`: one private `required(name)` helper that **rejects the empty string as well as
undefined**, and an object of **getters** — *getters so nothing is evaluated at import (which
would break `next build`); **throwing** so a missing value cannot silently degrade; and a
message that names both the local and the hosted fix.*

**Plus a startup validation pass**, which the original lacks: `assertEnv()` runs once from
`instrumentation.ts` and fails at boot rather than on the first request that needs a value.

| Variable | Required | Default | Consequence if absent |
| --- | --- | --- | --- |
| `DATABASE_URL` | no | — | **Unset = PGlite at `./.pglite`.** Also makes the build-time migration a no-op |
| `AUTH_SECRET` | **yes** | — | Read by Auth.js itself |
| `REQUIRE_EMAIL_VERIFICATION` | no | `false` | strict `=== "true"`, so `"1"`/`"yes"` read as false |
| `RESEND_API_KEY` / `EMAIL_FROM` | no | — | absent ⇒ mail is written to the server log and reported `delivered: true, via: "log"` |
| `NEXT_PUBLIC_SITE_URL` | no | `AUTH_URL` → Vercel vars → `http://localhost:3000` | base for email links, and **the MusicBrainz `User-Agent` contact string** |
| `LASTFM_API_KEY` | no | — | absent ⇒ the familiarity heuristic falls back to Deezer `fans`, and the second neighbour source is skipped |
| `CRON_SECRET` | no | — | absent ⇒ `/api/cron/prune` 404s rather than running unauthenticated |
| `PGLITE_DATA_DIR` | no | `./.pglite` | honoured by `db:reset`, unlike the original |

**No provider credential of any kind is required.**

### 13.6 Seed and smoke

**The seed** seeds a demo community so a fresh deployment is not an empty room. **Idempotent**:
members keyed by email, logs by (member, target). It pulls real catalogue data **through the
normal ingest path**.

Six members with written personalities, **twenty albums worth having ratings on — a mix of
eras, genres and shapes** — and **deliberate overlaps** so aggregates have more than one vote.
Members arrive `emailVerifiedAt: new Date()` because *posting requires a verified address, and
these addresses do not exist to receive a link.*

**Listen dates walk backwards from today** via a module-level cursor, *so the diary and year
charts have shape.* **Track ratings get deterministic ±1 jitter:**

```ts
drift = ((track.trackNumber * 7 + album.id * 3) % 3) - 1;   // exactly {-1, 0, +1}
rating = Math.min(10, Math.max(1, base + drift));
```

*So the heatmap has texture rather than one flat colour.* **Deterministic, not random** —
re-seeding produces identical texture, so screenshots are stable.

**Idempotency uses five different keys** — members by email, album-logs by
`(userId, albumId, 'album')`, track-logs by the full tuple, favourites by `onConflictDoUpdate`
on `(userId, position)`, lists by `lower(title)`, items and follows by `onConflictDoNothing`.
**Break any one and a second run duplicates data.**

**The smoke test is the single highest-value script in the repo for a dual-driver
architecture:**

> Most aggregates are raw SQL run through `db.execute`, whose result shape must be identical on
> both drivers. **If it ever differs, every one of those reads would silently return empty and
> the interface would look merely quiet rather than broken** — so this asserts real rows come
> back rather than printing them.

Twenty-five checks covering profile stats, rating stats, **that the histogram bucket counts sum
to the rating count**, track and album aggregates, viewer state, in-progress discographies,
completed albums, genre breakdown, logged years, **that `review.monthly.length === 12`**,
platform comparison, diary, both feeds, reviews, most-rated, local ILIKE search, top four,
public lists, list options, active members, **the discography heatmap payload**, and **that
`critic_score` is on the 0–10 scale** (the scale-bridge assertion).

It bails with *"Seed data missing: run `npm run seed` first."*

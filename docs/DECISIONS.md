# Deadwax — Decision Record

**What this is.** The answers to every question §20 of `ARCHITECTURE_AND_REPLICATION_BRIEF.md`
says must be settled *before writing any code*, plus the reasoning and the rejected
alternative for each. The brief's own porting notes are the input; this file is the output.

**Product.** **Deadwax** — a social diary for records. (The deadwax is the blank run-out
groove at the end of a record side, where the mastering engineer scratches a private
signature. A diary of personal verdicts on records is the same gesture.)

**Read order.** This file, then `ARCHITECTURE.md` (the system as it will be built), then
`PLAN.md` (phases), then `TASKS.md` (the executable checklist).

---

## 0. Why not the obvious providers

The brief's worked example assumes Spotify or MusicBrainz. A third option was requested
(YouTube Music) and a fourth was found to be better than any of them. All four were
evaluated by actually calling them, not by reading documentation.

| Provider | Verdict | Evidence |
| --- | --- | --- |
| **YouTube Music** | **Rejected as a catalogue.** Adopted for listen links. | No official metadata API exists. The YouTube Data API v3 is the only sanctioned surface: a `search.list` call costs 100 quota units against a 10,000/day default, i.e. **~100 searches per day for the entire platform** — two orders of magnitude short of a cache-through ingest. The community `ytmusicapi` is a reverse-engineered Python client (wrong runtime, unsanctioned, and unstable under ToS). It also returns no release-group identity, no rating, no vote count, and no similarity graph. |
| **Spotify** | **Rejected.** | Requires an OAuth2 client-credentials token that expires hourly (a whole failure class the TV version does not have), returns `popularity` 0–100 with **no vote count** so the consensus card could only be built by relabelling popularity as quality, and **deprecated `related-artists` and `/recommendations` for new applications in November 2024** — which removes the neighbour term, the single largest term in the recommender. |
| **Deezer** | **Adopted as primary.** | **No API key and no OAuth at all.** `GET /album/{id}` returns the album *and its complete tracklist* in one request, with `disk_number`, `track_position`, `duration`, `rank`, `isrc`, `explicit_lyrics` and a 30-second `preview` mp3 per track, plus `record_type` (album/single/ep/compilation), `label`, `upc`, `genres`, `fans`, `release_date` and `cover_xl` at 1000×1000. `GET /artist/{id}/related` **exists and works** — verified returning Justice, etc. for Daft Punk. `GET /chart/0/albums` and `/chart/{genreId}/albums` give discovery. ~50 req/5s. |
| **MusicBrainz** | **Adopted as optional enrichment.** | Verified returning `rating: {value: 4.5, votes-count: 72}` for Kid A — **a real score with a real count**, which is what makes the consensus card honest rather than decorative. Also `first-release-date` (fixes the reissue trap), `secondary-types` (the "specials" exclusion), fine-grained `tags` with counts, and artist `country`. But **1 request in 3 answered `"The MusicBrainz web server is currently busy"`** during probing. It is therefore never on a critical path. |
| **Cover Art Archive** | **Adopted as art fallback.** | `front-500` returns 200 but **302-redirects to `dn710905.ca.archive.org`** — a wildcard archive.org subdomain. Both origins must appear in `img-src` and `remotePatterns`, exactly as the brief warned. |
| **Last.fm** | **Adopted as optional, env-gated.** | `LASTFM_API_KEY` unlocks `listeners`/`playcount` (a better familiarity proxy than streaming popularity, and the true equivalent of TMDB's `vote_count` for onboarding) and `artist.getSimilar` as a second neighbour source. Absent ⇒ the features degrade to absent, never to wrong. |

**The single most consequential consequence of this stack: it needs no secrets.** `TMDB_READ_TOKEN`
was a required variable in the original; Deadwax's catalogue works on a cold deployment with
nothing configured but a database. That is a genuine improvement in portability, and it is
why a deployed instance can be verified end to end rather than merely built.

**Where YouTube Music ends up.** The brief's `watch_providers` port. Deezer supplies a
canonical `link` per album and track; YouTube Music, Spotify, Apple Music and Tidal each
accept a deterministic search deeplink built from `artist + title` with **zero API calls**:

```
https://music.youtube.com/search?q=<artist>+<title>
```

This is strictly better than mirroring an availability table: nothing to sync, nothing to go
stale, no extra ingest fan-out, and no per-region `market` parameter threading. **The
`watch_providers` table is therefore deliberately not ported** — see §7 below.

---

## 1. The five decisions (§20.1)

### Decision 1 — How many tiers, and which are loggable?

**Answer: three tiers — artist / album / track — and all three are loggable, with `album`
as the default scope.**

The brief's own suggestion was two loggable tiers (album + track, artist as a routed but
non-loggable container). That is rejected for three reasons:

1. §20.3 identifies **"the artist as a repeated author"** as a third pillar available to
   music and not to television. A tier that carries a product pillar should be a
   first-class rateable object; otherwise the pillar has no data behind it.
2. The dual-rating feature (§5.6) is the most valuable transplant in the brief. With three
   tiers it applies **twice**: album verdict vs. mean of its tracks, *and* artist verdict
   vs. mean of their albums. The second is the career-arc statement that has no clean TV
   equivalent — exactly the thing §20.3 says gets stronger in music.
3. The polymorphic log table already supports it at zero marginal schema cost. Refusing the
   tier would mean writing *more* special-casing, not less.

**MusicBrainz's fourth tier is collapsed**, as the brief instructs: release-group and
release become one `albums` row. The release-group is the identity (`albums.mbid` holds the
**release-group** MBID); a specific pressing is not modelled. Deezer's album id is the
primary external key because it is what resolves the tracklist.

**Direction flip, handled.** In Cliffhanger `show_id` is always present and the ordinals
narrow it. Here `artist_id` is the always-present anchor, `album_id` narrows it, and
`(disc_number, track_number)` narrow that. So:

```ts
targetTypeOf(input) =
  input.trackNumber !== undefined ? "track"
  : input.albumId   !== undefined ? "album"
  :                                 "artist";
```

`artist_id` is **never accepted from the client on an album or track log** — the server
resolves it from the `albums` row. That closes a whole class of "log a track against the
wrong artist" forgery that would otherwise need its own check.

### Decision 2 — Integer surrogate keys, or external string ids?

**Answer: local `serial` primary keys, with the external id as a `text NOT NULL UNIQUE`
secondary column.** This is the brief's recommendation and it is taken unchanged.

- Every FK stays an `integer`, so the 24-FK cascade graph ports verbatim.
- URLs keep the bounded-integer parsing the original audit added (SEC-06), so
  `/album/kid-a-9999999999` is a 404 and not a 500.
- Provider coupling is localised to one column per table, which is what makes the
  Last.fm/MusicBrainz enrichment columns additive rather than invasive.
- It also sidesteps a live hazard: Deezer album ids already reach ten digits
  (`1075809082` observed in the chart response) and are climbing toward the int4 ceiling of
  2,147,483,647. `text` external ids have no ceiling; `serial` internal ids are ours.

Rejected: `uuid`/`text` primary keys throughout. Nine FK columns, the slug parser and every
bounds check would change, and it does not even eliminate the 500-instead-of-404 class — a
malformed UUID raises `invalid input syntax for type uuid`, which is the same 500 wearing a
different hat.

### Decision 3 — What is the "shape" visualisation?

**Answer: both, with the discography grid as the signature view.**

- **`DiscographyHeatmap`** on the artist page — **one row per album** (chronological,
  replacing seasons), **one cell per track** (replacing episode numbers). This draws a
  career arc: the sophomore slump, the late return to form. It is the true analogue of
  "the shape of the run" and it is the product's thesis feature.
- **`TrackStrip`** on the album page — one row of 10–14 cells. The brief correctly calls
  this weak on its own; as a compact strip beside the tracklist it is still the fastest way
  to read an album's internal curve.

Two consequences the brief flags and this build accepts:

- **Rows are raggeder than in TV.** A 22-track double LP beside a 4-track EP has no
  equivalent in a series whose seasons are roughly uniform. Rows stay ragged (no padding to
  the widest) because padding would imply tracks that do not exist.
- **The row gutter grows** from a 2rem `S3` to an album title. It becomes a fixed
  `10rem` truncating label with the year in mono, and the grid keeps its own horizontal
  scroll.

### Decision 4 — Where does the crowd baseline come from, and is it a rating at all?

**Answer: MusicBrainz ratings, on a real `(score, count)` pair, normalised to the stored
0–10 scale at the mapper boundary — and the column is hidden rather than faked when the
count is zero.**

This was the question most likely to end in dishonesty, and probing settled it: MusicBrainz
returns `{value: 4.5, votes-count: 72}`. That is a genuine average with a genuine
denominator, which is the only thing the consensus card (§5.4) and `reliableAverage` (§7.2)
actually require.

**The scale bridge — the brief calls this "the single sharpest hazard in the port".** It is
neutralised by normalising *once, at the mapper*, and never again:

```ts
// lib/providers/musicbrainz/mappers.ts
// MusicBrainz rates 0..5. Everything downstream of this line — the consensus card,
// reliableAverage, the heatmap's `critic` source, <Stars> — speaks the stored 0..10 scale.
// Normalising here rather than at each call site is what keeps the two scales from meeting.
export const mbRatingToStored = (value: number) => Math.round(value * 2 * 10) / 10;
```

Pinned by `tests/ratings.test.ts`: `mbRatingToStored(4.5) === 9` and
`criticToStars(9) === 4.5`. A test asserts the member average and the critic score render
the same width in `<Stars>` for the same stored number.

**When `critic_votes === 0` the column is not rendered at all** — not greyed, not
zero-filled. The `label` override prop carries the honesty where a partial answer exists
(an artist has no artist-level MusicBrainz rating, so the artist page passes
`label="MusicBrainz album average"` over a mean of that artist's rated albums).

**Deezer `rank` and `fans` are popularity, and are never displayed as a rating.** They feed
retrieval, the notability floor and the onboarding familiarity heuristic only. Where
popularity is surfaced to a member it is a labelled meter reading "Deezer popularity", never
stars. This is the brief's instruction verbatim: *do not relabel popularity as quality.*

`LOW_CONFIDENCE_THRESHOLD = 5` transfers unchanged.

### Decision 5 — Is there a neighbour graph?

**Answer: yes — Deezer `/artist/{id}/related`, cached in an `artist_similar` table, with
Last.fm `artist.getSimilar` as an optional second source.**

Verified working. This is the term the brief calls "the largest single term" and "the reason
ranking works at all", and its absence was the top porting risk. Two design notes:

- **It is artist-level**, so neighbour provenance is per-artist rather than per-album. The
  reason string becomes `"Listeners of ${artist} tend to play this too"`.
- **It is cached in a table**, which the TV version does not do. At 1 req/s for MusicBrainz
  and 50 req/5s for Deezer, re-fetching the neighbour set on every `/for-you` render would
  dominate the request budget. Caching it also makes the recommender's retrieval stage a
  pure SQL join in the warm case, which is what allows `DETAIL_SYNC_LIMIT` to stay useful.

### Decision 6 (the cheap one the brief insists on) — guest mode timing

**Guest mode is built in Phase 7, before email verification and password reset in Phase 8.**
The brief's migration history shows guest mode landing *after* both, which is why both
needed guest special-cases retrofitted and why one shipped as a production bug (a banner
asking a guest to confirm `guest_46ee4182c3@guest.invalid`). Building it first costs nothing
and removes that whole class.

Every table a guest can write is enumerated explicitly in the merge transaction (I-36), and
`desert_island` — the table the original forgot — is **in** the list. See
`ARCHITECTURE.md` §9.3.

---

## 2. The pillars, re-justified (§20.3)

| Cliffhanger pillar | Survives? | Deadwax |
| --- | --- | --- |
| **Progress** — a member is partway through a show | **No.** Nobody is partway through a 42-minute album. | **Replaced by REPLAY.** How many times, and when. `is_rewatch` becomes `is_replay` and carries a *stronger* signal in music than in TV: relistening is the norm, not the exception. The profile surfaces a **replay count** and a "most played" ranking; the poster overlay becomes a replay badge (`×4`) instead of a progress bar. |
| — | — | **And by DISCOGRAPHY COMPLETION** at the artist level, which is where a completion denominator still means something: *"9 of 11 studio albums"*, with the non-canonical exclusion doing the work `season_number > 0` used to do. |
| **Shape** — the quality curve across a run | **Yes, and stronger.** | Twice: the track curve within an album, and the career arc across a discography (Decision 3). The second has no clean TV equivalent. |
| **Attributed consensus** — two numbers, never merged | **Yes, verbatim.** | MusicBrainz beside member, never averaged (Decision 4). |
| — | — | **New third pillar: the artist as a repeated author.** A show is not made repeatedly by one named person; an artist makes albums. This makes **artist affinity a legitimate second attribute axis in the recommender**, replacing the network axis — and the brief judges it "arguably a stronger music signal than a label affinity". |

**Consequence for the recommender's second axis.** The brief offers label-or-artist. Labels
are taken as a *third*, weak axis (Deezer returns `label` as free text with the wild
variation the brief predicted — `"Daft Life Ltd./ADA France"` observed — so it is normalised
and used only when it survives normalisation), and **artist is the second axis**. Weights
become genre 0.55 / artist 0.30 / label 0.15. See `ARCHITECTURE.md` §6.

---

## 3. Every retuned constant, and why

All arithmetic stays in **stored units: 1 unit = half a star**. The brief's warning is taken
literally — these are rescaled *together*.

| Constant | Cliffhanger | Deadwax | Reason |
| --- | --- | --- | --- |
| `MIN_RATING` / `MAX_RATING` | 1 / 10 | **unchanged** | integers so bucketing never touches floats |
| `LOW_CONFIDENCE_THRESHOLD` | 5 | **unchanged** | transfers cleanly |
| Bracket minima | 0/4/5.5/6.5/7.5/8.5/9.25 | **unchanged**, top band renamed | The seriesgraph recognisability argument evaporates outside TV, but the two properties the tests enforce — adjacent brackets differ in **hue**, shade varies **within** a bracket — are worth more than novelty. Top band `cinema` → **`desertIsland`**, label "Desert Island". |
| `--color-cinema` | `#57a3ff` | `--color-desert` `#57a3ff` | Same hex, same "two literals, one comment" binding to the top bracket. |
| Album detail TTL | 12h (`detail`) | **30 days** | A tracklist is immutable once released. The brief: the "cannot change once finished" rule is *stronger* for music. |
| Artist detail TTL | — | **24h** | So new releases appear in a discography. |
| Discovery TTL | 3h | **6h** | Charts move more slowly than "what aired this week". |
| Search TTL | 10m | **unchanged** | |
| MusicBrainz TTL | — | **30 days** | Ratings and tags accrete slowly; the endpoint is flaky, so cache hard. |
| `RUNNING_TTL` / `FINISHED_TTL` | 1d / 7d | **artist 1d if active, 14d otherwise** | An artist with a release in the last 18 months is "active". Replaces `in_production`. |
| `TMDB_PAGE_SIZE` stitching | 20→24 | **deleted** | Deezer accepts an arbitrary `limit`, so requesting `limit=25, index=offset` makes `windowBounds`/`maxWindowPage` unnecessary. The brief names this as "the simplest port". `GRID_PAGE_SIZE = 24` and the `% {3,4,6} === 0` test both stay. |
| `MAX_DB_INT` | 2,147,483,647 | **unchanged**, declared **once** | The original declares it twice; that is a defect, not a feature. |
| `SEASON_MAX` / `EPISODE_MAX` | 10,000 / 100,000 | `DISC_MAX = 50` / `TRACK_MAX = 500` | Min becomes **0**, not 1 — a pregap/hidden track is legitimately numbered 0. |
| `calendarDate` floor | 1930-01-01 "That is before television." | **1900-01-01** "That is before recorded music." | |
| `contains_spoilers` | boolean + toggle + blur branch | **deleted** | No music equivalent. Column, toggle, `LogEntry` field and the reveal branch all go. |
| `GUEST_REVIEW_CAP` | 3 | **unchanged** | "the wall arrives while they still care about the fourth" is domain-free. |
| `GUEST_NUDGE_AFTER` | 12 log rows | **12 distinct albums touched** | 12 *track* logs is one album, so the row count is the wrong unit. Counting `COUNT(DISTINCT album_id)` keeps the intent ("roughly a session of onboarding") with the right denominator. The leaving warning still fires from the **first** entry. |
| `ABSOLUTE_CINEMA_QUOTA` | 10 | `DESERT_ISLAND_QUOTA = 10` | Kept. A heavy listener has more rated tracks than a viewer has rated episodes, which argues for fewer, not more — but ten is the number a person can hold in their head, and that is the stated reason. Feature renamed **Desert Island**. |
| `MIN_RATED_SHOWS` | 5 | `MIN_RATED_ALBUMS = 8` | Rating an album is far lower-effort than rating a 60-hour series; listeners rate 20 in a sitting, and the extra evidence buys confidence directly. |
| genre-rail / ad-affinity floor | 3 | **5** | The original's 3-vs-5 inconsistency means a member with 4 ratings sees personalised rails while being told there is "not enough to go on". Aligning them at 5 removes a contradiction the brief calls out. |
| no-variety gate | `spread < 0.4` | **unchanged** | |
| `SHRINKAGE` | 3 | **5** | MusicBrainz tag vocabularies are noisy — 60+ tags observed on one album, many with `count: 1`. Tags are also pre-filtered to `count >= 2` before they become attributes. |
| deviation cap | ±2 | **unchanged** | The mean-near-7 asymmetry is a property of the 1–10 scale, not of television. |
| attribute weights | genre .7 / network .3 | **genre .55 / artist .30 / label .15** | See §2. |
| coverage denominator | 4 | **6** | Deezer album genres are coarse (1–3 per album from a 28-entry vocabulary) but MusicBrainz tags are fine. 6 saturates on a well-described album without saturating on everything. |
| neighbour term | 0.3 + enthusiasm × 0.35 | **unchanged** | |
| absence penalties | 0.8×ev; min(0.6, lean×0.4)×ev | **unchanged, but gated on coarse genres** | The brief: the "shares nothing at all" penalty never fires once `seenTags` holds hundreds of entries. It is computed against the **Deezer coarse-genre projection only**, never the fine tag set. |
| country penalty | 0.5 flat | **0.25** | Music is far less language-gated than television. |
| era penalty | `min(0.6, (gap − 15) / 40)` | **`min(0.6, (gap − 8) / 25)`** | 1968, 1983 and 1998 are different sonic worlds; a 15-year dead zone erases that. |
| length penalty | `min(0.45, (gap − 15) / 60)` on median **episode** minutes | **`min(0.45, (gap − 1.5) / 6)`** on mean **track** minutes | The purpose is format separation within a shared tag: a 3-minute pop single vs. a 9-minute post-rock piece vs. a 60-second hardcore track. A 15-*minute* dead zone is meaningless on a 1–12 minute range. |
| track-count signal | — | **new**: `min(0.3, (gap − 6) / 20)` on track count | EP vs. double LP. A TV-less signal the brief suggests adding. |
| `CONSENSUS_PRIOR` / `_WEIGHT` | 7 / 400 | **7 / 40** | The prior is the middle of the same 0–10 scale, so 7 stands. The weight must bite at *typical n*, and MusicBrainz vote counts are two orders of magnitude below TMDB's — 72 votes on Kid A, not 20,000. 400 would shrink every album to exactly 7. |
| `MIN_NOTABILITY_VOTES` | 150 | **`MIN_NOTABILITY_FANS = 5000`** (Deezer album `fans`) | MusicBrainz vote counts are too sparse to be a notability floor. Deezer `fans` is dense and is a notability signal, not a quality one — which is the role the constant plays. |
| `DETAIL_SYNC_LIMIT` | 18 parallel | **8, serialised** | 18 parallel `ensureAlbum` calls would violate the provider budget outright (the brief flags this for MusicBrainz specifically). Serialised, and lower, because the cached `artist_similar` table removes most of the need. |
| `RUN_THRESHOLD` | 3 | **5** | An album is 10–14 tracks in 40 minutes, so a listener generates runs constantly; 3 would collapse nearly every session into one row. |
| `INDIE_EVERY` / `MAX_ADS_PER_PAGE` | 3 / 2 | **unchanged** | |
| `PASSWORD_MAX_BYTES`, bcrypt cost, session ages, token TTLs, all 13 rate budgets | — | **unchanged** | Domain-free; copied with their numbers. |
| outbound budget | `tmdb:global` 600/60s | **`deezer:global` 400/60s** and **`musicbrainz:global` 45/60s** | Deezer's ~50 req/5s is 600/60s; 400 leaves headroom for the fixed-window 2× burst the limiter admits. MusicBrainz's ~1 req/s is 60/60s; 45 plus a serialising queue keeps us inside it. |

---

## 4. The specials problem (§20.7 q8)

TV's non-canonical items are season 0, detectable by `season_number > 0`. Music has no
numeric sentinel, and the brief warns this is *harder*. Deadwax derives one boolean at
ingest and copy-pastes the same comment next to every query that needs it:

```ts
// albums.is_canonical — the "specials" exclusion. A non-canonical release must never
// enter a completion denominator, a discography heatmap row, or a recommendation pool.
// Copy this comment next to any new query that filters on it; the TV version's
// `season_number > 0` was copy-pasted into three CTEs precisely because it is easy to
// omit in a fourth.
isCanonical =
     recordType === "album"                       // Deezer: not single/ep/compilation
  && !secondaryTypes.some(t => NON_CANONICAL.has(t))  // MB: Live, Remix, Soundtrack, DJ-mix, Demo, Compilation, Interview, Audiobook, Spokenword, Mixtape/Street
  && !TITLE_NOISE.test(title);                    // (Deluxe|Remaster|Anniversary|Expanded|Bonus|Live at|Karaoke|Instrumental)
```

The title check is a last resort, applied only when MusicBrainz has not been reached, and it
is unit-tested against a fixture list of real titles in both directions.

**Two corrections were forced by running it against the real catalogue rather than reasoning
about it**, and both are worth recording because the first version was defensible in the
abstract and wrong in practice:

1. **Position is the wrong thing to anchor on.** The first version was one regex requiring the
   noise word to follow the bracket immediately, which let
   `"Nevermind (30th Anniversary Super Deluxe)"` through — the bracket opens on `"30th"`, not
   on `"Anniversary"`. Real-world qualifiers routinely lead with an ordinal or a year, so the
   check now extracts every bracketed group and dash-tail and tests their **contents**.
2. **"Remastered" is not noise.** The first version rejected it. Resolving a curated list of
   forty canonical records against the live API showed why that is wrong: **the only edition
   Deezer stocks of Nevermind, Abbey Road, London Calling, Trans-Europe Express and Daydream
   Nation is the remaster.** A remaster of a studio album *is* the studio album — same work,
   same tracklist, same running order — so rejecting it does not exclude a duplicate, it
   excludes **the album**, and the artist's discography grid loses a row it should have.

   The rule is therefore narrowed to releases that are **a different kind of thing** from the
   studio album: live recordings, compilations, karaoke and instrumental versions, demos
   collections, tributes, and boxes that pad the tracklist far past the record
   (`Super Deluxe`, `Box Set`, `The Complete …`) — because those genuinely do corrupt a
   completion denominator and genuinely do put a 65-cell row next to a 10-cell one.

   **Duplicate editions are not this function's job.** They are handled at dedup time by
   `albumIdentity()`, which is the right split: canonicality asks *"is this a studio album?"*,
   deduplication asks *"have we already got this one?"*

A third class needed its own check: titles that are non-canonical **as whole titles**, with no
bracket to look inside — `"Greatest Hits"`, `"MTV Unplugged in New York"`,
`"The Complete Recordings"`. And one asymmetry is deliberate: a **bare** `(Live)` qualifier is
enough to disqualify a release, while the whole-title rule requires a preposition
(`Live at …`), so that `"Live Through This"` survives.

**Deduplication must get stricter, not merely renamed** (brief §7). The same album exists as
original / remaster / deluxe / 2CD / Japanese pressing, with different titles *and* different
years, so title+year would dedupe almost nothing:

```ts
albumIdentity(album) =
  album.mbid                                   // release-group MBID — authoritative
  ?? `${normalise(album.artistName)}::${normalise(stripSuffixes(album.title))}`;
// stripSuffixes removes bracketed/parenthesised trailing qualifiers and a trailing
// " - Remaster"/" Deluxe Edition" tail before comparison.
```

And the recommender **excludes every album sharing an identity with anything already
logged**, or the list fills with remasters of records the listener already rated.

---

## 5. Departures from the brief (things deliberately not copied)

The brief's §20.6 lists ten known defects in the shipped TV code and says a rebuild should
not inherit them. All ten are fixed here, plus the three "wrong but harmless" ones.

| # | Defect | Fix in Deadwax |
| --- | --- | --- |
| 1 | The episode detail page mounts `LogDialog` with no `initial` prop, reopening the SEC-01 data-loss shape | `LogDialog`'s `initial` prop is **required, not optional** — the type makes the omission a compile error rather than a silent data loss. |
| 2 | Nothing renders a comment thread on a log, so every review card's comment count is always 0 | A real `/log/[id]` route renders the thread. The count is then true. |
| 3 | The members directory runs 24 heavy aggregate queries for two numbers per card | One batched `getMemberCardStats(ids[])` returning a Map. |
| 4 | The profile runs `getProfileStats` twice per view because `db.execute` is not React-cached | Wrapped in React `cache()`, like `ensureAlbum`. |
| 5 | `markShowWatched` re-enters `guard()` per season, burning N+1 tokens and silently discarding mid-loop failures | `markDiscographyListened` does the whole loop inside **one** `guard()`, against internal un-guarded helpers, and reports partial failure instead of swallowing it. |
| 6 | Sign-in rate limits live in the Server Action, so a direct POST to the credentials callback reaches bcrypt with no budget consumed | Both budgets are consumed **inside `authorize`**, before the bcrypt compare. |
| 7 | `/login?next=…` is a dead parameter | Implemented, with an allowlist (`^/[A-Za-z0-9/@._-]*$` and no `//`) so it cannot become an open redirect. |
| 8 | `reorderList`, `updateList`, `clearFavorite` have no callers | A list edit surface exists: rename/describe, reorder (up/down buttons — keyboard-operable, no drag dependency), and clear a favourite slot. |
| 9 | The watchlist has no privacy flag | `users.wantlist_private boolean` (one column, one check, duplicated into `generateMetadata` per I-15). |
| 10 | Nothing prunes `rate_limits`, orphaned likes/comments, or abandoned guest rows | `GET /api/cron/prune`, bearer-authenticated with `CRON_SECRET`, wired in `vercel.json`. |
| +a | Dead `revalidatePath("/show/${id}")` | Not carried. |
| +b | The year page shows the raw 1–10 scale where everything else shows stars | Shows stars. |
| +c | `dislikedGenres` displays the three *least* disliked genres because it slices a lean-descending array | Slices from the ascending end; a test asserts the sign. |

Two further departures of my own:

- **Timezone debt (brief §6 porting note).** The original computes every date as
  `new Date().toISOString().slice(0,10)` — UTC on both client and server — so a member in
  UTC+13 logs yesterday and a member in UTC−8 can be refused for logging "the future". The
  client sends its local calendar date; the server accepts it only within ±1 day of UTC
  today. `calendarDate`'s upper bound becomes "UTC today + 1 day" for the same reason.
- **`watch_providers` is not ported.** See §0. Replaced by `lib/listen.ts`, a pure module
  producing deterministic deeplinks, plus Deezer's own canonical `link` and its 30-second
  `preview` mp3 (which gives an actual in-app play button — `media-src` is added to the CSP
  for `cdnt-preview.dzcdn.net` and nothing else).

---

## 5a. Findings from measuring rather than reasoning

Each of these changed the code or the documentation, and each was found by running the thing.
They are recorded here because a constant with a number tells you *what*, and a constant with a
measurement tells you whether the number still applies.

| Finding | Consequence |
| --- | --- |
| `GET /album/{id}`'s embedded tracklist **omits `track_position`, `disk_number` and `isrc`** — only `/album/{id}/tracks` has them | Album ingest is two requests, not one. Since `(album, disc, track)` *is* a track's addressable identity and a unique index depends on it, array order is a documented degraded fallback only. |
| MusicBrainz's **search** endpoint returns no `rating`, no `genres` and no `secondary-types`; `inc=` is silently ignored there | Enrichment is a search followed by a lookup. The first version called search only, so it resolved MBIDs and first-release dates correctly — making the reissue fix *appear* to work — while producing a catalogue with `critic_votes = 0` on every row. |
| Collapsing "no such release group" and "the server is busy" into one `null` | Turned a five-minute outage into thirty days of absence: one seeding run stamped a whole 37-album batch during a busy spell. Three outcomes now, and only two may be cached. |
| `/artist/{id}/albums` summaries carry **no `artist` object at all** | A filter requiring one dropped all 38 rows and reported success. Fixing it took the mirror from 37 albums to 189. |
| The only edition of Nevermind, Abbey Road, London Calling, Trans-Europe Express and Daydream Nation the catalogue stocks is **the remaster** | `isCanonicalRelease` no longer treats "(Remastered)" as noise. A remaster of a studio album *is* the studio album. |
| Longest-token label normalisation chose **"ADA France" over "Daft Life"** | ADA is the distributor. First-token plus a distributor stoplist — consistency matters more than being right on any one input, because support only accumulates if one input always maps to one key. |
| MusicBrainz rates **artists** as well as release groups (Radiohead: 4.5 from 80 votes) | `artists.critic_score` exists, so the artist page shows a genuine attributed baseline rather than a mean of its own albums wearing an artist's label. |
| Cover Art Archive **302-redirects to a wildcard `archive.org` subdomain** | Both origins in `img-src` and `remotePatterns`. |
| A shared `DELETE … RETURNING t.id` over `likes` and `comments` | `column t.id does not exist` on the first real call: **`likes` has a composite primary key** (`user_id, target_type, target_id`) and no `id` column at all, while `comments` has a serial. It returns `target_id` now — the one column both are guaranteed to have — and `tests/prune.test.ts` exercises both tables rather than only the one the helper was written against. |
| `scripts/security-probe.ts` reported **every** security header as missing | The probe, not the proxy. Node's `fetch` sends `Accept: */*`, and `proxy.ts`'s matcher requires `text/html` because the header policy is deliberately document-only — so the probe was measuring the exact request shape the policy skips, and thirteen consecutive failures read like "the CSP was never wired up". It now sends a browser navigation's `Accept` by default. The same run had the probe following `/verify?token=…` to the indexable sign-in page and reporting a leak that `safeNextPath` had already prevented by stripping the token; it asserts the strip instead. |
| The probe's rate-limit check compared **response sizes** — early bytes against late bytes — to see the documented degrade-to-mirror | It broke the moment the mirror grew. With 264 albums seeded, the local results alone fill the page's cap, so the throttled and unthrottled pages came within 100 bytes of each other and a working limiter read as a failure. It now asserts the **disclosure sentence** `SearchResults` prints, which is the mechanism's own statement about itself. A proxy measurement expires; the disclosure does not. |
| A **serial** burst of 45 requests is not a burst | Against hosted Postgres each `/search` render costs a round trip plus a provider call, so the 45 took longer than the 60-second window and the counter reset mid-run, peaking at 10 of a limit of 30. The limiter was working and the probe could not see it. The burst is concurrent now, and a run that still spans the window reports **inconclusive** rather than failing — an assertion that cannot guarantee its own window has not observed anything. |
| A production build failed `28P01 password authentication failed for user 'neondb_owner'`, and the first diagnosis was **the transport** | Wrong. The script piped values to `vercel env add` through `cmd.exe`, which is a plausible corruptor, and removing the shell changed nothing. The cheap test found it: running the same connection string locally — where it had worked an hour earlier — failed identically, so the credential had been revoked. A Neon claimable project put into a `pending` claim state stops authenticating and permits only status polling. The shell removal was kept on its own merits, and its comment now says it was **not** the bug, because a comment claiming an undemonstrated fix is how the next reader stops looking. |
| `scripts/migrate-deploy.ts` printed `error.message` only | Drizzle wraps every driver error, and the migrator's first statement is `CREATE SCHEMA IF NOT EXISTS "drizzle"` — so a connection failure, a permissions failure and a real SQL failure all printed one identical line, which was the **entire** content of a failed production build. It prints the cause chain now, whitelisted to the `safeErrorDetail` fields (I-35): never `query`, `parameters` or `stack`, because build logs are readable by anyone with project access. |
| Pushing `DATABASE_URL` to a Vercel project that a Marketplace integration already populates | The pushed copy shadows the value the platform owns and goes stale at the next credential rotation — and the symptom is a build-time 28P01 indistinguishable from a broken script. `vercel-setup.mjs` now reads `env ls` first and pushes `DATABASE_URL` only when nothing is providing one, which is the claimable-database case. |
| Reading `.env.local` with `cut -d=` after the Vercel CLI has rewritten it | The CLI writes **quoted** values, so a correct 64-character `CRON_SECRET` arrived as a 66-character one and `/api/cron/prune` returned 404 — which is the same 404 it returns when the secret is unset, by design. The route was right; the caller was wrong. |
| **A programmatic `notFound()` serves a 404 whose body is rendered only on the client.** Measured on the live deployment and reproduced in a local production build | Confirmed structural, and NOT fixed, because the fix is worse. Next returns 404 only for a NON-STREAMED response, and its own docs state the rule: "the response body starts streaming when a Suspense fallback renders… Place `notFound()` before those boundaries". This app does exactly that (I-3, no `loading.tsx` anywhere), so nothing has streamed — and with no boundary above the page React has nowhere to render the not-found UI server-side, so Next falls back to a client-recovery shell: `<html id="__next_error__">`, 39 visible characters, no `lang`, and the root `<title>` instead of the page's. Adding a Suspense boundary or a `loading.tsx` would render the body properly and turn the status into **200**, which is precisely the trade I-3 exists to refuse. `experimental.globalNotFound` does not apply: it handles URLs matching no route, which is the path that already renders correctly. So the choice stands — **correct status, client-rendered body** — and the cost is stated here rather than left to be discovered: a visitor with JavaScript blocked gets a blank document on every bad slug, and a screen reader gets one with no language declared. |
| `updateAge: 1 day` was configuration for a behaviour the application did not have | next-auth 5's RSC `auth()` branch resolves the session and **discards** the refreshed `Set-Cookie`; only the API-routes branch forwards it. `await auth()` from `currentUser()` is the only call site, `proxy.ts` deliberately never calls `auth()` (I-34), and there is no `SessionProvider` — so nothing could re-issue a cookie and the JWT's `exp` was always sign-in + 14 days. Three documents asserted the daily re-issue, and `GUEST_GRACE_DAYS` derived its value from it ("good until day 27" under a constant of 21). The inert setting is deleted and the cap is now documented as hard: fourteen days from sign-in, for everybody. Making re-issue real was rejected — it needs a `proxy.ts` that calls `auth()`, contradicting I-34, and rolling sessions would make the guest sweep delete the diary of a guest who visited yesterday. |
| **The two ad slots are not statistically independent.** Measured over 20,000 pages: 33.9% carry no indie unit, 66.1% carry exactly one, **0% carry two** — and the share is still 0.3305 | Kept, and documented in `lib/ads/plan.ts` with the mechanism. The brief predicts a 4/9–4/9–1/9 split; FNV-1a's final multiply turns the one-bit difference between `"…slot:0"` and `"…slot:1"` into a constant ±`P` offset, and `P ≡ 2 (mod 3)`, so the two residues can never both be zero. The *share* was the promise, and spreading the same third of impressions across more distinct page views is reach rather than frequency — which is what an unknown artist wants. A test asserts the zero so a future "fix" has to argue with it. |

## 6. What is NOT being built

Stated so that the absence is a decision rather than an omission:

- No direct messages, no notifications (as in the original).
- No image uploads. Avatars are generated gradients; ads have no image column.
- No third-party browser scripts of any kind — no analytics, no tag manager, no chat
  widget. This is what keeps the CSP free of holes.
- No collaborative filtering. The recommender is content-based and says so to the member.
- No billing. `users.plan` is operator-set, as in the original.
- No full-text search infrastructure. Postgres `ILIKE` (through `escapeLike`) plus provider
  search.
- No light theme.

---

## 7. Naming map (for reviewing a diff against the brief)

| Cliffhanger | Deadwax |
| --- | --- |
| `shows` (PK `tmdb_id`) | `artists` (PK `serial`, `deezer_id` unique) |
| `seasons` | `albums` |
| `episodes` | `tracks` |
| `watch_providers` | *(deleted — `lib/listen.ts`)* |
| — | `artist_similar` *(new — the neighbour graph, cached)* |
| `watchlist` | `wantlist` |
| `absolute_cinema` | `desert_island` |
| `logs.show_id` | `logs.artist_id` |
| `logs.season_number` | `logs.album_id` *(an id, not an ordinal)* |
| `logs.episode_number` | `logs.track_number` *(+ `logs.disc_number`)* |
| `logs.watched_on` | `logs.listened_on` |
| `logs.is_rewatch` | `logs.is_replay` |
| `logs.contains_spoilers` | *(deleted)* |
| `target_type` ∈ show\|season\|episode | ∈ artist\|album\|track |
| `episodeCode("S03E07")` | `trackLocator("2-5"` \| `"7")` |
| Absolute Cinema | Desert Island |
| `--color-cinema` | `--color-desert` |
| `ensureShow` / `ensureSeasonEpisodes` / `ensureAllSeasons` | `ensureArtist` / `ensureAlbum` / `ensureDiscography` |
| `TMDB_READ_TOKEN` | *(no secret required)* |
| `WATCH_REGION` | *(deleted)* |
| "Progress" pillar | "Replay" + "Discography completion" |

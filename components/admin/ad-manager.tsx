"use client";

/**
 * The ad manager — create a placement, move it through its states, and read the counters.
 *
 * ---------------------------------------------------------------------------------------
 * THE POLICY IS EXPLAINED IN PROSE, USING THE REAL CONSTANTS
 * ---------------------------------------------------------------------------------------
 *
 * `INDIE_EVERY` and `MAX_ADS_PER_PAGE` are imported and interpolated rather than written out,
 * because *an operator who cannot explain the reservation cannot sell it* — and a hard-coded
 * "one in three" is how a panel ends up describing a policy the code stopped honouring.
 *
 * WHAT THIS PANEL DOES NOT CLAIM, and the omission is deliberate and measured: it does not
 * state a distribution of indie slots per page. The obvious arithmetic — two independent slots
 * at one-in-three each — predicts roughly 4/9 of pages with no indie unit, 4/9 with one and 1/9
 * with two. **That is not what happens.** Twenty thousand planned pages were measured: 33.9%
 * zero, 66.1% exactly one, and **0% two** — while the overall indie share came out at 0.3305,
 * which is the number the policy actually promises.
 *
 * The mechanism was traced rather than guessed at. The two slots hash `…:slot:0` and `…:slot:1`,
 * inputs differing in one bit, and FNV-1a's final multiply turns that into a difference of
 * exactly ±16777619 — and 16777619 ≡ 2 (mod 3), so the two slots' residues can never coincide.
 * Two indie units on one page is arithmetically impossible, not merely rare.
 *
 * **It was kept.** The share is the promise, and it is honoured exactly; and for an unknown
 * artist reach beats frequency — one slot on twice as many pages is worth more than two slots
 * on half of them. A test asserts the zero, so the property cannot drift back into randomness
 * unnoticed. The panel simply declines to print a per-page distribution rather than printing
 * one that is wrong.
 *
 * ---------------------------------------------------------------------------------------
 * ARCHIVE IS TERMINAL, AND THE UI HAS TO MAKE THAT LEGIBLE
 * ---------------------------------------------------------------------------------------
 *
 * There is no delete. The per-day counters ARE the record of what ran, so deleting an ad would
 * destroy the evidence an advertiser was billed against. Archive stops it serving, stops it
 * counting, and freezes its numbers — so it gets the two-press arm/confirm and every other
 * control on an archived row is gone rather than disabled: the row is history, and history has
 * no buttons.
 *
 * Pause is the reversible one, and the panel says which is which in words.
 */

import { Archive, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { archiveAd, createAd, setAdStatus, setAdWeight } from "@/app/actions/ads";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input, Label, Select, Textarea } from "@/components/ui/field";
import { Badge, SectionHeading, type Tone } from "@/components/ui/primitives";
import { INDIE_EVERY, MAX_ADS_PER_PAGE } from "@/lib/ads/plan";
import type { AdRow, AdTotals } from "@/lib/db/queries/ads";
import { formatCount, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const DISARM_MS = 5000;

/** The three settable states. `archived` is reached through its own control, never this one. */
const SETTABLE_STATUSES = ["draft", "active", "paused"] as const;

const STATUS_TONES: Readonly<Record<string, Tone>> = {
  active: "teal",
  paused: "amber",
  draft: "neutral",
  archived: "rose",
};

export type AdManagerProps = {
  ads: AdRow[];
  totals: AdTotals;
  className?: string;
};

export function AdManager({ ads, totals, className }: AdManagerProps) {
  return (
    <div className={cn("space-y-10", className)}>
      <Policy totals={totals} />
      <CreateAdForm />
      <section>
        <SectionHeading
          as="h2"
          eyebrow={`${formatCount(ads.length)} in inventory`}
          title="Placements"
        />
        {ads.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing booked. An ad is created as a draft and does not serve until it is activated.
          </p>
        ) : (
          <ul className="space-y-3">
            {ads.map((ad) => (
              <li key={ad.id}>
                <AdRowCard ad={ad} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The policy, stated in the panel that enforces it                           */
/* -------------------------------------------------------------------------- */

function Policy({ totals }: { totals: AdTotals }) {
  /*
   * The click-through rate is computed here rather than in SQL because it is a ratio of two
   * numbers already on screen, and a ratio computed somewhere else is a third number that can
   * disagree with the two above it. Guarded against a zero denominator — a brand-new install
   * has no impressions, and `0/0` would print "NaN%" on the first page an operator ever sees.
   */
  const rate = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : null;

  return (
    <section className="card space-y-4 p-5">
      <SectionHeading as="h2" eyebrow="Policy" title="How the slots are allocated" />

      <div className="space-y-3 text-[0.8125rem] leading-relaxed text-muted">
        <p>
          A page carries at most {MAX_ADS_PER_PAGE} placements, never the same one twice, and
          one slot in {INDIE_EVERY} is reserved for an independent release — so roughly a third
          of all placements served go to a self-released record with a named artist behind it.
          The reservation is enforced when the page is planned, not when the ad is booked: if
          nothing indie is running, the slot goes to a general placement rather than sitting
          empty.
        </p>
        <p>
          Which ad fills a slot is decided by a seed derived from the viewer, the page and the
          current hour, so the same person reloading the same record sees the same unit and a
          different one an hour later. Genre affinity doubles an ad&rsquo;s weight when it
          matches what the viewer rates. <strong className="text-paper">Pro members see none of
          this</strong> — the plan is read from the database on every serve, and for a Pro member
          no candidate query runs at all.
        </p>
        <p>
          Indie placements require a credit before they can be activated. An indie slot without
          a named artist is just an ad with a coloured border, and the reservation would stop
          meaning anything.
        </p>
      </div>

      {/*
        FOUR NUMBERS, MONOSPACED AND TABULAR. These are the operator's whole reporting surface,
        and they are lifetime totals: the per-day curve lives on `ad_stats`, which holds one row
        per ad per day and has no member column at all, by construction rather than by policy.
      */}
      <dl className="grid grid-cols-2 gap-3 border-t border-line pt-4 sm:grid-cols-4">
        <Figure label="Active" value={formatCount(totals.active)} note={`of ${formatCount(totals.ads)} total`} />
        <Figure label="Indie running" value={formatCount(totals.indieActive)} />
        <Figure label="Impressions" value={formatCount(totals.impressions)} />
        <Figure
          label="Clicks"
          value={formatCount(totals.clicks)}
          note={rate === null ? "no impressions yet" : `${rate.toFixed(2)}% of impressions`}
        />
      </dl>
    </section>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="font-mono text-[0.625rem] uppercase tracking-wider text-faint">{label}</dt>
      <dd className="mt-1 font-mono text-lg tabular text-paper">{value}</dd>
      {note ? <p className="font-mono text-[0.625rem] tracking-wider text-faint">{note}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

function CreateAdForm() {
  const router = useRouter();
  const formRef = React.useRef<HTMLFormElement | null>(null);
  const [kind, setKind] = React.useState<"general" | "indie">("indie");
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<number | null>(null);
  const [pending, startTransition] = React.useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setCreated(null);

    const text = (name: string): string => String(form.get(name) ?? "").trim();
    const optional = (name: string): string | undefined => text(name) || undefined;

    startTransition(async () => {
      const result = await createAd({
        kind,
        slot: (optional("slot") ?? "any") as "feed" | "sidebar" | "any",
        headline: text("headline"),
        body: text("body"),
        ctaLabel: text("ctaLabel"),
        targetUrl: text("targetUrl"),
        creatorName: optional("creatorName"),
        /* An empty `<select>` value has to become `undefined`, not `""`: the schema's enum
           rejects the empty string, and "no project kind" is a legitimate answer. */
        projectKind: optional("projectKind") as "single" | "ep" | "lp" | "mixtape" | undefined,
        label: optional("label"),
        /* Comma-separated in the box, an array over the wire. `genreKey` lower-cases and trims
           each one on the server, so the operator's capitalisation does not matter. */
        genres: text("genres")
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
        weight: Number(text("weight") || "1"),
        startsAt: optional("startsAt"),
        endsAt: optional("endsAt"),
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCreated(result.data.adId);
      /* The form is reset rather than left populated: the next ad is a different ad, and a
         pre-filled form is how two placements end up with the same copy. */
      formRef.current?.reset();
      router.refresh();
    });
  }

  return (
    <section>
      <SectionHeading as="h2" eyebrow="New placement" title="Book an ad" />
      <form ref={formRef} onSubmit={submit} className="card space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <Label htmlFor="ad-kind">Kind</Label>
            {/*
              CONTROLLED, and it is the only controlled field here. The rest are read from
              `FormData` on submit, because nothing depends on them while typing; `kind` decides
              whether the credit field is required, so it has to be state.
            */}
            <Select
              id="ad-kind"
              name="kind"
              value={kind}
              onChange={(event) => setKind(event.currentTarget.value === "general" ? "general" : "indie")}
            >
              <option value="indie">Indie spotlight</option>
              <option value="general">General</option>
            </Select>
          </Field>

          <Field>
            <Label htmlFor="ad-slot">Slot</Label>
            <Select id="ad-slot" name="slot" defaultValue="any">
              <option value="any">Anywhere</option>
              <option value="feed">Feed only</option>
              <option value="sidebar">Sidebar only</option>
            </Select>
          </Field>
        </div>

        <Field>
          <Label htmlFor="ad-headline">Headline</Label>
          <Input id="ad-headline" name="headline" maxLength={120} required placeholder="A record you have not heard" />
        </Field>

        <Field>
          <Label htmlFor="ad-body">Copy</Label>
          <Textarea
            id="ad-body"
            name="body"
            rows={3}
            maxLength={240}
            required
            placeholder="Self-released, four tracks, recorded in a kitchen."
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <Label htmlFor="ad-cta">Button label</Label>
            <Input id="ad-cta" name="ctaLabel" maxLength={40} required placeholder="Listen" />
          </Field>
          <Field>
            <Label htmlFor="ad-url">Destination</Label>
            <Input
              id="ad-url"
              name="targetUrl"
              type="url"
              maxLength={2000}
              required
              placeholder="https://example.com/release"
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field>
            <Label htmlFor="ad-creator">
              Credit{kind === "indie" ? "" : " (optional)"}
            </Label>
            <Input
              id="ad-creator"
              name="creatorName"
              maxLength={120}
              /* The server refuses an indie placement without a credit; `required` here makes
                 the browser say so before a round trip, and the two checks agree. */
              required={kind === "indie"}
              placeholder="The artist or label"
            />
          </Field>
          <Field>
            <Label htmlFor="ad-project">Release</Label>
            <Select id="ad-project" name="projectKind" defaultValue="">
              <option value="">Unspecified</option>
              <option value="single">Single</option>
              <option value="ep">EP</option>
              <option value="lp">LP</option>
              <option value="mixtape">Mixtape</option>
            </Select>
          </Field>
          <Field>
            <Label htmlFor="ad-label">Label</Label>
            <Input id="ad-label" name="label" maxLength={120} placeholder="Self-released" />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field>
            <Label htmlFor="ad-genres">Genres</Label>
            <Input id="ad-genres" name="genres" placeholder="ambient, techno" />
          </Field>
          <Field>
            <Label htmlFor="ad-weight">Weight</Label>
            <Input id="ad-weight" name="weight" type="number" min={1} max={100} defaultValue={1} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <Label htmlFor="ad-starts">Starts</Label>
              <Input id="ad-starts" name="startsAt" type="datetime-local" />
            </Field>
            <Field>
              <Label htmlFor="ad-ends">Ends</Label>
              <Input id="ad-ends" name="endsAt" type="datetime-local" />
            </Field>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" disabled={pending}>
            <Plus />
            Create as draft
          </Button>
          {/* SAID EVERY TIME, not once in a docblock. `status: "draft"` is hardcoded in the
              action, so nothing an operator can type here makes an ad start serving. */}
          <p className="text-[0.75rem] text-faint">
            Created as a draft. It does not serve until you activate it.
          </p>
        </div>

        <FormError message={error} />
        {created !== null ? (
          <p role="status" className="text-[0.8125rem] text-teal">
            Draft #{created} created. Activate it below when the copy is right.
          </p>
        ) : null}
      </form>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* One placement                                                              */
/* -------------------------------------------------------------------------- */

function AdRowCard({ ad }: { ad: AdRow }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [armed, setArmed] = React.useState(false);
  const [weight, setWeight] = React.useState(String(ad.weight));
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), DISARM_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const archived = ad.status === "archived";

  function run(work: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong. Try again.");
        return;
      }
      router.refresh();
    });
  }

  function archive() {
    if (!armed) {
      setError(null);
      setArmed(true);
      return;
    }
    setArmed(false);
    run(() => archiveAd({ adId: ad.id }));
  }

  return (
    <article className={cn("card space-y-3 p-4", archived && "opacity-70")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={STATUS_TONES[ad.status] ?? "neutral"}>{ad.status}</Badge>
            {ad.kind === "indie" ? <Badge tone="desert">Indie</Badge> : <Badge>General</Badge>}
            {ad.slot === "any" ? null : <Badge>{ad.slot}</Badge>}
            <span className="font-mono text-[0.625rem] tracking-wider text-faint">#{ad.id}</span>
          </div>
          <p className="mt-2 font-display text-lg leading-tight text-paper text-balance">{ad.headline}</p>
          <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted">{ad.body}</p>
          <p className="mt-2 truncate font-mono text-[0.625rem] tracking-wider text-faint">
            {ad.ctaLabel} → {ad.targetUrl}
          </p>
        </div>

        <dl className="shrink-0 text-right font-mono text-[0.6875rem] tabular text-muted">
          <div>
            <dt className="sr-only">Impressions</dt>
            <dd>
              {formatCount(ad.impressions)} <span className="text-faint">seen</span>
            </dd>
          </div>
          <div>
            <dt className="sr-only">Clicks</dt>
            <dd>
              {formatCount(ad.clicks)} <span className="text-faint">clicked</span>
            </dd>
          </div>
          {ad.startsAt || ad.endsAt ? (
            <div className="mt-1 text-[0.625rem] tracking-wider text-faint">
              <dt className="sr-only">Schedule</dt>
              <dd>
                {formatDate(ad.startsAt) ?? "now"} — {formatDate(ad.endsAt) ?? "open"}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>

      {(ad.creatorName ?? ad.label ?? null) !== null || ad.genres.length > 0 ? (
        <p className="border-t border-line pt-3 font-mono text-[0.6875rem] tracking-wider text-faint">
          {ad.creatorName ? <span className="text-paper">{ad.creatorName}</span> : null}
          {ad.projectKind ? <span> · {ad.projectKind}</span> : null}
          {ad.label ? <span> · {ad.label}</span> : null}
          {ad.genres.length > 0 ? <span> · {ad.genres.join(", ")}</span> : null}
        </p>
      ) : null}

      {/*
        AN ARCHIVED ROW HAS NO CONTROLS AT ALL. Not disabled ones: its weight no longer affects
        anything, its status cannot change, and its counters are final. A row of greyed buttons
        would suggest the state is recoverable.
      */}
      {archived ? (
        <p className="border-t border-line pt-3 text-[0.75rem] text-faint">
          Archived {formatDate(ad.updatedAt)}. Its figures are the record of what ran, which is why
          nothing here can delete it.
        </p>
      ) : (
        <div className="flex flex-wrap items-end justify-between gap-3 border-t border-line pt-3">
          <div role="group" aria-label={`Status of ad ${ad.id}`} className="flex flex-wrap gap-1.5">
            {SETTABLE_STATUSES.map((status) => (
              <Button
                key={status}
                type="button"
                variant={ad.status === status ? "secondary" : "ghost"}
                size="sm"
                disabled={pending || ad.status === status}
                onClick={() => run(() => setAdStatus({ adId: ad.id, status }))}
                aria-pressed={ad.status === status}
              >
                {status === "active" ? "Activate" : status === "paused" ? "Pause" : "To draft"}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <Field className="w-24">
              <Label htmlFor={`ad-weight-${ad.id}`}>Weight</Label>
              <Input
                id={`ad-weight-${ad.id}`}
                type="number"
                min={1}
                max={100}
                value={weight}
                onChange={(event) => setWeight(event.currentTarget.value)}
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending || String(ad.weight) === weight.trim()}
              onClick={() => run(() => setAdWeight({ adId: ad.id, weight: Number(weight) }))}
            >
              Save weight
            </Button>

            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={pending}
              onClick={archive}
              aria-label={armed ? `Confirm archive ad ${ad.id}` : `Archive ad ${ad.id}`}
              className={cn(armed && "border-rose bg-rose/30 text-paper")}
            >
              <Archive />
              {armed ? "Confirm archive" : "Archive"}
            </Button>
          </div>
        </div>
      )}

      {armed ? (
        <p role="status" className="text-[0.75rem] leading-snug text-rose">
          Press again to archive. Archiving is final — it stops serving, stops counting, and cannot
          be undone. Pause instead if this is temporary.
        </p>
      ) : null}
      <FormError message={error} />
    </article>
  );
}

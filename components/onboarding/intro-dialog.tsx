"use client";

/**
 * The onboarding dialog. IT OPENS ON ARRIVAL WITH THE GRID ALREADY RENDERED BEHIND IT, SO
 * CLOSING IT IS THE WHOLE INTERACTION.
 *
 * > The hero used to carry a paragraph nobody reads before they have chosen anything. Here it
 * > arrives after "Start your diary", which is the first point at which what this app does is
 * > a question the visitor is actually asking.
 *
 * That ordering is the design, and it is worth stating what it costs: the visitor sees the
 * product's explanation exactly once, over a working page, at the moment they have already
 * committed to trying it. Every dismissal — Escape, the overlay, the X, the footer button —
 * lands them on twenty-four covers and a star control. There is no step two.
 *
 * `useState(true)` IS THE ENTIRE "OPENS ON ARRIVAL" MECHANISM, AND IT IS NOT AN EFFECT.
 * Radix portals its content through `@radix-ui/react-portal`, which renders nothing during
 * SSR, so the server response is the grid alone and the dialog arrives on hydration. An
 * effect that set `open` after mount would do the same thing one render later, with a flash of
 * un-dimmed grid in between, and would need a dependency list to stop it reopening.
 *
 * NO PERSISTENCE. No cookie, no `localStorage`, no `users` column — IT REOPENS ON EVERY VISIT
 * to /start. The rejected alternative is a "seen it" flag, and the reason it loses is that
 * /start is not a route anybody lands on twice by accident: a signed-out visitor is redirected
 * into a guest session to reach it, and a claimed member is sent to their own diary instead
 * (see `signUp`). A flag would therefore add a storage key, a migration and a synchronisation
 * question in order to suppress a dialog almost nobody sees twice — and the one member who
 * does see it twice came back deliberately.
 *
 * THE GUEST-ONLY PARAGRAPH SITS IN ITS OWN BLOCK BELOW A RULE.
 *
 * > It is a different subject, and burying it in the last sentence of a feature list is how
 * > people miss the one thing that could cost them their work.
 *
 * A feature list answers "what is this for". "Your diary lives in this session and nothing
 * else" answers "what could go wrong", and a reader skimming four bullet points has already
 * stopped reading by the time a fifth one says something structurally different.
 */

import { BookMarked, LayoutGrid, Star, Users } from "lucide-react";
import * as React from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Eyebrow } from "@/components/ui/primitives";

/**
 * FOUR POINTS, MAPPING ONTO THE FOUR PILLARS, IN THIS ORDER.
 *
 * The order is the product's own dependency chain and not a ranking: you rate before a
 * discography has a shape, the shape is what makes a diary worth keeping, and following people
 * is only interesting once you have taste of your own on file. A list that opened with
 * "follow people" would be asking for the one thing a new arrival cannot yet do.
 *
 * Declared as data rather than as four copies of the same markup, so the icon sizing and the
 * text treatment cannot drift between them.
 */
const POINTS: ReadonlyArray<{ icon: React.ComponentType<{ className?: string }>; title: string; body: string }> = [
  {
    icon: Star,
    title: "Rate albums and tracks",
    body: "Half a star to five, on the record as a whole and on every track. A verdict on the album sits beside the mean of its parts — they are different opinions and neither is averaged away.",
  },
  {
    icon: LayoutGrid,
    title: "See the shape of a discography",
    body: "One row per album, one cell per track, coloured by rating. A sophomore slump is a row of oranges between two rows of greens, and a late return to form is a blue cell in the last row.",
  },
  {
    icon: BookMarked,
    title: "Keep a diary and a wantlist",
    body: "What you played and when, replays included, with tags and a review if you want one. Records you have not heard yet go on the wantlist instead.",
  },
  {
    icon: Users,
    title: "Follow people with taste",
    body: "A feed of what people you trust are actually playing, and recommendations built from your own ratings rather than from what is charting this week.",
  },
];

export type IntroDialogProps = {
  /**
   * True when the viewer is in a guest session, which on /start is the normal case: the route
   * is guest-gated and opens a session for anybody who arrives without one.
   *
   * IT GATES THE BLOCK BELOW THE RULE AND NOTHING ELSE. A member who reached /start
   * deliberately has an account already, and telling them their work depends on a session
   * cookie would be false.
   */
  isGuest?: boolean;
};

export function IntroDialog({ isGuest = false }: IntroDialogProps) {
  const [open, setOpen] = React.useState(true);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/*
        NO `DialogTrigger`. There is nothing to press to reopen this — it is a greeting, not a
        panel, and a "what is this?" button on an onboarding page is a second thing to decide
        about before rating anything.

        Escape and a click outside both close it, which is Radix's default and is left alone:
        the dialog is informational, so every exit is a correct exit. `LogDialog` overrides
        those two handlers because it can be mid-save; this one cannot lose anything.
      */}
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <Eyebrow className="mb-2">Welcome to Deadwax</Eyebrow>
          <DialogTitle>A social diary for records.</DialogTitle>
          <DialogDescription>
            Rate a few albums you know and the rest of the product turns on. Twelve or so is
            enough to get recommendations worth reading.
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-3">
          {POINTS.map((point) => {
            const Icon = point.icon;
            return (
              <li key={point.title} className="flex gap-3">
                {/*
                  The glyphs are decoration: every point's meaning is in its own heading, so
                  naming them would announce "star, rate albums and tracks" and add nothing.
                */}
                <Icon className="mt-0.5 size-4 shrink-0 text-amber" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-mono text-xs tracking-wider text-paper">{point.title}</p>
                  <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted">{point.body}</p>
                </div>
              </li>
            );
          })}
        </ul>

        {isGuest ? (
          /*
           * ITS OWN BLOCK, BELOW A RULE. `border-t` is the rule — not `.section-rule`, whose
           * hairline trails off to the right of a label and reads as a section heading rather
           * than as a division between two subjects.
           */
          <div className="mt-5 border-t border-line pt-4">
            <Eyebrow className="mb-2">About this session</Eyebrow>
            <p className="text-[0.8125rem] leading-relaxed text-muted">
              You are signed in as a guest, so there is nothing to fill in and nothing to
              confirm. Everything you rate is saved on the server, and creating an account
              later claims this diary in place — the same rows, under a name you choose.{" "}
              <span className="text-paper">
                Until you do, this browser session is the only way back into it.
              </span>
            </p>
          </div>
        ) : null}

        <DialogFooter>
          {/*
            The only control this dialog needs, and it is the amber one: closing is the whole
            interaction. `DialogClose asChild` keeps Radix's own dismissal — including
            returning focus to where it came from — rather than calling `setOpen(false)` by
            hand and losing the focus restoration.
          */}
          <DialogClose asChild>
            <Button variant="primary" size="lg">
              Start rating
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

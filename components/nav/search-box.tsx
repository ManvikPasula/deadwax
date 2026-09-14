"use client";

/**
 * The header's search field.
 *
 * `"use client"` because it holds the typed value and pushes a route — but note WHAT IT IS:
 * a real `<form method="get" action="/search">` with a real `name="q"`. With JavaScript
 * disabled the browser submits it and lands on `/search?q=…` unaided; with JavaScript the
 * submit handler intercepts and does the same navigation through the router so the transition
 * is client-side and the header does not remount.
 *
 * The rejected alternative was a controlled input firing `router.replace` on every keystroke.
 * That turns each character into an RSC request against a route that consumes a provider
 * budget (`/search` calls `searchByIp`), and it makes the back button walk through every
 * prefix the member typed.
 *
 * NO `focus:outline-none`. The global amber `:focus-visible` rule is the focus treatment.
 */

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import { Input } from "@/components/ui/field";
import { cn } from "@/lib/utils";

export type SearchBoxProps = {
  /** Pre-fills the box on `/search?q=…`, so the query stays visible above its own results. */
  initialQuery?: string;
  className?: string;
};

export function SearchBox({ initialQuery = "", className }: SearchBoxProps) {
  const router = useRouter();
  const [query, setQuery] = React.useState(initialQuery);
  // `useId` rather than a literal: the header renders one of these and `/search` renders
  // another, and two elements with id="search-q" would make the first label claim both.
  const inputId = React.useId();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    // An empty query still navigates. `/search` with no `q` renders its own landing box, so
    // pressing Enter on an empty field lands somewhere sensible instead of doing nothing.
    router.push(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search");
  }

  return (
    <form
      // The native action and method are the no-JavaScript path, and they are load-bearing:
      // remove them and this control does nothing at all for a visitor whose script failed
      // to load, which is the one visitor most likely to be looking for the search box.
      action="/search"
      method="get"
      role="search"
      onSubmit={submit}
      className={cn("relative", className)}
    >
      <label htmlFor={inputId} className="sr-only">
        Search albums, artists and members
      </label>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint"
        aria-hidden="true"
      />
      <Input
        id={inputId}
        name="q"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search records"
        // Off, because the browser's cross-field autofill offers names and addresses in
        // anything it cannot classify. `type="search"` still gives the field the platform's
        // clear button and its own per-site history of submitted queries.
        autoComplete="off"
        className="h-9 w-44 pl-8 lg:w-60"
      />
    </form>
  );
}

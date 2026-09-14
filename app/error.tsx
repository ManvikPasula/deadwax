"use client";

/**
 * The root error boundary.
 *
 * `"use client"` IS MANDATORY HERE — Next requires it of every `error.tsx`, because the file
 * is compiled into a React error boundary and boundaries are a client-only feature. This is
 * one of the few files in the app that carries the directive without a state or event reason
 * of its own.
 *
 * WHAT IT MAY AND MAY NOT SAY. `error.message` is deliberately not rendered. In production
 * Next replaces it with a generic string anyway, but in development it can carry driver
 * detail — and driver errors carry the SQL and its bound parameters (I-35). The `digest` is
 * the entire diagnostic surface: it is a hash Next also writes to the server log, so a
 * member can quote eight characters and an operator can find the real stack. Showing it is
 * what makes "something went wrong" actionable instead of a dead end.
 */

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <p className="eyebrow">Error</p>
      <h1 className="mt-3 font-display text-4xl leading-tight text-paper text-balance">
        Something went wrong on our side.
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        The page could not be rendered. Trying again is worth a shot — if it keeps happening,
        quote the reference below.
      </p>

      <div className="mt-6 flex justify-center gap-2">
        {/* `reset()` re-renders the segment without a full reload, so a transient failure
            (a provider timing out, a cold database connection) recovers in place. */}
        <Button variant="primary" onClick={reset}>
          Try again
        </Button>
        <Button asChild variant="ghost">
          <Link href="/">Back to the home page</Link>
        </Button>
      </div>

      {error.digest ? (
        <p className="mt-8 font-mono text-[0.6875rem] tabular text-faint">Reference {error.digest}</p>
      ) : null}
    </div>
  );
}

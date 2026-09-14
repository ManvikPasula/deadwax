/**
 * 404.
 *
 * A Server Component — unlike app/error.tsx there is nothing to reset and no boundary to be,
 * so it ships no JavaScript.
 *
 * THIS PAGE IS REACHED FAR MORE OFTEN THAN IT LOOKS, because `notFound()` is the standard
 * answer to a malformed URL throughout the app: a slug whose trailing id is out of int4
 * range, a track locator outside the disc/track bounds, a private list, an admin route
 * requested by a non-admin (a 404 rather than a 403, because a 403 confirms the route
 * exists — I-21). So it must read as a plain dead end and must NOT hint at what would have
 * been there.
 *
 * A REMINDER FOR ANYBODY ADDING A CONTENT ROUTE: `notFound()` has to be reached before
 * anything streams. A `notFound()` raised after the shell has flushed is sent as a 200, and
 * adding a route-level `loading.tsx` to a content route turns every 404 into a 200 with this
 * page's markup inside it (I-3).
 */

import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <p className="eyebrow">404</p>
      <h1 className="mt-3 font-display text-4xl leading-tight text-paper text-balance">
        That side is blank.
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Nothing is filed at this address. The record you were after may have been renamed, or
        the link may have lost its trailing id.
      </p>

      <div className="mt-6 flex justify-center gap-2">
        <Button asChild variant="primary">
          <Link href="/albums">Browse albums</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/search">Search</Link>
        </Button>
      </div>
    </div>
  );
}

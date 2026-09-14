/**
 * Outside a Next request context `next/cache` cannot resolve, which would stop the security
 * tests from importing a Server Action at all.
 *
 * Three no-ops with MATCHING SIGNATURES — matching, so that a call with the wrong arity is
 * still a type error in tests rather than being silently accepted.
 */
export function revalidatePath(_path: string, _type?: "layout" | "page"): void {}
export function revalidateTag(_tag: string): void {}
export function unstable_cache<T extends (...args: never[]) => unknown>(fn: T): T {
  return fn;
}

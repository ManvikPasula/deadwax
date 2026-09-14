import { handlers } from "@/lib/auth";

/**
 * The only Auth.js endpoint. Three lines, and nothing may be added to them.
 *
 * `handlers` already contains the sign-in, callback, session and CSRF routes. Wrapping either
 * export to add a check would put a second authorization rule in a second place; the checks
 * that belong to sign-in live inside `authorize()` — including both rate-limit budgets, which
 * are consumed there precisely because a caller can POST to `/api/auth/callback/credentials`
 * directly and never touch the Server Action.
 */
export const { GET, POST } = handlers;

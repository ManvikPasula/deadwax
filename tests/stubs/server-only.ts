/**
 * The real `server-only` package throws when imported outside a React Server Component
 * graph. That guard is exactly right in the app and unhelpful in a Node test runner, where
 * importing the query and security layers directly is the entire point.
 *
 * Aliased in vitest.config.ts. The app itself always resolves the real package.
 */
export {};

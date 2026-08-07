// @autologger/contract package entry (package-split-foundation task 3.1).
// Re-exports the wire-facing modules moved in from server/src: the Zod
// request schemas validated at the Hono route boundary, and the ai-v2
// dashboard widget catalog + config validator. Single home of wire request
// schemas and dashboard-config validation (package-architecture spec).

export * from './aiV2Catalog';
export * from './schemas';

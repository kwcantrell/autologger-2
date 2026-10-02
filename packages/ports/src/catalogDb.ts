// CatalogDb port (spec: core-ports-architecture "Catalog persistence is asynchronous…", "The
// catalog transaction contract" and "The Postgres catalog adapter"; ADR 0021 slices 3-4).
// `@autologger/storage` implements it over postgres.js (`PostgresCatalogDb`, wired since slice 4c;
// the SQLite implementation was retired in slice 4e).
//
// `tx` passes its body a handle scoped to the transaction, with this same interface; `tx` on
// that handle joins the enclosing transaction (no savepoint). Any error inside the transaction,
// even one the body catches, fails the whole transaction: it rolls back and rejects with the
// first error. The root handle used inside an open transaction, and a handle used after its
// transaction ended, reject.
//
// On Postgres a `tx` body may run more than once: a serialization failure or deadlock re-runs it
// (at most three runs). A body must therefore have only database effects.

export interface CatalogDb {
  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null>;
  run(sql: string, ...binds: unknown[]): Promise<{ changes: number }>;
  tx<T>(fn: (t: CatalogDb) => Promise<T>): Promise<T>;
}

// CatalogDb port (spec: core-ports-architecture "Catalog persistence is asynchronous…" and "The
// catalog transaction contract"; ADR 0021 slice 3). Implemented over SQLite today by
// `@autologger/storage`'s `AsyncSqliteCatalogDb`; slice 4 swaps in postgres.js behind it.
//
// `tx` passes its body a handle scoped to the transaction, with this same interface; `tx` on
// that handle joins the enclosing transaction (no savepoint). Any error inside the transaction,
// even one the body catches, fails the whole transaction: it rolls back and rejects with the
// first error. The root handle used inside an open transaction, and a handle used after its
// transaction ended, reject.

export interface CatalogDb {
  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null>;
  run(sql: string, ...binds: unknown[]): Promise<{ changes: number }>;
  tx<T>(fn: (t: CatalogDb) => Promise<T>): Promise<T>;
}

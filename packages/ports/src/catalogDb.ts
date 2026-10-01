// CatalogDb port (spec: core-ports-architecture): the synchronous
// catalog-query seam over better-sqlite3 today (`server/src/node/catalogStore.ts`'s
// `CatalogDb` class) — kept as the reversal point if a second backend ever
// became real. The catalog is embedded and single-process (permanent
// invariant), so the seam is synchronous by design.

export interface CatalogDb {
  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): T[];
  first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): T | null;
  run(sql: string, ...binds: unknown[]): { changes: number };
  /** Atomic multi-statement writes: all-or-nothing. */
  tx<T>(fn: () => T): T;
}

/** Asynchronous catalog seam (async-catalog-adapter D1; ADR 0021 slice 3). `tx` passes its body
 * a handle scoped to the transaction, with this same interface; `tx` on that handle joins the
 * enclosing transaction (no savepoint). Any error inside the transaction, even one the body
 * catches, fails the whole transaction: it rolls back and rejects with the first error. The root
 * handle used inside an open transaction, and a handle used after its transaction ended, reject.
 * Not yet in `Ports`: slice 3d moves the stores here and retires the synchronous `CatalogDb`. */
export interface AsyncCatalogDb {
  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null>;
  run(sql: string, ...binds: unknown[]): Promise<{ changes: number }>;
  tx<T>(fn: (t: AsyncCatalogDb) => Promise<T>): Promise<T>;
}

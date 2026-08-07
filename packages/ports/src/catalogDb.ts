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

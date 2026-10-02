// @autologger/catalog package entry (persistence-package-extraction task
// 3.2). The Catalog facade + its five domain stores (studios/shows/auth/
// sessions/profile) + sessionTitleDerivation, moved from server/src/db/.
// Depends on @autologger/domain + @autologger/ports only: Catalog speaks the
// CatalogDb port, never a driver (design D1/D7). The catalog schema is the
// Postgres schema in supabase/migrations/ (ADR 0021 slice 4; the SQLite
// migrations were retired in slice 4e).

import type { CatalogDb } from '@autologger/ports';
import { Catalog, type CatalogFacade } from './catalog';

export * from './authStore';
export * from './catalog';
export * from './profileAssembler';
export * from './sessionIndexStore';
export * from './sessionTitleDerivation';
export * from './showsStore';
export * from './studioRegistry';

/**
 * Sanctioned non-composition-root construction path (design D3): `Catalog`
 * is constructed per request in `server/src/middleware/auth.ts`, followed
 * by `init()` (refreshes the studio registry) before any registry read —
 * that lifecycle is preserved exactly by this factory. Returns the
 * `CatalogFacade` interface (task 5.1/5.3 — narrowed from the concrete
 * `Catalog` class); the body is unchanged. `middleware/auth.ts` itself keeps
 * calling `new Catalog(db)` directly until task 5.3 switches it to this
 * factory.
 */
export function createCatalog(db: CatalogDb): CatalogFacade {
  return new Catalog(db);
}

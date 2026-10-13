// @autologger/catalog package entry (persistence-package-extraction task
// 3.2). The Catalog facade + its five domain stores (studios/shows/auth/
// sessions/profile) + sessionTitleDerivation, moved from server/src/db/.
// Depends on @autologger/domain + @autologger/ports only: Catalog speaks the
// CatalogDb port, never a driver (design D1/D7). The catalog schema is the
// Postgres schema in supabase/migrations/ (ADR 0021 slice 4; the SQLite
// migrations were retired in slice 4e).

import type { CatalogRoot } from '@autologger/ports';
import { Catalog, type CatalogFacade, UNBOUND_DB } from './catalog';
import type { WikiLinksParser } from './wikiStore';

export * from './authStore';
export * from './catalog';
export * from './profileAssembler';
export * from './searchStore';
export * from './sessionIndexStore';
export * from './sessionTitleDerivation';
export * from './showsStore';
export * from './studioRegistry';
export * from './wikiStore';

/**
 * Sanctioned non-composition-root construction path (design D3): `Catalog`
 * is constructed per request in `server/src/middleware/auth.ts`, followed
 * by `init()` before any registry read. The catalog it returns is unbound
 * (catalog-roles D7): every store call, `tx` and `init()` reject with
 * `CatalogUnboundError` until `forUser(id)` or `system(reason)` derives a
 * bound catalog from it (`unbound()` derives another unbound one).
 * `wikiLinks` is the wiki link parser (show-wiki D4), carried to every
 * catalog derived from this one.
 */
export function createCatalog(
  root: CatalogRoot,
  opts: { wikiLinks?: WikiLinksParser } = {},
): CatalogFacade {
  return new Catalog(UNBOUND_DB, { root, wikiLinks: opts.wikiLinks });
}

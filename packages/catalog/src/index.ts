// @autologger/catalog package entry (persistence-package-extraction task
// 3.2). The Catalog facade + its five domain stores (studios/shows/auth/
// sessions/profile) + sessionTitleDerivation, moved from server/src/db/.
// Depends on @autologger/domain + @autologger/ports only — no
// better-sqlite3: Catalog speaks the CatalogDb port, never the driver
// (design D1/D7), so the schema-migration `.sql` files can live here
// (schema and stores evolve together) while the directory-generic migrator
// (`openCatalogDb`/`applyMigrations`) stays in `@autologger/storage`.

import { fileURLToPath } from 'node:url';
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
 * Resolved path to this package's catalog schema migration `.sql` files
 * (design D7 — the catalog package owns the migrations; the migrator that
 * applies them is directory-generic and lives in `@autologger/storage`).
 * Resolved via `import.meta.url` from inside the package so it works
 * identically under `tsx` (dev/prod) and vitest, regardless of process cwd.
 */
export const CATALOG_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

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

// Catalog — thin facade over the catalog domain stores (studioRegistry / authStore /
// showsStore / sessionIndexStore / profileAssembler). Preserves the per-request
// `new Catalog(db)` + init() lifecycle that routers reach via c.get('catalog'). The `readonly`
// store fields are the API surface (callers use catalog.shows.x() etc.), plus the lifecycle
// members init() and tx() (async-catalog-stores D3). KV login sessions + OAuth CSRF live in auth/identity.ts.

import type { CatalogDb, CatalogRoot } from '@autologger/ports';
import { AuthStore, type AuthStoreFacade } from './authStore';
import { ProfileAssembler, type ProfileAssemblerFacade } from './profileAssembler';
import { SessionIndexStore, type SessionIndexStoreFacade } from './sessionIndexStore';
import { ShowsStore, type ShowsStoreFacade } from './showsStore';
import { StudioRegistry, type StudioRegistryFacade } from './studioRegistry';

export type { AuthUser, ProfileCtx, Row } from '@autologger/domain';
export type { AuthStoreFacade } from './authStore';
export type { ProfileAssemblerFacade } from './profileAssembler';
export type { SessionIndexStoreFacade } from './sessionIndexStore';
export type { ShowsStoreFacade } from './showsStore';
export { showApiDict, showCategoriesApiShape } from './showsStore';
export type { StudioRegistryFacade } from './studioRegistry';

/** Facade interface for `Catalog` (persistence-package-extraction design D3 /
 * spec "Persistence facades are consumed through package-exported
 * interfaces"): the five `readonly` store-interface fields + `init()` — the
 * per-request lifecycle `middleware/auth.ts` drives via `createCatalog` +
 * `init()`. Property-style function type for `init` (design D3 —
 * contravariant `implements` checking under `strictFunctionTypes`; this
 * member has no parameters, so the property-style choice matters only for
 * consistency/uniformity here, not for catching a drifted parameter). */
export interface CatalogFacade {
  readonly shows: ShowsStoreFacade;
  readonly studios: StudioRegistryFacade;
  readonly auth: AuthStoreFacade;
  readonly sessions: SessionIndexStoreFacade;
  readonly profile: ProfileAssemblerFacade;
  init: () => Promise<void>;
  /** Runs `fn` on a Catalog bound to one catalog transaction (async-catalog-stores D3). */
  tx: <T>(fn: (cat: CatalogFacade) => Promise<T>) => Promise<T>;
  /** A catalog whose statements run for this signed-in user (catalog-roles D7). */
  forUser: (userId: string) => CatalogFacade;
  /** A catalog whose statements run for the named system task (catalog-roles D7, D10). */
  system: (reason: string) => CatalogFacade;
  /** A catalog whose every statement is refused with `CatalogUnboundError` (catalog-roles D7). */
  unbound: () => CatalogFacade;
}

/** A catalog call with neither a user nor a system binding: a programming error, refused before
 * anything is sent (catalog-roles D7; core-ports-architecture "Every catalog call is bound to a
 * caller"). */
export class CatalogUnboundError extends Error {
  override name = 'CatalogUnboundError';
}

const unboundCall = (): Promise<never> =>
  Promise.reject(new CatalogUnboundError('catalog call without a user or system binding'));

/** The handle of an unbound catalog: every statement and transaction rejects, nothing is sent. */
export const UNBOUND_DB: CatalogDb = {
  all: unboundCall,
  first: unboundCall,
  run: unboundCall,
  tx: unboundCall,
};

export class Catalog implements CatalogFacade {
  readonly shows: ShowsStore;
  readonly studios: StudioRegistry;
  readonly auth: AuthStore;
  readonly sessions: SessionIndexStore;
  readonly profile: ProfileAssembler;
  /** Private (`#`), so the stores stay the only enumerable fields. */
  readonly #db: CatalogDb;
  readonly #root: CatalogRoot | undefined;

  /** `root` hands out the bound handles `forUser`/`system` use; `studios` lets a derived Catalog
   * carry this one's registry snapshot. */
  constructor(db: CatalogDb, opts: { root?: CatalogRoot; studios?: StudioRegistry } = {}) {
    this.#db = db;
    this.#root = opts.root;
    this.studios = opts.studios ?? new StudioRegistry(db);
    this.shows = new ShowsStore(db);
    this.auth = new AuthStore(db);
    this.sessions = new SessionIndexStore(db, this.studios, this.shows);
    this.profile = new ProfileAssembler(this.studios, this.auth, this.shows);
  }

  /** Refresh the studio registry; must run once per request before registry reads. */
  async init(): Promise<void> {
    await this.studios.init();
  }

  /** The body runs on stores bound to the transaction handle, with a copy of this catalog's
   * registry snapshot (no query), under this catalog's binding; a store transaction inside it
   * joins it. On Postgres the body may run more than once (a SERIALIZABLE retry), so it must touch
   * only the catalog: no logging, broadcasts, timers, file I/O or outer-state writes
   * (catalog-on-postgres D7). */
  tx<T>(fn: (cat: CatalogFacade) => Promise<T>): Promise<T> {
    return this.#db.tx(async (t) => fn(this.#derive(t)));
  }

  /** Methods, not fields, so the stores stay the only enumerable members. */
  forUser(userId: string): CatalogFacade {
    return this.#derive(this.#needRoot().bindUser(userId));
  }

  system(reason: string): CatalogFacade {
    return this.#derive(this.#needRoot().bindSystem(reason));
  }

  unbound(): CatalogFacade {
    return this.#derive(UNBOUND_DB);
  }

  #derive(db: CatalogDb): Catalog {
    return new Catalog(db, { root: this.#root, studios: this.studios.withDb(db) });
  }

  #needRoot(): CatalogRoot {
    if (!this.#root) throw new TypeError('this Catalog has no CatalogRoot to bind from');
    return this.#root;
  }
}

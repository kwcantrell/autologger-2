// Catalog — thin facade over the catalog domain stores (studioRegistry / authStore /
// showsStore / sessionIndexStore / profileAssembler). Preserves the per-request
// `new Catalog(db)` + init() lifecycle that routers reach via c.get('catalog'). The `readonly`
// store fields are the API surface (callers use catalog.shows.x() etc.), plus the lifecycle
// members init() and tx() (async-catalog-stores D3). KV login sessions + OAuth CSRF live in auth/identity.ts.

import type { CatalogDb, CatalogRoot } from '@autologger/ports';
import { AuthStore, type AuthStoreFacade } from './authStore';
import { ProfileAssembler, type ProfileAssemblerFacade } from './profileAssembler';
import { type CatalogSearchResult, type SearchParams, SearchStore } from './searchStore';
import { SessionIndexStore, type SessionIndexStoreFacade } from './sessionIndexStore';
import { ShowsStore, type ShowsStoreFacade } from './showsStore';
import { StudioRegistry, type StudioRegistryFacade } from './studioRegistry';
import { type WikiLinksParser, WikiStore, type WikiStoreFacade } from './wikiStore';

export type { AuthUser, ProfileCtx, Row } from '@autologger/domain';
export type { AuthStoreFacade } from './authStore';
export type { ProfileAssemblerFacade } from './profileAssembler';
export type { SessionIndexStoreFacade } from './sessionIndexStore';
export type { ShowsStoreFacade } from './showsStore';
export { showApiDict, showCategoriesApiShape } from './showsStore';
export type { StudioRegistryFacade } from './studioRegistry';
export type { WikiStoreFacade } from './wikiStore';

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
  /** The show wiki (show-wiki design D1-D4). */
  readonly wiki: WikiStoreFacade;
  init: () => Promise<void>;
  /** Runs `fn` on a Catalog bound to one catalog transaction (async-catalog-stores D3). */
  tx: <T>(fn: (cat: CatalogFacade) => Promise<T>) => Promise<T>;
  /** A catalog whose statements run for this signed-in user (catalog-roles D7). */
  forUser: (userId: string) => CatalogFacade;
  /** A catalog whose statements run for the named system task (catalog-roles D7, D10). */
  system: (reason: string) => CatalogFacade;
  /** A catalog whose every statement is refused with `CatalogUnboundError` (catalog-roles D7). */
  unbound: () => CatalogFacade;
  /** `pg_notify(channel, payload)` under this catalog's binding; inside `tx`, on the transaction,
   * so it is delivered only if the transaction commits (session-frame-bus D5). */
  notify: (channel: string, payload: string) => Promise<void>;
  /** One search under this catalog's binding, in its own catalog transaction with a 3 s statement
   * budget, at most 2 per process (catalog-search D7). Rejects with `SearchTimeoutError` or
   * `SearchBusyError`. */
  search: (params: SearchParams) => Promise<CatalogSearchResult>;
}

/** A catalog call with neither a user nor a system binding: a programming error, refused before
 * anything is sent (catalog-roles D7; core-ports-architecture "Every catalog and session call is bound to a
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

/** `Catalog` construction options. `wikiLinks` is the wiki link parser (the server passes
 * `parseWikiLinks` from `@autologger/contract`; show-wiki D4); derived catalogs carry it on, and
 * without it every wiki write that sets a body fails. */
export interface CatalogOptions {
  root?: CatalogRoot;
  studios?: StudioRegistry;
  wikiLinks?: WikiLinksParser;
}

export class Catalog implements CatalogFacade {
  readonly shows: ShowsStore;
  readonly studios: StudioRegistry;
  readonly auth: AuthStore;
  readonly sessions: SessionIndexStore;
  readonly profile: ProfileAssembler;
  readonly wiki: WikiStore;
  /** Private (`#`), so the stores stay the only enumerable fields. */
  readonly #db: CatalogDb;
  readonly #root: CatalogRoot | undefined;
  readonly #search: SearchStore;
  readonly #wikiLinks: WikiLinksParser | undefined;

  /** `root` hands out the bound handles `forUser`/`system` use; `studios` lets a derived Catalog
   * carry this one's registry snapshot. */
  constructor(db: CatalogDb, opts: CatalogOptions = {}) {
    this.#db = db;
    this.#root = opts.root;
    this.#wikiLinks = opts.wikiLinks;
    this.#search = new SearchStore(db);
    this.studios = opts.studios ?? new StudioRegistry(db);
    this.shows = new ShowsStore(db);
    this.auth = new AuthStore(db);
    this.sessions = new SessionIndexStore(db, this.studios, this.shows);
    this.profile = new ProfileAssembler(this.studios, this.auth, this.shows);
    this.wiki = new WikiStore(db, opts.wikiLinks);
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

  /** Session-frame-bus D5: an access-loss close is published inside the revoking transaction. */
  async notify(channel: string, payload: string): Promise<void> {
    await this.#db.all('SELECT pg_notify(?, ?)', channel, payload);
  }

  /** A method over a private store, so the stores stay the only enumerable members. */
  search(params: SearchParams): Promise<CatalogSearchResult> {
    return this.#search.search(params);
  }

  #derive(db: CatalogDb): Catalog {
    return new Catalog(db, {
      root: this.#root,
      studios: this.studios.withDb(db),
      wikiLinks: this.#wikiLinks,
    });
  }

  #needRoot(): CatalogRoot {
    if (!this.#root) throw new TypeError('this Catalog has no CatalogRoot to bind from');
    return this.#root;
  }
}

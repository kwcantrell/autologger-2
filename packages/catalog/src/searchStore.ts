// Catalog search store (catalog-search design D5, D7): one catalog transaction that sets a 3 s
// statement budget and runs the definer function `catalog.search` as one statement, under the
// caller's binding (the function reads the user from `app.user_id`). A process-wide semaphore
// lets at most 2 searches run at once, so search never holds more than 2 of the catalog's
// transaction slots; a search that waits longer than 1 s for its turn fails as busy.

import type { CatalogDb } from '@autologger/ports';

/** The statement was cancelled by the 3 s budget (Postgres `57014`). Reported as a timeout, not a
 * server error (catalog-search spec "Filters and the timeout"). */
export class SearchTimeoutError extends Error {
  override name = 'SearchTimeoutError';
}

/** No search slot freed within the wait (design D7). */
export class SearchBusyError extends Error {
  override name = 'SearchBusyError';
}

export interface SearchParams {
  /** The query, already trimmed and bounds-checked by the route. */
  q: string;
  studioId?: string | null;
  showId?: string | null;
  /** One session's moments only (design D11); other groups come back empty. */
  sessionId?: string | null;
  /** 1–25; the function clamps. Default 5. */
  limit?: number;
}

export interface SearchStudioHit {
  id: string;
  name: string;
}
export interface SearchShowHit {
  id: string;
  name: string;
  studio_id: string;
}
export interface SearchSessionHit {
  id: string;
  title: string;
  episode: string;
  show_id: string;
  studio_id: string;
  started_at_utc: string;
  archived: boolean;
  match: 'title' | 'notes';
  snippet: string | null;
}
export interface SearchMomentHit {
  session_id: string;
  session_title: string;
  show_id: string;
  kind: 'transcript' | 'topic' | 'event';
  id: string;
  sec: number | null;
  speaker: string;
  snippet: string;
}
/** A session's total matching moments, at most 1000 (design D11). */
export interface SearchMomentSession {
  session_id: string;
  total: number;
}
/** What `catalog.search` returns (design D5, D11): four groups, snippets with U+E000/U+E001 around
 * hits, and each moment session's total. */
export interface CatalogSearchResult {
  q: string;
  studios: SearchStudioHit[];
  shows: SearchShowHit[];
  sessions: SearchSessionHit[];
  moments: SearchMomentHit[];
  moment_sessions: SearchMomentSession[];
}

/** A counting semaphore with a bounded, first-come-first-served wait. */
export class SearchSlots {
  #free: number;
  readonly #waiters: Array<() => void> = [];

  constructor(
    readonly size = 2,
    readonly waitMs = 1000,
  ) {
    this.#free = size;
  }

  /** Free slots right now. */
  get available(): number {
    return this.#free;
  }

  /** Resolves with a release function once a slot is held; rejects with `SearchBusyError` after
   * `waitMs` without one. */
  acquire(): Promise<() => void> {
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve(this.#releaser());
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(this.#releaser());
      };
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(grant);
        if (i !== -1) this.#waiters.splice(i, 1);
        reject(new SearchBusyError('Search is busy; try again.'));
      }, this.waitMs);
      this.#waiters.push(grant);
    });
  }

  #releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.#waiters.shift();
      if (next) next();
      else this.#free++;
    };
  }
}

/** The process-wide search slots (design D7): 2 at once, 1 s wait. */
export const SEARCH_SLOTS = new SearchSlots(2, 1000);

const STATEMENT_TIMEOUT = "SET LOCAL statement_timeout = '3s'";
const SEARCH = 'select catalog.search(?::text, ?::text, ?::text, ?::int, ?::text) as r';

export class SearchStore {
  constructor(
    private readonly db: CatalogDb,
    private readonly slots: SearchSlots = SEARCH_SLOTS,
  ) {}

  /** Runs one search under this store's binding. Call it outside a catalog transaction: inside
   * one, it joins it and the `SET LOCAL` budget applies to the rest of that transaction. */
  async search(p: SearchParams): Promise<CatalogSearchResult> {
    const release = await this.slots.acquire();
    try {
      return await this.db.tx(async (t) => {
        await t.run(STATEMENT_TIMEOUT);
        const row = await t.first<{ r: CatalogSearchResult }>(
          SEARCH,
          p.q,
          p.studioId ?? null,
          p.showId ?? null,
          p.limit ?? 5,
          p.sessionId ?? null,
        );
        if (!row) throw new Error('catalog.search returned no row');
        return row.r;
      });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === '57014') {
        throw new SearchTimeoutError('search exceeded its 3 s budget', { cause: error });
      }
      throw error;
    } finally {
      release();
    }
  }
}

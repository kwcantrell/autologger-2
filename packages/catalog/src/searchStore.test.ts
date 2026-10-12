// catalog-search task 3.2 (design D7): the search store sends one catalog transaction holding
// `SET LOCAL statement_timeout = '3s'` and one `select catalog.search(…)`, maps a cancelled
// statement (57014) to SearchTimeoutError, and lets at most 2 searches run per process: a third
// waits up to 1 s for a slot, then fails with SearchBusyError.

import type { CatalogDb } from '@autologger/ports';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Catalog } from './catalog';
import {
  type CatalogSearchResult,
  SEARCH_SLOTS,
  SearchBusyError,
  SearchSlots,
  SearchStore,
  SearchTimeoutError,
} from './searchStore';

interface Sent {
  inTx: boolean;
  op: 'all' | 'first' | 'run';
  sql: string;
  binds: unknown[];
}

const RESULT: CatalogSearchResult = {
  q: 'budget',
  studios: [],
  shows: [{ id: 's1', name: 'Budget Hour', studio_id: 'st' }],
  sessions: [],
  moments: [],
  moment_sessions: [],
};

/** A fake CatalogDb: records every statement and whether it ran inside `tx`; `onSearch` answers
 * the `catalog.search` statement. */
function fakeDb(onSearch: () => Promise<unknown> = async () => ({ r: RESULT })) {
  const sent: Sent[] = [];
  let txCount = 0;
  const handle = (inTx: boolean): CatalogDb => ({
    all: async <T>(sql: string, ...binds: unknown[]) => {
      sent.push({ inTx, op: 'all', sql, binds });
      return [] as T[];
    },
    first: async <T>(sql: string, ...binds: unknown[]) => {
      sent.push({ inTx, op: 'first', sql, binds });
      return sql.includes('catalog.search(') ? ((await onSearch()) as T) : null;
    },
    run: async (sql: string, ...binds: unknown[]) => {
      sent.push({ inTx, op: 'run', sql, binds });
      return { changes: 0 };
    },
    tx: async <T>(fn: (t: CatalogDb) => Promise<T>) => {
      txCount++;
      return fn(handle(true));
    },
  });
  return { db: handle(false), sent, txCount: () => txCount };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SearchStore (catalog-search D7)', () => {
  it("sends SET LOCAL statement_timeout = '3s' and one select catalog.search(…) in one transaction", async () => {
    const { db, sent, txCount } = fakeDb();
    const store = new SearchStore(db, new SearchSlots());
    const r = await store.search({ q: 'budget', studioId: 'st', showId: null, limit: 25 });
    expect(r).toEqual(RESULT);
    expect(txCount()).toBe(1);
    expect(sent).toEqual([
      { inTx: true, op: 'run', sql: "SET LOCAL statement_timeout = '3s'", binds: [] },
      {
        inTx: true,
        op: 'first',
        sql: 'select catalog.search(?::text, ?::text, ?::text, ?::int, ?::text) as r',
        binds: ['budget', 'st', null, 25, null],
      },
    ]);
  });

  it('defaults the filters to null and the limit to 5', async () => {
    const { db, sent } = fakeDb();
    await new SearchStore(db, new SearchSlots()).search({ q: 'budget' });
    expect(sent[1]?.binds).toEqual(['budget', null, null, 5, null]);
  });

  it('passes sessionId as the fifth argument, an empty one unchanged (catalog-search D11)', async () => {
    const { db, sent } = fakeDb();
    const store = new SearchStore(db, new SearchSlots());
    await store.search({ q: 'budget', sessionId: 'se1', limit: 25 });
    await store.search({ q: 'budget', sessionId: '' });
    expect(sent.filter((x) => x.op === 'first').map((x) => x.binds)).toEqual([
      ['budget', null, null, 25, 'se1'],
      ['budget', null, null, 5, ''],
    ]);
  });

  it('maps 57014 (statement cancelled by the timeout) to SearchTimeoutError', async () => {
    const cancelled = Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    });
    const { db } = fakeDb(async () => {
      throw cancelled;
    });
    const slots = new SearchSlots();
    const err = await new SearchStore(db, slots).search({ q: 'budget' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchTimeoutError);
    expect((err as Error).name).toBe('SearchTimeoutError');
    expect((err as Error).cause).toBe(cancelled);
    // The slot came back.
    expect(slots.available).toBe(2);
  });

  it('passes any other error through unchanged and releases the slot', async () => {
    const other = Object.assign(new Error('boom'), { code: '42501' });
    const { db } = fakeDb(async () => {
      throw other;
    });
    const slots = new SearchSlots();
    await expect(new SearchStore(db, slots).search({ q: 'budget' })).rejects.toBe(other);
    expect(slots.available).toBe(2);
  });
});

describe('SearchSlots: two searches at once, a third waits up to 1 s (catalog-search D7)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a third concurrent search waits, and gets SearchBusyError after 1 s while two are running', async () => {
    const gates = [deferred<unknown>(), deferred<unknown>()];
    let started = 0;
    const { db } = fakeDb(() => {
      const g = gates[started++];
      if (!g) throw new Error('a third search reached the database');
      return g.promise;
    });
    const slots = new SearchSlots();
    const store = new SearchStore(db, slots);
    const one = store.search({ q: 'a' });
    const two = store.search({ q: 'b' });
    const three = store.search({ q: 'c' });
    let threeOutcome: unknown = 'pending';
    three.then(
      () => {
        threeOutcome = 'resolved';
      },
      (e: unknown) => {
        threeOutcome = e;
      },
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(started).toBe(2);
    expect(threeOutcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(threeOutcome).toBeInstanceOf(SearchBusyError);
    expect((threeOutcome as Error).name).toBe('SearchBusyError');
    expect(started).toBe(2);
    gates[0]?.resolve({ r: RESULT });
    gates[1]?.resolve({ r: RESULT });
    await expect(Promise.all([one, two])).resolves.toEqual([RESULT, RESULT]);
    expect(slots.available).toBe(2);
  });

  it('a waiting search runs as soon as a slot frees within the second', async () => {
    const gates = [deferred<unknown>(), deferred<unknown>(), deferred<unknown>()];
    let started = 0;
    const { db } = fakeDb(() => (gates[started++] as { promise: Promise<unknown> }).promise);
    const store = new SearchStore(db, new SearchSlots());
    const one = store.search({ q: 'a' });
    store.search({ q: 'b' }).catch(() => {});
    const three = store.search({ q: 'c' });
    await vi.advanceTimersByTimeAsync(500);
    expect(started).toBe(2);
    gates[0]?.resolve({ r: RESULT });
    await one;
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(3);
    // Past the original 1 s: the granted search is not timed out as busy.
    await vi.advanceTimersByTimeAsync(2000);
    gates[2]?.resolve({ r: RESULT });
    await expect(three).resolves.toEqual(RESULT);
    gates[1]?.resolve({ r: RESULT });
  });

  it('waiters are served first come, first served', async () => {
    const slots = new SearchSlots(1, 1000);
    const release = await slots.acquire();
    const order: string[] = [];
    const a = slots.acquire().then((r) => {
      order.push('a');
      return r;
    });
    const b = slots.acquire().then((r) => {
      order.push('b');
      return r;
    });
    release();
    (await a)();
    (await b)();
    expect(order).toEqual(['a', 'b']);
    expect(slots.available).toBe(1);
  });

  it('a release is idempotent', async () => {
    const slots = new SearchSlots(2, 1000);
    const release = await slots.acquire();
    release();
    release();
    expect(slots.available).toBe(2);
  });
});

describe('catalog.search on the facade', () => {
  it('runs on the catalog handle and shares the process-wide slots across per-request catalogs', async () => {
    const { db, sent } = fakeDb();
    const a = new Catalog(db);
    const b = new Catalog(db);
    await expect(a.search({ q: 'budget' })).resolves.toEqual(RESULT);
    await expect(b.search({ q: 'budget', showId: 's1', limit: 3 })).resolves.toEqual(RESULT);
    expect(sent.filter((s) => s.op === 'first').map((s) => s.binds)).toEqual([
      ['budget', null, null, 5, null],
      ['budget', null, 's1', 3, null],
    ]);
    expect(SEARCH_SLOTS.size).toBe(2);
    expect(SEARCH_SLOTS.waitMs).toBe(1000);
    expect(SEARCH_SLOTS.available).toBe(2);
    // A method, so the stores stay the only enumerable members.
    expect(Object.keys(a)).not.toContain('search');
  });
});

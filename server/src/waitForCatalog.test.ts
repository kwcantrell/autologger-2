// The boot-time readiness wait (catalog-on-postgres D2): retry until the catalog answers a `kv`
// query, inside one 30 s budget that also bounds each attempt; log each failure code once.

import type { CatalogDb } from '@autologger/ports';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitForCatalog } from './waitForCatalog';

const err = (code: string, message = `value-bearing message for ${code}`) =>
  Object.assign(new Error(message), { code });

function fakeDb(attempts: Array<() => Promise<unknown>>) {
  const sql: string[] = [];
  let i = 0;
  const db = {
    first: (q: string) => {
      sql.push(q);
      const next = attempts[Math.min(i++, attempts.length - 1)];
      return next ? next() : Promise.resolve({ ok: 1 });
    },
  } as unknown as CatalogDb;
  return { db, sql, calls: () => i };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('waitForCatalog', () => {
  it('retries through a refused connection and a missing schema, then resolves', async () => {
    const log = vi.fn();
    const { db, sql, calls } = fakeDb([
      () => Promise.reject(err('ECONNREFUSED')),
      () => Promise.reject(err('42P01')),
      () => Promise.resolve({ ok: 1 }),
    ]);
    const done = waitForCatalog(db, { log });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(done).resolves.toBeUndefined();
    expect(calls()).toBe(3);
    expect(sql[0]).toMatch(/FROM kv/i);
  });

  it('rejects once the 30 s budget is spent, naming the last code', async () => {
    const { db } = fakeDb([() => Promise.reject(err('28P01'))]);
    const done = waitForCatalog(db, { log: () => {} });
    const settled = expect(done).rejects.toThrow(/28P01/);
    await vi.advanceTimersByTimeAsync(29_000);
    let early = true;
    done.catch(() => {}).finally(() => (early = false));
    await Promise.resolve();
    expect(early).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
  });

  it('cuts off an attempt that never settles at the remaining budget', async () => {
    const { db, calls } = fakeDb([() => new Promise(() => {})]);
    const done = waitForCatalog(db, { log: () => {} });
    const settled = expect(done).rejects.toThrow(/not ready/);
    await vi.advanceTimersByTimeAsync(30_001);
    await settled;
    expect(calls()).toBe(1);
  });

  it('logs each distinct code once, with no message text', async () => {
    const log = vi.fn();
    const { db } = fakeDb([
      () => Promise.reject(err('ECONNREFUSED')),
      () => Promise.reject(err('ECONNREFUSED')),
      () => Promise.reject(err('42P01')),
      () => Promise.reject(err('42P01')),
      () => Promise.resolve({ ok: 1 }),
    ]);
    const done = waitForCatalog(db, { log });
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/ECONNREFUSED/);
    expect(lines[1]).toMatch(/42P01/);
    expect(lines.join('\n')).not.toMatch(/value-bearing/);
  });
});

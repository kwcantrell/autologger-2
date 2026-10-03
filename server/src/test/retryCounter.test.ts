// catalog-policies design D11: the test-only retry counter. A fake `CatalogRoot` stands in for
// the adapter: its `tx` re-runs the body on a `40001`/`40P01` up to five runs, as the adapter does.

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogDb, CatalogRoot } from '@autologger/ports';
import { afterEach, describe, expect, it } from 'vitest';
import { RetryCountingRoot } from './retryCounter';

const RETRYABLE = new Set(['40001', '40P01']);

/** A fake handle that records its calls; `tx` re-runs the body like the adapter, at most
 * `maxTries` runs, and can fail a run that returned normally (a commit-time failure). */
class FakeHandle implements CatalogDb {
  constructor(
    readonly calls: string[],
    readonly name: string,
    readonly commitFailures: { left: number } = { left: 0 },
  ) {}

  async all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
    this.calls.push(`${this.name}.all ${sql} ${JSON.stringify(binds)}`);
    return [{ sql } as T];
  }

  async first<T>(sql: string, ...binds: unknown[]): Promise<T | null> {
    this.calls.push(`${this.name}.first ${sql} ${JSON.stringify(binds)}`);
    return { sql } as T;
  }

  async run(sql: string, ...binds: unknown[]): Promise<{ changes: number }> {
    this.calls.push(`${this.name}.run ${sql} ${JSON.stringify(binds)}`);
    return { changes: 7 };
  }

  async tx<T>(fn: (t: CatalogDb) => Promise<T>): Promise<T> {
    const inner = new FakeTxHandle(this.calls, `${this.name}.tx`);
    for (let n = 1; ; n++) {
      try {
        const r = await fn(inner);
        if (this.commitFailures.left > 0) {
          this.commitFailures.left--;
          throw Object.assign(new Error('could not serialize (commit)'), { code: '40001' });
        }
        return r;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (n >= 5 || !RETRYABLE.has(code as string)) throw error;
      }
    }
  }
}

/** The body's handle: `tx` joins (runs the body once on the same handle), as the adapter's does. */
class FakeTxHandle extends FakeHandle {
  override async tx<T>(fn: (t: CatalogDb) => Promise<T>): Promise<T> {
    this.calls.push(`${this.name}.join`);
    return fn(this);
  }
}

class FakeRoot implements CatalogRoot {
  readonly calls: string[] = [];
  readonly commitFailures = { left: 0 };
  bindUser(userId: string): CatalogDb {
    return new FakeHandle(this.calls, `user:${userId}`, this.commitFailures);
  }
  bindSystem(reason: string): CatalogDb {
    return new FakeHandle(this.calls, `system:${reason}`, this.commitFailures);
  }
  async close(): Promise<void> {
    this.calls.push('close');
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function logFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'retry-counter-'));
  dirs.push(d);
  return join(d, 'retries.jsonl');
}

const lines = (path: string): unknown[] =>
  readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

describe('RetryCountingRoot (catalog-policies D11)', () => {
  it('passes root statements of user and system handles through unchanged', async () => {
    const fake = new FakeRoot();
    const path = logFile();
    const root = new RetryCountingRoot(fake, path);
    const u = root.bindUser('u1');
    const s = root.bindSystem('kv');
    expect(await u.all('SELECT 1', 'a')).toEqual([{ sql: 'SELECT 1' }]);
    expect(await u.first('SELECT 2', 'b')).toEqual({ sql: 'SELECT 2' });
    expect(await s.run('UPDATE x', 'c')).toEqual({ changes: 7 });
    await root.close();
    expect(fake.calls).toEqual([
      'user:u1.all SELECT 1 ["a"]',
      'user:u1.first SELECT 2 ["b"]',
      'system:kv.run UPDATE x ["c"]',
      'close',
    ]);
    expect(existsSync(path)).toBe(false);
  });

  it('records a re-run after a 40001 thrown by the body', async () => {
    const path = logFile();
    const root = new RetryCountingRoot(new FakeRoot(), path);
    let n = 0;
    const r = await root.bindUser('u1').tx(async (t) => {
      n++;
      await t.run('UPDATE y');
      if (n === 1) throw { code: '40001' };
      return 'ok';
    });
    expect(r).toBe('ok');
    expect(lines(path)).toEqual([{ runs: 2, codes: ['40001'], exhausted: false }]);
  });

  it('records a re-run after a body that returned normally (a commit-time failure)', async () => {
    const fake = new FakeRoot();
    fake.commitFailures.left = 1;
    const path = logFile();
    const root = new RetryCountingRoot(fake, path);
    expect(await root.bindSystem('kv').tx(async () => 1)).toBe(1);
    expect(lines(path)).toEqual([{ runs: 2, codes: [], exhausted: false }]);
  });

  it('records an exhausted call that rejects with 40001 after five runs', async () => {
    const path = logFile();
    const root = new RetryCountingRoot(new FakeRoot(), path);
    await expect(
      root.bindUser('u1').tx(async () => {
        throw Object.assign(new Error('serialize'), { code: '40001' });
      }),
    ).rejects.toMatchObject({ code: '40001' });
    expect(lines(path)).toEqual([
      { runs: 5, codes: ['40001', '40001', '40001', '40001', '40001'], exhausted: true },
    ]);
  });

  it('records a single run, and a nested tx on the body handle appends nothing of its own', async () => {
    const fake = new FakeRoot();
    const path = logFile();
    const root = new RetryCountingRoot(fake, path);
    const r = await root.bindUser('u1').tx(async (t) => t.tx(async (t2) => t2.first('SELECT 3')));
    expect(r).toEqual({ sql: 'SELECT 3' });
    expect(fake.calls).toContain('user:u1.tx.join');
    expect(lines(path)).toEqual([{ runs: 1, codes: [], exhausted: false }]);
  });

  it('writes nothing without a log path', async () => {
    const root = new RetryCountingRoot(new FakeRoot());
    expect(await root.bindUser('u1').tx(async () => 2)).toBe(2);
    expect(root.calls).toEqual([{ runs: 1, codes: [], exhausted: false }]);
  });
});

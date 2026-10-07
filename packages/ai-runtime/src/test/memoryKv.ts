// Package-local in-memory KvStore test helper (shared-request-state D4). A package may not import
// @autologger/storage (packageBoundaries.repo.test.ts), so this copies the Postgres `KvStore`'s
// semantics exactly: a lazy expiry judged by the injected Clock, `put`'s `expirationTtl` in
// seconds (a falsy TTL means no expiry), an atomic `take`, and a `replaceIf` that swaps only a
// live row still holding `expected`, keeping its expiry unless `{expirationTtl}` is given. The
// server integration tests repeat the key cases on the real Postgres kv. Imports no vitest, so it
// needs no test-infrastructure exemption. A duplicate lives in packages/log-import
// (duplicate-per-package, as with fakeClock.ts).

import type { Clock, KvStore } from '@autologger/ports';

interface Row {
  value: string;
  expiresAt: number | null;
}

export type MemoryKvOp = 'get' | 'put' | 'delete' | 'take' | 'replaceIf';

export class MemoryKv implements KvStore {
  readonly rows = new Map<string, Row>();
  /** Awaited before each operation touches the map: a test can delay or fail one call. */
  before: ((op: MemoryKvOp, key: string) => Promise<void> | void) | null = null;

  constructor(private readonly clock: Clock) {}

  private live(key: string): Row | null {
    const row = this.rows.get(key);
    if (!row) return null;
    if (row.expiresAt !== null && row.expiresAt <= this.clock.now()) {
      this.rows.delete(key);
      return null;
    }
    return row;
  }

  private expiry(ttl: number | undefined): number | null {
    return ttl ? this.clock.now() + ttl * 1000 : null;
  }

  async get(key: string): Promise<string | null> {
    await this.before?.('get', key);
    return this.live(key)?.value ?? null;
  }

  async put(key: string, value: string, opts: { expirationTtl?: number } = {}): Promise<void> {
    await this.before?.('put', key);
    this.rows.set(key, { value, expiresAt: this.expiry(opts.expirationTtl) });
  }

  async delete(key: string): Promise<void> {
    await this.before?.('delete', key);
    this.rows.delete(key);
  }

  async take(key: string): Promise<string | null> {
    await this.before?.('take', key);
    const row = this.live(key);
    this.rows.delete(key);
    return row?.value ?? null;
  }

  async replaceIf(
    key: string,
    expected: string,
    next: string,
    opts: { expirationTtl?: number } = {},
  ): Promise<boolean> {
    await this.before?.('replaceIf', key);
    const row = this.live(key);
    if (!row || row.value !== expected) return false;
    this.rows.set(key, {
      value: next,
      expiresAt: opts.expirationTtl ? this.expiry(opts.expirationTtl) : row.expiresAt,
    });
    return true;
  }

  async purgeExpired(): Promise<void> {
    for (const key of [...this.rows.keys()]) this.live(key);
  }
}

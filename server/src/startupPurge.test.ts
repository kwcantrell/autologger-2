// The KV startup purge is an awaited boot step that never blocks boot (async-session-callers D2).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KvStore } from '@autologger/ports';
import { describe, expect, it, vi } from 'vitest';
import { purgeExpiredAtBoot, startPeriodicPurge } from './startupPurge';

const kvWith = (purgeExpired: () => Promise<void>) => ({ purgeExpired }) as unknown as KvStore;

describe('purgeExpiredAtBoot', () => {
  it('awaits the purge', async () => {
    let done = false;
    const kv = kvWith(async () => {
      await new Promise((r) => setTimeout(r, 5));
      done = true;
    });
    await purgeExpiredAtBoot(kv, vi.fn());
    expect(done).toBe(true);
  });

  it('logs a warning and resolves when the purge fails', async () => {
    const warn = vi.fn();
    const kv = kvWith(async () => {
      throw Object.assign(new Error('database is locked'), { name: 'SqliteError' });
    });
    await expect(purgeExpiredAtBoot(kv, warn)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('SqliteError');
  });

  it('main.ts awaits it before the server listens', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    const purge = main.indexOf('await purgeExpiredAtBoot(');
    expect(purge).toBeGreaterThan(main.indexOf('createBindings(process.env)'));
    expect(purge).toBeLessThan(main.indexOf('serve('));
  });
});

// catalog-database "Expired key/value rows are purged periodically" (catalog-concurrency-hazards D10).
describe('startPeriodicPurge', () => {
  it('purges every 10 minutes without holding the process open, warns on failure, and stops', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const warn = vi.fn();
      const kv = kvWith(async () => {
        calls += 1;
        if (calls === 2) throw Object.assign(new Error('gone'), { code: 'CONNECTION_CLOSED' });
      });
      const timer = startPeriodicPurge(kv, warn);
      expect(timer.hasRef()).toBe(false);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(calls).toBe(2);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/periodic KV purge failed \(CONNECTION_CLOSED\)/);
      clearInterval(timer);
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('main.ts starts it and clears it on shutdown', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    expect(main).toMatch(/const purgeTimer = startPeriodicPurge\(/);
    expect(main).toMatch(/clearInterval\(purgeTimer\)/);
  });
});

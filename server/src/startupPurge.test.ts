// The KV startup purge is an awaited boot step that never blocks boot (async-session-callers D2).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KvStore } from '@autologger/ports';
import { describe, expect, it, vi } from 'vitest';
import { purgeExpiredAtBoot } from './startupPurge';

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

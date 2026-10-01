// One server per DATA_DIR (retire-host-dev D2): an exclusive SQLite file lock held for the
// process lifetime, released by the kernel when the process dies.

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDataDirLock, DataDirLockedError } from './dataDirLock';

const SELF = join(__dirname, 'dataDirLock.ts');
let dir: string;
const fresh = () => (dir = mkdtempSync(join(tmpdir(), 'autologger-lock-')));
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

// A child process that takes the lock, prints LOCKED, and waits (optionally after a forced GC).
function holder(d: string, gc = false) {
  const code = `import { acquireDataDirLock } from ${JSON.stringify(SELF)};
    acquireDataDirLock(${JSON.stringify(d)});
    ${gc ? 'globalThis.gc(); globalThis.gc();' : ''}
    console.log('LOCKED'); setInterval(() => {}, 1000);`;
  // One process (node with the tsx loader), so SIGKILL hits the lock holder itself.
  const c = spawn(
    process.execPath,
    ['--import', 'tsx', ...(gc ? ['--expose-gc'] : []), '--input-type=module', '-e', code],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return new Promise<typeof c>((ok) =>
    c.stdout.on('data', (b) => String(b).includes('LOCKED') && ok(c)),
  );
}
const tryLockElsewhere = (d: string) =>
  spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { acquireDataDirLock } from ${JSON.stringify(SELF)};
    try { acquireDataDirLock(${JSON.stringify(d)}); console.log('ACQUIRED'); } catch (e) { console.log(e.name); }`,
    ],
    { encoding: 'utf8' },
  ).stdout.trim();

describe('acquireDataDirLock', () => {
  it('refuses a second holder in the same process quickly, and frees on release', () => {
    fresh();
    const first = acquireDataDirLock(dir);
    const t = Date.now();
    expect(() => acquireDataDirLock(dir)).toThrow(DataDirLockedError);
    expect(Date.now() - t).toBeLessThan(100);
    first.release();
    acquireDataDirLock(dir).release();
  });
  it('refuses another process while held, and the lock survives forced garbage collection', async () => {
    fresh();
    const c = await holder(dir, true);
    try {
      expect(tryLockElsewhere(dir)).toBe('DataDirLockedError');
    } finally {
      c.kill('SIGKILL');
    }
  }, 30_000);
  it('is released by the kernel when the holder is SIGKILLed', async () => {
    fresh();
    const c = await holder(dir);
    c.kill('SIGKILL');
    await new Promise((ok) => c.on('exit', ok));
    expect(tryLockElsewhere(dir)).toBe('ACQUIRED');
  }, 30_000);
  it('refuses a lock file it cannot write (would otherwise take only a read lock)', () => {
    fresh();
    writeFileSync(join(dir, '.server.lock'), '');
    chmodSync(join(dir, '.server.lock'), 0o444);
    expect(() => acquireDataDirLock(dir)).toThrow();
  });
  it('creates a missing data directory, and names the lock file without a .db suffix', () => {
    fresh();
    const sub = join(dir, 'a', 'b');
    const l = acquireDataDirLock(sub);
    expect(existsSync(join(sub, '.server.lock'))).toBe(true);
    l.release();
  });
});

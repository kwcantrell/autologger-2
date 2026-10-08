// main.ts and PROVIDER_KEYS_SECRET (byo-ai-providers design D2; provider-credentials "Provider keys
// are encrypted at rest and write-only"): spawned the way a stack starts it, on this test's
// database. A missing or malformed secret is refused before the data directory is touched. The
// first boot records a check value; a later boot with a different valid secret exits 1 before
// listening, releases the DATA_DIR lock, and leaves the recorded value as it was.

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testDatabase } from './test/harness';

const SERVER = join(__dirname, '..');
const TSX = join(SERVER, '../node_modules/.bin/tsx');
const S1 = Buffer.alloc(32, 1).toString('base64');
const S2 = Buffer.alloc(32, 2).toString('base64');

let dir: string | null = null;
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) {
    if (c.pid === undefined) continue;
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      // the group is already gone
    }
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** The env a stack gives main.ts, on this test's database; one data directory per test. */
function stackEnv(extra: Record<string, string>): Record<string, string> {
  dir ??= mkdtempSync(join(tmpdir(), 'autologger-boot-keys-'));
  const db = testDatabase();
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    AUTOLOGGER_STACK: 'dev',
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: '0',
    DATA_DIR: join(dir, 'data'),
    PGHOST: db.host,
    PGPORT: String(db.port),
    PGUSER: db.user,
    PGPASSWORD: db.password,
    PGDATABASE: db.database,
    GOOGLE_CLIENT_ID: 'boot-keys-client-id',
    GOOGLE_CLIENT_SECRET: 'boot-keys-client-secret',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    BOOTSTRAP_OWNER_EMAIL: 'bootstrap-owner@example.com',
    SESSION_COOKIE: 'autologger_sid',
    FRAME_BUS_SECRET: 'b'.repeat(48),
    ...extra,
  };
}

function boot(env: Record<string, string>) {
  const out = { stdout: '', stderr: '' };
  const proc = spawn(TSX, [join(SERVER, 'src/main.ts')], {
    cwd: dir ?? undefined,
    env,
    detached: true,
  });
  children.push(proc);
  proc.stdout.on('data', (d) => {
    out.stdout += String(d);
  });
  proc.stderr.on('data', (d) => {
    out.stderr += String(d);
  });
  const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
  const listening = new Promise<number>((resolve, reject) => {
    proc.stdout.on('data', () => {
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(out.stdout);
      if (m) resolve(Number(m[1]));
    });
    void exited.then((code) => reject(new Error(`main.ts exited ${code}: ${out.stderr}`)));
  });
  listening.catch(() => {});
  return { proc, out, exited, listening };
}

async function stop(r: ReturnType<typeof boot>): Promise<void> {
  r.proc.kill('SIGTERM');
  await r.exited;
}

describe('main.ts and PROVIDER_KEYS_SECRET (byo-ai-providers D2)', () => {
  for (const [what, extra] of [
    ['without PROVIDER_KEYS_SECRET', {}],
    ['with a 16-byte PROVIDER_KEYS_SECRET', { PROVIDER_KEYS_SECRET: 'MTIzNDU2Nzg5MDEyMzQ1Ng==' }],
  ] as const) {
    it(`${what}: exits 1 naming it, before the data directory is created`, async () => {
      const r = boot(stackEnv(extra));
      expect(await r.exited).toBe(1);
      expect(r.out.stderr).toMatch(/PROVIDER_KEYS_SECRET/);
      expect(r.out.stderr).not.toMatch(/MTIzNDU2Nzg5MDEyMzQ1Ng/);
      expect(r.out.stdout).not.toMatch(/listening/);
      expect(readdirSync(dir as string)).toEqual([]);
    }, 40_000);
  }

  it('a later boot with a different secret exits 1 before listening, and releases the lock', async () => {
    const first = boot(stackEnv({ PROVIDER_KEYS_SECRET: S1 }));
    await first.listening;
    await stop(first);

    const wrong = boot(stackEnv({ PROVIDER_KEYS_SECRET: S2 }));
    expect(await wrong.exited).toBe(1);
    expect(wrong.out.stderr).toMatch(
      /PROVIDER_KEYS_SECRET does not match the stored provider keys/,
    );
    expect(wrong.out.stderr).not.toContain(S2);
    expect(wrong.out.stdout).not.toMatch(/listening/);

    // The lock was released and the recorded value kept: the original secret boots again.
    const again = boot(stackEnv({ PROVIDER_KEYS_SECRET: S1 }));
    await again.listening;
    await stop(again);
  }, 120_000);
});

// The guard runs before anything touches data (retire-host-dev D1): main.ts is spawned the way a
// host run would start it, in an empty cwd, and must refuse without creating a data directory.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SERVER = join(__dirname, '..');
const TSX = join(SERVER, '../node_modules/.bin/tsx');
let cwd: string;
afterEach(() => cwd && rmSync(cwd, { recursive: true, force: true }));

function boot(
  env: Record<string, string> | ((cwd: string) => Record<string, string>),
  timeout = 30_000,
) {
  cwd = mkdtempSync(join(tmpdir(), 'autologger-boot-'));
  const extra = typeof env === 'function' ? env(cwd) : env;
  const r = spawnSync(TSX, [join(SERVER, 'src/main.ts')], {
    cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, ...extra },
    encoding: 'utf8',
    timeout,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, files: readdirSync(cwd) };
}

describe('main.ts boot order', () => {
  it('outside a compose stack: exits 1 naming make dev-up, creating nothing', () => {
    const r = boot({});
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/make dev-up/);
    expect(r.files).toEqual([]);
    expect(existsSync(join(SERVER, 'data', 'catalog.db.never'))).toBe(false);
  }, 40_000);
  it('with the sentinel but a relative DATA_DIR: exits 1 naming DATA_DIR, creating nothing', () => {
    const r = boot({ AUTOLOGGER_STACK: 'dev', DATA_DIR: 'data' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DATA_DIR/);
    expect(r.files).toEqual([]);
  }, 40_000);
  it('with the sentinel and DATA_DIR but no PGPASSWORD: exits 1 naming it, creating nothing (catalog-on-postgres D2)', () => {
    const r = boot((dir) => ({
      AUTOLOGGER_STACK: 'dev',
      DATA_DIR: join(dir, 'data'),
      PGHOST: '127.0.0.1',
      PGPORT: '1',
      PGUSER: 'autologger_app',
      PGDATABASE: 'postgres',
    }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/PGPASSWORD/);
    expect(r.files).toEqual([]);
  }, 40_000);
  it('with an unreachable catalog: exits 1 after the readiness wait, never listening (catalog-on-postgres D2)', () => {
    const r = boot(
      (dir) => ({
        AUTOLOGGER_STACK: 'dev',
        DATA_DIR: join(dir, 'data'),
        PORT: '0',
        PGHOST: '127.0.0.1',
        PGPORT: '1', // nothing listens on port 1
        PGUSER: 'autologger_app',
        PGPASSWORD: 'unused',
        PGDATABASE: 'postgres',
        // require-login D1: the sign-in settings the boot guard requires before the catalog wait.
        GOOGLE_CLIENT_ID: 'boot-order-client-id',
        GOOGLE_CLIENT_SECRET: 'boot-order-client-secret',
        PUBLIC_BASE_URL: 'http://localhost:8787',
      }),
      45_000,
    );
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/listening/);
    expect(r.stderr).toMatch(/catalog not ready/);
    expect(r.stderr).not.toMatch(/unused/);
  }, 60_000);
});

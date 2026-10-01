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

function boot(env: Record<string, string>) {
  cwd = mkdtempSync(join(tmpdir(), 'autologger-boot-'));
  const r = spawnSync(TSX, [join(SERVER, 'src/main.ts')], {
    cwd,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: r.status, stderr: r.stderr, files: readdirSync(cwd) };
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
});

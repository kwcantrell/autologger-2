// test/bindings.ts is the one hermetic way tests build bindings (job 006): it never resolves the
// operator's credentials file under the real $HOME, it restores HOME whatever happens, and no other
// test file builds bindings without it.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testBindings } from './bindings';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function procEnv(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'autologger-bindings-'));
  const blobs = mkdtempSync(join(tmpdir(), 'autologger-bindings-blobs-'));
  dirs.push(dir, blobs);
  // The adapter connects lazily; port 1 is never dialled.
  return {
    DATA_DIR: dir,
    BLOB_DIR: blobs,
    PUBLIC_BASE_URL: 'https://example.com',
    PGHOST: '127.0.0.1',
    PGPORT: '1',
    PGUSER: 'autologger_app',
    PGPASSWORD: 'unused',
    PGDATABASE: 'postgres',
  };
}

describe('testBindings', () => {
  it('never resolves AI_V2_CREDENTIAL_SOURCE_PATH or AI_CHAT_CLI_HOME under the real $HOME', async () => {
    const realHome = homedir();
    const { bindings, close, home } = testBindings(procEnv());
    try {
      const path = bindings.config.AI_V2_CREDENTIAL_SOURCE_PATH;
      expect(path).toBe(join(home, '.claude', '.credentials.json'));
      expect(home).not.toBe(realHome);
      expect(path).not.toBe(join(realHome, '.claude', '.credentials.json'));
      expect(relative(realHome, path).startsWith('..')).toBe(true);
      expect(bindings.config.AI_CHAT_CLI_HOME).toBe(home);
      // The stand-in home is gone, so there is nothing at the path to read.
      expect(existsSync(home)).toBe(false);
      expect(existsSync(path)).toBe(false);
      expect(homedir()).toBe(realHome);
    } finally {
      await close();
    }
  });

  it('gives each call its own stand-in home', async () => {
    const a = testBindings(procEnv());
    const b = testBindings(procEnv());
    try {
      expect(a.home).not.toBe(b.home);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('restores HOME and removes the stand-in when createBindings throws', () => {
    const env = procEnv();
    // A private TMPDIR, so other workers' stand-ins can't show up in the listing.
    const tmp = mkdtempSync(join(tmpdir(), 'autologger-bindings-tmp-'));
    dirs.push(tmp);
    const before = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
    process.env.TMPDIR = tmp;
    try {
      expect(() => testBindings({ ...env, DATA_DIR: 'relative' })).toThrow(/DATA_DIR/);
      expect(process.env.HOME).toBe(before.HOME);
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      if (before.TMPDIR === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before.TMPDIR;
    }
  });

  it('restores an unset HOME as unset', async () => {
    const before = process.env.HOME;
    delete process.env.HOME;
    try {
      const { close } = testBindings(procEnv());
      await close();
      expect('HOME' in process.env).toBe(false);
    } finally {
      process.env.HOME = before;
    }
  });
});

describe('no test builds bindings around the helper', () => {
  it('only test/bindings.ts calls createBindings among test code', () => {
    const src = join(__dirname, '..');
    const offenders = readdirSync(src, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => relative(src, join(e.parentPath, e.name)))
      .filter((f) => f.endsWith('.test.ts') || f.startsWith('test/'))
      .filter((f) => f !== 'test/bindings.ts')
      .filter((f) => /createBindings\(/.test(readFileSync(join(src, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

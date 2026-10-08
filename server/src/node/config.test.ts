// Startup wiring for createBindings() -- notably the NEW_USER_ALL_TEAMS
// deprecation warning (design D5, teams-self-serve). Plain node tier (no
// setup.int.ts harness needed): createBindings builds its own temp-dir
// bindings from a procEnv object, same shape test/harness.ts uses per test.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireDataDirLock, DataDirLockedError } from '@autologger/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loopbackHostname } from '../env';
import { createBindings } from './config';

let dir: string;
// shared-blob-volume D8 category 1: each env's BLOB_DIR is a sibling temp dir, never inside DATA_DIR.
let blobDir: string;
const madeDirs: string[] = [];
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const d of madeDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshProcEnv(overrides: Record<string, string | undefined> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'autologger-config-'));
  blobDir = mkdtempSync(join(tmpdir(), 'autologger-config-blobs-'));
  madeDirs.push(dir, blobDir);
  return {
    DATA_DIR: dir,
    BLOB_DIR: blobDir,
    PUBLIC_BASE_URL: 'https://example.com',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    BOOTSTRAP_OWNER_EMAIL: 'bootstrap-owner@example.com',
    // Dummy catalog settings: the adapter connects lazily, so nothing here dials them
    // (catalog-on-postgres A14). Port 1 is never listening.
    PGHOST: '127.0.0.1',
    PGPORT: '1',
    PGUSER: 'autologger_app',
    PGPASSWORD: 'unused',
    PGDATABASE: 'postgres',
    ...overrides,
  };
}

describe('createBindings -- NEW_USER_ALL_TEAMS deprecation (design D5)', () => {
  it('logs a one-time startup warning when NEW_USER_ALL_TEAMS is truthy', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { close } = createBindings(freshProcEnv({ NEW_USER_ALL_TEAMS: '1' }));
      try {
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.join(' ')).toMatch(/NEW_USER_ALL_TEAMS.*deprecated/i);
      } finally {
        await close();
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when NEW_USER_ALL_TEAMS is unset/falsy', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { close } = createBindings(freshProcEnv({ NEW_USER_ALL_TEAMS: '0' }));
      try {
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('createBindings -- AI_V2_CREDENTIAL_SOURCE_PATH has NO environment override (ruling E6)', () => {
  it(
    'resolves the credential source path to EXACTLY join(homedir(), ".claude", ' +
      '".credentials.json") — never a same-named env var, a differently-named one, nor any ' +
      'other root — set to attacker-controlled sentinels. The value names a file copied into a ' +
      "subprocess's CLAUDE_CONFIG_DIR, so any env override (by either key) would be an " +
      'arbitrary-file-read primitive. Pinning the exact expected value (not just a suffix) also ' +
      'catches a correct-suffixed-but-wrong-rooted resolution, which a suffix-only assertion ' +
      'cannot distinguish from the real thing (phase-2 fix2 re-review, finding A).',
    async () => {
      const base = freshProcEnv({
        AI_V2_CREDENTIAL_SOURCE_PATH: '/etc/passwd',
        // A plausible differently-named override a buggy implementation
        // might read instead of/in addition to the field's own name.
        CLAUDE_CREDENTIALS_FILE: '/etc/shadow',
        // Boot validates AI_PROVIDER, so it needs a valid value here (run-status-and-sweeper D7
        // category 2); it has no bearing on the credential path.
        AI_PROVIDER: 'claude_cli',
      });
      // Pinning two sentinel KEY NAMES only proves an implementation that
      // happens to read one of those two names is caught -- a third,
      // unanticipated key name (e.g. CLAUDE_CREDS_PATH) would fall through
      // to the correct value and pass a two-key guard silently (audit
      // finding I-1). A Proxy that returns an attacker sentinel for EVERY
      // key read -- not just the two named here -- pins the actual
      // property under test: "the value depends on no environment key,"
      // not "the value depends on none of these two specific keys." Keys
      // `freshProcEnv` itself supplies (DATA_DIR, PUBLIC_BASE_URL, ...) are
      // passed through unchanged so createBindings' other, legitimate
      // procEnv reads are unaffected.
      const anyKeyIsAttackerControlled = new Proxy(base as Record<string, unknown>, {
        get: (t, k) => (k in t ? t[k as string] : '/etc/attacker'),
      }) as unknown as Record<string, string>;
      const { bindings, close } = createBindings(anyKeyIsAttackerControlled);
      try {
        expect(bindings.config.AI_V2_CREDENTIAL_SOURCE_PATH).toBe(
          join(homedir(), '.claude', '.credentials.json'),
        );
        expect(bindings.config.AI_V2_CREDENTIAL_SOURCE_PATH).not.toBe('/etc/passwd');
        expect(bindings.config.AI_V2_CREDENTIAL_SOURCE_PATH).not.toBe('/etc/shadow');
      } finally {
        await close();
      }
    },
  );
});

describe('createBindings -- DATA_DIR is required and absolute (retire-host-dev D1)', () => {
  it('throws without DATA_DIR, with an empty one, or with a relative one', () => {
    for (const v of [undefined, '', 'data', './data']) {
      expect(() => createBindings({ ...freshProcEnv(), DATA_DIR: v }), String(v)).toThrow(
        /DATA_DIR/,
      );
    }
  });
});

describe('createBindings -- one server per DATA_DIR (retire-host-dev D2)', () => {
  it('refuses a held DATA_DIR before creating or sweeping anything', () => {
    const env = freshProcEnv();
    const scratch = join(dir, 'tmp', 'youtube-import-planted');
    mkdirSync(scratch, { recursive: true });
    const lock = acquireDataDirLock(dir);
    try {
      expect(() => createBindings(env)).toThrow(DataDirLockedError);
      expect(existsSync(scratch)).toBe(true); // the sweep never ran
      expect(existsSync(join(dir, 'catalog.db'))).toBe(false);
      expect(existsSync(join(dir, 'sessions'))).toBe(false); // nothing was created
    } finally {
      lock.release();
    }
  });
  it('releases the lock on close, so the same DATA_DIR can boot again', async () => {
    const env = freshProcEnv();
    await createBindings(env).close();
    await createBindings(env).close();
  });
});

describe('createBindings -- one effective host (retire-host-dev D3)', () => {
  it('defaults HOST to loopback outside production, and the loopback checks agree', async () => {
    for (const NODE_ENV of [undefined, 'development']) {
      const b = createBindings({ ...freshProcEnv(), NODE_ENV });
      try {
        expect(b.bindings.config.HOST).toBe('127.0.0.1');
        expect(loopbackHostname(b.bindings.config)).toBe(true);
      } finally {
        await b.close();
      }
    }
  });
  it('defaults HOST to every interface in production, and keeps an explicit HOST', async () => {
    const p = createBindings({ ...freshProcEnv(), NODE_ENV: 'production' });
    try {
      expect(p.bindings.config.HOST).toBe('0.0.0.0');
    } finally {
      await p.close();
    }
    const e = createBindings({ ...freshProcEnv(), HOST: '10.1.2.3' });
    try {
      expect(e.bindings.config.HOST).toBe('10.1.2.3');
    } finally {
      await e.close();
    }
  });
});

describe('createBindings -- the catalog is Postgres (catalog-on-postgres D1)', () => {
  it('refuses each missing PG* setting by name, before taking the DATA_DIR lock', async () => {
    const env = freshProcEnv();
    for (const k of ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE']) {
      expect(() => createBindings({ ...env, [k]: undefined }), k).toThrow(new RegExp(k));
      expect(() => createBindings({ ...env, [k]: '' }), k).toThrow(new RegExp(k));
    }
    expect(existsSync(join(dir, 'sessions'))).toBe(false); // nothing was created
    await createBindings(env).close(); // and the lock was never held
  });

  it('opens no catalog.db, and close() returns a promise', async () => {
    const b = createBindings(freshProcEnv());
    const closed = b.close();
    expect(closed).toBeInstanceOf(Promise);
    await closed;
    expect(existsSync(join(dir, 'catalog.db'))).toBe(false);
  });

  it('opens no catalog connection: the KV purge and readiness wait are boot steps in main.ts', async () => {
    let connections = 0;
    const server = createServer((s) => {
      connections++;
      s.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as { port: number }).port;
      const b = createBindings(freshProcEnv({ PGPORT: String(port) }));
      await new Promise((r) => setTimeout(r, 300));
      await b.close();
      expect(connections).toBe(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('createBindings -- BOOTSTRAP_OWNER_EMAIL (owner-bootstrap D8)', () => {
  it('passes the value through to Config, and defaults to empty', async () => {
    const set = createBindings(freshProcEnv());
    try {
      expect(set.bindings.config.BOOTSTRAP_OWNER_EMAIL).toBe('bootstrap-owner@example.com');
    } finally {
      await set.close();
    }
    const unset = createBindings(freshProcEnv({ BOOTSTRAP_OWNER_EMAIL: undefined }));
    try {
      expect(unset.bindings.config.BOOTSTRAP_OWNER_EMAIL).toBe('');
    } finally {
      await unset.close();
    }
  });
});

describe('createBindings -- AI_PROVIDER (run-status-and-sweeper D1)', () => {
  it('refuses an unknown AI_PROVIDER before taking the DATA_DIR lock', async () => {
    const env = freshProcEnv();
    expect(() => createBindings({ ...env, AI_PROVIDER: 'openai' })).toThrow(
      'AI_PROVIDER must be one of: claude_cli (got "openai")',
    );
    expect(existsSync(join(dir, 'sessions'))).toBe(false); // nothing was created
    await createBindings(env).close(); // and the lock was never held
  });
  it('carries claude_cli on Config when unset', async () => {
    const b = createBindings(freshProcEnv());
    try {
      expect(b.bindings.config.AI_PROVIDER).toBe('claude_cli');
    } finally {
      await b.close();
    }
  });
});

describe('createBindings -- BLOB_DIR (shared-blob-volume D1-D4)', () => {
  const LEGACY_LINE =
    'autologger: DATA_DIR/blobs holds 3 legacy audio file(s) the server no longer reads; move ' +
    'them into BLOB_DIR (README "Moving audio into BLOB_DIR")';

  it('refuses an unset, relative or overlapping BLOB_DIR before the lock, creating nothing', async () => {
    const env = freshProcEnv();
    const refused: Array<[string | undefined, RegExp]> = [
      [undefined, /BLOB_DIR must be set to an absolute path/],
      ['', /BLOB_DIR must be set to an absolute path/],
      ['blobs', /BLOB_DIR must be set to an absolute path/],
      ['./blobs', /BLOB_DIR must be set to an absolute path/],
      [dir, /BLOB_DIR and DATA_DIR must be separate/], // equal
      [`${dir}/`, /BLOB_DIR and DATA_DIR must be separate/], // equal after path.resolve
      [join(dir, 'blobs'), /BLOB_DIR and DATA_DIR must be separate/], // blob inside data
      [dirname(dir), /BLOB_DIR and DATA_DIR must be separate/], // data inside blob
      ['/', /BLOB_DIR and DATA_DIR must be separate/], // '/' overlaps everything
    ];
    for (const [v, re] of refused) {
      expect(() => createBindings({ ...env, BLOB_DIR: v }), String(v)).toThrow(re);
    }
    expect(readdirSync(dir)).toEqual([]); // no lock file, no tmp, no blobs
    expect(readdirSync(blobDir)).toEqual([]);
    await createBindings(env).close(); // and the lock was never held
  });

  it('a second server with another DATA_DIR and the same BLOB_DIR boots', async () => {
    const a = freshProcEnv();
    const b = freshProcEnv({ BLOB_DIR: a.BLOB_DIR });
    expect(b.DATA_DIR).not.toBe(a.DATA_DIR);
    const first = createBindings(a);
    try {
      const second = createBindings(b);
      await second.close();
    } finally {
      await first.close();
    }
  });

  it('creates BLOB_DIR/.tmp and DATA_DIR/tmp, not DATA_DIR/blobs; the store writes to BLOB_DIR', async () => {
    const b = createBindings(freshProcEnv());
    try {
      expect(existsSync(join(blobDir, '.tmp'))).toBe(true);
      expect(existsSync(join(dir, 'tmp'))).toBe(true);
      expect(existsSync(join(dir, 'blobs'))).toBe(false);
      expect(b.bindings.ports.audio.scratchRoot()).toBe(join(dir, 'tmp'));
      await b.bindings.ports.audio.put('audio/s1/0001_k.webm', new Uint8Array([1, 2, 3]));
      expect(readFileSync(join(blobDir, 'audio', 's1', '0001_k.webm'))).toEqual(
        Buffer.from([1, 2, 3]),
      );
      expect(readdirSync(join(blobDir, '.tmp'))).toEqual([]);
    } finally {
      await b.close();
    }
  });

  it('sweeps put- temp files older than 24 h from BLOB_DIR/.tmp at boot', async () => {
    const env = freshProcEnv();
    const tmp = join(blobDir, '.tmp');
    mkdirSync(tmp);
    for (const name of ['put-old', 'put-young', 'other-old']) writeFileSync(join(tmp, name), 'x');
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    const aMinuteAgo = (Date.now() - 60_000) / 1000;
    utimesSync(join(tmp, 'put-old'), twoDaysAgo, twoDaysAgo);
    utimesSync(join(tmp, 'other-old'), twoDaysAgo, twoDaysAgo);
    utimesSync(join(tmp, 'put-young'), aMinuteAgo, aMinuteAgo);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await createBindings(env).close();
      expect(readdirSync(tmp).sort()).toEqual(['other-old', 'put-young']);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('warns once, naming the count and the README section, when DATA_DIR/blobs holds files', async () => {
    const env = freshProcEnv();
    const legacy = join(dir, 'blobs', 'audio', 'sid-1');
    mkdirSync(legacy, { recursive: true });
    mkdirSync(join(dir, 'blobs', 'audio', 'sid-2'), { recursive: true });
    writeFileSync(join(legacy, '0001_a.webm'), 'a');
    writeFileSync(join(legacy, '0002_b.webm'), 'b');
    writeFileSync(join(dir, 'blobs', 'audio', 'sid-2', '0001_c.webm'), 'c');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await createBindings(env).close();
      const lines = warnSpy.mock.calls.map((c) => c.join(' ')).filter((l) => /legacy/.test(l));
      expect(lines).toEqual([LEGACY_LINE]);
      // never read, moved or deleted
      expect(readFileSync(join(legacy, '0001_a.webm'), 'utf8')).toBe('a');
      expect(readdirSync(legacy).sort()).toEqual(['0001_a.webm', '0002_b.webm']);
      expect(existsSync(join(blobDir, 'audio'))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when DATA_DIR/blobs is empty or missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await createBindings(freshProcEnv()).close(); // missing
      const env = freshProcEnv();
      mkdirSync(join(dir, 'blobs', 'audio', 'sid-1'), { recursive: true }); // empty dirs only
      await createBindings(env).close();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

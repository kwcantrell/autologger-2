// Startup wiring for createBindings() -- notably the NEW_USER_ALL_TEAMS
// deprecation warning (design D5, teams-self-serve). Plain node tier (no
// setup.int.ts harness needed): createBindings builds its own temp-dir
// bindings from a procEnv object, same shape test/harness.ts uses per test.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDataDirLock, DataDirLockedError } from '@autologger/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loopbackHostname } from '../env';
import { createBindings } from './config';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function freshProcEnv(overrides: Record<string, string | undefined> = {}) {
  dir = mkdtempSync(join(tmpdir(), 'autologger-config-'));
  return {
    DATA_DIR: dir,
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

// Startup wiring for createBindings() -- notably the NEW_USER_ALL_TEAMS
// deprecation warning (design D5, teams-self-serve). Plain node tier (no
// setup.int.ts harness needed): createBindings builds its own temp-dir
// bindings from a procEnv object, same shape test/harness.ts uses per test.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDataDirLock, DataDirLockedError } from '@autologger/storage';
import Database from 'better-sqlite3';
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
    REQUIRE_LOGIN: '0',
    ...overrides,
  };
}

describe('createBindings -- NEW_USER_ALL_TEAMS deprecation (design D5)', () => {
  it('logs a one-time startup warning when NEW_USER_ALL_TEAMS is truthy', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { close } = createBindings(freshProcEnv({ NEW_USER_ALL_TEAMS: '1' }));
      try {
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0]?.join(' ')).toMatch(/NEW_USER_ALL_TEAMS.*deprecated/i);
      } finally {
        close();
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not warn when NEW_USER_ALL_TEAMS is unset/falsy', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { close } = createBindings(freshProcEnv({ NEW_USER_ALL_TEAMS: '0' }));
      try {
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        close();
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
    () => {
      const base = freshProcEnv({
        AI_V2_CREDENTIAL_SOURCE_PATH: '/etc/passwd',
        // A plausible differently-named override a buggy implementation
        // might read instead of/in addition to the field's own name.
        CLAUDE_CREDENTIALS_FILE: '/etc/shadow',
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
        close();
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
  it('refuses a held DATA_DIR before migrating, creating or sweeping anything', () => {
    const env = freshProcEnv();
    const scratch = join(dir, 'tmp', 'youtube-import-planted');
    mkdirSync(scratch, { recursive: true });
    const lock = acquireDataDirLock(dir);
    try {
      expect(() => createBindings(env)).toThrow(DataDirLockedError);
      expect(existsSync(scratch)).toBe(true); // the sweep never ran
      expect(existsSync(join(dir, 'catalog.db'))).toBe(false); // no migration ran
      expect(existsSync(join(dir, 'sessions'))).toBe(false); // nothing was created
    } finally {
      lock.release();
    }
  });
  it('releases the lock on close, so the same DATA_DIR can boot again', () => {
    const env = freshProcEnv();
    createBindings(env).close();
    createBindings(env).close();
  });
});

describe('createBindings -- one effective host (retire-host-dev D3)', () => {
  it('defaults HOST to loopback outside production, and the loopback checks agree', () => {
    for (const NODE_ENV of [undefined, 'development']) {
      const b = createBindings({ ...freshProcEnv(), NODE_ENV });
      try {
        expect(b.bindings.config.HOST).toBe('127.0.0.1');
        expect(loopbackHostname(b.bindings.config)).toBe(true);
      } finally {
        b.close();
      }
    }
  });
  it('defaults HOST to every interface in production, and keeps an explicit HOST', () => {
    const p = createBindings({ ...freshProcEnv(), NODE_ENV: 'production' });
    try {
      expect(p.bindings.config.HOST).toBe('0.0.0.0');
    } finally {
      p.close();
    }
    const e = createBindings({ ...freshProcEnv(), HOST: '10.1.2.3' });
    try {
      expect(e.bindings.config.HOST).toBe('10.1.2.3');
    } finally {
      e.close();
    }
  });
});

describe('createBindings -- the KV purge is a boot step, not part of createBindings (async-session-callers D2)', () => {
  it('leaves an expired KV row in place', () => {
    const env = freshProcEnv();
    createBindings(env).close();
    const db = new Database(join(dir, 'catalog.db'));
    db.prepare('INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)').run('dead', 'x', 1);
    db.close();
    const { close } = createBindings(env);
    close();
    const after = new Database(join(dir, 'catalog.db'));
    expect(after.prepare('SELECT COUNT(*) AS n FROM kv WHERE key = ?').get('dead')).toEqual({
      n: 1,
    });
    after.close();
  });
});

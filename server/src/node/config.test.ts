// Startup wiring for createBindings() -- notably the NEW_USER_ALL_TEAMS
// deprecation warning (design D5, teams-self-serve). Plain node tier (no
// setup.int.ts harness needed): createBindings builds its own temp-dir
// bindings from a procEnv object, same shape test/harness.ts uses per test.

import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

// Startup wiring for createBindings() -- notably the NEW_USER_ALL_TEAMS
// deprecation warning (design D5, teams-self-serve). Plain node tier (no
// setup.int.ts harness needed): createBindings builds its own temp-dir
// bindings from a procEnv object, same shape test/harness.ts uses per test.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// Per-test Node bindings over a temp DATA_DIR — the isolatedStorage equivalent.
// `env` is a Proxy so existing `{...env, ...overrides}` spreads keep working.

import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpgradeWebSocket } from 'hono/ws';
import { wireApp } from '../app';
import { createBindings } from '../node/config';
import type { AppEnv, Bindings } from '../types';

let current: { bindings: Bindings; close(): void; dir: string } | null = null;

export function resetTestEnv(): void {
  teardownTestEnv();
  const dir = mkdtempSync(join(tmpdir(), 'autologger-int-'));
  const made = createBindings({
    DATA_DIR: dir,
    PUBLIC_BASE_URL: 'https://example.com',
    // Empty: the historical test vars set GOOGLE_CLIENT_ID="" so
    // oauthConfigured() is false in the base test env (anonymous /api/studio
    // and PUT /api/profile depend on it). OAuth suites opt in via envWith.
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    REQUIRE_LOGIN: '0', // the historical test default; gate tests override per-request
    SESSION_COOKIE: 'autologger_sid',
    SESSION_DAYS: '14',
    NEW_USER_ALL_TEAMS: '0',
    COOKIE_SECURE: '',
    IP_ALLOWLIST: '',
    TRUST_PROXY: '',
    API_TOKEN: 'test-api-token',
    ADMIN_TOKEN: 'test-admin-token',
  });
  current = { ...made, dir };
}

export function teardownTestEnv(): void {
  if (!current) return;
  current.close();
  rmSync(current.dir, { recursive: true, force: true });
  current = null;
}

function must(): Bindings {
  if (!current) throw new Error('test env not initialized — is setup.int.ts registered?');
  return current.bindings;
}

export const env: Bindings = new Proxy({} as Bindings, {
  get: (_t, p) => (must() as unknown as Record<string | symbol, unknown>)[p],
  has: (_t, p) => p in must(),
  ownKeys: () => Reflect.ownKeys(must()),
  getOwnPropertyDescriptor: (_t, p) => ({
    enumerable: true,
    configurable: true,
    value: (must() as unknown as Record<string | symbol, unknown>)[p],
  }),
});

/** Layer per-request Config overrides over the live per-test bindings. Safe to
 * call at module scope — property reads resolve at request time, after setup. */
export function envWith(overrides: Record<string, unknown>): Bindings {
  const read = (p: string | symbol): unknown => {
    if (p === 'config') return { ...must().config, ...overrides };
    return (must() as unknown as Record<string | symbol, unknown>)[p];
  };
  return new Proxy({} as Bindings, {
    get: (_t, p) => read(p),
    has: (_t, p) => p in must(),
    ownKeys: () => Reflect.ownKeys(must()),
    getOwnPropertyDescriptor: (_t, p) => ({
      enumerable: true,
      configurable: true,
      value: read(p),
    }),
  });
}

const upgradeStub = ((() => async (c: { text(b: string, s: number): Response }) =>
  c.text('WebSocket unavailable in HTTP tests', 426)) as unknown) as UpgradeWebSocket;

export const app = wireApp(new Hono<AppEnv>(), upgradeStub);

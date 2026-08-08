// Per-test Node bindings over a temp DATA_DIR — the isolatedStorage equivalent.
// `env` is a Proxy so existing `{...env, ...overrides}` spreads keep working.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { wireApp } from '../app';
import type { AppEnv, Bindings } from '../appEnv';
import { createBindings } from '../node/config';

let current: { bindings: Bindings; close(): void; dir: string } | null = null;

export function resetTestEnv(): void {
  teardownTestEnv();
  const dir = mkdtempSync(join(tmpdir(), 'autologger-int-'));
  // Hermetic stand-in for the operator's home directory (ai-runtime-package
  // task 2.5, closing the leak task 2.1 found): `createBindings` resolves
  // `Config.AI_V2_CREDENTIAL_SOURCE_PATH` from `homedir()` exactly once, at
  // construction time below. Pointing `HOME` at a fresh, always-empty temp
  // dir for the duration of that one call means the resolved path can never
  // land on a REAL `~/.claude/.credentials.json` — a machine that happens to
  // have one no longer has it silently read (existsSync-checked, and
  // potentially copied into a throwaway temp dir) by every integration test
  // that reaches the AI v2 design route with no workspace key configured.
  // `os.homedir()` reads `process.env.HOME` directly on this deployment
  // target (POSIX/Linux — verified with a throwaway `node -e` check, same
  // finding task 2.1's characterization tests already recorded). HOME is
  // restored and the temp dir removed immediately after — nothing downstream
  // depends on either persisting, since only the resolved PATH STRING is kept
  // (on `Config`), never the directory itself.
  //
  // Hermeticity here is a property of THIS HELPER (phase-2 review, finding
  // 3), not of `createBindings` itself: eight other test call sites across
  // the suite construct bindings directly (bypassing `resetTestEnv`/`envWith`
  // entirely) and so resolve `AI_V2_CREDENTIAL_SOURCE_PATH` from the
  // operator's REAL `$HOME`. None of them drives an AI v2 design turn today,
  // so nothing ever reads the file — but any NEW test that constructs
  // bindings directly AND drives `ai/v2/design` must shim `HOME` the same way
  // this function does, or it inherits the leak this function exists to
  // close.
  const fakeHome = mkdtempSync(join(tmpdir(), 'autologger-int-home-'));
  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  let made: { bindings: Bindings; close(): void };
  try {
    made = createBindings({
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
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
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

/** Layer per-request Config overrides — and, since ai-runtime-package task
 * 2.4, per-request **Ports** overrides — over the live per-test bindings. Safe
 * to call at module scope: property reads resolve at request time, after setup.
 *
 * The `ports` arm exists because `createBindings` hardwires `ports.clock` to
 * the real `systemClock`, so no integration test could supply a controllable
 * clock through `c.env.ports.clock`. That made the Clock threaded through the
 * AI runtime in task 2.2 **unobservable**: swapping a router's
 * `c.env.ports.clock` for a freshly constructed clock left every integration
 * test green — a seam satisfied in shape while defeated in purpose. With this
 * arm a test can inject a fake clock and assert what the router actually
 * handed downstream.
 *
 * `ports` is returned **by identity** when no override is given, so every
 * pre-existing caller sees exactly the object it saw before; only an
 * override-bearing call pays for a fresh spread. Members are copied by
 * reference, so stateful services (the hub registry, the KV store) are shared
 * with the live bindings either way.
 *
 * Note the asymmetry (phase-2 review, finding 3): when overrides ARE supplied,
 * the returned `ports` CONTAINER is a fresh object per property read (`e.ports
 * !== e.ports` across two reads of the same `envWith(...)` result) — only the
 * MEMBERS are the stable thing, by reference, per the paragraph above.
 * Identity of the container itself is preserved only when overrides are
 * unused. This breaks no invariant: the CLAUDE.md `@hono/node-ws` "mutate
 * env in place, fresh env per request" rule governs the per-request `env`
 * object Hono compares on WS upgrade, which stays stable per `envWith()`
 * call — that rule was never about `ports` container identity. */
export function envWith(
  overrides: Record<string, unknown>,
  portOverrides: Partial<Bindings['ports']> = {},
): Bindings {
  const hasPortOverrides = Object.keys(portOverrides).length > 0;
  const read = (p: string | symbol): unknown => {
    if (p === 'config') return { ...must().config, ...overrides };
    if (p === 'ports' && hasPortOverrides) return { ...must().ports, ...portOverrides };
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

const upgradeStub = (() => async (c: { text(b: string, s: number): Response }) =>
  c.text('WebSocket unavailable in HTTP tests', 426)) as unknown as UpgradeWebSocket;

export const app = wireApp(new Hono<AppEnv>(), upgradeStub);

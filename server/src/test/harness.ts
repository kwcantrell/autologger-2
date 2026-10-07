// Per-test Node bindings over a temp DATA_DIR and a fresh Postgres catalog cloned from the
// migrated template (catalog-on-postgres D6) — the isolatedStorage equivalent.
// `env` is a Proxy so existing `{...env, ...overrides}` spreads keep working.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog } from '@autologger/catalog';
import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { type ConnOptions, createTestDatabase } from '../../../test/pg/testDb';
import { wireApp } from '../app';
import type { AppEnv, Bindings } from '../appEnv';
import { createLoginSession } from '../auth/identity';
import { sessionCookieName } from '../env';
import { createBindings } from '../node/config';
import { RetryCountingRoot } from './retryCounter';

let current: {
  bindings: Bindings;
  close(): Promise<void>;
  dir: string;
  db: ConnOptions;
  defaultUser: Promise<{ id: string; cookie: string }> | null;
} | null = null;

export async function resetTestEnv(): Promise<void> {
  await teardownTestEnv();
  const db = (await createTestDatabase()).app;
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
  let made: { bindings: Bindings; close(): Promise<void> };
  try {
    made = createBindings({
      DATA_DIR: dir,
      PUBLIC_BASE_URL: 'https://example.com',
      // Sign-in is configured, as the boot guard requires of every running server (require-login
      // D1/D7), so oauthConfigured() is true in the base test env.
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      // owner-bootstrap D13: an address no suite signs in with, so no sign-in claims by accident.
      BOOTSTRAP_OWNER_EMAIL: 'bootstrap-owner@example.com',
      // run-status-and-sweeper D7 category 5: seeded users and the default user run the six run
      // routes as approved users; negative cases seed an explicit, non-approved email.
      RUN_FEATURE_EMAILS: 'seeded-user@example.com,default-user@example.com',
      SESSION_COOKIE: 'autologger_sid',
      SESSION_DAYS: '14',
      NEW_USER_ALL_TEAMS: '0',
      COOKIE_SECURE: '',
      IP_ALLOWLIST: '',
      TRUST_PROXY: '',
      API_TOKEN: 'test-api-token',
      ADMIN_TOKEN: 'test-admin-token',
      PGHOST: db.host,
      PGPORT: String(db.port),
      PGUSER: db.user,
      PGPASSWORD: db.password,
      PGDATABASE: db.database,
    });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
  // catalog-policies D11: with CATALOG_RETRY_LOG set, count the retries of every transaction the
  // routes and suites run on the catalog (KV and the session hubs keep their own handles; KV's
  // root statements never retry). A `GatedCatalog(env.ports.catalog)` then wraps the counting root.
  const retryLog = process.env.CATALOG_RETRY_LOG;
  if (retryLog) {
    made.bindings.ports.catalog = new RetryCountingRoot(made.bindings.ports.catalog, retryLog);
  }
  current = { ...made, dir, db, defaultUser: null };
}

/** The current test's database as the app role, for a second adapter over it (a second server
 * process, session-tables D12). */
export function testDatabase(): ConnOptions {
  if (!current) throw new Error('test env not initialized — is setup.int.ts registered?');
  return current.db;
}

/** The default signed-in caller (require-login D7): an `admin` of the two seed teams
 * (`test-studios`, `test-studio-2`; owner-bootstrap D13) only, so it reaches every show there
 * without a grant (show-grants D14; an admin, not the owner, so the bootstrap claim still finds
 * the seed teams ownerless). `seededSession()` and `seedMemberStudio()` add the same `admin`
 * membership for their fresh studio; `seedStudio` adds none, so team and admin suites see no extra
 * member. The member path is covered by `seedAccessMatrix()`. Created on first use (the wrapped `app` adding its cookie,
 * or `seededSession()`), so a suite that never signs in as it — the admin users capture — sees no
 * extra user either. */
export function defaultUser(): Promise<{ id: string; cookie: string }> {
  const cur = current;
  if (!cur) throw new Error('test env not initialized — is setup.int.ts registered?');
  cur.defaultUser ??= (async () => {
    const catalog = createCatalog(cur.bindings.ports.catalog).system('test-seed');
    const id = crypto.randomUUID();
    await catalog.auth.authCreateUserGoogle({
      id,
      email: 'default-user@example.com',
      googleSub: 'default-user-sub',
      givenName: 'Default',
      familyName: 'User',
      pictureUrl: '',
    });
    for (const sid of ['test-studios', 'test-studio-2']) {
      await catalog.auth.authAddMembershipWithRole(id, sid, 'admin');
    }
    const raw = await createLoginSession(cur.bindings.ports.kv, id, 14);
    return { id, cookie: `${sessionCookieName(cur.bindings.config)}=${raw}` };
  })();
  return cur.defaultUser;
}

export async function teardownTestEnv(): Promise<void> {
  if (!current) return;
  const done = current;
  current = null;
  await done.close();
  rmSync(done.dir, { recursive: true, force: true });
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

/** The raw app: requests reach it exactly as sent, so a request with no credentials is
 * anonymous. Suites that test auth, roles or anonymous behavior use this (require-login D7). */
export const anonApp = wireApp(new Hono<AppEnv>(), upgradeStub);

/** Add the default user's cookie only when the request carries no `cookie` header (any case),
 * no `authorization` header, and its path is not under `/api/companion/` — Companion suites send
 * the bearer like the real client, so a forgotten bearer fails instead of running as a user. */
async function withDefaultCookie(req: Request): Promise<Request> {
  if (!current) return req;
  if (req.headers.has('cookie') || req.headers.has('authorization')) return req;
  let path = new URL(req.url).pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path
  }
  if (path.startsWith('/api/companion/')) return req;
  const headers = new Headers(req.headers);
  headers.set('cookie', (await defaultUser()).cookie);
  return new Request(req, { headers });
}

type AppFetch = typeof anonApp.fetch;
type AppRequest = typeof anonApp.request;

const wrappedFetch: AppFetch = async (req, ...rest) =>
  anonApp.fetch(await withDefaultCookie(req), ...rest);

// Mirrors Hono's own `request`: build the Request, then go through the wrapped fetch.
const wrappedRequest: AppRequest = (input, requestInit, envArg, executionCtx) => {
  let req: Request;
  if (input instanceof Request) {
    req = requestInit ? new Request(input, requestInit) : input;
  } else {
    const s = input.toString();
    const url = /^https?:\/\//.test(s) ? s : `http://localhost${s.startsWith('/') ? s : `/${s}`}`;
    req = new Request(url, requestInit);
  }
  return wrappedFetch(req, envArg, executionCtx);
};

/** The app most suites use: it signs in the default user unless the request brings its own
 * credentials (see `withDefaultCookie`). Everything other than `fetch`/`request` is the raw app. */
export const app: typeof anonApp = new Proxy(anonApp, {
  get(target, p, receiver) {
    if (p === 'fetch') return wrappedFetch;
    if (p === 'request') return wrappedRequest;
    return Reflect.get(target, p, receiver);
  },
});

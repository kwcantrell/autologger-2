// Per-test Node bindings over fresh temp DATA_DIR/BLOB_DIR and a fresh Postgres catalog cloned
// from the migrated template (catalog-on-postgres D6). setup.int.ts resets before and tears down
// after every integration test; bindings are built by test/bindings.ts, which shims HOME.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog } from '@autologger/catalog';
import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { type ConnOptions, createTestDatabase, type TestDatabase } from '../../../test/pg/testDb';
import { wireApp } from '../app';
import type { AppEnv, Bindings } from '../appEnv';
import { createLoginSession } from '../auth/identity';
import { sessionCookieName } from '../env';
import { type TestBindings, testBindings } from './bindings';
import { RetryCountingRoot } from './retryCounter';

/** The base test env: development mode like the dev stack (production-mode cases set
 * PROVIDER_DEV_MODE: false through envWith), sign-in configured as the boot guard requires
 * (require-login D1/D7), a bootstrap owner nobody signs in as (owner-bootstrap D13), and run
 * features approved for the seeded and default users (run-status-and-sweeper D7 category 5). */
const BASE_ENV = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'https://example.com',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  BOOTSTRAP_OWNER_EMAIL: 'bootstrap-owner@example.com',
  RUN_FEATURE_EMAILS: 'seeded-user@example.com,default-user@example.com',
  SESSION_COOKIE: 'autologger_sid',
  SESSION_DAYS: '14',
  NEW_USER_ALL_TEAMS: '0',
  COOKIE_SECURE: '',
  IP_ALLOWLIST: '',
  TRUST_PROXY: '',
  ADMIN_TOKEN: 'test-admin-token',
};

let current: {
  made: TestBindings;
  dir: string;
  blobDir: string;
  db: ConnOptions;
  defaultUser: Promise<{ id: string; cookie: string }> | null;
} | null = null;

/** The clone the next test will get, made while this one runs: every test still gets a
 * clone nothing has touched, without waiting for `create database`. A failed clone rejects in the
 * test that takes it. */
let nextDb: Promise<TestDatabase> | null = null;

function takeDatabase(): Promise<TestDatabase> {
  const db = nextDb ?? createTestDatabase();
  nextDb = createTestDatabase();
  nextDb.catch(() => {});
  return db;
}

export async function resetTestEnv(): Promise<void> {
  await teardownTestEnv();
  const db = (await takeDatabase()).app;
  const dir = mkdtempSync(join(tmpdir(), 'autologger-int-'));
  // shared-blob-volume D8 category 1: the blob root is a sibling temp dir, never inside DATA_DIR.
  const blobDir = mkdtempSync(join(tmpdir(), 'autologger-int-blobs-'));
  const made = testBindings({
    ...BASE_ENV,
    DATA_DIR: dir,
    BLOB_DIR: blobDir,
    PGHOST: db.host,
    PGPORT: String(db.port),
    PGUSER: db.user,
    PGPASSWORD: db.password,
    PGDATABASE: db.database,
  });
  // catalog-policies D11: with CATALOG_RETRY_LOG set, count the retries of every transaction the
  // routes and suites run on the catalog (KV and the session hubs keep their own handles).
  const retryLog = process.env.CATALOG_RETRY_LOG;
  if (retryLog) {
    made.bindings.ports.catalog = new RetryCountingRoot(made.bindings.ports.catalog, retryLog);
  }
  current = { made, dir, blobDir, db, defaultUser: null };
}

/** The current test's DATA_DIR and BLOB_DIR (ai-sdk-agent-harness task 7.1: the "nothing
 * survives" scans read them). */
export function testDirs(): { dataDir: string; blobDir: string } {
  const { dir, blobDir } = cur();
  return { dataDir: dir, blobDir };
}

/** The current test's database as the app role, for a second adapter over it (a second server
 * process, session-tables D12). */
export function testDatabase(): ConnOptions {
  return cur().db;
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
  const test = cur();
  const { bindings } = test.made;
  test.defaultUser ??= (async () => {
    const catalog = createCatalog(bindings.ports.catalog).system('test-seed');
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
    const raw = await createLoginSession(bindings.ports.kv, id, 14);
    return { id, cookie: `${sessionCookieName(bindings.config)}=${raw}` };
  })();
  return test.defaultUser;
}

export async function teardownTestEnv(): Promise<void> {
  if (!current) return;
  const done = current;
  current = null;
  await done.made.close();
  rmSync(done.dir, { recursive: true, force: true });
  rmSync(done.blobDir, { recursive: true, force: true });
}

function cur(): NonNullable<typeof current> {
  if (!current) throw new Error('test env not initialized — is setup.int.ts registered?');
  return current;
}

const must = (): Bindings => cur().made.bindings;

/** The live per-test bindings, layered with per-request Config and Ports overrides (ai-runtime-package
 * task 2.4: `createBindings` hardwires `ports.clock`, so a test injects a fake clock here). Safe at
 * module scope: properties resolve at read time. With no overrides `config` and `ports` are the
 * live objects themselves; with overrides each read is a fresh spread whose members are still the
 * live services (the hub registry, KV). The `env` Hono compares on WS upgrade is the proxy itself,
 * stable per call. */
export function envWith(
  overrides: Record<string, unknown>,
  portOverrides: Partial<Bindings['ports']> = {},
): Bindings {
  const hasOverrides = Object.keys(overrides).length > 0;
  const hasPortOverrides = Object.keys(portOverrides).length > 0;
  const read = (p: string | symbol): unknown => {
    if (p === 'config' && hasOverrides) return { ...must().config, ...overrides };
    if (p === 'ports' && hasPortOverrides) return { ...must().ports, ...portOverrides };
    return (must() as unknown as Record<string | symbol, unknown>)[p];
  };
  return new Proxy({} as Bindings, {
    get: (_t, p) => read(p),
    has: (_t, p) => p in must(),
    ownKeys: () => Reflect.ownKeys(must()),
    getOwnPropertyDescriptor: (_t, p) => ({ enumerable: true, configurable: true, value: read(p) }),
  });
}

/** The live per-test bindings; a Proxy so `{...env, ...overrides}` spreads keep working. */
export const env: Bindings = envWith({});

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

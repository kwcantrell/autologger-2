// Dispatch-contract tests for the Next.js frontend bridge (design D1,
// nextjs-frontend-migration; spec "Next.js frontend served through the Hono
// bridge"). Rewritten from the old fixture-`web/dist` assertions (D7): the
// bridge is a new seam, and this file characterizes ITS dispatch decisions
// — which requests reach `frontend.handle()` and which 404 from Hono without
// ever touching it — against a stub `{ handle }`, not against real
// Next-rendered shell content (that's the e2e tier's job, per design D7).
//
// The stub satisfies the declared seam property (`.apply/ledger.md` phase-3
// section): "after `handle` resolves, the response has been fully written
// by the frontend" — it writes a canned response onto the fake `outgoing`
// object it's handed before resolving, exactly as the real Next wrapper
// (`server/src/node/nextFrontend.ts`) must.

import type { ServerResponse } from 'node:http';
import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireApp } from '../app';
import type { AppEnv, Bindings } from '../appEnv';
import { env } from '../test/harness';
import { seedSession, seedShow, seedStudio } from '../test/helpers';

const upgradeStub = (() => async (c: { text(b: string, s: number): Response }) =>
  c.text('WebSocket unavailable in HTTP tests', 426)) as unknown as UpgradeWebSocket;

/** A fake `ServerResponse`: enough surface for the bridge's own guard logic
 * (`headersSent`) plus a place for the stub frontend to write its canned
 * response. Not a real Node `ServerResponse` — the bridge treats `outgoing`
 * as opaque and just forwards it to `frontend.handle()`. */
function fakeOutgoing(): ServerResponse & { writeHead: ReturnType<typeof vi.fn> } {
  return {
    headersSent: false,
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse & { writeHead: ReturnType<typeof vi.fn> };
}

/** Records every call and, by default, fully answers the response before
 * resolving (the declared seam property) — matching what a real frontend
 * provider must do. `behavior` lets individual tests swap in a rejecting
 * implementation for the handle()-rejection coverage below. */
function createStubFrontend(
  behavior: (outgoing: ServerResponse) => void | Promise<void> = (outgoing) => {
    (outgoing as unknown as { writeHead(...a: unknown[]): void }).writeHead(200, {
      'content-type': 'text/html',
    });
    (outgoing as unknown as { headersSent: boolean }).headersSent = true;
    (outgoing as unknown as { end(...a: unknown[]): void }).end('<html>stub shell</html>');
  },
) {
  const handle = vi.fn(async (_incoming: unknown, outgoing: ServerResponse) => {
    await behavior(outgoing);
  });
  return { handle };
}

/** Env carrying a real `incoming`/`outgoing` pair, as the bridge sees for a
 * genuine HTTP request. */
function envWithIO(outgoing: ServerResponse = fakeOutgoing()): Bindings {
  return { ...env, incoming: {} as Bindings['incoming'], outgoing } as unknown as Bindings;
}

describe('frontend bridge dispatch — GET-only catch-all (design D1, spec "Next.js frontend served through the Hono bridge")', () => {
  const stub = createStubFrontend();
  const app = wireApp(new Hono<AppEnv>(), upgradeStub, { frontend: stub });

  afterEach(() => stub.handle.mockClear());

  it('never bridges API routes', async () => {
    const res = await app.request('/api/profile', {}, envWithIO());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    expect(stub.handle).not.toHaveBeenCalled();
  });

  it.each([
    '/api/definitely-not-a-route',
    '/auth/nope',
    '/api',
    '/auth',
  ])('unmatched GET %s 404s from Hono without invoking the bridge (spec "API routes never reach the frontend bridge")', async (path) => {
    const res = await app.request(path, {}, envWithIO());
    expect(res.status).toBe(404);
    expect(stub.handle).not.toHaveBeenCalled();
  });

  it.each([
    '/',
    '/sessions/abc-123',
    '/teams',
    '/admin/users',
    '/sessions/a%2Fb',
    '/static/logo.png',
    // Bare-prefix guard: `/apifoo` and `/authors` share a string prefix with
    // `/api`/`/auth` but are NOT under either prefix (no `/api/…` or
    // `/auth/…` separator) — pins that the short-circuit above matches
    // `/api`/`/auth` exactly or `/api/*`/`/auth/*`, never a bare-prefix
    // match, so these two MUST still bridge to the frontend.
    '/apifoo',
    '/authors',
  ])('bridges GET %s to the frontend', async (path) => {
    const res = await app.request(path, {}, envWithIO());
    expect(stub.handle).toHaveBeenCalledTimes(1);
    // RESPONSE_ALREADY_SENT carries this header (@hono/node-server/utils/response) —
    // its presence is the observable signal that the bridge, not Hono's
    // own 404, answered the dispatch (the wire-level bytes of the stub's
    // canned write are a Node-socket side effect this Fetch Response
    // can't see; the e2e tier covers real shell content).
    expect(res.headers.get('x-hono-already-sent')).toBe('true');
  });

  it('real vs. nonexistent session id both bridge (dispatch never depends on session/catalog data)', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const sessionId = seedSession({ showId: show });

    await app.request(`/sessions/${sessionId}`, {}, envWithIO());
    expect(stub.handle).toHaveBeenCalledTimes(1);
    stub.handle.mockClear();

    await app.request('/sessions/definitely-does-not-exist', {}, envWithIO());
    expect(stub.handle).toHaveBeenCalledTimes(1);
  });

  it('POST /sessions/abc 404s from Hono without invoking the bridge (non-GET stays off the bridge)', async () => {
    const res = await app.request('/sessions/abc', { method: 'POST' }, envWithIO());
    expect(res.status).toBe(404);
    expect(stub.handle).not.toHaveBeenCalled();
  });

  it.each([
    '/teams/',
    '/sessions/abc/',
    '/admin/users/',
  ])('trailing slash %s 404s without invoking the bridge', async (path) => {
    const res = await app.request(path, {}, envWithIO());
    expect(res.status).toBe(404);
    expect(stub.handle).not.toHaveBeenCalled();
  });

  it('GET / (root) is not treated as a trailing-slash path', async () => {
    const res = await app.request('/', {}, envWithIO());
    expect(res.headers.get('x-hono-already-sent')).toBe('true');
    expect(stub.handle).toHaveBeenCalledTimes(1);
  });

  it('absent outgoing (plain app.request() env) 404s without invoking the bridge', async () => {
    // `env` from the harness carries no incoming/outgoing — the exact shape
    // a plain app.request() test constructs (spec "Bridge without a
    // writable response object").
    const res = await app.request('/', {}, env);
    expect(res.status).toBe(404);
    expect(stub.handle).not.toHaveBeenCalled();
  });

  it('absent outgoing with incoming present (the @hono/node-ws upgrade replay shape) 404s without invoking the bridge', async () => {
    const replayEnv = { ...env, incoming: {} as Bindings['incoming'] } as unknown as Bindings;
    const res = await app.request('/', {}, replayEnv);
    expect(res.status).toBe(404);
    expect(stub.handle).not.toHaveBeenCalled();
  });
});

describe('frontend bridge dispatch — frontend absent (API-only / plain HTTP tests)', () => {
  const app = wireApp(new Hono<AppEnv>(), upgradeStub, {});

  it('404s unmatched GET paths with no frontend configured', async () => {
    const res = await app.request('/', {}, envWithIO());
    expect(res.status).toBe(404);
  });

  it('still serves API routes normally', async () => {
    const res = await app.request('/api/profile', {}, envWithIO());
    expect(res.status).toBe(200);
  });
});

describe('frontend bridge — handle() rejection handling (design D1 "Bridge guards" (c))', () => {
  it('logs and returns the sentinel when headers were already sent before rejecting', async () => {
    const stub = createStubFrontend(async (outgoing) => {
      (outgoing as unknown as { headersSent: boolean }).headersSent = true;
      throw new Error('boom after headers');
    });
    const app = wireApp(new Hono<AppEnv>(), upgradeStub, { frontend: stub });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await app.request('/', {}, envWithIO());
      expect(res.headers.get('x-hono-already-sent')).toBe('true');
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('rethrows (producing the normal 500 via onError) when no headers were sent yet', async () => {
    const stub = createStubFrontend(async () => {
      throw new Error('boom before headers');
    });
    const app = wireApp(new Hono<AppEnv>(), upgradeStub, { frontend: stub });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await app.request('/', {}, envWithIO());
      expect(res.status).toBe(500);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('frontend bridge — IP allowlist covers page requests before the bridge runs (spec "Page requests pass through server middleware")', () => {
  const stub = createStubFrontend();
  const app = wireApp(new Hono<AppEnv>(), upgradeStub, { frontend: stub });

  afterEach(() => stub.handle.mockClear());

  it('rejects a non-allowlisted client requesting / before invoking the bridge', async () => {
    const blockedEnv = {
      ...envWithIO(),
      config: { ...env.config, IP_ALLOWLIST: '203.0.113.0/24' },
      incoming: { socket: { remoteAddress: '198.51.100.1' } },
    } as unknown as Bindings;
    const res = await app.request('/', {}, blockedEnv);
    expect(res.status).toBe(403);
    expect(stub.handle).not.toHaveBeenCalled();
  });

  it('admits an allowlisted client through to the bridge', async () => {
    const allowedEnv = {
      ...envWithIO(),
      config: { ...env.config, IP_ALLOWLIST: '203.0.113.0/24' },
      incoming: { socket: { remoteAddress: '203.0.113.7' } },
    } as unknown as Bindings;
    const res = await app.request('/', {}, allowedEnv);
    expect(res.headers.get('x-hono-already-sent')).toBe('true');
    expect(stub.handle).toHaveBeenCalledTimes(1);
  });
});

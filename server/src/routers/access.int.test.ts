// show-grants D15: every session-scoped route, the WebSocket upgrade and the show-scoped
// log-import route answer an ungranted member exactly as they answer a nonexistent id (the masked
// 404), and never deny a granted member, an admin or the owner. The route table is the source, so
// a route added later without the gate fails here.

import { rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { AI_RUNTIME_FIXTURES_DIR } from '@autologger/ai-runtime';
import { aiChatTurns } from '@autologger/ai-runtime/aiChatRegistry';
import { stableSessionCwd } from '@autologger/ai-runtime/aiChatRunner';
import { transcriptGenerationLock } from '@autologger/transcription';
import { type ServerType, serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { wireApp } from '../app';
import type { AppEnv } from '../appEnv';
import { anonApp, env, envWith } from '../test/harness';
import { seedAccessMatrix, type TestCaller } from '../test/helpers';
import { liveLeaseOfAnotherProcess } from '../test/runLeases';

const SESSION_NOT_FOUND = JSON.stringify({ detail: 'Session not found' });
const SHOW_NOT_FOUND = JSON.stringify({ detail: 'Show not found.' });
const LOG_IMPORT = '/api/shows/:showId/log-import';

/** Every registered session-scoped route (any path with `:sessionId`, which includes
 * `GET /api/sessions/:sessionId` and the `…/ws` upgrade) plus the show-scoped log-import route,
 * one entry per method and path. */
function gatedRoutes(): Array<{ method: string; path: string }> {
  const seen = new Set<string>();
  const out: Array<{ method: string; path: string }> = [];
  for (const r of anonApp.routes) {
    if (r.method === 'ALL') continue;
    if (!r.path.includes(':sessionId') && r.path !== LOG_IMPORT) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: r.path });
  }
  return out;
}

function concrete(path: string, ids: { sessionId: string; showId: string }): string {
  return path
    .replace(':sessionId', ids.sessionId)
    .replace(':showId', ids.showId)
    .replace(/:[^/]+/g, 'x');
}

async function call(
  method: string,
  path: string,
  who: TestCaller,
  reqEnv: object = { ...env },
): Promise<{ status: number; body: string }> {
  const res = await anonApp.request(path, { method, headers: { cookie: who.cookie } }, reqEnv);
  return { status: res.status, body: await res.text() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  transcriptGenerationLock.reset();
});

describe('the route table: show access on every session-scoped route (show-grants D15)', () => {
  it('enumerates the gated routes', () => {
    const routes = gatedRoutes();
    expect(routes.length).toBeGreaterThan(40);
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(keys).toContain('GET /api/sessions/:sessionId');
    expect(keys).toContain('GET /api/sessions/:sessionId/ws');
    expect(keys).toContain(`POST ${LOG_IMPORT}`);
  });

  it('an ungranted member gets a 404 byte-identical to a nonexistent id on every route', async () => {
    const m = await seedAccessMatrix();
    const wrong: string[] = [];
    for (const r of gatedRoutes()) {
      const isShow = r.path === LOG_IMPORT;
      const real = await call(r.method, concrete(r.path, m), m.ungranted);
      const missing = await call(
        r.method,
        concrete(r.path, { sessionId: 'no-such-session', showId: 'no-such-show' }),
        m.ungranted,
      );
      const expected = isShow ? SHOW_NOT_FOUND : SESSION_NOT_FOUND;
      if (
        real.status !== 404 ||
        real.body !== expected ||
        missing.status !== 404 ||
        missing.body !== real.body
      ) {
        wrong.push(
          `${r.method} ${r.path} -> ${real.status} ${real.body.slice(0, 80)} (missing: ${missing.status})`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the granted member, an admin and the owner never get that 404', async () => {
    const wrong: string[] = [];
    for (const r of gatedRoutes()) {
      const isShow = r.path === LOG_IMPORT;
      for (const who of ['granted', 'admin', 'owner'] as const) {
        // A fresh matrix per call: some routes change the session (delete, archive).
        const m = await seedAccessMatrix();
        const res = await call(r.method, concrete(r.path, m), m[who]);
        if (res.status === 404 && res.body === (isShow ? SHOW_NOT_FOUND : SESSION_NOT_FOUND)) {
          wrong.push(`${who}: ${r.method} ${r.path}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});

describe('one concrete call per family is 200 for the granted member and the admin (show-grants D15)', () => {
  const families: Array<[string, string]> = [
    ['sessions', '/api/sessions/:sessionId'],
    ['events', '/api/sessions/:sessionId/events'],
    ['transcripts', '/api/sessions/:sessionId/transcript-words'],
    ['topics', '/api/sessions/:sessionId/topics'],
    ['exports', '/api/sessions/:sessionId/export.csv'],
    ['audio', '/api/sessions/:sessionId/audio/segments'],
  ];

  it.each(families)('%s: GET %s', async (_family, path) => {
    const m = await seedAccessMatrix();
    for (const who of [m.granted, m.admin]) {
      expect((await call('GET', concrete(path, m), who)).status).toBe(200);
    }
    expect((await call('GET', concrete(path, m), m.ungranted)).status).toBe(404);
  });

  it('AI v2: GET the dashboard', async () => {
    const m = await seedAccessMatrix();
    const on = envWith({ AI_V2_ENABLED: '1' });
    const path = concrete('/api/sessions/:sessionId/ai/v2/dashboard', m);
    for (const who of [m.granted, m.admin]) {
      expect((await call('GET', path, who, on)).status).toBe(200);
    }
    expect((await call('GET', path, m.ungranted, on)).status).toBe(404);
  });

  it('AI chat: a configured turn serves', async () => {
    const m = await seedAccessMatrix();
    const on = envWith({
      CLAUDE_CLI_PATH: join(AI_RUNTIME_FIXTURES_DIR, 'fake-claude.mjs'),
      HOST: '127.0.0.1',
    });
    try {
      for (const who of [m.granted, m.admin, m.ungranted]) {
        aiChatTurns.reset();
        const res = await anonApp.request(
          `/api/sessions/${m.sessionId}/ai/chat`,
          {
            method: 'POST',
            headers: { cookie: who.cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ message: 'hi' }),
          },
          on,
        );
        await res.text();
        expect(`${who === m.ungranted ? 'ungranted' : 'allowed'} ${res.status}`).toBe(
          who === m.ungranted ? 'ungranted 404' : 'allowed 200',
        );
      }
    } finally {
      aiChatTurns.reset();
      rmSync(stableSessionCwd(m.sessionId), { recursive: true, force: true });
    }
  });

  it('log-import: POST starts a job', async () => {
    const m = await seedAccessMatrix();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<!DOCTYPE html><html></html>', { status: 200 })),
    );
    const on = envWith({ SHEETS_LOG_IMPORT_ENABLED: '1', HOST: '127.0.0.1' });
    for (const who of [m.granted, m.admin, m.ungranted]) {
      const res = await anonApp.request(
        `/api/shows/${m.showId}/log-import`,
        {
          method: 'POST',
          headers: { cookie: who.cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            spreadsheet_url: 'https://docs.google.com/spreadsheets/d/abc/edit',
          }),
        },
        on,
      );
      const body = await res.text();
      if (who === m.ungranted) {
        expect(res.status).toBe(404);
        expect(body).toBe(SHOW_NOT_FOUND);
      } else {
        expect(res.status).toBe(200);
      }
    }
  });
});

describe('the session WebSocket upgrade follows show access (show-grants D15)', () => {
  let server: ServerType;
  let port: number;

  beforeAll(async () => {
    const app = new Hono<AppEnv>();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    wireApp(app, upgradeWebSocket, { bindings: env });
    port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
        resolve(info.port),
      );
      injectWebSocket(server);
    });
  });
  afterAll(() => server.close());

  function connect(sessionId: string, who: TestCaller): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/ws`, {
        headers: { cookie: who.cookie },
      } as unknown as string[]);
      ws.addEventListener('open', () => resolve(ws));
      ws.addEventListener('error', (e) => reject(e));
    });
  }

  it('opens for the granted member and the admin, and is refused for the ungranted member', async () => {
    const m = await seedAccessMatrix();
    for (const who of [m.granted, m.admin]) {
      const ws = await connect(m.sessionId, who);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    }
    await expect(connect(m.sessionId, m.ungranted)).rejects.toBeTruthy();
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${m.sessionId}/ws`, {
      headers: { cookie: m.ungranted.cookie },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(SESSION_NOT_FOUND);
  });
});

describe('the transcript-generation lock status follows show access (show-grants D12)', () => {
  it('names the holder for the granted member and nulls it for the ungranted member', async () => {
    const m = await seedAccessMatrix();
    const startedAtMs = 1_700_000_000_000;
    // The status reads the lease (run-status-and-sweeper D5): a live run held by another process.
    await liveLeaseOfAnotherProcess(m.sessionId, 'transcript-generation', startedAtMs);
    const status = async (who: TestCaller): Promise<Record<string, unknown>> => {
      const res = await anonApp.request(
        '/api/transcript-generation/status',
        { method: 'GET', headers: { cookie: who.cookie } },
        { ...env },
      );
      return (await res.json()) as Record<string, unknown>;
    };
    expect(await status(m.granted)).toEqual({
      in_flight: true,
      session_id: m.sessionId,
      session_title: 'Test Session',
      started_at: new Date(startedAtMs).toISOString(),
    });
    expect(await status(m.ungranted)).toEqual({
      in_flight: true,
      session_id: null,
      session_title: null,
      started_at: new Date(startedAtMs).toISOString(),
    });
  });
});

describe('the Companion table: a cookie caller without access sees no active session (show-grants D10, D15)', () => {
  const routes: Array<{ method: string; path: string; body?: unknown }> = [
    { method: 'GET', path: '/api/companion/state' },
    { method: 'GET', path: '/api/companion/categories' },
    { method: 'POST', path: '/api/companion/log', body: { category_id: 'cam', message: 'x' } },
    { method: 'POST', path: '/api/companion/transport', body: { action: 'start' } },
    { method: 'POST', path: '/api/companion/command', body: { type: 'play-toggle' } },
  ];
  const send = async (r: (typeof routes)[number], who: TestCaller) => {
    const res = await anonApp.request(
      r.path,
      {
        method: r.method,
        headers: { cookie: who.cookie, 'content-type': 'application/json' },
        body: r.body === undefined ? undefined : JSON.stringify(r.body),
      },
      { ...env },
    );
    return { status: res.status, body: await res.text() };
  };

  it.each(routes)('$method $path', async (r) => {
    const m = await seedAccessMatrix();
    const idle = await send(r, m.ungranted);
    // Presence is per user (companion-devices D3/D4, D9 category 3): the denied caller's own
    // fresh, visible row names the session, so the masked answer still proves the access check.
    await env.ports.presence.upsert('teammate-tab', {
      user_id: m.ungranted.id,
      session_id: m.sessionId,
      visible: true,
      is_playing: false,
      updated: env.ports.clock.now(),
    });
    const denied = await send(r, m.ungranted);
    if (r.path === '/api/companion/state') {
      const a = JSON.parse(denied.body) as Record<string, unknown>;
      const b = JSON.parse(idle.body) as Record<string, unknown>;
      expect({ ...a, connected_clients: 0 }).toEqual({ ...b, connected_clients: 0 });
    } else {
      expect(denied).toEqual(idle);
      expect(denied.status).toBe(409);
    }
    await env.ports.presence.upsert('granted-tab', {
      user_id: m.granted.id,
      session_id: m.sessionId,
      visible: true,
      is_playing: false,
      updated: env.ports.clock.now(),
    });
    const allowed = await send(r, m.granted);
    expect(allowed.status).toBe(200);
    if (r.path === '/api/companion/state') {
      expect((JSON.parse(allowed.body) as { active_session_id: string }).active_session_id).toBe(
        m.sessionId,
      );
    }
  });
});

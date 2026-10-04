// src/routers/sessionWs.access.int.test.ts — session sockets close when access is lost
// (show-grants D20, owner decision E; api-contract-freeze "Session sockets close when access is
// lost"). Real upgrades on a listening @hono/node-ws server, like companion-ws.int.test.ts: a grant
// revoke, a member removal, a leave, the support-plane membership delete, and a demotion to
// `member` (team plane or support plane) close the affected user's sockets on sessions they no
// longer reach with code 4403, after the write commits; every other socket stays open.

import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wireApp } from '../app';
import type { AppEnv } from '../appEnv';
import { env } from '../test/harness';
import {
  adminHeader,
  catalogFor,
  loginCookie,
  seedSession,
  seedShow,
  seedStudio,
  seedUser,
  type TestCaller,
} from '../test/helpers';

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

const ADMIN_H = { ...adminHeader('test-admin-token'), 'content-type': 'application/json' };

/** A socket with its close code (null while open) and every message it received. */
interface Sock {
  ws: WebSocket;
  closeCode: () => number | null;
  closed: Promise<number>;
  messages: string[];
}

async function connect(sessionId: string, caller: TestCaller): Promise<Sock> {
  const messages: string[] = [];
  let code: number | null = null;
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/ws`, {
      headers: { cookie: caller.cookie },
    } as unknown as string[]);
    w.addEventListener('open', () => resolve(w));
    w.addEventListener('error', (e) => reject(e));
  });
  ws.addEventListener(
    'message',
    (e) => void messages.push(typeof e.data === 'string' ? e.data : ''),
  );
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener('close', (e) => {
      code = e.code;
      resolve(e.code);
    });
  });
  return { ws, closeCode: () => code, closed, messages };
}

function within<T>(p: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/** A broadcast on `sessionId` reaches every socket in `open` (proving each is still open; a
 * close frame sent earlier on the same connection would arrive first). */
async function expectStillOpen(sessionId: string, open: Sock[]): Promise<void> {
  const before = open.map((s) => s.messages.length);
  (await env.ports.sessions.get(sessionId)).broadcastCommand('play-toggle');
  for (const [i, s] of open.entries()) {
    await within(
      (async () => {
        while (s.messages.length <= before[i]) await new Promise((r) => setTimeout(r, 10));
      })(),
    );
    expect(s.closeCode()).toBeNull();
    expect(s.ws.readyState).toBe(WebSocket.OPEN);
    expect(JSON.parse(s.messages[s.messages.length - 1])).toMatchObject({
      type: 'command',
      command: 'play-toggle',
    });
  }
}

async function expectRefused(sessionId: string, caller: TestCaller): Promise<void> {
  await expect(connect(sessionId, caller)).rejects.toBeTruthy();
}

async function call(path: string, method: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(res.status, `${method} ${path}`).toBe(200);
}

/** A team with show S (session sS) and show T (session sT); the owner, an admin A, member M
 * granted S and T, member N granted S. */
async function team() {
  const cat = catalogFor();
  const studio = await seedStudio();
  const showS = await seedShow({ studioId: studio, name: 'Show S', code: 'SS' });
  const showT = await seedShow({ studioId: studio, name: 'Show T', code: 'ST' });
  const sS = await seedSession({ showId: showS, title: 'On S' });
  const sT = await seedSession({ showId: showT, title: 'On T' });
  const mk = async (role: 'owner' | 'admin' | 'member'): Promise<TestCaller> => {
    const id = await seedUser({ studios: [studio], role });
    return { id, cookie: await loginCookie(id) };
  };
  const owner = await mk('owner');
  const admin = await mk('admin');
  const m = await mk('member');
  const n = await mk('member');
  const now = new Date().toISOString();
  await cat.auth.authGrantShow(m.id, showS, owner.id, now);
  await cat.auth.authGrantShow(m.id, showT, owner.id, now);
  await cat.auth.authGrantShow(n.id, showS, owner.id, now);
  return { studio, showS, showT, sS, sT, owner, admin, m, n };
}

describe('session sockets close when access is lost (show-grants D20)', () => {
  it('a revoke closes M’s socket on S with 4403 and refuses the reconnect; T, N and the admin stay open', async () => {
    const t = await team();
    const mS = await connect(t.sS, t.m);
    const mT = await connect(t.sT, t.m);
    const nS = await connect(t.sS, t.n);
    const aS = await connect(t.sS, t.admin);

    await call(`/api/teams/${t.studio}/shows/${t.showS}/grants/${t.m.id}`, 'DELETE', {
      cookie: t.owner.cookie,
    });

    expect(await within(mS.closed)).toBe(4403);
    await expectRefused(t.sS, t.m);
    await expectStillOpen(t.sT, [mT]);
    await expectStillOpen(t.sS, [nS, aS]);
    for (const s of [mT, nS, aS]) s.ws.close();
  });

  it('an unrelated revoke (another member’s grant for S, or M’s grant for another show) leaves M’s socket open', async () => {
    const t = await team();
    const other = await seedShow({ studioId: t.studio, name: 'Show U', code: 'SU' });
    await catalogFor().auth.authGrantShow(t.m.id, other, t.owner.id, new Date().toISOString());
    const mS = await connect(t.sS, t.m);

    await call(`/api/teams/${t.studio}/shows/${t.showS}/grants/${t.n.id}`, 'DELETE', {
      cookie: t.owner.cookie,
    });
    await call(`/api/teams/${t.studio}/shows/${other}/grants/${t.m.id}`, 'DELETE', {
      cookie: t.owner.cookie,
    });

    await expectStillOpen(t.sS, [mS]);
    mS.ws.close();
  });

  const removals: Array<[string, (t: Awaited<ReturnType<typeof team>>) => Promise<void>]> = [
    [
      'removing M from the team',
      (t) => call(`/api/teams/${t.studio}/members/${t.m.id}`, 'DELETE', { cookie: t.admin.cookie }),
    ],
    ['M leaving', (t) => call(`/api/teams/${t.studio}/leave`, 'POST', { cookie: t.m.cookie })],
    [
      'the support-plane membership delete',
      (t) => call(`/api/admin/users/${t.m.id}/memberships/${t.studio}`, 'DELETE', ADMIN_H),
    ],
  ];
  for (const [what, act] of removals) {
    it(`${what} closes M’s sockets in that team; N’s stays open`, async () => {
      const t = await team();
      const mS = await connect(t.sS, t.m);
      const mT = await connect(t.sT, t.m);
      const nS = await connect(t.sS, t.n);

      await act(t);

      expect(await within(mS.closed)).toBe(4403);
      expect(await within(mT.closed)).toBe(4403);
      await expectRefused(t.sS, t.m);
      await expectStillOpen(t.sS, [nS]);
      nS.ws.close();
    });
  }

  const demotions: Array<[string, (t: Awaited<ReturnType<typeof team>>) => Promise<void>]> = [
    [
      'the owner demoting admin A to member',
      (t) =>
        call(
          `/api/teams/${t.studio}/members/${t.admin.id}/role`,
          'POST',
          { cookie: t.owner.cookie },
          {
            role: 'member',
          },
        ),
    ],
    [
      'a support-plane upsert that leaves A a member',
      (t) =>
        call(`/api/admin/users/${t.admin.id}/memberships`, 'POST', ADMIN_H, {
          studio_id: t.studio,
          role: 'member',
        }),
    ],
  ];
  for (const [what, act] of demotions) {
    it(`${what} closes A’s socket on an ungranted show and keeps the one on a granted show`, async () => {
      const t = await team();
      // A holds a (dormant) grant for T, which applies again after the demotion (D11).
      await catalogFor().auth.authGrantShow(
        t.admin.id,
        t.showT,
        t.owner.id,
        new Date().toISOString(),
      );
      const aS = await connect(t.sS, t.admin);
      const aT = await connect(t.sT, t.admin);
      const mS = await connect(t.sS, t.m);

      await act(t);

      expect(await within(aS.closed)).toBe(4403);
      await expectRefused(t.sS, t.admin);
      await expectStillOpen(t.sT, [aT]);
      await expectStillOpen(t.sS, [mS]);
      aT.ws.close();
      mS.ws.close();
    });
  }
});

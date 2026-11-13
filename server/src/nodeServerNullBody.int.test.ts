// src/nodeServerNullBody.int.test.ts — the real app (wireApp) on a real socket
// through @hono/node-server's serve(), checking the headers that go on the wire
// for null-body responses.
//
// @hono/node-server 1.x added `content-type: text/plain; charset=UTF-8` to every
// response that had none, including 204s and `c.redirect` 302s. 2.x does not.
// The human accepted that change for job 009 (api-contract-freeze "Null-body
// responses carry no Content-Type"), so this pins the 2.x behavior on one real
// 204 route and one real redirect. Both assertions fail on 1.x.

import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wireApp } from './app';
import type { AppEnv } from './appEnv';
import { defaultUser, env } from './test/harness';
import { seedCompanionDevice } from './test/helpers';

let server: ServerType;
let base: string;

beforeAll(async () => {
  const app = new Hono<AppEnv>();
  const { upgradeWebSocket } = createNodeWebSocket({ app });
  wireApp(app, upgradeWebSocket, { bindings: env });
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
      resolve(info.port),
    );
  });
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('null-body responses through serve()', () => {
  it('DELETE /api/companion-devices/:id answers 204 with no body and no content-type', async () => {
    const device = await seedCompanionDevice();
    const { cookie } = await defaultUser();
    const res = await fetch(`${base}/api/companion-devices/${device.id}`, {
      method: 'DELETE',
      headers: { cookie, origin: base },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('content-type')).toBeNull();
    expect(await res.text()).toBe('');
  });

  it('the OAuth callback failure redirect answers 302 with its Location and no content-type', async () => {
    const res = await fetch(`${base}/auth/google/callback?error=x`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?login_error=provider_error');
    expect(res.headers.get('content-type')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toBe('');
  });
});

// src/nodeServerNullBody.int.test.ts — the real app (wireApp) on a real socket
// through @hono/node-server's serve(), checking the headers that go on the wire
// for null-body responses.
//
// @hono/node-server 1.x added `content-type: text/plain; charset=UTF-8` to every
// response that had none, including 204s and `c.redirect` 302s. 2.x does not.
// The human accepted that change for job 009 (api-contract-freeze "Null-body
// responses carry no Content-Type"), so this pins the 2.x behavior on one real
// 204 route and one real redirect. Both assertions fail on 1.x.
//
// The second human decision for job 009 accepted two more 2.x changes, pinned
// below over a raw socket (fetch can't send an arbitrary Host or `OPTIONS *`):
// - a Host with uppercase letters and a port (`LOCALHOST:<port>`) got 400 on
//   1.x, whose host check was case-sensitive; 2.x routes it like the lowercase
//   host (api-contract-freeze "Host names are matched case-insensitively");
// - the adapter's own null-body 400s for malformed requests (an invalid Host,
//   `OPTIONS *`, a backslash in the path) no longer carry content-type.

import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
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
let port: number;

beforeAll(async () => {
  const app = new Hono<AppEnv>();
  const { upgradeWebSocket } = createNodeWebSocket({ app });
  wireApp(app, upgradeWebSocket, { bindings: env });
  port = await new Promise<number>((resolve) => {
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

type RawResponse = { status: number; headers: Record<string, string>; head: string };

// One HTTP/1.1 request written byte for byte; reads until the server closes.
function rawRequest(requestLine: string, host: string, extra: string[] = []): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(
        [requestLine, `Host: ${host}`, ...extra, 'Connection: close', '', ''].join('\r\n'),
      );
    });
    sock.on('data', (d: Buffer) => chunks.push(d));
    sock.on('error', reject);
    sock.on('end', () => {
      const text = Buffer.concat(chunks).toString('latin1');
      const head = text.slice(0, text.indexOf('\r\n\r\n'));
      const [statusLine, ...lines] = head.split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of lines) {
        const i = line.indexOf(':');
        headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ status: Number(statusLine.split(' ')[1]), headers, head });
    });
  });
}

describe('Host header case through serve()', () => {
  it('routes an uppercase Host with a port exactly like the lowercase one', async () => {
    const { cookie } = await defaultUser();
    const lower = await rawRequest('GET /api/studio HTTP/1.1', `localhost:${port}`, [
      `Cookie: ${cookie}`,
    ]);
    const upper = await rawRequest('GET /api/studio HTTP/1.1', `LOCALHOST:${port}`, [
      `Cookie: ${cookie}`,
    ]);
    expect(lower.status).toBe(200);
    expect(upper.status).toBe(lower.status);
    expect(upper.headers['content-type']).toBe('application/json');
  });

  it('still leaves auth to the route for an uppercase Host', async () => {
    const res = await rawRequest('GET /api/studio HTTP/1.1', `LOCALHOST:${port}`);
    expect(res.status).toBe(401);
  });

  it('still rejects an invalid Host with 400', async () => {
    const res = await rawRequest('GET /api/studio HTTP/1.1', 'exa mple');
    expect(res.status).toBe(400);
  });
});

describe("the adapter's own 400s for malformed requests", () => {
  it.each([
    ['an invalid Host', 'GET /api/studio HTTP/1.1', 'exa mple'],
    ['OPTIONS *', 'OPTIONS * HTTP/1.1', 'localhost'],
    ['a backslash in the path', 'GET /api\\studio HTTP/1.1', 'localhost'],
  ])('%s answers 400 with no content-type', async (_name, requestLine, host) => {
    const res = await rawRequest(requestLine, host);
    expect(res.status, res.head).toBe(400);
    expect(res.headers['content-type'], res.head).toBeUndefined();
  });
});

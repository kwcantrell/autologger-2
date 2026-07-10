import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, AutologgerApi } from './api.js';

let server: Server;
let base: string;
let handler: (req: import('node:http').IncomingMessage, body: string) => { status: number; json: unknown };

beforeEach(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { status, json } = handler(req, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function api(token = ''): AutologgerApi {
  return new AutologgerApi({ url: base, token, signal: new AbortController().signal });
}

describe('AutologgerApi', () => {
  it('sends the bearer token and parses state JSON', async () => {
    let seenAuth: string | undefined;
    handler = (req) => {
      seenAuth = req.headers.authorization;
      return { status: 200, json: { connected_clients: 1, active_session_id: 's1', session: null, last_command: null } };
    };
    const state = await api('tok').getState();
    expect(seenAuth).toBe('Bearer tok');
    expect(state.active_session_id).toBe('s1');
  });

  it('omits Authorization when token is blank', async () => {
    let seenAuth: string | undefined = 'unset';
    handler = (req) => {
      seenAuth = req.headers.authorization;
      return { status: 200, json: { connected_clients: 0, active_session_id: null, session: null, last_command: null } };
    };
    await api('').getState();
    expect(seenAuth).toBeUndefined();
  });

  it('maps 401 -> auth', async () => {
    handler = () => ({ status: 401, json: { detail: 'Login required.' } });
    await expect(api().getState()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps 409 -> no_session on transport', async () => {
    handler = () => ({ status: 409, json: { detail: 'No active session' } });
    await expect(api().transport('toggle')).rejects.toMatchObject({ kind: 'no_session' });
  });

  it('maps 400 -> bad_category on log', async () => {
    handler = () => ({ status: 400, json: { detail: 'Unknown category' } });
    await expect(api().log({ category_id: 'x', message: 'm' })).rejects.toMatchObject({ kind: 'bad_category' });
  });

  it('maps 500 -> http', async () => {
    handler = () => ({ status: 500, json: { detail: 'boom' } });
    await expect(api().getCategories()).rejects.toMatchObject({ kind: 'http', status: 500 });
  });

  it('surfaces ApiError type', async () => {
    handler = () => ({ status: 401, json: {} });
    const err = await api().getState().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
  });
});

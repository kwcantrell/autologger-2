// catalog-database "Error logs" (catalog-on-postgres D8): a Postgres error's `detail` echoes the
// values involved (an email, a Google subject id), so the generic 500 logs its code, constraint
// and table only. Exercised through the real `wireApp` onError.

import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireApp } from './app';
import type { AppEnv } from './appEnv';

afterEach(() => vi.restoreAllMocks());

function appThrowing(err: unknown): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/boom', () => {
    throw err;
  });
  return wireApp(app, (() => () => undefined) as unknown as UpgradeWebSocket);
}

function logged(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls
    .map((args: unknown[]) =>
      args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 0))).join(' '),
    )
    .join('\n');
}

describe('generic 500 logging', () => {
  it('logs a database error by code, constraint and table, never its detail or message values', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = Object.assign(
      new Error('duplicate key value violates unique constraint "users_email_norm_key"'),
      {
        name: 'PostgresError',
        code: '23505',
        constraint_name: 'users_email_norm_key',
        table_name: 'users',
        detail: 'Key (email_norm)=(x@y.example) already exists.',
        where: 'SQL statement with x@y.example',
      },
    );
    const res = await appThrowing(err).request('/boom');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ detail: 'Internal Server Error' });
    const out = logged(spy);
    expect(out).toMatch(/23505/);
    expect(out).toMatch(/users_email_norm_key/);
    expect(out).toMatch(/users/);
    expect(out).not.toMatch(/x@y\.example/);
  });

  it('logs any other error as before', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('plain failure');
    const res = await appThrowing(err).request('/boom');
    expect(res.status).toBe(500);
    expect(spy).toHaveBeenCalledWith('unhandled error', err);
  });
});

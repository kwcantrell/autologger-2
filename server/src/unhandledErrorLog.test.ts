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

// ai-sdk-agent-harness D5: an AI SDK error carries the whole prompt (`requestBodyValues`) and the
// provider's body (`responseBody`), and its message can repeat the body, so one that escapes a
// route by a bug is logged as its class name only. `ai` is not a server dependency, so the shapes
// below stand in for its classes: the `Symbol.for('vercel.ai.error')` marker every `AISDKError`
// carries (what `AISDKError.isInstance` checks), and the two content-bearing properties.
describe('generic 500 logging of AI SDK errors (ai-sdk-agent-harness D5)', () => {
  const PROMPT = 'PLANTED-PROMPT-MARKER';
  const SDK_MARKER = Symbol.for('vercel.ai.error');

  class APICallError extends Error {
    readonly [SDK_MARKER] = true;
    constructor(
      readonly requestBodyValues: unknown,
      readonly responseBody: string,
    ) {
      super(`provider said: ${responseBody}`);
      this.name = 'AI_APICallError';
    }
  }
  class RetryError extends Error {
    readonly [SDK_MARKER] = true;
    constructor(readonly lastError: unknown) {
      super(`Failed after 3 attempts. Last error: ${PROMPT}`);
      this.name = 'AI_RetryError';
    }
  }

  async function capture(err: unknown) {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      lines.push(
        a.map((x) => (typeof x === 'string' ? x : (JSON.stringify(x) ?? String(x)))).join(' '),
      );
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      lines.push(String(c));
      return true;
    });
    let res: Response;
    try {
      res = await appThrowing(err).request('/boom');
    } finally {
      stderr.mockRestore();
    }
    return { res, out: lines.join('\n'), spy };
  }

  it.each([
    [
      'an APICallError',
      () =>
        new APICallError(
          { messages: [{ role: 'user', content: PROMPT }] },
          `{"error":"${PROMPT}"}`,
        ),
      'APICallError',
    ],
    ['a RetryError (the marker alone)', () => new RetryError(new Error(PROMPT)), 'RetryError'],
    [
      'any error carrying requestBodyValues',
      () => Object.assign(new TypeError(PROMPT), { requestBodyValues: { prompt: PROMPT } }),
      'TypeError',
    ],
    [
      'any error carrying responseBody',
      () => Object.assign(new Error(PROMPT), { responseBody: PROMPT }),
      'Error',
    ],
  ])('logs %s as its class name only', async (_label, make, className) => {
    const { res, out, spy } = await capture(make());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ detail: 'Internal Server Error' });
    expect(spy).toHaveBeenCalledWith('unhandled error', { name: className });
    expect(out).not.toContain(PROMPT);
  });

  it('logs a non-SDK error with other properties as before', async () => {
    const err = Object.assign(new Error('plain failure'), { body: 'not an sdk field' });
    const { spy } = await capture(err);
    expect(spy).toHaveBeenCalledWith('unhandled error', err);
  });
});

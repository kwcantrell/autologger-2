// The 422 body under zod 4, through the real app (migrate-zod-4 D3; api-contract-freeze
// "Validation error bodies carry zod 4 issues").
//
// Clients rely only on an issue's `code`, `path` and `message`, so these cases pin those and
// nothing else: a missing field, a message our code sets, and a non-finite number (owner decision
// 6: JSON `1e400` parses to Infinity, which zod 3 stored and zod 4 refuses). The teams family turns
// the first issue into a string `400` detail. Defaults and transforms are pinned at contract level
// (`packages/contract/src/schemas.zod4.test.ts`, case (c)).

import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import { seededSession } from '../test/helpers';

type Issue = { code: string; path: (string | number)[]; message: string };

const JSON_HEADERS = { 'content-type': 'application/json' };

async function send(method: string, path: string, body: string): Promise<Response> {
  return app.request(path, { method, headers: JSON_HEADERS, body }, { ...env });
}

async function issuesOf(res: Response): Promise<Issue[]> {
  expect(res.status).toBe(422);
  const body = (await res.json()) as { detail: unknown };
  expect(Array.isArray(body.detail)).toBe(true);
  return body.detail as Issue[];
}

describe('validation error bodies carry zod 4 issues (migrate-zod-4 D3)', () => {
  it('a session create without show_id: an invalid_type issue at show_id with a message', async () => {
    const issues = await issuesOf(
      await send('POST', '/api/sessions', JSON.stringify({ episode: '1' })),
    );
    const issue = issues.find((i) => i.path.join('.') === 'show_id');
    expect(issue?.code).toBe('invalid_type');
    expect(issue?.path).toEqual(['show_id']);
    expect(typeof issue?.message).toBe('string');
    expect(issue?.message.length).toBeGreaterThan(0);
  });

  it('an event PUT with overwrite and no version: the message our code sets, at overwrite', async () => {
    const { sessionId } = await seededSession();
    const body = {
      category: 'cam',
      message: 'm',
      wall_time_utc: '2026-01-01T00:00:00Z',
      timecode_hms: '00:00:01',
      overwrite: true,
    };
    const issues = await issuesOf(
      await send('PUT', `/api/sessions/${sessionId}/events/any-event`, JSON.stringify(body)),
    );
    expect(issues.map((i) => [i.path, i.message])).toContainEqual([
      ['overwrite'],
      'overwrite requires version',
    ]);
  });

  it('a topic create with duration_sec 1e400: a 422 at duration_sec, and no topic is written', async () => {
    const { sessionId } = await seededSession();
    const topics = `/api/sessions/${sessionId}/topics`;
    const issues = await issuesOf(
      await send('POST', topics, '{"duration_sec": 1e400, "summary": "s"}'),
    );
    expect(issues.map((i) => i.path)).toContainEqual(['duration_sec']);
    const list = await app.request(topics, { method: 'GET' }, { ...env });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ topics: [] });
  });

  it('a teams body failing its schema: a 400 whose detail is a non-empty string', async () => {
    const res = await send('POST', '/api/teams', JSON.stringify({ display_name: 'No id' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: unknown };
    expect(typeof body.detail).toBe('string');
    expect((body.detail as string).length).toBeGreaterThan(0);
  });
});

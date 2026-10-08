// session-row-versions design D3 (api-contract-freeze "Session content rows carry their version"):
// every event, transcript word and topic in a JSON response carries `version`. Lists, creates and
// updates here; Companion `log`; the generate responses use the same mappers (`wordApiDict`, the
// hub's `Topic`) and are pinned by their own suites and the captured fixtures.

import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import {
  SEED_CATEGORY_ID,
  seedCompanionDevice,
  seededSession,
  setCompanionPresence,
} from '../test/helpers';

const J = { 'content-type': 'application/json' };
async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = J,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.request(
    path,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    { ...env },
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('row responses carry version (design D3)', () => {
  it('events: create 1, list 1, update 2', async () => {
    const { sessionId } = await seededSession();
    const base = `/api/sessions/${sessionId}/events`;
    const created = await call('POST', base, { category: SEED_CATEGORY_ID, message: 'm' });
    expect(created.status).toBe(200);
    expect(created.json.version).toBe(1);
    const listed = await call('GET', base);
    expect((listed.json.events as Array<{ version: number }>).map((e) => e.version)).toEqual([1]);
    const updated = await call('PUT', `${base}/${created.json.event_id}`, {
      category: SEED_CATEGORY_ID,
      message: 'n',
      wall_time_utc: created.json.wall_time_utc,
      timecode_hms: '00:00:01',
    });
    expect(updated.status).toBe(200);
    expect(updated.json.version).toBe(2);
  });

  it('transcript words: create 1, update 2, list 2', async () => {
    const { sessionId } = await seededSession();
    const base = `/api/sessions/${sessionId}/transcript-words`;
    const created = await call('POST', base, { word: 'x' });
    expect(created.status).toBe(201);
    expect(created.json.version).toBe(1);
    const patched = await call('PATCH', `${base}/${created.json.id}`, { word: 'y' });
    expect(patched.json.version).toBe(2);
    const listed = await call('GET', base);
    expect((listed.json.words as Array<{ version: number }>).map((w) => w.version)).toEqual([2]);
  });

  it('topics: create 1, update 2, list 2', async () => {
    const { sessionId } = await seededSession();
    const base = `/api/sessions/${sessionId}/topics`;
    const created = await call('POST', base, { summary: 's' });
    expect(created.status).toBe(201);
    expect(created.json.version).toBe(1);
    const patched = await call('PATCH', `${base}/${created.json.id}`, { summary: 't' });
    expect(patched.json.version).toBe(2);
    const listed = await call('GET', base);
    expect((listed.json.topics as Array<{ version: number }>).map((t) => t.version)).toEqual([2]);
  });

  it('Companion log answers the event with version 1', async () => {
    const { sessionId } = await seededSession();
    await setCompanionPresence('c-v', sessionId);
    const res = await call(
      'POST',
      '/api/companion/log',
      { category_id: SEED_CATEGORY_ID, message: 'Cut' },
      { ...J, ...(await seedCompanionDevice()).bearer },
    );
    expect(res.status).toBe(200);
    expect(res.json.version).toBe(1);
  });
});

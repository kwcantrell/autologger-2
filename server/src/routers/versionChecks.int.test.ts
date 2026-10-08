// session-row-versions design D4, D5 (api-contract-freeze "Opt-in version checks on session content
// edits", "Overwrites are audited"): the six edit routes take an optional expected version. Without
// one they behave as before; with a current one they succeed; with a stale one they answer
// `409 {"detail":"Version conflict.","current":<row>}`, where `<row>` is the route's own success
// shape. The answer order is 404 session, 422, the event update's 400s, 404 row, 409. An overwrite
// that passes the check is recorded; one that fails is not.

import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import {
  SEED_CATEGORY_ID,
  seedCompanionDevice,
  seededSession,
  seedSession,
  seedShow,
  seedStudio,
  setCompanionPresence,
} from '../test/helpers';
import { catalogRoot } from '../test/session/sessionRows';

const J = { 'content-type': 'application/json' };
type Res = { status: number; json: Record<string, unknown> };
async function call(method: string, path: string, body?: unknown, headers = J): Promise<Res> {
  const res = await app.request(
    path,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    { ...env },
  );
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
const audits = (sessionId: string) =>
  catalogRoot()
    .bindSystem('test-seed')
    .all<Record<string, unknown>>(
      'SELECT table_name, row_id, replaced_version FROM session_overwrites WHERE session_id = ?',
      sessionId,
    );

/** A session the default signed-in user cannot reach (no membership in its team). */
async function unreachableSession(): Promise<string> {
  const studioId = await seedStudio();
  const showId = await seedShow({ studioId });
  return seedSession({ showId });
}

const eventBody = (message: string, extra: Record<string, unknown> = {}, wall = '2026-10-10T00:00:00.000Z') => ({
  category: SEED_CATEGORY_ID,
  message,
  wall_time_utc: wall,
  timecode_hms: '00:00:01',
  ...extra,
});

describe('events: PUT and DELETE with a version', () => {
  it('no version, a current version, a stale version (409 with the success shape), a deleted row (404)', async () => {
    const { sessionId } = await seededSession();
    const base = `/api/sessions/${sessionId}/events`;
    const created = await call('POST', base, { category: SEED_CATEGORY_ID, message: 'm' });
    const id = created.json.event_id as string;
    const plain = await call('PUT', `${base}/${id}`, eventBody('plain'));
    expect(plain.status).toBe(200);
    expect(plain.json.version).toBe(2);
    const current = await call('PUT', `${base}/${id}`, eventBody('current', { version: 2 }));
    expect(current.status).toBe(200);
    expect(current.json.version).toBe(3);
    const stale = await call('PUT', `${base}/${id}`, eventBody('stale', { version: 2 }));
    expect(stale.status).toBe(409);
    expect(stale.json).toEqual({ detail: 'Version conflict.', current: current.json });
    const staleDelete = await call('DELETE', `${base}/${id}?version=2`);
    expect(staleDelete).toEqual({ status: 409, json: { detail: 'Version conflict.', current: current.json } });
    expect((await call('DELETE', `${base}/${id}?version=3`)).status).toBe(200);
    expect((await call('PUT', `${base}/${id}`, eventBody('gone', { version: 3 }))).json).toEqual({ detail: 'Event not found.' });
    expect((await call('DELETE', `${base}/${id}?version=3`)).status).toBe(404);
  });

  it('answers in order: 404 session, 422, 400, then 409', async () => {
    const other = await unreachableSession();
    expect((await call('PUT', `/api/sessions/${other}/events/x`, eventBody('m', { version: 1 }))).status).toBe(404);
    expect((await call('DELETE', `/api/sessions/${other}/events/x?version=abc`)).json).toEqual({ detail: 'Session not found' });
    const { sessionId } = await seededSession();
    const base = `/api/sessions/${sessionId}/events`;
    const id = (await call('POST', base, { category: SEED_CATEGORY_ID, message: 'm' })).json.event_id as string;
    await call('PUT', `${base}/${id}`, eventBody('n'));
    expect((await call('PUT', `${base}/${id}`, eventBody('m', { overwrite: true }))).status).toBe(422);
    for (const q of ['version=abc', 'version=0', 'overwrite=1', 'version=1&overwrite=yes']) {
      expect((await call('DELETE', `${base}/${id}?${q}`)).status, q).toBe(422);
    }
    const unknownCategory = await call('PUT', `${base}/${id}`, { ...eventBody('m', { version: 1 }), category: 'nope' });
    expect(unknownCategory).toEqual({ status: 400, json: { detail: 'Unknown category for this studio profile.' } });
  });

  it('an overwrite after a conflict is recorded; a stale overwrite is refused and not recorded', async () => {
    const { sessionId } = await seededSession();
    const base = `/api/sessions/${sessionId}/events`;
    const id = (await call('POST', base, { category: SEED_CATEGORY_ID, message: 'm' })).json.event_id as string;
    await call('PUT', `${base}/${id}`, eventBody('theirs'));
    const conflict = await call('PUT', `${base}/${id}`, eventBody('mine', { version: 1 }));
    expect(conflict.status).toBe(409);
    const v = (conflict.json.current as { version: number }).version;
    await call('PUT', `${base}/${id}`, eventBody('third'));
    const staleOverwrite = await call('PUT', `${base}/${id}`, eventBody('mine', { version: v, overwrite: true }));
    expect(staleOverwrite.status).toBe(409);
    expect(await audits(sessionId)).toEqual([]);
    const fresh = (staleOverwrite.json.current as { version: number }).version;
    const overwrite = await call('PUT', `${base}/${id}`, eventBody('mine', { version: fresh, overwrite: true }));
    expect(overwrite.status).toBe(200);
    expect(overwrite.json.message).toBe('mine');
    expect(await audits(sessionId)).toEqual([
      { table_name: 'session_events', row_id: id, replaced_version: fresh },
    ]);
  });
});

describe('transcript words and topics: PATCH and DELETE with a version', () => {
  for (const kind of ['transcript-words', 'topics'] as const) {
    const field = kind === 'topics' ? 'summary' : 'word';
    const notFound = kind === 'topics' ? 'Topic not found.' : 'Transcript word not found.';
    const table = kind === 'topics' ? 'session_topics' : 'session_transcript_words';

    it(`${kind}: current, stale (409 with the success shape), deleted (404), 422s, order`, async () => {
      const { sessionId } = await seededSession();
      const base = `/api/sessions/${sessionId}/${kind}`;
      const id = (await call('POST', base, { [field]: 'a' })).json.id as string;
      const current = await call('PATCH', `${base}/${id}`, { [field]: 'b', version: 1 });
      expect(current.status).toBe(200);
      expect(current.json.version).toBe(2);
      const stale = await call('PATCH', `${base}/${id}`, { [field]: 'c', version: 1 });
      expect(stale).toEqual({ status: 409, json: { detail: 'Version conflict.', current: current.json } });
      expect(await call('DELETE', `${base}/${id}?version=1`)).toEqual({
        status: 409,
        json: { detail: 'Version conflict.', current: current.json },
      });
      expect((await call('PATCH', `${base}/${id}`, { [field]: 'd', overwrite: true })).status).toBe(422);
      expect((await call('DELETE', `${base}/${id}?overwrite=1`)).status).toBe(422);
      const other = await unreachableSession();
      expect((await call('PATCH', `/api/sessions/${other}/${kind}/${id}`, { [field]: 'x', version: 1 })).status).toBe(404);
      expect((await call('DELETE', `${base}/${id}?version=2`)).status).toBe(204);
      expect(await call('PATCH', `${base}/${id}`, { [field]: 'e', version: 2 })).toEqual({
        status: 404,
        json: { detail: notFound },
      });
      expect((await call('DELETE', `${base}/${id}?version=2`)).status).toBe(404);
    });

    it(`${kind}: an empty PATCH with the matching version and overwrite changes and records nothing; an overwriting DELETE is recorded`, async () => {
      const { sessionId } = await seededSession();
      const base = `/api/sessions/${sessionId}/${kind}`;
      const id = (await call('POST', base, { [field]: 'a' })).json.id as string;
      const empty = await call('PATCH', `${base}/${id}`, { version: 1, overwrite: true });
      expect(empty.status).toBe(200);
      expect(empty.json.version).toBe(1);
      expect(await audits(sessionId)).toEqual([]);
      expect((await call('DELETE', `${base}/${id}?version=1&overwrite=1`)).status).toBe(204);
      expect(await audits(sessionId)).toEqual([{ table_name: table, row_id: id, replaced_version: 1 }]);
    });
  }
});

describe('routes outside the check accept no version', () => {
  it('Companion log and transport ignore a version and never answer the version 409', async () => {
    const { sessionId } = await seededSession();
    await setCompanionPresence('c-vc', sessionId);
    const H = { ...J, ...(await seedCompanionDevice()).bearer };
    const log = await call('POST', '/api/companion/log', { category_id: SEED_CATEGORY_ID, message: 'x', version: 99, overwrite: true }, H);
    expect(log.status).toBe(200);
    const transport = await call('POST', '/api/companion/transport', { action: 'toggle', version: 99 }, H);
    expect(transport.status).toBe(200);
  });
});

// session-row-versions design D2 (panel F1): listing events never advances the session revision.
// The first page runs the orphan relink check, whose guard row is bookkeeping, not content; only a
// relink that changes an event advances the revision.

import { UI_SNAPSHOT_LABEL_KEY } from '@autologger/domain';
import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import { seededSession } from '../test/helpers';
import { insertRaw, testStorage } from '../test/session/sessionRows';

async function get(path: string): Promise<Record<string, unknown>> {
  const res = await app.request(path, { method: 'GET' }, { ...env });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}
const status = async (id: string) =>
  (await get(`/api/sessions/${id}/status`)).events_stream_revision as number;

describe('GET /api/sessions/:id/events and the session revision', () => {
  it('a second first-page list leaves events_stream_revision unchanged', async () => {
    const { sessionId } = await seededSession();
    // An orphan whose label snapshot names the seeded "Camera" button: the first list relinks it.
    await insertRaw(testStorage(sessionId), 'session_events', {
      id: 'orphan',
      wall_time_utc: '2026-10-10T00:00:00.000Z',
      frame_rate: 24,
      category: 'gone',
      message: 'm',
      metadata_json: JSON.stringify({ [UI_SNAPSHOT_LABEL_KEY]: 'Camera' }),
    });
    const before = await status(sessionId);
    const first = await get(`/api/sessions/${sessionId}/events`);
    expect((first.events as Array<{ category: string }>)[0]?.category).toBe('cam');
    const afterRelink = await status(sessionId);
    expect(afterRelink).toBe(before + 1);
    await get(`/api/sessions/${sessionId}/events`);
    await get(`/api/sessions/${sessionId}/events`);
    expect(await status(sessionId)).toBe(afterRelink);
  });
});

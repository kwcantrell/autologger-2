// api-contract-freeze "Catalog mirror failures don't fail saved session changes" and
// catalog-database "Session live projection is mirrored in order" (catalog-concurrency-hazards D6).

import { SessionIndexStore } from '@autologger/catalog';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app, env } from '../test/harness';
import { SEED_CATEGORY_ID, seededSession, testDb } from '../test/helpers';

const J = { 'content-type': 'application/json' };
afterEach(() => vi.restoreAllMocks());

const logEvent = (sessionId: string, message: string) =>
  app.request(
    `/api/sessions/${sessionId}/events`,
    { method: 'POST', headers: J, body: JSON.stringify({ category: SEED_CATEGORY_ID, message }) },
    { ...env },
  );
const eventCount = async (sessionId: string) =>
  Number(
    (
      await testDb().first<{ event_count: number }>(
        'SELECT event_count FROM sessions WHERE id = ?',
        sessionId,
      )
    )?.event_count,
  );

describe('a failed mirror write after a saved session change', () => {
  it('still answers 200, saves the event once, warns, and the next change heals the projection', async () => {
    const { sessionId } = await seededSession();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(SessionIndexStore.prototype, 'projectSessionLive').mockRejectedValueOnce(
      Object.assign(new Error('connection lost'), { code: 'CONNECTION_CLOSED' }),
    );
    const res = await logEvent(sessionId, 'first');
    expect(res.status).toBe(200);
    expect(env.ports.sessions.get(sessionId).ensure().event_count).toBe(1);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      new RegExp(`${sessionId}.*CONNECTION_CLOSED`),
    );
    expect(await eventCount(sessionId)).toBe(0); // the failed write

    expect((await logEvent(sessionId, 'second')).status).toBe(200);
    expect(await eventCount(sessionId)).toBe(2); // healed by the next change
  });
});

// event-generate-hardening task 1.2 (design D1) — the additive
// `has_auto_generated` boolean on `GET /api/sessions/:sessionId/events`
// (delta spec "Events list has_auto_generated field"), computed over the
// WHOLE session, independent of the returned page's `limit`/`offset`.

import { describe, expect, it } from 'vitest';
import { app, defaultUser, env } from '../test/harness';
import { catalogFor, SEED_CATEGORY_ID, seededSession } from '../test/helpers';

async function getEvents(
  sessionId: string,
  query?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  const res = await app.request(
    `/api/sessions/${sessionId}/events${qs}`,
    { method: 'GET' },
    { ...env },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('GET /api/sessions/:sessionId/events — has_auto_generated', () => {
  it('is false for a session with no events', async () => {
    const { sessionId } = await seededSession();
    const body = await getEvents(sessionId);
    expect(body.has_auto_generated).toBe(false);
  });

  it('is false when events exist but none are auto-generated', async () => {
    const { sessionId } = await seededSession();
    await (await env.ports.sessions.get(sessionId)).addEvent({
      category: 'cam',
      message: 'manual hit',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: { frameRate: 24, startOffsetFrames: 0 },
    });
    const body = await getEvents(sessionId);
    expect(body.has_auto_generated).toBe(false);
  });

  it('is true when the only auto-generated row lies outside the requested limit/offset window', async () => {
    const { sessionId } = await seededSession();
    const hub = await env.ports.sessions.get(sessionId);
    // Three manual rows first (earliest wall times), then one auto row last —
    // a limit=1/offset=0 page returns only the first manual row.
    for (let i = 0; i < 3; i += 1) {
      await hub.addEvent({
        category: 'cam',
        message: `manual-${i}`,
        metadataJson: '{}',
        markedAtUtc: `2026-01-01T00:00:0${i}.000Z`,
        ctx: { frameRate: 24, startOffsetFrames: 0 },
      });
    }
    await hub.addEvent({
      category: 'cam',
      message: 'auto hit',
      metadataJson: '{"auto_generated":true,"auto_generate_run_id":"r1"}',
      markedAtUtc: '2026-01-01T00:00:09.000Z',
      ctx: { frameRate: 24, startOffsetFrames: 0 },
    });

    const page = await getEvents(sessionId, { limit: '1', offset: '0' });
    const pageEvents = page.events as Array<Record<string, unknown>>;
    expect(pageEvents).toHaveLength(1);
    expect(pageEvents[0]?.message).toBe('manual-0');
    expect(page.has_auto_generated).toBe(true);
  });
});

// session-tables design D8 (catalog-database "The session live projection commits with the session
// write", scenario "The list is current after the response"): the projection commits with the
// event's insert, so the list read right after the response reports the new count, with no
// separate catalog writer behind the route (the mirror it once had is retired).
describe('GET /api/sessions right after POST …/events', () => {
  it('reports the new event_count', async () => {
    const { studioId, showId, sessionId } = await seededSession();
    await catalogFor().auth.authSetPrefs((await defaultUser()).id, studioId, showId);
    const post = await app.request(
      `/api/sessions/${sessionId}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: SEED_CATEGORY_ID, message: 'listed' }),
      },
      { ...env },
    );
    expect(post.status).toBe(200);
    const list = await app.request('/api/sessions', { method: 'GET' }, { ...env });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { active: Array<Record<string, unknown>> };
    expect(body.active.find((s) => s.id === sessionId)?.event_count).toBe(1);
  });
});

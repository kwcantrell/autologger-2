// event-metadata-reserved-keys task 1.2 — POST /api/sessions/:sessionId/events
// SHALL strip the reserved auto-generation attribution keys (`auto_generated`,
// `auto_generate_run_id`) from client-supplied metadata unconditionally
// (api-contract-freeze delta "Events POST strips reserved auto-generation
// metadata keys"), and PUT preserves an already-stamped row's attribution on
// edit (auto-event-generation delta "Auto-generation attribution metadata is
// server-authoritative", scenario "Editing an auto row preserves its
// attribution"). The grandfathered pre-existing-row sweep (D3: no retroactive
// cleanup, the next regenerate still sweeps client-stamped rows) is already
// pinned by events.generate.int.test.ts's `seedAutoSlateEvent` fixture, which
// seeds a predicate-matching row directly at the hub (bypassing this route,
// same as any row written before this change) and asserts the regenerate
// sweep removes it — unaffected by this change, so not re-proven here.

import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import { seededSession } from '../test/helpers';

const J = { 'content-type': 'application/json' };

interface EventOut {
  event_id: string;
  wall_time_utc: string;
  category: string;
  metadata: Record<string, unknown>;
}

async function postEvent(
  session: string,
  body: { category: string; message: string; metadata?: Record<string, unknown> },
): Promise<{ status: number; json: EventOut }> {
  const res = await app.request(
    `/api/sessions/${session}/events`,
    { method: 'POST', headers: J, body: JSON.stringify(body) },
    { ...env },
  );
  return { status: res.status, json: (await res.json()) as EventOut };
}

async function getEvents(session: string): Promise<Record<string, unknown>> {
  const res = await app.request(`/api/sessions/${session}/events`, { method: 'GET' }, { ...env });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function putEvent(
  session: string,
  eventId: string,
  body: { category: string; wall_time_utc: string },
): Promise<{ status: number; json: EventOut }> {
  const res = await app.request(
    `/api/sessions/${session}/events/${eventId}`,
    {
      method: 'PUT',
      headers: J,
      body: JSON.stringify({
        category: body.category,
        message: 'edited',
        wall_time_utc: body.wall_time_utc,
        timecode_hms: '00:00:01',
      }),
    },
    { ...env },
  );
  return { status: res.status, json: (await res.json()) as EventOut };
}

describe('POST events — reserved auto-generation metadata keys are stripped', () => {
  it('strips auto_generated/auto_generate_run_id, keeps other keys, 200', async () => {
    const { sessionId } = seededSession();
    const { status, json } = await postEvent(sessionId, {
      category: 'cam',
      message: 'm',
      metadata: { auto_generated: true, auto_generate_run_id: 'x', note: 'keep' },
    });
    expect(status).toBe(200);
    expect(json.metadata.note).toBe('keep');
    expect(json.metadata).not.toHaveProperty('auto_generated');
    expect(json.metadata).not.toHaveProperty('auto_generate_run_id');

    // Subsequent reads agree.
    const list = await getEvents(sessionId);
    const events = list.events as EventOut[];
    const stored = events.find((e) => e.event_id === json.event_id);
    expect(stored?.metadata.note).toBe('keep');
    expect(stored?.metadata).not.toHaveProperty('auto_generated');
    expect(stored?.metadata).not.toHaveProperty('auto_generate_run_id');
  });

  it('strips regardless of the values sent (value-independent)', async () => {
    const { sessionId } = seededSession();
    const { status, json } = await postEvent(sessionId, {
      category: 'cam',
      message: 'm',
      metadata: { auto_generated: 'yes', auto_generate_run_id: 7, note: 'keep' },
    });
    expect(status).toBe(200);
    expect(json.metadata.note).toBe('keep');
    expect(json.metadata).not.toHaveProperty('auto_generated');
    expect(json.metadata).not.toHaveProperty('auto_generate_run_id');
  });

  it('strips unconditionally on the internal-category path too', async () => {
    const { sessionId } = seededSession();
    const { status, json } = await postEvent(sessionId, {
      category: 'internal',
      message: 'm',
      metadata: { auto_generated: true, auto_generate_run_id: 'x', note: 'keep' },
    });
    expect(status).toBe(200);
    expect(json.category).toBe('internal');
    expect(json.metadata.note).toBe('keep');
    expect(json.metadata).not.toHaveProperty('auto_generated');
    expect(json.metadata).not.toHaveProperty('auto_generate_run_id');
  });

  it('leaves ordinary metadata (no reserved keys) byte-identical', async () => {
    const { sessionId } = seededSession();
    const metadata = { note: 'keep', nested: { x: 1 }, n: 3 };
    const { status, json } = await postEvent(sessionId, {
      category: 'cam',
      message: 'm',
      metadata,
    });
    expect(status).toBe(200);
    // UI-snapshot keys are added by the category merge — assert the
    // ordinary-metadata subset is unaffected, not the whole object.
    expect(json.metadata.note).toBe('keep');
    expect(json.metadata.nested).toEqual({ x: 1 });
    expect(json.metadata.n).toBe(3);
  });

  it('has_auto_generated stays false after a stamping POST (delta scenario)', async () => {
    const { sessionId } = seededSession();
    const { status } = await postEvent(sessionId, {
      category: 'cam',
      message: 'm',
      metadata: { auto_generated: true, auto_generate_run_id: 'x' },
    });
    expect(status).toBe(200);
    const list = await getEvents(sessionId);
    expect(list.has_auto_generated).toBe(false);
  });
});

describe("PUT event update — preserves an existing auto row's attribution", () => {
  it('an edited generation-created row still matches the auto predicate', async () => {
    const { sessionId } = seededSession();
    // Simulate a row the generation run wrote (server-side create_event
    // merge — never reachable through the POST route): stamped directly at
    // the hub, same as aiMcpServer.ts's create_event tool does.
    const hub = env.ports.sessions.get(sessionId);
    const { event } = hub.addEvent({
      category: 'cam',
      message: 'generated',
      metadataJson: '{"auto_generated":true,"auto_generate_run_id":"r1"}',
      markedAtUtc: null,
      ctx: { frameRate: 24, startOffsetFrames: 0 },
    });
    expect(hub.hasAutoGeneratedEvents()).toBe(true);

    const { status, json } = await putEvent(sessionId, event.event_id, {
      category: 'cam',
      wall_time_utc: event.wall_time_utc,
    });
    expect(status).toBe(200);
    expect(json.metadata.auto_generated).toBe(true);
    expect(json.metadata.auto_generate_run_id).toBe('r1');
    expect(hub.hasAutoGeneratedEvents()).toBe(true);
  });
});

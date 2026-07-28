// Pinning test for task 2.6 of code-health-tail (finding 3.8, design D9) and the
// change's api-contract-freeze delta: the PUT event-update `internal`-category
// snapshot-stripping branch is REACHABLE (a studio profile may define a category
// with id `internal` — category-id validation reserves no ids) and is frozen
// observable behavior, as is the PUT-vs-POST asymmetry (POST admits the built-in
// `internal` off-profile; PUT requires profile membership first). These tests pin
// that existing behavior so the branch cannot later be removed as dead code.

import { app, env } from '../test/harness';
import { describe, expect, it } from 'vitest';
import { UI_SNAPSHOT_COLOR_KEY, UI_SNAPSHOT_LABEL_KEY } from '../studio';
import { seededSession } from '../test/helpers';

const J = { 'content-type': 'application/json' };

function categoriesJsonWithInternal(internalId: string): string {
  return JSON.stringify([
    {
      id: 'cam',
      name: 'Camera',
      color: '#112233',
      type: 'BUTTON',
      dropdown_options: [],
      on_label: '',
      off_label: '',
    },
    {
      id: internalId,
      name: 'Internal Notes',
      color: '#445566',
      type: 'BUTTON',
      dropdown_options: [],
      on_label: '',
      off_label: '',
    },
  ]);
}

interface EventOut {
  event_id: string;
  wall_time_utc: string;
  category: string;
  metadata: Record<string, unknown>;
}

async function postEvent(session: string, category: string): Promise<EventOut> {
  const res = await app.request(
    `/api/sessions/${session}/events`,
    { method: 'POST', headers: J, body: JSON.stringify({ category, message: 'm' }) },
    { ...env },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as EventOut;
}

async function putEvent(
  session: string,
  eventId: string,
  body: { category: string; wall_time_utc: string },
): Promise<Response> {
  return app.request(
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
}

describe('PUT event update — profile-defined internal category (frozen edge)', () => {
  it('strips category UI snapshots when the profile defines id `internal`', async () => {
    const session = seededSession({ categoriesJson: categoriesJsonWithInternal('internal') }).sessionId;
    const ev = await postEvent(session, 'cam');
    expect(ev.metadata[UI_SNAPSHOT_LABEL_KEY]).toBe('Camera');
    expect(ev.metadata[UI_SNAPSHOT_COLOR_KEY]).toBe('#112233');

    const res = await putEvent(session, ev.event_id, {
      category: 'internal',
      wall_time_utc: ev.wall_time_utc,
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as EventOut;
    expect(updated.category).toBe('internal');
    expect(updated.metadata).not.toHaveProperty(UI_SNAPSHOT_LABEL_KEY);
    expect(updated.metadata).not.toHaveProperty(UI_SNAPSHOT_COLOR_KEY);
  });

  it('strips snapshots for any letter case of the profile-defined id', async () => {
    const session = seededSession({ categoriesJson: categoriesJsonWithInternal('Internal') }).sessionId;
    const ev = await postEvent(session, 'cam');
    const res = await putEvent(session, ev.event_id, {
      category: 'Internal',
      wall_time_utc: ev.wall_time_utc,
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as EventOut;
    expect(updated.metadata).not.toHaveProperty(UI_SNAPSHOT_LABEL_KEY);
    expect(updated.metadata).not.toHaveProperty(UI_SNAPSHOT_COLOR_KEY);
  });
});

describe('PUT event update — non-profile category rejected (frozen asymmetry)', () => {
  it('400s on `internal` when the profile does not define it (default seed profile)', async () => {
    const session = seededSession().sessionId;
    const ev = await postEvent(session, 'cam');
    const res = await putEvent(session, ev.event_id, {
      category: 'internal',
      wall_time_utc: ev.wall_time_utc,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: 'Unknown category for this studio profile.' });
  });

  it('400s on any other non-profile category', async () => {
    const session = seededSession().sessionId;
    const ev = await postEvent(session, 'cam');
    const res = await putEvent(session, ev.event_id, {
      category: 'nope',
      wall_time_utc: ev.wall_time_utc,
    });
    expect(res.status).toBe(400);
  });

  it('POST (asymmetrically) admits the built-in `internal` even off-profile', async () => {
    const session = seededSession().sessionId;
    const ev = await postEvent(session, 'internal');
    expect(ev.category).toBe('internal');
  });
});

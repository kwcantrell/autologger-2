// Integration coverage for the router -> SessionHub -> catalog-projection
// path, replacing the platform-bound integration test of the original spine
// (which drove its internals directly). The Node port has no
// DO RPC boundary — SessionHubRegistry#get() returns the hub in-process — so
// this suite instead exercises the same scenarios over real HTTP requests
// through the router, asserting on the catalog projection and response payloads.
// Task 9's SessionHub.test.ts already covers hub-internal timer/lease/eviction
// mechanics directly; this file only covers what only shows up through HTTP.

import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import { seedSession, seedShow, seedStudio, SEED_CATEGORY_ID } from '../test/helpers';

async function seeded(): Promise<string> {
  const show = await seedShow({ studioId: await seedStudio() });
  return seedSession({ showId: show });
}

describe('hub ↔ catalog projection', () => {
  it('logging an event bumps the projected event_count on the catalog row', async () => {
    const s = await seeded();
    const res = await app.request(
      `/api/sessions/${s}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: SEED_CATEGORY_ID, message: 'hello' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const row = env.DB.first<{ event_count: number }>(
      'SELECT event_count FROM sessions WHERE id = ?',
      s,
    );
    expect(row?.event_count).toBe(1);
  });

  it('start/stop take round-trips is_rolling through hub and projection', async () => {
    const s = await seeded();
    const start = await app.request(`/api/sessions/${s}/transport/start`, { method: 'POST' }, env);
    expect(start.status).toBe(200);
    const startBody = (await start.json()) as { started: boolean; is_rolling: boolean };
    expect(startBody.started).toBe(true);
    expect(startBody.is_rolling).toBe(true);

    const status = await app.request(`/api/sessions/${s}/status`, {}, env);
    expect(((await status.json()) as { is_rolling: boolean }).is_rolling).toBe(true);

    const rowWhileRolling = env.DB.first<{ is_rolling: number }>(
      'SELECT is_rolling FROM sessions WHERE id = ?',
      s,
    );
    expect(rowWhileRolling?.is_rolling).toBe(1);

    const stop = await app.request(`/api/sessions/${s}/transport/stop`, { method: 'POST' }, env);
    expect(stop.status).toBe(200);
    const stopBody = (await stop.json()) as { stopped: boolean; is_rolling: boolean };
    expect(stopBody.stopped).toBe(true);
    expect(stopBody.is_rolling).toBe(false);

    const rowAfterStop = env.DB.first<{ is_rolling: number }>(
      'SELECT is_rolling FROM sessions WHERE id = ?',
      s,
    );
    expect(rowAfterStop?.is_rolling).toBe(0);
  });

  it('hub state persists across registry eviction (reopen from disk)', async () => {
    const s = await seeded();
    await app.request(
      `/api/sessions/${s}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: SEED_CATEGORY_ID, message: 'persisted' }),
      },
      env,
    );
    env.SESSION_HUBS.evictIdle(0); // force-close every idle hub
    const events = await app.request(`/api/sessions/${s}/events`, {}, env);
    const body = (await events.json()) as { events: Array<{ message: string }> };
    expect(body.events.some((e) => e.message === 'persisted')).toBe(true);
  });

  it('recording lease claim/conflict/release over HTTP', async () => {
    const s = await seeded();
    const claim = (cid: string) =>
      app.request(
        `/api/sessions/${s}/audio-recording-lease`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: cid }),
        },
        env,
      );
    expect((await claim('tab-a')).status).toBe(200);
    expect((await claim('tab-b')).status).toBe(409);
    const release = await app.request(
      `/api/sessions/${s}/audio-recording-lease/release`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: 'tab-a' }),
      },
      env,
    );
    expect(release.status).toBe(200);
    expect((await claim('tab-b')).status).toBe(200);
  });

  it('status payload exposes event counts, revision, and lease fields (old-suite parity)', async () => {
    const s = await seeded();
    await app.request(
      `/api/sessions/${s}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: SEED_CATEGORY_ID, message: 'first' }),
      },
      env,
    );
    const res = await app.request(`/api/sessions/${s}/status`, {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      event_count: number;
      logged_event_count: number;
      events_stream_revision: number;
      audio_recording_lease_holder_id: string | null;
      audio_recording_lease_alive: boolean;
    };
    expect(body.event_count).toBe(1);
    expect(body.logged_event_count).toBe(1);
    expect(body.events_stream_revision).toBeGreaterThan(0);
    expect(body.audio_recording_lease_holder_id).toBeNull();
    expect(body.audio_recording_lease_alive).toBe(false);
  });

  it('audio segment add/list round-trips through the hub over HTTP (add→list; delete has no HTTP route)', async () => {
    const s = await seeded();
    const bytes = new Uint8Array([9, 8, 7]);
    const up = await app.request(
      `/api/sessions/${s}/audio/segments`,
      { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: bytes },
      env,
    );
    expect(up.status).toBe(200);
    const seg = (await up.json()) as { id: string };

    const list = await app.request(`/api/sessions/${s}/audio/segments`, {}, env);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { segments: Array<{ id: string }>; has_audio: boolean };
    expect(listBody.segments.some((x) => x.id === seg.id)).toBe(true);
    expect(listBody.has_audio).toBe(true);
  });
});

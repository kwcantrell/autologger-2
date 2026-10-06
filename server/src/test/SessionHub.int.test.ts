// Integration coverage for the router -> SessionHub -> catalog-projection
// path, replacing the platform-bound integration test of the original spine
// (which drove its internals directly). The Node port has no
// DO RPC boundary — SessionHubRegistry#get() returns the hub in-process — so
// this suite instead exercises the same scenarios over real HTTP requests
// through the router, asserting on the catalog projection and response payloads. The projection
// commits inside each hub write (session-tables design D8), so the catalog row is current as soon
// as the response arrives, with no writer behind the route.
// Task 9's SessionHub.test.ts already covers hub-internal timer/lease/eviction
// mechanics directly; this file only covers what only shows up through HTTP.

import { describe, expect, it } from 'vitest';
import { app, env } from './harness';
import {
  COMPANION_BEARER,
  loginCookie,
  SEED_CATEGORY_ID,
  seededSession,
  seedUser,
  setCompanionPresence,
  testDb,
} from './helpers';

describe('hub ↔ catalog projection', () => {
  it('logging an event bumps the projected event_count on the catalog row, committed with the write', async () => {
    const s = (await seededSession()).sessionId;
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
    const row = await testDb().first<{ event_count: number }>(
      'SELECT event_count FROM sessions WHERE id = ?',
      s,
    );
    expect(row?.event_count).toBe(1);
  });

  it('start/stop take round-trips is_rolling through hub and projection', async () => {
    const s = (await seededSession()).sessionId;
    const start = await app.request(`/api/sessions/${s}/transport/start`, { method: 'POST' }, env);
    expect(start.status).toBe(200);
    const startBody = (await start.json()) as { started: boolean; is_rolling: boolean };
    expect(startBody.started).toBe(true);
    expect(startBody.is_rolling).toBe(true);

    const status = await app.request(`/api/sessions/${s}/status`, {}, env);
    expect(((await status.json()) as { is_rolling: boolean }).is_rolling).toBe(true);

    const rowWhileRolling = await testDb().first<{ is_rolling: number }>(
      'SELECT is_rolling FROM sessions WHERE id = ?',
      s,
    );
    expect(rowWhileRolling?.is_rolling).toBe(1);

    const stop = await app.request(`/api/sessions/${s}/transport/stop`, { method: 'POST' }, env);
    expect(stop.status).toBe(200);
    const stopBody = (await stop.json()) as { stopped: boolean; is_rolling: boolean };
    expect(stopBody.stopped).toBe(true);
    expect(stopBody.is_rolling).toBe(false);

    const rowAfterStop = await testDb().first<{ is_rolling: number }>(
      'SELECT is_rolling FROM sessions WHERE id = ?',
      s,
    );
    expect(rowAfterStop?.is_rolling).toBe(0);
  });

  it('hub state persists across registry eviction (reopen from disk)', async () => {
    const s = (await seededSession()).sessionId;
    await app.request(
      `/api/sessions/${s}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: SEED_CATEGORY_ID, message: 'persisted' }),
      },
      env,
    );
    env.ports.sessions.evictIdle(0); // force-close every idle hub
    const events = await app.request(`/api/sessions/${s}/events`, {}, env);
    const body = (await events.json()) as { events: Array<{ message: string }> };
    expect(body.events.some((e) => e.message === 'persisted')).toBe(true);
  });

  it('recording lease claim/conflict/release over HTTP', async () => {
    const s = (await seededSession()).sessionId;
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

  // session-leases task 5.1 (design D3, D4): the lease is bound to the user as well as the client
  // id, and only the holding user sees its client id. A is the default signed-in user; B is a
  // second user who also reaches the session (an admin of its studio, show-grants D14).
  describe('recording lease user binding and holder masking (session-leases D3, D4)', () => {
    type LeaseStatus = {
      audio_recording_lease_holder_id: string | null;
      audio_recording_lease_alive: boolean;
      audio_recording_lease_age_sec: number | null;
    } & Record<string, unknown>;

    async function twoUsers(): Promise<{ s: string; bCookie: string }> {
      const { studioId, sessionId } = await seededSession();
      const b = await seedUser({ studios: [studioId], role: 'admin' });
      return { s: sessionId, bCookie: await loginCookie(b) };
    }

    const post = (s: string, path: string, clientId: string, cookie?: string) =>
      app.request(
        `/api/sessions/${s}/audio-recording-lease${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cookie === undefined ? {} : { cookie }),
          },
          body: JSON.stringify({ client_id: clientId }),
        },
        env,
      );
    const claim = (s: string, cid: string, cookie?: string) => post(s, '', cid, cookie);
    const heartbeat = (s: string, cid: string, cookie?: string) =>
      post(s, '/heartbeat', cid, cookie);
    const release = (s: string, cid: string, cookie?: string) => post(s, '/release', cid, cookie);
    const status = async (s: string, cookie?: string): Promise<LeaseStatus> => {
      const res = await app.request(
        `/api/sessions/${s}/status`,
        cookie === undefined ? {} : { headers: { cookie } },
        env,
      );
      expect(res.status).toBe(200);
      return (await res.json()) as LeaseStatus;
    };

    it('B cannot claim, heartbeat or release A’s lease, and sees "another-client"', async () => {
      const { s, bCookie } = await twoUsers();
      expect((await claim(s, 'tab-a')).status).toBe(200);

      // B claims with A's own client id, and with its own: both 409.
      expect((await claim(s, 'tab-a', bCookie)).status).toBe(409);
      expect((await claim(s, 'tab-b', bCookie)).status).toBe(409);

      // B heartbeats with A's client id: refused.
      const hb = await heartbeat(s, 'tab-a', bCookie);
      expect(hb.status).toBe(200);
      expect(await hb.json()).toEqual({ ok: false });

      // B releases with A's client id: answers ok, but A still holds a live lease.
      const rel = await release(s, 'tab-a', bCookie);
      expect(rel.status).toBe(200);
      expect(await rel.json()).toEqual({ ok: true });
      const asA = await status(s);
      expect(asA.audio_recording_lease_holder_id).toBe('tab-a');
      expect(asA.audio_recording_lease_alive).toBe(true);

      // B's status masks the holder's client id.
      const asB = await status(s, bCookie);
      expect(asB.audio_recording_lease_holder_id).toBe('another-client');
      expect(asB.audio_recording_lease_alive).toBe(true);

      // A's own heartbeat still works.
      expect(await (await heartbeat(s, 'tab-a')).json()).toEqual({ ok: true });
    });

    it('A claiming with another client is 409; after A releases, B claims', async () => {
      const { s, bCookie } = await twoUsers();
      expect((await claim(s, 'tab-a')).status).toBe(200);
      expect((await claim(s, 'tab-a2')).status).toBe(409);
      expect(await (await release(s, 'tab-a')).json()).toEqual({ ok: true });
      expect((await claim(s, 'tab-b', bCookie)).status).toBe(200);
      const asB = await status(s, bCookie);
      expect(asB.audio_recording_lease_holder_id).toBe('tab-b');
      const asA = await status(s);
      expect(asA.audio_recording_lease_holder_id).toBe('another-client');
      expect(asA.audio_recording_lease_alive).toBe(true);
    });

    it.each([
      ['whitespace-only', '   '],
      ['NUL', '\u0000'],
      ['NUL padded by spaces', ' \u0000 '],
      ['NUL inside an id', 'tab\u0000a'],
    ])('a %s client id gives 409 / {ok:false} / {ok:true}, never 500', async (_label, cid) => {
      const { s } = await twoUsers();
      const c = await claim(s, cid);
      expect(c.status).toBe(409);
      const hb = await heartbeat(s, cid);
      expect(hb.status).toBe(200);
      expect(await hb.json()).toEqual({ ok: false });
      const rel = await release(s, cid);
      expect(rel.status).toBe(200);
      expect(await rel.json()).toEqual({ ok: true });
      const st = await status(s);
      expect(st.audio_recording_lease_holder_id).toBeNull();
      expect(st.audio_recording_lease_alive).toBe(false);
      // The refusals left the lease free.
      expect((await claim(s, 'tab-a')).status).toBe(200);
    });

    it('the status field names and lease field types are unchanged', async () => {
      const { s, bCookie } = await twoUsers();
      const free = await status(s);
      expect(free.audio_recording_lease_holder_id).toBeNull();
      expect(free.audio_recording_lease_alive).toBe(false);
      expect(free.audio_recording_lease_age_sec).toBeNull();
      expect((await claim(s, 'tab-a')).status).toBe(200);
      const asA = await status(s);
      const asB = await status(s, bCookie);
      for (const held of [asA, asB]) {
        expect(Object.keys(held).sort()).toEqual(Object.keys(free).sort());
        expect(typeof held.audio_recording_lease_holder_id).toBe('string');
        expect(typeof held.audio_recording_lease_alive).toBe('boolean');
        expect(typeof held.audio_recording_lease_age_sec).toBe('number');
      }
    });

    it('GET /api/companion/state shows is_recording while A holds the lease', async () => {
      const { s } = await twoUsers();
      await setCompanionPresence('c1', s, { visible: true });
      const state = async () => {
        const res = await app.request(
          '/api/companion/state',
          { method: 'GET', headers: COMPANION_BEARER },
          env,
        );
        expect(res.status).toBe(200);
        return (await res.json()) as { session: { id: string; is_recording: boolean } | null };
      };
      expect((await state()).session?.is_recording).toBe(false);
      expect((await claim(s, 'tab-a')).status).toBe(200);
      const held = await state();
      expect(held.session?.id).toBe(s);
      expect(held.session?.is_recording).toBe(true);
      expect(await (await release(s, 'tab-a')).json()).toEqual({ ok: true });
      expect((await state()).session?.is_recording).toBe(false);
    });
  });

  it('status payload exposes event counts, revision, and lease fields (old-suite parity)', async () => {
    const s = (await seededSession()).sessionId;
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
    const s = (await seededSession()).sessionId;
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

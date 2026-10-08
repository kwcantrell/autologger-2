// companion-devices D3 (api-contract-freeze "Companion routes run as the caller's user"): every
// Companion route runs as a user (the signed-in user, or the device's user). The active session is
// picked from the caller's own fresh presence rows and then checked for access; the last command
// is per device; a device cannot post presence; presence rows belong to the user who wrote them.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { anonApp, env } from '../test/harness';
import {
  catalogFor,
  SEED_CATEGORY_ID,
  seedAccessMatrix,
  seedCompanionDevice,
  seedSession,
  testDb,
} from '../test/helpers';
import { busProcess, closeBusProcesses } from '../test/session/busProcesses';
import { harnessHub } from '../test/session/sessionRows';

const JSON_H = { 'content-type': 'application/json' };
const NO_ACTIVE = {
  detail: 'No active session — open AutoLogger in a browser and open a session.',
};
const DEVICE_PRESENCE_403 = {
  detail: 'Presence is posted by the AutoLogger browser app, not by a Companion device.',
};

type Init = { method?: string; body?: unknown; raw?: string };
type Json = Record<string, unknown>;

function send(headers: Record<string, string>, path: string, init: Init = {}) {
  const hasBody = init.body !== undefined || init.raw !== undefined;
  return anonApp.request(
    path,
    {
      method: init.method ?? (hasBody ? 'POST' : 'GET'),
      headers: { ...JSON_H, ...headers },
      body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    },
    { ...env },
  );
}
const asCookie = (cookie: string, path: string, init: Init = {}) => send({ cookie }, path, init);
const asDevice = (dev: { bearer: Record<string, string> }, path: string, init: Init = {}) =>
  send(dev.bearer, path, init);

async function stateOf(res: Response | Promise<Response>): Promise<Json> {
  const r = await res;
  expect(r.status).toBe(200);
  return (await r.json()) as Json;
}

/** Presence posted through the route by `cookie` (the browser's own post). */
async function postPresence(cookie: string, body: Json): Promise<Response> {
  return await asCookie(cookie, '/api/companion/presence', { body });
}

async function eventCount(sessionId: string): Promise<number> {
  return (await (await harnessHub(sessionId)).ensure()).event_count;
}

async function lastCommandKeys(): Promise<Array<{ key: string; value: string }>> {
  return testDb().all<{ key: string; value: string }>(
    "SELECT key, value FROM kv WHERE key LIKE 'companion:last_command%' ORDER BY key",
  );
}

/** A team with two sessions of one show, reachable by the owner and the granted member. */
async function twoSessions() {
  const m = await seedAccessMatrix();
  const s2 = await seedSession({ showId: m.showId });
  return { ...m, s1: m.sessionId, s2 };
}

describe('the active session is picked from the caller’s own presence rows', () => {
  it('a device follows only its user’s presence, and logs into that session', async () => {
    const t = await twoSessions();
    const a = t.granted;
    const b = t.owner;
    expect((await postPresence(a.cookie, { client_id: 'tab-a', session_id: t.s1 })).status).toBe(
      200,
    );
    expect((await postPresence(b.cookie, { client_id: 'tab-b', session_id: t.s2 })).status).toBe(
      200,
    );
    const dev = await seedCompanionDevice(a.id);
    const st = await stateOf(asDevice(dev, '/api/companion/state'));
    expect(st.active_session_id).toBe(t.s1);
    expect(st.connected_clients).toBe(1);
    const log = await asDevice(dev, '/api/companion/log', {
      body: { category_id: SEED_CATEGORY_ID, message: 'mine' },
    });
    expect(log.status).toBe(200);
    expect(await eventCount(t.s1)).toBe(1);
    expect(await eventCount(t.s2)).toBe(0);
    // B's device follows B's browser.
    const bDev = await seedCompanionDevice(b.id);
    expect((await stateOf(asDevice(bDev, '/api/companion/state'))).active_session_id).toBe(t.s2);
  });

  it('a cookie caller sees only their own presence rows', async () => {
    const t = await twoSessions();
    await postPresence(t.granted.cookie, { client_id: 'tab-a', session_id: t.s1, visible: false });
    await postPresence(t.owner.cookie, { client_id: 'tab-b', session_id: t.s2, visible: true });
    await postPresence(t.owner.cookie, { client_id: 'tab-b2', session_id: t.s2, visible: true });
    const st = await stateOf(asCookie(t.granted.cookie, '/api/companion/state'));
    expect(st.active_session_id).toBe(t.s1);
    expect(st.connected_clients).toBe(1);
    const own = await stateOf(asCookie(t.owner.cookie, '/api/companion/state'));
    expect(own.active_session_id).toBe(t.s2);
    expect(own.connected_clients).toBe(2);
  });

  it('a session the device’s user lost access to gives the masked answer', async () => {
    const m = await seedAccessMatrix();
    await postPresence(m.granted.cookie, { client_id: 'tab-a', session_id: m.sessionId });
    const dev = await seedCompanionDevice(m.granted.id);
    expect((await stateOf(asDevice(dev, '/api/companion/state'))).active_session_id).toBe(
      m.sessionId,
    );
    await catalogFor().auth.authRevokeShow(m.granted.id, m.showId);
    const st = await stateOf(asDevice(dev, '/api/companion/state'));
    expect(st).toMatchObject({ active_session_id: null, session: null });
    const log = await asDevice(dev, '/api/companion/log', {
      body: { category_id: SEED_CATEGORY_ID, message: 'x' },
    });
    expect(log.status).toBe(409);
    expect(await log.json()).toEqual(NO_ACTIVE);
    expect(await eventCount(m.sessionId)).toBe(0);
  });

  it('a cookie caller’s fresh own row on a session they cannot access: the masked answer on all five routes', async () => {
    const m = await seedAccessMatrix();
    const idle = await stateOf(asCookie(m.ungranted.cookie, '/api/companion/state'));
    // The denied user's own fresh, visible row, through the port.
    await env.ports.presence.upsert('tab-denied', {
      user_id: m.ungranted.id,
      session_id: m.sessionId,
      visible: true,
      is_playing: true,
      updated: env.ports.clock.now(),
    });
    expect((await env.ports.presence.list(m.ungranted.id)).map((r) => r.session_id)).toEqual([
      m.sessionId,
    ]);
    const hub = await harnessHub(m.sessionId);
    const broadcast = vi.spyOn(hub, 'broadcastCommand');
    const before = await (await harnessHub(m.sessionId)).ensure();
    const st = await stateOf(asCookie(m.ungranted.cookie, '/api/companion/state'));
    expect(st).toMatchObject({ active_session_id: null, session: null, last_command: null });
    expect({ ...st, connected_clients: 0 }).toEqual({ ...idle, connected_clients: 0 });
    for (const [path, body] of [
      ['/api/companion/categories', undefined],
      ['/api/companion/log', { category_id: SEED_CATEGORY_ID, message: 'x' }],
      ['/api/companion/transport', { action: 'start' }],
      ['/api/companion/command', { type: 'record-start' }],
    ] as const) {
      const res = await asCookie(m.ungranted.cookie, path, { body });
      expect(`${path} ${res.status}`).toBe(`${path} 409`);
      expect(await res.json()).toEqual(NO_ACTIVE);
    }
    const after = await (await harnessHub(m.sessionId)).ensure();
    expect([after.event_count, after.current_take]).toEqual([
      before.event_count,
      before.current_take,
    ]);
    expect(broadcast).not.toHaveBeenCalled();
    expect(await lastCommandKeys()).toEqual([]);
  });
});

describe('connected_clients and is_playing are scoped to the caller’s own fresh rows', () => {
  it('another user’s rows on the same session neither count nor make it playing', async () => {
    const m = await seedAccessMatrix();
    const a = m.granted;
    await postPresence(a.cookie, { client_id: 'a-1', session_id: m.sessionId, is_playing: false });
    await postPresence(a.cookie, { client_id: 'a-2', session_id: null });
    await postPresence(m.owner.cookie, {
      client_id: 'o-1',
      session_id: m.sessionId,
      is_playing: true,
    });
    const dev = await seedCompanionDevice(a.id);
    let st = await stateOf(asDevice(dev, '/api/companion/state'));
    expect(st.connected_clients).toBe(2);
    expect((st.session as { is_playing: boolean }).is_playing).toBe(false);
    const ck = await stateOf(asCookie(a.cookie, '/api/companion/state'));
    expect(ck.connected_clients).toBe(2);
    expect((ck.session as { is_playing: boolean }).is_playing).toBe(false);

    await postPresence(a.cookie, { client_id: 'a-1', session_id: m.sessionId, is_playing: true });
    st = await stateOf(asDevice(dev, '/api/companion/state'));
    expect((st.session as { is_playing: boolean }).is_playing).toBe(true);
    // The owner's view counts only the owner's row.
    const own = await stateOf(asCookie(m.owner.cookie, '/api/companion/state'));
    expect(own.connected_clients).toBe(1);
  });
});

describe('the last command is per device', () => {
  it('D1’s command is D1’s last command, under D1’s key; D2 neither sees nor acks it', async () => {
    const m = await seedAccessMatrix();
    await postPresence(m.granted.cookie, { client_id: 'tab', session_id: m.sessionId });
    const d1 = await seedCompanionDevice(m.granted.id);
    const d2 = await seedCompanionDevice(m.granted.id);
    const cmd = await asDevice(d1, '/api/companion/command', { body: { type: 'record-start' } });
    expect(cmd.status).toBe(200);
    const { command_id } = (await cmd.json()) as { command_id: string };

    const keys = await lastCommandKeys();
    expect(keys.map((k) => k.key)).toEqual([`companion:last_command:${d1.id}`]);
    expect(JSON.parse(keys[0].value)).toMatchObject({ id: command_id, session_id: m.sessionId });

    expect(
      ((await stateOf(asDevice(d1, '/api/companion/state'))).last_command as { id: string }).id,
    ).toBe(command_id);
    expect((await stateOf(asDevice(d2, '/api/companion/state'))).last_command).toBeNull();

    const ack = (dev: typeof d1) =>
      asDevice(dev, `/api/companion/commands/${command_id}/ack`, {
        body: { client_id: 'tab', ok: true },
      });
    expect(await (await ack(d2)).json()).toEqual({ ok: false });
    expect(await (await ack(d1)).json()).toEqual({ ok: true });
    expect((await stateOf(asDevice(d1, '/api/companion/state'))).last_command).toMatchObject({
      id: command_id,
      ok: true,
      delivered_to: 'tab',
    });
  });

  it('a cookie caller’s command is delivered but recorded under no key; it reads null and acks {ok:false}', async () => {
    const m = await seedAccessMatrix();
    await postPresence(m.granted.cookie, { client_id: 'tab', session_id: m.sessionId });
    const d1 = await seedCompanionDevice(m.granted.id);
    const devCmd = (await (
      await asDevice(d1, '/api/companion/command', { body: { type: 'record-start' } })
    ).json()) as { command_id: string };
    const before = await lastCommandKeys();

    const hub = await harnessHub(m.sessionId);
    const broadcast = vi.spyOn(hub, 'broadcastCommand');
    const res = await asCookie(m.granted.cookie, '/api/companion/command', {
      body: { type: 'play-toggle' },
    });
    expect(res.status).toBe(200);
    expect(broadcast).toHaveBeenCalledWith('play-toggle');
    expect(await lastCommandKeys()).toEqual(before);

    const st = await stateOf(asCookie(m.granted.cookie, '/api/companion/state'));
    expect(st.active_session_id).toBe(m.sessionId);
    expect(st.last_command).toBeNull();
    const ack = await asCookie(
      m.granted.cookie,
      `/api/companion/commands/${devCmd.command_id}/ack`,
      {
        body: { client_id: 'tab', ok: true },
      },
    );
    expect(await ack.json()).toEqual({ ok: false });
    expect(await lastCommandKeys()).toEqual(before);
  });
});

describe('presence POST', () => {
  it('a device caller gets 403 first: before body validation, the NUL 400 and any write', async () => {
    const m = await seedAccessMatrix();
    const dev = await seedCompanionDevice(m.granted.id);
    const upsert = vi.spyOn(env.ports.presence, 'upsert');
    const remove = vi.spyOn(env.ports.presence, 'remove');
    for (const init of [
      { body: { client_id: 'dev-tab', session_id: m.sessionId } },
      { body: { client_id: 'dev-tab', closing: true } },
      { body: {} },
      { raw: 'not json' },
      { body: { client_id: `a\u0000b`, session_id: m.sessionId } },
      { body: { client_id: 'dev-tab', session_id: `s\u00001` } },
      { body: { client_id: '   ' } },
    ]) {
      const res = await asDevice(dev, '/api/companion/presence', init);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(DEVICE_PRESENCE_403);
    }
    expect(upsert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await env.ports.presence.list(m.granted.id)).toEqual([]);
    expect((await stateOf(asDevice(dev, '/api/companion/state'))).active_session_id).toBeNull();
  });

  it('another user’s post or closing for a live client id changes nothing and answers 200', async () => {
    const t = await twoSessions();
    const a = t.granted;
    const b = t.owner;
    await postPresence(a.cookie, { client_id: 'shared', session_id: t.s1 });
    const moved = await postPresence(b.cookie, { client_id: 'shared', session_id: t.s2 });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual({ ok: true });
    const closed = await postPresence(b.cookie, { client_id: 'shared', closing: true });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toEqual({ ok: true });
    const st = await stateOf(asCookie(a.cookie, '/api/companion/state'));
    expect(st.active_session_id).toBe(t.s1);
    expect(st.connected_clients).toBe(1);
    expect(await env.ports.presence.list(b.id)).toEqual([]);
  });

  it('a blank-after-trim or NUL client_id is 400 before any write', async () => {
    const m = await seedAccessMatrix();
    await postPresence(m.granted.cookie, { client_id: 'keep', session_id: m.sessionId });
    const upsert = vi.spyOn(env.ports.presence, 'upsert');
    const remove = vi.spyOn(env.ports.presence, 'remove');
    for (const body of [
      { client_id: '   ', session_id: m.sessionId },
      { client_id: '   ', closing: true },
      { client_id: `ke${'\u0000'}ep`, session_id: m.sessionId },
      { client_id: `ke${'\u0000'}ep`, closing: true },
    ]) {
      const res = await postPresence(m.granted.cookie, body);
      expect(`${JSON.stringify(body)} ${res.status}`).toBe(`${JSON.stringify(body)} 400`);
      expect(await res.json()).toEqual({ detail: expect.any(String) });
    }
    expect(upsert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect((await env.ports.presence.list(m.granted.id)).map((r) => r.client_id)).toEqual(['keep']);
  });

  it('an absent, null or blank session_id stores no session', async () => {
    const m = await seedAccessMatrix();
    for (const [cid, extra] of [
      ['no-sid', {}],
      ['null-sid', { session_id: null }],
      ['blank-sid', { session_id: '   ' }],
    ] as const) {
      const res = await postPresence(m.granted.cookie, { client_id: cid, ...extra });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    const rows = await env.ports.presence.list(m.granted.id);
    expect(rows.map((r) => [r.client_id, r.session_id]).sort()).toEqual([
      ['blank-sid', null],
      ['no-sid', null],
      ['null-sid', null],
    ]);
    const st = await stateOf(asCookie(m.granted.cookie, '/api/companion/state'));
    expect(st).toMatchObject({ active_session_id: null, session: null, connected_clients: 3 });
  });
});

describe('two processes', () => {
  afterEach(() => closeBusProcesses());

  it('presence posted on app A is followed by /state with the device on app B', async () => {
    const m = await seedAccessMatrix();
    const [a, b] = [await busProcess(), await busProcess()];
    const posted = await fetch(`http://127.0.0.1:${a.port}/api/companion/presence`, {
      method: 'POST',
      headers: { ...JSON_H, cookie: m.granted.cookie },
      body: JSON.stringify({ client_id: 'tab-a', session_id: m.sessionId, visible: true }),
    });
    expect(posted.status).toBe(200);
    const dev = await seedCompanionDevice(m.granted.id);
    const res = await fetch(`http://127.0.0.1:${b.port}/api/companion/state`, {
      headers: dev.bearer,
    });
    expect(res.status).toBe(200);
    const st = (await res.json()) as Json;
    expect(st.active_session_id).toBe(m.sessionId);
    expect((st.session as { id: string }).id).toBe(m.sessionId);
  });
});

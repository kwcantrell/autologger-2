import { KvStore } from '@autologger/storage';
import { describe, expect, it, vi } from 'vitest';
import { GatedCatalog } from '../test/gatedCatalog';
import { anonApp, app, defaultUser, env, envWith } from '../test/harness';
import {
  SEED_CATEGORY_ID,
  seedAccessMatrix,
  seedCompanionDevice,
  seededSession,
  seedMemberStudio,
  seedSession,
  seedShow,
  seedUser,
  setCompanionPresence,
} from '../test/helpers';
import { harnessHub } from '../test/session/sessionRows';

/** JSON headers with the default user's Companion device token (D9 category 1). */
const J = async () => ({
  'content-type': 'application/json',
  ...(await seedCompanionDevice()).bearer,
});
async function state(): Promise<Record<string, unknown>> {
  const res = await app.request(
    '/api/companion/state',
    { method: 'GET', headers: (await seedCompanionDevice()).bearer },
    { ...env },
  );
  return (await res.json()) as Record<string, unknown>;
}

describe('presence + state', () => {
  it('a registered presence surfaces in state', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s, { visible: true });
    const body = await state();
    expect(Number(body.connected_clients)).toBeGreaterThanOrEqual(1);
    expect(body.active_session_id).toBe(s);
    expect((body.session as { id: string }).id).toBe(s);
    expect(body.last_command).toBeNull();
  });

  // session-title-suffix (design D5, gate ruling 2026-08-02, task 1.5/3.1):
  // deck_title equals the stored session title everywhere — Companion state
  // is the third of the three frozen emitters (list/detail/status are
  // covered in sessions.int.test.ts).
  it('deck_title equals the stored title, not CODE - episode', async () => {
    // D9 category 3: the device's user must be able to access the studio (no token-only bypass).
    const studio = await seedMemberStudio();
    const show = await seedShow({ studioId: studio, code: 'HD' });
    const s = await seedSession({ showId: show, episode: '7', title: 'HD_260802' });
    await setCompanionPresence('c1', s, { visible: true });
    const body = await state();
    expect((body.session as { deck_title: string }).deck_title).toBe('HD_260802');
  });

  it('deck_title falls back to "—" for a blank stored title, even with a show code present', async () => {
    // D9 category 3: the device's user must be able to access the studio (no token-only bypass).
    const studio = await seedMemberStudio();
    const show = await seedShow({ studioId: studio, code: 'HD' });
    const s = await seedSession({ showId: show, episode: '7', title: '' });
    await setCompanionPresence('c1', s, { visible: true });
    const body = await state();
    expect((body.session as { title: string }).title).toBe('');
    expect((body.session as { deck_title: string }).deck_title).toBe('—');
  });

  it('POST presence with closing:true removes it', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    // D9 category 7: the closing post comes from the row's owner (the default user's cookie);
    // a token-only post now stores and removes nothing.
    await anonApp.request(
      '/api/companion/presence',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: (await defaultUser()).cookie },
        body: JSON.stringify({ client_id: 'c1', closing: true }),
      },
      { ...env },
    );
    expect((await state()).active_session_id).toBeNull();
  });
});

describe('log', () => {
  it('logs an event by category_id for the active session', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const res = await app.request(
      '/api/companion/log',
      {
        method: 'POST',
        headers: await J(),
        body: JSON.stringify({ category_id: 'cam', message: 'Cut' }),
      },
      { ...env },
    );
    expect(res.status).toBe(200);
  });

  it('409 when there is no active session', async () => {
    const res = await app.request(
      '/api/companion/log',
      {
        method: 'POST',
        headers: await J(),
        body: JSON.stringify({ category_id: 'cam', message: 'x' }),
      },
      { ...env },
    );
    expect(res.status).toBe(409);
  });

  it('400 on an unknown category', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const res = await app.request(
      '/api/companion/log',
      {
        method: 'POST',
        headers: await J(),
        body: JSON.stringify({ category_id: 'nope', message: 'x' }),
      },
      { ...env },
    );
    expect(res.status).toBe(400);
  });
});

describe('transport', () => {
  it('start then stop flips is_rolling', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const start = await app.request(
      '/api/companion/transport',
      { method: 'POST', headers: await J(), body: JSON.stringify({ action: 'start' }) },
      { ...env },
    );
    expect((await start.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      is_rolling: true,
      current_take: 1,
    });
    const stop = await app.request(
      '/api/companion/transport',
      { method: 'POST', headers: await J(), body: JSON.stringify({ action: 'stop' }) },
      { ...env },
    );
    expect(((await stop.json()) as { is_rolling: boolean }).is_rolling).toBe(false);
  });
});

describe('command + ack', () => {
  it('records last_command and acks by id', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const cmd = await app.request(
      '/api/companion/command',
      { method: 'POST', headers: await J(), body: JSON.stringify({ type: 'record-start' }) },
      { ...env },
    );
    const commandId = ((await cmd.json()) as { command_id: string }).command_id;
    expect(commandId).toBeTruthy();
    expect(((await state()).last_command as { id: string }).id).toBe(commandId);

    const ack = await app.request(
      `/api/companion/commands/${commandId}/ack`,
      { method: 'POST', headers: await J(), body: JSON.stringify({ client_id: 'c1', ok: true }) },
      { ...env },
    );
    expect((await ack.json()) as { ok: boolean }).toMatchObject({ ok: true });

    const bad = await app.request(
      '/api/companion/commands/wrong-id/ack',
      { method: 'POST', headers: await J(), body: JSON.stringify({ client_id: 'c1', ok: true }) },
      { ...env },
    );
    expect((await bad.json()) as { ok: boolean }).toMatchObject({ ok: false });
  });
});

describe('categories + commands/wait', () => {
  it('returns the active session show categories', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const res = await app.request(
      '/api/companion/categories',
      { method: 'GET', headers: (await seedCompanionDevice()).bearer },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { categories: unknown[] }).categories)).toBe(true);
  });

  it('byte-shape is unchanged for an instruction-bearing show (auto-generate-event-logs)', async () => {
    // Frozen-contract pin (delta scenario "Feed client learns instruction
    // presence; Companion unchanged"): even when the show's categories carry
    // `auto_instruction` values, the Companion response has no
    // `auto_instructions_present` boolean and its category/option entries
    // carry no instruction fields — exact body equality, not key sampling.
    const { sessionId, showId } = await seededSession({
      categoriesJson: JSON.stringify([
        {
          id: 'mic',
          name: 'Mic',
          color: '#7cb7ff',
          type: 'DROPDOWN',
          auto_instruction: 'log every mic swap',
          dropdown_options: [
            { label: 'Lav', needs_context: false, auto_instruction: 'log every lav handoff' },
            { label: 'Boom', needs_context: true },
          ],
          on_label: '',
          off_label: '',
        },
      ]),
    });
    await setCompanionPresence('c1', sessionId);
    const res = await app.request(
      '/api/companion/categories',
      { method: 'GET', headers: (await seedCompanionDevice()).bearer },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      session_id: sessionId,
      show_id: showId,
      show_name: 'Test Show',
      show_code: 'TS',
      categories: [
        {
          id: 'mic',
          label: 'Mic',
          color: '#7cb7ff',
          type: 'DROPDOWN',
          dropdown_options: [
            { label: 'Lav', needs_context: false },
            { label: 'Boom', needs_context: true },
          ],
          on_label: '',
          off_label: '',
        },
      ],
    });
  });

  it('commands/wait with timeout=0 returns empty immediately', async () => {
    const res = await app.request(
      '/api/companion/commands/wait?timeout=0',
      { method: 'GET', headers: (await seedCompanionDevice()).bearer },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { commands: unknown[] }).toMatchObject({ commands: [] });
  });
});

// D9 category 3: the pick is per user (companion-devices D3), no longer global.
describe('primarySession is per user', () => {
  it('selects the visibly-fresher of its own user’s sessions; another user’s rows are ignored', async () => {
    const sA = (await seededSession()).sessionId;
    const sB = (await seededSession()).sessionId;
    const sC = (await seededSession()).sessionId;
    await setCompanionPresence('cA', sA, { visible: false });
    await setCompanionPresence('cB', sB, { visible: true });
    await setCompanionPresence('cC', sC, { visible: true, user_id: await seedUser() });
    expect((await state()).active_session_id).toBe(sB);
  });
});

describe('ordering on async storage (async-session-callers D4/D5)', () => {
  it('/command stores last_command before broadcasting it', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const hub = await harnessHub(s);
    const deviceId = (await seedCompanionDevice()).id;
    let storedAtBroadcast: Promise<string | null> | null = null;
    const spy = vi.spyOn(hub, 'broadcastCommand').mockImplementation(() => {
      // D9 category 3: the last command is stored under the device's own key (D3).
      storedAtBroadcast = env.ports.kv.get(`companion:last_command:${deviceId}`);
    });
    try {
      const res = await app.request(
        '/api/companion/command',
        { method: 'POST', headers: await J(), body: JSON.stringify({ type: 'record-start' }) },
        { ...env },
      );
      expect(res.status).toBe(200);
      const { command_id } = (await res.json()) as { command_id: string };
      expect(spy).toHaveBeenCalledOnce();
      const raw = await (storedAtBroadcast as Promise<string | null> | null);
      expect(JSON.parse(raw ?? 'null')).toMatchObject({ id: command_id, type: 'record-start' });
    } finally {
      spy.mockRestore();
    }
  });

  it('/state takes one presence snapshot', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const spy = vi.spyOn(env.ports.presence, 'list');
    try {
      await state();
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });
});

// catalog-concurrency-hazards D7: an ack marks its command only while it is still the latest.
describe('ack racing a newer command', () => {
  it('a late ack for command A after command B lands gives {ok:false}, and last_command stays B', async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s, { visible: true });
    const command = async () =>
      (await (
        await app.request(
          '/api/companion/command',
          { method: 'POST', headers: await J(), body: JSON.stringify({ type: 'record-toggle' }) },
          { ...env },
        )
      ).json()) as { command_id: string };
    const a = await command();
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(/^SELECT value, expires_at FROM kv WHERE key = \?$/);
    const ack = app.request(
      `/api/companion/commands/${a.command_id}/ack`,
      { method: 'POST', headers: await J(), body: JSON.stringify({ client_id: 'c1', ok: true }) },
      envWith({}, { kv: new KvStore(gated, env.ports.clock) }),
    );
    await h.reached;
    const b = await command();
    h.release();
    expect(await (await ack).json()).toEqual({ ok: false });
    expect(((await state()).last_command as { id: string }).id).toBe(b.command_id);
  });
});

// show-grants D10: a signed-in caller's Companion requests are checked against their session
// access; token-only calls are the Companion's device credential and are unchanged.
describe('Companion routes check a signed-in caller’s session access (show-grants D10)', () => {
  const JSON_H = { 'content-type': 'application/json' };
  const NO_ACTIVE = {
    detail: 'No active session — open AutoLogger in a browser and open a session.',
  };

  function asCookie(cookie: string, path: string, init: { method?: string; body?: unknown } = {}) {
    return anonApp.request(
      path,
      {
        method: init.method ?? 'GET',
        headers: { ...JSON_H, cookie },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
      { ...env },
    );
  }
  /** D9 category 3: the former token-only caller is a device of `userId`, scoped as that user:
   * one device per user (user ids are unique per test), since the last command is per device. */
  const devices = new Map<string, ReturnType<typeof seedCompanionDevice>>();
  const deviceOf = (userId: string) => {
    let d = devices.get(userId);
    if (!d) {
      d = seedCompanionDevice(userId);
      devices.set(userId, d);
    }
    return d;
  };
  async function asToken(
    userId: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ) {
    return anonApp.request(
      path,
      {
        method: init.method ?? 'GET',
        headers: { ...JSON_H, ...(await deviceOf(userId)).bearer },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      },
      { ...env },
    );
  }
  // D9 category 3: the recorded command is the device's own key (D3).
  const counts = async (sessionId: string, deviceUser: string) => {
    const hub = await (await harnessHub(sessionId)).ensure();
    return {
      events: hub.event_count,
      take: hub.current_take,
      cmd: await env.ports.kv.get(`companion:last_command:${(await deviceOf(deviceUser)).id}`),
    };
  };

  it('presence: an ungranted member and a nonexistent id get 404 Session not found and store nothing', async () => {
    const m = await seedAccessMatrix();
    const idle = await (await asToken(m.granted.id, '/api/companion/state')).json();
    for (const sid of [m.sessionId, 'no-such-session']) {
      const res = await asCookie(m.ungranted.cookie, '/api/companion/presence', {
        method: 'POST',
        body: { client_id: 'tab-u', session_id: sid },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ detail: 'Session not found' });
    }
    expect(await (await asToken(m.granted.id, '/api/companion/state')).json()).toEqual(idle);
  });

  it('presence: a granted member is 200 and the state reports the session', async () => {
    const m = await seedAccessMatrix();
    const res = await asCookie(m.granted.cookie, '/api/companion/presence', {
      method: 'POST',
      body: { client_id: 'tab-g', session_id: m.sessionId },
    });
    expect(res.status).toBe(200);
    const st = (await (await asToken(m.granted.id, '/api/companion/state')).json()) as Record<
      string,
      unknown
    >;
    expect(st.active_session_id).toBe(m.sessionId);
  });

  it('presence: closing, an empty session_id and a token-only post behave as before; NUL is still 400 first', async () => {
    const m = await seedAccessMatrix();
    const closing = await asCookie(m.ungranted.cookie, '/api/companion/presence', {
      method: 'POST',
      body: { client_id: 'tab-u', session_id: m.sessionId, closing: true },
    });
    expect(closing.status).toBe(200);
    const empty = await asCookie(m.ungranted.cookie, '/api/companion/presence', {
      method: 'POST',
      body: { client_id: 'tab-u', session_id: '' },
    });
    expect(empty.status).toBe(200);
    const nul = await asCookie(m.ungranted.cookie, '/api/companion/presence', {
      method: 'POST',
      body: { client_id: 'tab-u', session_id: `a\u0000b` },
    });
    expect(nul.status).toBe(400);
    // D9 category 7: the presence post that names the session moves from the bearer to a cookie
    // caller with access (a token-only post now stores nothing).
    const token = await asCookie(m.granted.cookie, '/api/companion/presence', {
      method: 'POST',
      body: { client_id: 'device', session_id: m.sessionId },
    });
    expect(token.status).toBe(200);
    const st = (await (await asToken(m.granted.id, '/api/companion/state')).json()) as Record<
      string,
      unknown
    >;
    expect(st.active_session_id).toBe(m.sessionId);
  });

  for (const scenario of ['a granted teammate', 'another team'] as const) {
    it(`with ${scenario}'s presence active, the ungranted member's cookie sees no active session`, async () => {
      const m = await seedAccessMatrix();
      const idle = await (await asCookie(m.ungranted.cookie, '/api/companion/state')).json();
      let held = m.sessionId;
      if (scenario === 'another team') held = (await seededSession()).sessionId;
      // D9 category 3: presence is per user, so the denied caller's own fresh, visible row names
      // the held session (the masked answer still proves the access check).
      await setCompanionPresence('tab-holder', held, { visible: true, user_id: m.ungranted.id });
      // D9 category 3: the former token-only caller is a device of a user who can access the held
      // session (the granted teammate, or the default user who admins the other team), reading
      // its user's own presence row.
      const deviceUser =
        scenario === 'a granted teammate' ? m.granted.id : (await defaultUser()).id;
      await setCompanionPresence('tab-device', held, { visible: true, user_id: deviceUser });
      const cmd = await asToken(deviceUser, '/api/companion/command', {
        method: 'POST',
        body: { type: 'record-start' },
      });
      expect(cmd.status).toBe(200);
      const before = await counts(held, deviceUser);

      const st = (await (
        await asCookie(m.ungranted.cookie, '/api/companion/state')
      ).json()) as Record<string, unknown>;
      expect({ ...st, connected_clients: 0 }).toEqual({
        ...(idle as object),
        connected_clients: 0,
      });
      expect(st).toMatchObject({ active_session_id: null, session: null, last_command: null });

      for (const [path, body] of [
        ['/api/companion/categories', undefined],
        ['/api/companion/log', { category_id: SEED_CATEGORY_ID, message: 'x' }],
        ['/api/companion/transport', { action: 'start' }],
        ['/api/companion/command', { type: 'play-toggle' }],
      ] as const) {
        const res = await asCookie(m.ungranted.cookie, path, {
          method: body === undefined ? 'GET' : 'POST',
          body,
        });
        expect(`${path} ${res.status}`).toBe(`${path} 409`);
        expect(await res.json()).toEqual(NO_ACTIVE);
      }
      expect(await counts(held, deviceUser)).toEqual(before);

      // The token and (for the teammate's session) the granted member still get the session.
      const tok = (await (await asToken(deviceUser, '/api/companion/state')).json()) as Record<
        string,
        unknown
      >;
      expect(tok.active_session_id).toBe(held);
      expect(tok.last_command).not.toBeNull();
      if (scenario === 'a granted teammate') {
        // D9 category 3: the allowed case reads a row owned by the allowed user.
        await setCompanionPresence('tab-granted', held, { visible: true, user_id: m.granted.id });
        const g = (await (
          await asCookie(m.granted.cookie, '/api/companion/state')
        ).json()) as Record<string, unknown>;
        expect(g.active_session_id).toBe(held);
        // D9 category 3 (amended): a cookie caller has no device key, so no last command (D3).
        expect(g.last_command).toBeNull();
        const cats = await asCookie(m.granted.cookie, '/api/companion/categories');
        expect(cats.status).toBe(200);
      }
    });
  }
});

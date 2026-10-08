// catalog-policies (ADR 0021 slice 6b-2): routes keep their statuses under the catalog_user
// policies (core-ports-architecture "Policy outcomes keep each route's status"; api-contract-freeze
// "Writes whose access is revoked in flight change nothing").

import { createCatalog } from '@autologger/catalog';
import { CatalogForbiddenError } from '@autologger/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bindings } from '../appEnv';
import { GatedCatalog } from '../test/gatedCatalog';
import { anonApp, env, envWith } from '../test/harness';
import {
  COMPANION_BEARER,
  loginCookie,
  SEED_CATEGORY_ID,
  seedAccessMatrix,
  seedShow,
  seedStudio,
  seedUser,
  setCompanionPresence,
  testDb,
} from '../test/helpers';
import { RewritingCatalog } from '../test/rewritingCatalog';
import { type GateMatch, nthUserCall, sessionGate, systemCall } from '../test/session/sessionGate';
import { harnessHub } from '../test/session/sessionRows';
import type { TestRegistry } from '../test/session/testHub';

const J = { 'content-type': 'application/json' };

async function send(
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
  e = env,
): Promise<Response> {
  return anonApp.request(
    path,
    {
      method,
      headers: { ...J, Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    e,
  );
}

describe('existence probes keep their statuses (design D6)', () => {
  it('POST /api/shows: 404 for an existing team of which the caller is not a member, 400 for a missing team', async () => {
    const mine = await seedStudio();
    const foreign = await seedStudio();
    const cookie = await loginCookie(await seedUser({ studios: [mine], role: 'owner' }));
    const res = await send('POST', '/api/shows', cookie, { studio_id: foreign, name: 'X' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Unknown studio id.' });
    const missing = await send('POST', '/api/shows', cookie, {
      studio_id: 'no-such-team',
      name: 'X',
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ detail: 'Unknown studio id.' });
  });

  it("POST /api/sessions: another team's show is 400 Show does not belong to the active team.", async () => {
    const mine = await seedStudio();
    const foreign = await seedStudio();
    const foreignShow = await seedShow({ studioId: foreign });
    const cookie = await loginCookie(await seedUser({ studios: [mine], role: 'owner' }));
    const res = await send('POST', '/api/sessions', cookie, { show_id: foreignShow });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: 'Show does not belong to the active team.' });
  });

  it("a user-bound catalog's existence checks see other teams' rows", async () => {
    const mine = await seedStudio();
    const foreign = await seedStudio();
    const foreignShow = await seedShow({ studioId: foreign });
    const userId = await seedUser({ studios: [mine], role: 'owner' });
    const cat = createCatalog(env.ports.catalog).forUser(userId);
    expect(await cat.studios.studioExistsAnywhere(foreign)).toBe(true);
    expect(await cat.studios.studioExistsAnywhere('no-such-team')).toBe(false);
    expect(await cat.shows.showExistsAnywhere(foreignShow)).toBe(true);
    expect(await cat.shows.showExistsAnywhere('no-such-show')).toBe(false);
  });
});

const SETTINGS = {
  categories: [{ id: 'c-new', name: 'New cat', color: '#112233', type: 'BUTTON' }],
  show_title_format: '',
  default_frame_rate: 25,
};
/** The early, unlocked role check of `PUT /api/profile` (not the in-transaction `FOR SHARE`). */
const EARLY_ROLE = /^SELECT role FROM user_studio_memberships WHERE user_id = \? AND studio_id = \?$/;

/** A team with an owner, an admin (the caller) and one show. */
async function teamWithAdmin() {
  const team = await seedStudio();
  const ownerId = await seedUser({ studios: [team], role: 'owner' });
  const adminId = await seedUser({ studios: [team], role: 'admin' });
  const show = await seedShow({ studioId: team, name: 'Original' });
  return {
    team,
    ownerId,
    adminId,
    show,
    ownerCookie: await loginCookie(ownerId),
    adminCookie: await loginCookie(adminId),
  };
}

const settingsValue = async (team: string) =>
  (
    await testDb().first<{ value: string }>(
      'SELECT value FROM app_settings WHERE key = ?',
      `studio_config:${team}`,
    )
  )?.value ?? null;
const showName = async (id: string) =>
  (await testDb().first<{ name: string }>('SELECT name FROM shows WHERE id = ?', id))?.name;
const prefsOf = async (id: string) =>
  testDb().first('SELECT active_studio_id, active_show_id FROM user_prefs WHERE user_id = ?', id);
const namesOf = async (id: string) =>
  testDb().first('SELECT given_name, family_name FROM users WHERE id = ?', id);

describe('PUT /api/profile re-checks the role in its write transaction (design D8)', () => {
  it('an admin demoted after the early check gets 403 and nothing is written', async () => {
    const { team, adminId, show, ownerCookie, adminCookie } = await teamWithAdmin();
    const before = {
      settings: await settingsValue(team),
      show: await showName(show),
      prefs: await prefsOf(adminId),
      names: await namesOf(adminId),
    };
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(EARLY_ROLE);
    const put = send(
      'PUT',
      '/api/profile',
      adminCookie,
      {
        active_studio_id: team,
        settings: SETTINGS,
        show_updates: [{ show_id: show, name: 'Renamed' }],
        active_show_id: show,
        given_name: 'Changed',
      },
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    const demote = await send('POST', `/api/teams/${team}/members/${adminId}/role`, ownerCookie, {
      role: 'member',
    });
    expect(demote.status).toBe(200);
    h.release();
    const res = await put;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: 'Admin role required.' });
    expect({
      settings: await settingsValue(team),
      show: await showName(show),
      prefs: await prefsOf(adminId),
      names: await namesOf(adminId),
    }).toEqual(before);
  });

  it('a serial request saves the settings and the first show before a 400 for a foreign show', async () => {
    const { team, show, adminCookie } = await teamWithAdmin();
    const other = await seedShow({ studioId: await seedStudio(), name: 'Other' });
    const res = await send('PUT', '/api/profile', adminCookie, {
      active_studio_id: team,
      settings: SETTINGS,
      show_updates: [
        { show_id: show, name: 'Renamed' },
        { show_id: other, name: 'Nope' },
      ],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: `Show '${other}' is not part of the selected team.` });
    expect(JSON.parse(String(await settingsValue(team))).default_frame_rate).toBe(25);
    expect(await showName(show)).toBe('Renamed');
    expect(await showName(other)).toBe('Other');
  });

  it('a serial request with invalid categories in the second entry keeps the first entry (400)', async () => {
    const { team, adminCookie } = await teamWithAdmin();
    const second = await seedShow({ studioId: team, name: 'Second' });
    const first = await seedShow({ studioId: team, name: 'First' });
    const res = await send('PUT', '/api/profile', adminCookie, {
      active_studio_id: team,
      show_updates: [
        { show_id: first, name: 'First renamed' },
        { show_id: second, name: 'Second renamed', categories: [] },
      ],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: 'Add at least one log category.' });
    expect(await showName(first)).toBe('First renamed');
    expect(await showName(second)).toBe('Second');
  });
});

describe('policy outcomes map to existing statuses (design D8, before the policies)', () => {
  it('a session update whose UPDATE changes no row is 404 Session not found', async () => {
    const { sessionId, granted } = await seedAccessMatrix();
    const rw = new RewritingCatalog(env.ports.catalog);
    const UPDATE = /^UPDATE sessions SET title/;
    rw.rewrite(UPDATE, { changes: 0 });
    const res = await send(
      'PUT',
      `/api/sessions/${sessionId}`,
      granted.cookie,
      { title: 'Renamed' },
      envWith({}, { catalog: rw }),
    );
    expect(rw.applied(UPDATE)).toBe(true);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Session not found' });
  });

  it('a transfer whose target user row cannot be read is 404 Member not found', async () => {
    const { studioId, owner, admin } = await seedAccessMatrix();
    const rw = new RewritingCatalog(env.ports.catalog);
    const TARGET = /^SELECT \* FROM users WHERE id = \?$/;
    rw.rewrite(TARGET, { noRow: true });
    const res = await send(
      'POST',
      `/api/teams/${studioId}/owner`,
      owner.cookie,
      { user_id: admin.id },
      envWith({}, { catalog: rw }),
    );
    expect(rw.applied(TARGET)).toBe(true);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Member not found' });
    const roles = await testDb().all<{ user_id: string; role: string }>(
      'SELECT user_id, role FROM user_studio_memberships WHERE studio_id = ? AND user_id IN (?, ?) ORDER BY role',
      studioId,
      owner.id,
      admin.id,
    );
    expect(roles).toEqual(
      expect.arrayContaining([
        { user_id: owner.id, role: 'owner' },
        { user_id: admin.id, role: 'admin' },
      ]),
    );
  });

  it('a CatalogForbiddenError after requireTeamRoleIn is the generic 500 with a redacted log line', async () => {
    const { studioId, owner } = await seedAccessMatrix();
    const rw = new RewritingCatalog(env.ports.catalog);
    const RENAME = /^UPDATE studio_definitions SET display_name/;
    rw.rewrite(RENAME, {
      throws: () =>
        new CatalogForbiddenError('user', {
          table_name: 'studio_definitions',
          message: 'permission denied for table studio_definitions',
        }),
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await send(
        'PATCH',
        `/api/teams/${studioId}`,
        owner.cookie,
        { display_name: 'Renamed' },
        envWith({}, { catalog: rw }),
      );
      expect(rw.applied(RENAME)).toBe(true);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ detail: 'Internal Server Error' });
      expect(spy).toHaveBeenCalledWith('unhandled error', {
        name: 'CatalogForbiddenError',
        code: '42501',
        table_name: 'studio_definitions',
        binding: 'user',
      });
      expect(JSON.stringify(spy.mock.calls)).not.toContain(owner.id);
    } finally {
      spy.mockRestore();
    }
  });
});

// -- under the policies (task 4.2; red before migration step 2 for the race cases) ----------------

/** requireSession's access read, after which a race commits (design D8). */
const ACCESS_READ = /^SELECT 1 FROM shows s\s+JOIN user_studio_memberships m ON m\.studio_id = s\.studio_id AND m\.user_id = \?\s+WHERE s\.id = \?/;

describe('routes under the catalog_user policies (design D3, D5, D7, D8)', () => {
  it("a plain member's profile loads defaults for a team with no settings row, and writes none", async () => {
    const { studioId, ungranted } = await seedAccessMatrix();
    await testDb().run('DELETE FROM app_settings WHERE key = ?', `studio_config:${studioId}`);
    const res = await send('GET', '/api/profile', ungranted.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { studio_settings: Record<string, { categories: unknown[] }> };
    expect(body.studio_settings[studioId]?.categories.length).toBeGreaterThan(0);
    expect(await settingsValue(studioId)).toBeNull();
  });

  it("a plain member's name edit is stored", async () => {
    const { studioId, ungranted } = await seedAccessMatrix();
    const res = await send('PUT', '/api/profile', ungranted.cookie, {
      active_studio_id: studioId,
      given_name: 'Plain',
      family_name: 'Member',
    });
    expect(res.status).toBe(200);
    expect(await namesOf(ungranted.id)).toEqual({ given_name: 'Plain', family_name: 'Member' });
  });

  it("the owner's team delete leaves no invite, definition, settings or membership row", async () => {
    const team = await seedStudio();
    const ownerId = await seedUser({ studios: [team], role: 'owner' });
    await seedUser({ studios: [team], role: 'member' });
    await testDb().run(
      "INSERT INTO team_invites (studio_id, email_norm, invited_by_user_id, invited_at_utc) VALUES (?, 'x@example.com', ?, '2026-10-03')",
      team,
      ownerId,
    );
    const res = await send('DELETE', `/api/teams/${team}`, await loginCookie(ownerId));
    expect(res.status).toBe(200);
    const left = await testDb().first<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM team_invites WHERE studio_id = ?)
            + (SELECT COUNT(*) FROM studio_definitions WHERE id = ?)
            + (SELECT COUNT(*) FROM app_settings WHERE key = ?)
            + (SELECT COUNT(*) FROM user_studio_memberships WHERE studio_id = ?) AS n`,
      team,
      team,
      `studio_config:${team}`,
      team,
    );
    expect(Number(left?.n)).toBe(0);
  });

  it("a granted member's leave removes their grants in that team only", async () => {
    const a = await seedAccessMatrix();
    const b = await seedAccessMatrix();
    await createCatalog(env.ports.catalog)
      .system('test-seed')
      .auth.authAddMembershipWithRole(a.granted.id, b.studioId, 'member');
    await createCatalog(env.ports.catalog)
      .system('test-seed')
      .auth.authGrantShow(a.granted.id, b.showId, b.owner.id, '2026-10-03T00:00:00Z');
    const res = await send('POST', `/api/teams/${a.studioId}/leave`, a.granted.cookie, {});
    expect(res.status).toBe(200);
    const grants = await testDb().all<{ show_id: string }>(
      'SELECT show_id FROM show_grants WHERE user_id = ? ORDER BY show_id',
      a.granted.id,
    );
    expect(grants).toEqual([{ show_id: b.showId }]);
  });

  it('a transfer to a non-member or to an unknown user id is 404 Member not found', async () => {
    const { studioId, owner, nonMember } = await seedAccessMatrix();
    for (const target of [nonMember.id, 'no-such-user']) {
      const res = await send('POST', `/api/teams/${studioId}/owner`, owner.cookie, {
        user_id: target,
      });
      expect(res.status, target).toBe(404);
      expect(await res.json()).toEqual({ detail: 'Member not found' });
    }
  });

  it('a grant revoked between requireSession and the session update gives 404 and changes nothing', async () => {
    const { studioId, showId, sessionId, owner, granted } = await seedAccessMatrix();
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(ACCESS_READ);
    const put = send(
      'PUT',
      `/api/sessions/${sessionId}`,
      granted.cookie,
      { title: 'Renamed in a race' },
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    const revoke = await send(
      'DELETE',
      `/api/teams/${studioId}/shows/${showId}/grants/${granted.id}`,
      owner.cookie,
    );
    expect(revoke.status).toBe(200);
    h.release();
    const res = await put;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Session not found' });
    expect(
      await testDb().first('SELECT title FROM sessions WHERE id = ?', sessionId),
    ).toEqual({ title: 'Test Session' });
  });

  it('a member removed between requireSession and an archive gives 404 and the session stays', async () => {
    const { studioId, sessionId, owner, granted } = await seedAccessMatrix();
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(ACCESS_READ);
    const archive = send(
      'POST',
      `/api/sessions/${sessionId}/archive`,
      granted.cookie,
      {},
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    const remove = await send('DELETE', `/api/teams/${studioId}/members/${granted.id}`, owner.cookie);
    expect(remove.status).toBe(200);
    h.release();
    const res = await archive;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Session not found' });
    expect(
      Number((await testDb().first<{ archived: number }>('SELECT archived FROM sessions WHERE id = ?', sessionId))?.archived),
    ).toBe(0);
  });

  it("POST /api/shows for a foreign team takes the catalog.studio_exists path", async () => {
    const mine = await seedStudio();
    const foreign = await seedStudio();
    const userId = await seedUser({ studios: [mine], role: 'owner' });
    const gated = new GatedCatalog(env.ports.catalog);
    const res = await send(
      'POST',
      '/api/shows',
      await loginCookie(userId),
      { studio_id: foreign, name: 'X' },
      envWith({}, { catalog: gated }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Unknown studio id.' });
    expect(gated.bindings).toContainEqual({
      binding: `user:${userId}`,
      sql: 'SELECT catalog.studio_exists(?) AS e',
    });
  });
});

// -- session hub calls refused in a race (session-content-policies D8, task 5.1) ------------------
// A session-storage gate holds the route's hub call after `requireSession`; the owner revokes the
// granted member's grant in the gap. The refusal answers the status the route already gives for
// missing access, writes nothing (or the route's undo, run as `session-undo`, removes what it
// wrote) and sends no frame.

describe('session hub calls refused in a race keep each route’s status (session-content-policies D8)', () => {
  const NOT_FOUND = { detail: 'Session not found' };
  const NO_ACTIVE = {
    detail: 'No active session — open AutoLogger in a browser and open a session.',
  };
  const CTX = { frameRate: 24, startOffsetFrames: 0 };
  const registries: TestRegistry[] = [];
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.closeAll();
  });

  type Matrix = Awaited<ReturnType<typeof seedAccessMatrix>>;

  /** Runs `request` against a gated registry, holding the call `match` accepts until the owner
   * has revoked the granted member's grant. */
  async function raced(
    m: Matrix,
    match: GateMatch,
    request: (e: Bindings) => Response | Promise<Response>,
    opts: { config?: Record<string, unknown>; ports?: Partial<Bindings['ports']> } = {},
  ) {
    const gate = sessionGate();
    registries.push(gate.registry);
    const hub = await gate.registry.get(m.sessionId);
    const frames: { type: string }[] = [];
    hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
    const held = gate.holdNext(match);
    const pending = Promise.resolve(
      request(envWith(opts.config ?? {}, { sessions: gate.registry, ...(opts.ports ?? {}) })),
    );
    await held.reached;
    const revoke = await send(
      'DELETE',
      `/api/teams/${m.studioId}/shows/${m.showId}/grants/${m.granted.id}`,
      m.owner.cookie,
    );
    expect(revoke.status).toBe(200);
    held.release();
    return { res: await pending, frames, hub };
  }

  it('a content write (event add, transport start, word edit, dashboard save) answers 404, writes nothing, sends no frame', async () => {
    const VALID_DASHBOARD = {
      widgets: [{ id: 'w1', type: 'session_duration', title: 'Duration', x: 0, y: 0, w: 4, h: 2 }],
      interactions: [],
    };
    const cases: Array<[string, (m: Matrix, wordId: string, e: Bindings) => Promise<Response>, Record<string, unknown>]> = [
      [
        'POST events',
        (m, _w, e) =>
          send('POST', `/api/sessions/${m.sessionId}/events`, m.granted.cookie, { category: SEED_CATEGORY_ID, message: 'raced' }, e),
        {},
      ],
      [
        'transport start',
        (m, _w, e) => send('POST', `/api/sessions/${m.sessionId}/transport/start`, m.granted.cookie, {}, e),
        {},
      ],
      [
        'word edit',
        (m, w, e) =>
          send('PATCH', `/api/sessions/${m.sessionId}/transcript-words/${w}`, m.granted.cookie, { word: 'edited' }, e),
        {},
      ],
      [
        'dashboard save',
        (m, _w, e) => send('PUT', `/api/sessions/${m.sessionId}/ai/v2/dashboard`, m.granted.cookie, VALID_DASHBOARD, e),
        { AI_V2_ENABLED: '1', HOST: '127.0.0.1', AI_V2_API_KEY: '' },
      ],
    ];
    for (const [name, request, config] of cases) {
      const m = await seedAccessMatrix();
      const seedHub = await harnessHub(m.sessionId);
      const word = await seedHub.insertTranscriptWord({ session_time: '00:00:01', speaker: '0', word: 'original' });
      const before = await testDb().first('SELECT * FROM sessions WHERE id = ?', m.sessionId);
      const { res, frames, hub } = await raced(m, nthUserCall(1), (e) => request(m, String(word.id), e), { config });
      expect(`${name} ${res.status}`).toBe(`${name} 404`);
      expect(await res.json(), name).toEqual(NOT_FOUND);
      expect(frames, name).toEqual([]);
      expect(await hub.exportEvents(), name).toEqual([]);
      expect((await hub.transportSnapshot(CTX)).is_rolling, name).toBe(false);
      expect((await hub.listTranscriptWords()).map((w) => w.word), name).toEqual(['original']);
      expect(await hub.listDashboards(), name).toEqual([]);
      expect(await testDb().first('SELECT * FROM sessions WHERE id = ?', m.sessionId), name).toEqual(before);
    }
  });

  it('GET events racing a revoke answers 404, not an empty list', async () => {
    const m = await seedAccessMatrix();
    const { res } = await raced(m, nthUserCall(1, 'snapshot'), (e) =>
      send('GET', `/api/sessions/${m.sessionId}/events`, m.granted.cookie, undefined, e),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
  });

  it('a local audio import refused at its anchor answers 404, and its segment and blob are undone', async () => {
    const m = await seedAccessMatrix();
    const { res, frames, hub } = await raced(m, nthUserCall(2, 'tx'), (e) =>
      anonApp.request(
        `/api/sessions/${m.sessionId}/local-audio-import?duration_s=10`,
        {
          method: 'POST',
          headers: { 'content-type': 'audio/wav', Cookie: m.granted.cookie },
          body: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
        },
        e,
      ),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(NOT_FOUND);
    expect(await hub.listAudioSegments()).toEqual([]);
    expect(await hub.exportEvents()).toEqual([]);
    expect((await env.ports.audio.list({ prefix: `audio/${m.sessionId}/` })).objects).toEqual([]);
    expect(frames.filter((f) => f.type === 'event.changed')).toEqual([]);
  });

  it('an audio upload whose blob write fails is undone as session-undo after a revoke: no segment row stays', async () => {
    const m = await seedAccessMatrix();
    const failingAudio = new Proxy(env.ports.audio, {
      get(target, prop) {
        if (prop === 'put') return async () => Promise.reject(new Error('injected: disk full'));
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const { res, hub } = await raced(
      m,
      systemCall('session-undo'),
      (e) =>
        anonApp.request(
          `/api/sessions/${m.sessionId}/audio/segments`,
          {
            method: 'POST',
            headers: { 'content-type': 'audio/webm', Cookie: m.granted.cookie },
            body: new Uint8Array([1, 2, 3, 4]),
          },
          e,
        ),
      { ports: { audio: failingAudio } },
    );
    expect(res.status).toBe(500);
    expect(await hub.listAudioSegments()).toEqual([]);
  });

  it('Companion with a cookie: log answers 409 and stores nothing; state answers 200 with the active session masked', async () => {
    const m = await seedAccessMatrix();
    await setCompanionPresence('tab-race', m.sessionId, { visible: true, user_id: m.granted.id });
    const cmd = await send('POST', '/api/companion/command', m.granted.cookie, { type: 'record-start' });
    expect(cmd.status).toBe(200);
    const companion = (cookie: string, path: string, body: unknown, e: Bindings) =>
      // (anonApp.request may answer synchronously; `raced` takes either.)
      anonApp.request(
        path,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers: { ...J, cookie },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        e,
      );

    const log = await raced(m, nthUserCall(1), (e) =>
      companion(m.granted.cookie, '/api/companion/log', { category_id: SEED_CATEGORY_ID, message: 'raced' }, e),
    );
    expect(log.res.status).toBe(409);
    expect(await log.res.json()).toEqual(NO_ACTIVE);
    expect(await log.hub.exportEvents()).toEqual([]);
    expect(log.frames).toEqual([]);

    // A fresh grant for the state case (the first race revoked it).
    await createCatalog(env.ports.catalog)
      .system('test-seed')
      .auth.authGrantShow(m.granted.id, m.showId, m.owner.id, new Date().toISOString());
    const tokenState = (await (
      await anonApp.request('/api/companion/state', { headers: COMPANION_BEARER }, { ...env })
    ).json()) as { connected_clients: number };
    const state = await raced(m, nthUserCall(1, 'snapshot'), (e) =>
      companion(m.granted.cookie, '/api/companion/state', undefined, e),
    );
    expect(state.res.status).toBe(200);
    expect(await state.res.json()).toMatchObject({
      active_session_id: null,
      session: null,
      last_command: null,
      connected_clients: tokenState.connected_clients,
    });
  });
});

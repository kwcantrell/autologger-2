// catalog-policies (ADR 0021 slice 6b-2): routes keep their statuses under the catalog_user
// policies (core-ports-architecture "Policy outcomes keep each route's status"; api-contract-freeze
// "Writes whose access is revoked in flight change nothing").

import { createCatalog } from '@autologger/catalog';
import { CatalogForbiddenError } from '@autologger/storage';
import { describe, expect, it, vi } from 'vitest';
import { GatedCatalog } from '../test/gatedCatalog';
import { anonApp, env, envWith } from '../test/harness';
import {
  loginCookie,
  seedAccessMatrix,
  seedShow,
  seedStudio,
  seedUser,
  testDb,
} from '../test/helpers';
import { RewritingCatalog } from '../test/rewritingCatalog';

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

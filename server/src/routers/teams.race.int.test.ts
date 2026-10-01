// team-management "Concurrent team writes" (catalog-concurrency-hazards D2, D3): each test holds
// one request at a chosen catalog statement, commits a competing request, then lets the first go,
// and checks the outcome is the one a serial order gives.

import { describe, expect, it } from 'vitest';
import { GatedCatalog } from '../test/gatedCatalog';
import { app, env, envWith } from '../test/harness';
import { catalogFor, loginCookie, seedStudio, seedUser } from '../test/helpers';

const J = { 'content-type': 'application/json' };
/** The early (root) role check every admin route makes before its write. */
const EARLY_ROLE_READ = /^SELECT role FROM user_studio_memberships WHERE user_id = \? AND studio_id = \?$/;

async function teamWithAdmins(n: number): Promise<{ team: string; ids: string[]; cookies: string[] }> {
  const team = await seedStudio();
  const ids: string[] = [];
  const cookies: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await seedUser();
    await catalogFor().auth.authAddMembershipWithRole(id, team, 'admin');
    ids.push(id);
    cookies.push(await loginCookie(id));
  }
  return { team, ids, cookies };
}

function send(
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
  bindings = env,
): Promise<Response> {
  return Promise.resolve(app.request(
    path,
    {
      method,
      headers: body === undefined ? { cookie } : { ...J, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    bindings,
  ));
}

const role = (userId: string, team: string) =>
  catalogFor().auth.authGetMembershipRole(userId, team);

describe('admin re-check inside the write (#8)', () => {
  it('a demoted admin’s in-flight delete gets 403 and the team survives', async () => {
    const { team, ids, cookies } = await teamWithAdmins(3);
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(EARLY_ROLE_READ);
    const del = send('DELETE', `/api/teams/${team}`, cookies[1] as string, undefined, envWith({}, { catalog: gated }));
    await h.reached;
    const demote = await send('POST', `/api/teams/${team}/members/${ids[1]}/role`, cookies[0] as string, {
      role: 'member',
    });
    expect(demote.status).toBe(200);
    h.release();
    expect((await del).status).toBe(403);
    expect(await role(ids[0] as string, team)).toBe('admin');
  });

  it('a demoted admin’s in-flight rename gets 403 and the name is unchanged', async () => {
    const { team, ids, cookies } = await teamWithAdmins(3);
    const before = await env.ports.catalog.first<{ display_name: string }>(
      'SELECT display_name FROM studio_definitions WHERE id = ?',
      team,
    );
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(EARLY_ROLE_READ);
    const rename = send('PATCH', `/api/teams/${team}`, cookies[1] as string, { display_name: 'Renamed' }, envWith({}, { catalog: gated }));
    await h.reached;
    await send('POST', `/api/teams/${team}/members/${ids[1]}/role`, cookies[0] as string, { role: 'member' });
    h.release();
    expect((await rename).status).toBe(403);
    const after = await env.ports.catalog.first<{ display_name: string }>(
      'SELECT display_name FROM studio_definitions WHERE id = ?',
      team,
    );
    expect(after).toEqual(before);
  });
});

const ADMIN_TOKEN = 'race-admin-token';
const ADMIN_ENV = envWith({ ADMIN_TOKEN });
const ADMIN_H = { Authorization: `Bearer ${ADMIN_TOKEN}`, ...J };
/** The creation cap's count of the caller's admin teams. */
const CAP_COUNT = /SELECT COUNT\(\*\) AS n FROM user_studio_memberships\s+WHERE user_id = \? AND role = 'admin'/;

async function members(team: string): Promise<string[]> {
  return (
    await env.ports.catalog.all<{ user_id: string }>(
      'SELECT user_id FROM user_studio_memberships WHERE studio_id = ? ORDER BY user_id',
      team,
    )
  ).map((r) => r.user_id);
}
async function invites(team: string): Promise<number> {
  const r = await env.ports.catalog.first<{ n: number }>(
    'SELECT COUNT(*) AS n FROM team_invites WHERE studio_id = ?',
    team,
  );
  return Number(r?.n ?? 0);
}
async function settingsRow(team: string): Promise<string | null> {
  const r = await env.ports.catalog.first<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?',
    `studio_config:${team}`,
  );
  return r?.value ?? null;
}
/** Rows a pre-4d race could have left under a deleted team's id. */
async function leaveOrphans(team: string, strangerId: string): Promise<void> {
  await env.ports.catalog.run(
    "INSERT INTO user_studio_memberships (user_id, studio_id, role) VALUES (?, ?, 'member')",
    strangerId,
    team,
  );
  await env.ports.catalog.run(
    "INSERT INTO team_invites (studio_id, email_norm, invited_by_user_id, invited_at_utc) VALUES (?, 'old@example.com', ?, '2026-01-01T00:00:00Z')",
    team,
    strangerId,
  );
  await env.ports.catalog.run(
    "INSERT INTO app_settings (key, value) VALUES (?, '{\"stale\":true}')",
    `studio_config:${team}`,
  );
}

describe('team creation (#9, #18)', () => {
  it('concurrent creates by a user at 19 teams: one 200, one 400', async () => {
    const userId = await seedUser();
    for (let i = 0; i < 19; i++) {
      await catalogFor().auth.authAddMembershipWithRole(userId, await seedStudio(), 'admin');
    }
    const cookie = await loginCookie(userId);
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(CAP_COUNT);
    const a = send('POST', '/api/teams', cookie, { id: 'cap-a', display_name: 'A' }, envWith({}, { catalog: gated }));
    await h.reached;
    const b = await send('POST', '/api/teams', cookie, { id: 'cap-b', display_name: 'B' });
    h.release();
    expect([b.status, (await a).status].sort()).toEqual([200, 400]);
    const owned = await catalogFor().auth.authCountAdminTeams(userId, ['test-studios', 'test-studio-2']);
    expect(owned).toBe(20);
  });

  it('an invite racing the team delete gets 404, and a recreated id starts empty', async () => {
    const { team, cookies } = await teamWithAdmins(2);
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(EARLY_ROLE_READ);
    const invite = send('POST', `/api/teams/${team}/invites`, cookies[1] as string, { email: 'late@example.com' }, envWith({}, { catalog: gated }));
    await h.reached;
    expect((await send('DELETE', `/api/teams/${team}`, cookies[0] as string)).status).toBe(200);
    h.release();
    expect((await invite).status).toBe(404);
    expect(await invites(team)).toBe(0);
  });

  it('a recreated id has only its creator, no invites and default settings', async () => {
    const team = 'reused-team';
    const stranger = await seedUser();
    await leaveOrphans(team, stranger);
    const creator = await seedUser();
    const res = await send('POST', '/api/teams', await loginCookie(creator), { id: team, display_name: 'Reused' });
    expect(res.status).toBe(200);
    expect(await members(team)).toEqual([creator]);
    expect(await invites(team)).toBe(0);
    expect(await settingsRow(team)).toBeNull(); // the stale blob is gone; defaults come on first read
  });

  it('an id that still has shows is refused', async () => {
    await env.ports.catalog.run(
      "INSERT INTO shows (id, studio_id, name, show_code, created_at_utc) VALUES ('ghost-show', 'ghost-team', 'G', 'G', '2026-01-01T00:00:00Z')",
    );
    const res = await send('POST', '/api/teams', await loginCookie(await seedUser()), { id: 'ghost-team', display_name: 'G' });
    expect(res.status).toBe(400);
    expect(await members('ghost-team')).toEqual([]);
  });

  it('a built-in id is refused and its memberships are untouched', async () => {
    const member = await seedUser({ studios: ['test-studios'] });
    const before = await members('test-studios');
    const res = await send('POST', '/api/teams', await loginCookie(member), { id: 'test-studios', display_name: 'X' });
    expect(res.status).toBe(400);
    expect(await members('test-studios')).toEqual(before);
  });

  it('the admin plane refuses leftover shows and purges leftovers the same way', async () => {
    const stranger = await seedUser();
    await leaveOrphans('admin-reused', stranger);
    const create = await app.request(
      '/api/admin/studios',
      { method: 'POST', headers: ADMIN_H, body: JSON.stringify({ id: 'admin-reused', display_name: 'R' }) },
      ADMIN_ENV,
    );
    expect(create.status).toBe(200);
    expect(await members('admin-reused')).toEqual([]);
    expect(await invites('admin-reused')).toBe(0);
    expect(await settingsRow('admin-reused')).toBeNull();

    await env.ports.catalog.run(
      "INSERT INTO shows (id, studio_id, name, show_code, created_at_utc) VALUES ('ghost-show-2', 'admin-ghost', 'G', 'G', '2026-01-01T00:00:00Z')",
    );
    const ghost = await app.request(
      '/api/admin/studios',
      { method: 'POST', headers: ADMIN_H, body: JSON.stringify({ id: 'admin-ghost', display_name: 'G' }) },
      ADMIN_ENV,
    );
    expect(ghost.status).toBe(400);
  });
});

describe('invite cap (#10)', () => {
  it('two invites for new emails at 199 pending: one recorded, one 400', async () => {
    const { team, ids, cookies } = await teamWithAdmins(2);
    for (let i = 0; i < 199; i++) {
      await catalogFor().auth.authUpsertInvite(team, `p${i}@example.com`, ids[0] as string);
    }
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(/FROM team_invites WHERE studio_id = \?/);
    const a = send('POST', `/api/teams/${team}/invites`, cookies[0] as string, { email: 'new-a@example.com' }, envWith({}, { catalog: gated }));
    await h.reached;
    const b = await send('POST', `/api/teams/${team}/invites`, cookies[1] as string, { email: 'new-b@example.com' });
    h.release();
    expect([b.status, (await a).status].sort()).toEqual([200, 400]);
    expect(await invites(team)).toBe(200);
  });
});

describe('role change and removal (#11, #12)', () => {
  /** Holds the second matching role read: the target's, after the caller's own early check. */
  function holdTargetRoleRead(gated: GatedCatalog) {
    const own = gated.holdAfter(EARLY_ROLE_READ);
    own.release();
    return gated.holdAfter(EARLY_ROLE_READ);
  }

  it('a promotion racing the target’s removal gets 404 and doesn’t re-create the member', async () => {
    const { team, cookies } = await teamWithAdmins(2);
    const m = await seedUser();
    await catalogFor().auth.authAddMembershipWithRole(m, team, 'member');
    const gated = new GatedCatalog(env.ports.catalog);
    const h = holdTargetRoleRead(gated);
    const promote = send('POST', `/api/teams/${team}/members/${m}/role`, cookies[0] as string, { role: 'admin' }, envWith({}, { catalog: gated }));
    await h.reached;
    expect((await send('DELETE', `/api/teams/${team}/members/${m}`, cookies[1] as string)).status).toBe(200);
    h.release();
    expect((await promote).status).toBe(404);
    expect(await role(m, team)).toBeNull();
  });

  it('a double removal: one 200, one 404', async () => {
    const { team, cookies } = await teamWithAdmins(2);
    const m = await seedUser();
    await catalogFor().auth.authAddMembershipWithRole(m, team, 'member');
    const gated = new GatedCatalog(env.ports.catalog);
    const h = holdTargetRoleRead(gated);
    const first = send('DELETE', `/api/teams/${team}/members/${m}`, cookies[0] as string, undefined, envWith({}, { catalog: gated }));
    await h.reached;
    const second = await send('DELETE', `/api/teams/${team}/members/${m}`, cookies[1] as string);
    h.release();
    expect([second.status, (await first).status].sort()).toEqual([200, 404]);
  });
});

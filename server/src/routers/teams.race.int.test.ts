// team-management "Concurrent team and ownership writes" (catalog-concurrency-hazards D2, D3;
// owner-bootstrap D2, D3): each test holds one request at a chosen catalog statement, commits a
// competing request, then lets the first go, and checks the outcome is the one a serial order
// gives.

import { describe, expect, it } from 'vitest';
import { GatedCatalog } from '../test/gatedCatalog';
import { app, env, envWith } from '../test/harness';
import { catalogFor, loginCookie, seedStudio, seedUser } from '../test/helpers';

const J = { 'content-type': 'application/json' };
/** The early (root) role check every admin route makes before its write. */
const EARLY_ROLE_READ =
  /^SELECT role FROM user_studio_memberships WHERE user_id = \? AND studio_id = \?$/;

/** A team of `n` users: `ids[0]` is the owner, the rest are admins. */
async function teamWithAdmins(
  n: number,
): Promise<{ team: string; ids: string[]; cookies: string[] }> {
  const team = await seedStudio();
  const ids: string[] = [];
  const cookies: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = await seedUser();
    await catalogFor().auth.authAddMembershipWithRole(id, team, i === 0 ? 'owner' : 'admin');
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
  return Promise.resolve(
    app.request(
      path,
      {
        method,
        headers: body === undefined ? { cookie } : { ...J, cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      bindings,
    ),
  );
}

const role = (userId: string, team: string) =>
  catalogFor().auth.authGetMembershipRole(userId, team);

/** The ids of the team's owners; the one-owner index means at most one. */
async function owners(team: string): Promise<string[]> {
  return (
    await env.ports.catalog.all<{ user_id: string }>(
      "SELECT user_id FROM user_studio_memberships WHERE studio_id = ? AND role = 'owner'",
      team,
    )
  ).map((r) => r.user_id);
}

describe('role re-check inside the write (#8)', () => {
  it('an owner who transferred ownership mid-delete gets 403 and the team survives', async () => {
    const { team, ids, cookies } = await teamWithAdmins(3);
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(EARLY_ROLE_READ);
    const del = send(
      'DELETE',
      `/api/teams/${team}`,
      cookies[0] as string,
      undefined,
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    const transfer = await send('POST', `/api/teams/${team}/owner`, cookies[0] as string, {
      user_id: ids[1],
    });
    expect(transfer.status).toBe(200);
    h.release();
    expect((await del).status).toBe(403);
    expect(await owners(team)).toEqual([ids[1]]);
    expect(await role(ids[0] as string, team)).toBe('admin');
  });

  it('the owner’s demotion of admin B racing B’s rename: B gets 403 and the name is unchanged', async () => {
    const { team, ids, cookies } = await teamWithAdmins(3);
    const before = await env.ports.catalog.first<{ display_name: string }>(
      'SELECT display_name FROM studio_definitions WHERE id = ?',
      team,
    );
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(EARLY_ROLE_READ);
    const rename = send(
      'PATCH',
      `/api/teams/${team}`,
      cookies[1] as string,
      { display_name: 'Renamed' },
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    const demote = await send(
      'POST',
      `/api/teams/${team}/members/${ids[1]}/role`,
      cookies[0] as string,
      { role: 'member' },
    );
    expect(demote.status).toBe(200);
    h.release();
    expect((await rename).status).toBe(403);
    const after = await env.ports.catalog.first<{ display_name: string }>(
      'SELECT display_name FROM studio_definitions WHERE id = ?',
      team,
    );
    expect(after).toEqual(before);
    expect(await owners(team)).toEqual([ids[0]]);
  });
});

describe('ownership transfer races (owner-bootstrap D3)', () => {
  async function teamWithMembers(): Promise<{
    team: string;
    o: string;
    m: string;
    n: string;
    cookies: Record<string, string>;
  }> {
    const team = await seedStudio();
    const o = await seedUser();
    const m = await seedUser();
    const n = await seedUser();
    await catalogFor().auth.authAddMembershipWithRole(o, team, 'owner');
    await catalogFor().auth.authAddMembershipWithRole(m, team, 'member');
    await catalogFor().auth.authAddMembershipWithRole(n, team, 'member');
    const cookies = { o: await loginCookie(o), m: await loginCookie(m), n: await loginCookie(n) };
    return { team, o, m, n, cookies };
  }

  it('two concurrent transfers to different members: one 200, one 403, exactly one owner', async () => {
    const { team, o, m, n, cookies } = await teamWithMembers();
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(EARLY_ROLE_READ);
    const toM = send(
      'POST',
      `/api/teams/${team}/owner`,
      cookies.o,
      { user_id: m },
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    const toN = await send('POST', `/api/teams/${team}/owner`, cookies.o, { user_id: n });
    expect(toN.status).toBe(200);
    h.release();
    expect((await toM).status).toBe(403);
    expect(await owners(team)).toEqual([n]);
    expect(await role(o, team)).toBe('admin');
    expect(await role(m, team)).toBe('member');
  });

  it('a transfer racing the target’s leave, leave first: the transfer gets 404, one owner', async () => {
    const { team, o, m, cookies } = await teamWithMembers();
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(EARLY_ROLE_READ);
    const transfer = send(
      'POST',
      `/api/teams/${team}/owner`,
      cookies.o,
      { user_id: m },
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    expect((await send('POST', `/api/teams/${team}/leave`, cookies.m)).status).toBe(200);
    h.release();
    const res = await transfer;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Member not found' });
    expect(await owners(team)).toEqual([o]);
    expect(await role(m, team)).toBeNull();
  });

  it('a transfer racing the target’s leave, transfer first: the leave gets 409, one owner', async () => {
    const { team, o, m, cookies } = await teamWithMembers();
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(EARLY_ROLE_READ);
    const leave = send(
      'POST',
      `/api/teams/${team}/leave`,
      cookies.m,
      undefined,
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    expect((await send('POST', `/api/teams/${team}/owner`, cookies.o, { user_id: m })).status).toBe(
      200,
    );
    h.release();
    const res = await leave;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: 'Transfer ownership first.' });
    expect(await owners(team)).toEqual([m]);
    expect(await role(o, team)).toBe('admin');
  });
});

const ADMIN_TOKEN = 'race-admin-token';
const ADMIN_ENV = envWith({ ADMIN_TOKEN });
const ADMIN_H = { Authorization: `Bearer ${ADMIN_TOKEN}`, ...J };
/** The creation cap's count of the caller's owned teams. */
const CAP_COUNT =
  /SELECT COUNT\(\*\) AS n FROM user_studio_memberships WHERE user_id = \? AND role = 'owner'/;

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
    'INSERT INTO app_settings (key, value) VALUES (?, \'{"stale":true}\')',
    `studio_config:${team}`,
  );
}

describe('team creation (#9, #18)', () => {
  it('concurrent creates by a user owning 19 teams: one 200, one 400', async () => {
    const userId = await seedUser();
    for (let i = 0; i < 19; i++) {
      await catalogFor().auth.authAddMembershipWithRole(userId, await seedStudio(), 'owner');
    }
    const cookie = await loginCookie(userId);
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(CAP_COUNT);
    const a = send(
      'POST',
      '/api/teams',
      cookie,
      { id: 'cap-a', display_name: 'A' },
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    const b = await send('POST', '/api/teams', cookie, { id: 'cap-b', display_name: 'B' });
    h.release();
    expect([b.status, (await a).status].sort()).toEqual([200, 400]);
    const owned = await catalogFor().auth.authCountOwnedTeams(userId);
    expect(owned).toBe(20);
  });

  it('an invite racing the team delete gets 404, and a recreated id starts empty', async () => {
    const { team, cookies } = await teamWithAdmins(2);
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(EARLY_ROLE_READ);
    const invite = send(
      'POST',
      `/api/teams/${team}/invites`,
      cookies[1] as string,
      { email: 'late@example.com' },
      envWith({}, { catalog: gated }),
    );
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
    const res = await send('POST', '/api/teams', await loginCookie(creator), {
      id: team,
      display_name: 'Reused',
    });
    expect(res.status).toBe(200);
    expect(await members(team)).toEqual([creator]);
    expect(await invites(team)).toBe(0);
    expect(await settingsRow(team)).toBeNull(); // the stale blob is gone; defaults come on first read
  });

  it('an id that still has shows is refused', async () => {
    await env.ports.catalog.run(
      "INSERT INTO shows (id, studio_id, name, show_code, created_at_utc) VALUES ('ghost-show', 'ghost-team', 'G', 'G', '2026-01-01T00:00:00Z')",
    );
    const res = await send('POST', '/api/teams', await loginCookie(await seedUser()), {
      id: 'ghost-team',
      display_name: 'G',
    });
    expect(res.status).toBe(400);
    expect(await members('ghost-team')).toEqual([]);
  });

  it('a former built-in id is refused as an existing team and its memberships are untouched', async () => {
    const member = await seedUser({ studios: ['test-studios'] });
    const before = await members('test-studios');
    const res = await send('POST', '/api/teams', await loginCookie(member), {
      id: 'test-studios',
      display_name: 'X',
    });
    expect(res.status).toBe(400);
    expect(await members('test-studios')).toEqual(before);
  });

  it('the admin plane refuses leftover shows and purges leftovers the same way', async () => {
    const stranger = await seedUser();
    await leaveOrphans('admin-reused', stranger);
    const create = await app.request(
      '/api/admin/studios',
      {
        method: 'POST',
        headers: ADMIN_H,
        body: JSON.stringify({ id: 'admin-reused', display_name: 'R' }),
      },
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
      {
        method: 'POST',
        headers: ADMIN_H,
        body: JSON.stringify({ id: 'admin-ghost', display_name: 'G' }),
      },
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
    const a = send(
      'POST',
      `/api/teams/${team}/invites`,
      cookies[0] as string,
      { email: 'new-a@example.com' },
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    const b = await send('POST', `/api/teams/${team}/invites`, cookies[1] as string, {
      email: 'new-b@example.com',
    });
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
    const promote = send(
      'POST',
      `/api/teams/${team}/members/${m}/role`,
      cookies[0] as string,
      { role: 'admin' },
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    expect(
      (await send('DELETE', `/api/teams/${team}/members/${m}`, cookies[1] as string)).status,
    ).toBe(200);
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
    const first = send(
      'DELETE',
      `/api/teams/${team}/members/${m}`,
      cookies[0] as string,
      undefined,
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    const second = await send('DELETE', `/api/teams/${team}/members/${m}`, cookies[1] as string);
    h.release();
    expect([second.status, (await first).status].sort()).toEqual([200, 404]);
  });
});

describe('show create and admin membership add vs team delete (#13, #14)', () => {
  it('a show create racing the team delete gets 400 Unknown studio id. and no show exists', async () => {
    const { team, cookies } = await teamWithAdmins(2);
    const gated = new GatedCatalog(env.ports.catalog);
    // Held after the team-exists read: the role read that follows is FOR SHARE (show-grants D9),
    // so holding after it would block the delete on the membership row lock.
    const h = gated.holdAfter(/^SELECT 1 FROM studio_definitions WHERE id = \?$/);
    const create = send(
      'POST',
      '/api/shows',
      cookies[1] as string,
      { studio_id: team, name: 'Late Show', show_code: 'LS' },
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    expect((await send('DELETE', `/api/teams/${team}`, cookies[0] as string)).status).toBe(200);
    h.release();
    const res = await create;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: 'Unknown studio id.' });
    const n = await env.ports.catalog.first<{ n: number }>(
      'SELECT COUNT(*) AS n FROM shows WHERE studio_id = ?',
      team,
    );
    expect(Number(n?.n)).toBe(0);
  });

  it('an admin-plane membership add racing the team delete is refused and leaves no row', async () => {
    const { team, cookies } = await teamWithAdmins(1);
    const target = await seedUser();
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(/^SELECT \* FROM users WHERE id = \?$/);
    const add = app.request(
      `/api/admin/users/${target}/memberships`,
      { method: 'POST', headers: ADMIN_H, body: JSON.stringify({ studio_id: team }) },
      envWith({ ADMIN_TOKEN }, { catalog: gated }),
    );
    await h.reached;
    expect((await send('DELETE', `/api/teams/${team}`, cookies[0] as string)).status).toBe(200);
    h.release();
    expect((await add).status).toBe(400);
    expect(await members(team)).toEqual([]);
  });
});

describe('cross-team independence (D12)', () => {
  const INSERT_DEFINITION = /^INSERT INTO studio_definitions/;

  it('creates of two different teams by two users both succeed', async () => {
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(INSERT_DEFINITION);
    const a = send(
      'POST',
      '/api/teams',
      await loginCookie(await seedUser()),
      { id: 'indep-a', display_name: 'A' },
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    const b = await send('POST', '/api/teams', await loginCookie(await seedUser()), {
      id: 'indep-b',
      display_name: 'B',
    });
    h.release();
    expect([b.status, (await a).status]).toEqual([200, 200]);
    // On tables this small SERIALIZABLE tracks reads by whole index page (or table, when the
    // planner picks a sequential scan), so the two creates may still conflict once; the retry
    // absorbs it. The per-team indexes (D12) keep that from scaling with the number of teams.
    expect(gated.count(INSERT_DEFINITION)).toBeLessThanOrEqual(2);
  });

  it('invites in two different teams both succeed', async () => {
    const t1 = await teamWithAdmins(1);
    const t2 = await teamWithAdmins(1);
    const UPSERT_INVITE = /^INSERT INTO team_invites/;
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(UPSERT_INVITE);
    const a = send(
      'POST',
      `/api/teams/${t1.team}/invites`,
      t1.cookies[0] as string,
      { email: 'x1@example.com' },
      envWith({}, { catalog: gated }),
    );
    await h.reached;
    const b = await send('POST', `/api/teams/${t2.team}/invites`, t2.cookies[0] as string, {
      email: 'x2@example.com',
    });
    h.release();
    expect([b.status, (await a).status]).toEqual([200, 200]);
    expect(gated.count(UPSERT_INVITE)).toBeLessThanOrEqual(2);
  });
});

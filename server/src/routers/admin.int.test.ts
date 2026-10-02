import { describe, expect, it } from 'vitest';
import { anonApp, envWith } from '../test/harness';
import { adminHeader, catalogFor, seedShow, seedStudio, seedUser } from '../test/helpers';

const TOKEN = 'sweep-admin-token';
const ADMIN_ENV = envWith({ ADMIN_TOKEN: TOKEN });
const H = { ...adminHeader(TOKEN), 'content-type': 'application/json' };

describe('admin auth', () => {
  it('401 with a wrong token', async () => {
    const res = await anonApp.request(
      '/api/admin/users',
      { method: 'GET', headers: adminHeader('nope') },
      ADMIN_ENV,
    );
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/users returns studios_catalog + users', async () => {
    const res = await anonApp.request('/api/admin/users', { method: 'GET', headers: H }, ADMIN_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { studios_catalog: unknown[]; users: unknown[] };
    expect(Array.isArray(body.studios_catalog)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true);
  });
});

describe('admin-plane builtin flag (owner-bootstrap D9)', () => {
  it('studios_catalog reports builtin: false for the former built-ins', async () => {
    const res = await anonApp.request('/api/admin/users', { method: 'GET', headers: H }, ADMIN_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      studios_catalog: Array<{ id: string; builtin: boolean }>;
    };
    const former = body.studios_catalog.filter((s) =>
      ['test-studios', 'test-studio-2'].includes(s.id),
    );
    expect(former).toEqual([
      { id: 'test-studios', name: 'Test Studio', builtin: false },
      { id: 'test-studio-2', name: 'Test Studio 2', builtin: false },
    ]);
  });
});

describe('admin studios', () => {
  it('creates then deletes a studio', async () => {
    const create = await anonApp.request(
      '/api/admin/studios',
      {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ id: 'sweep-team', display_name: 'Sweep' }),
      },
      ADMIN_ENV,
    );
    expect(create.status).toBe(200);
    expect((await create.json()) as { studio: { id: string } }).toMatchObject({
      studio: { id: 'sweep-team' },
    });
    const del = await anonApp.request(
      '/api/admin/studios/sweep-team',
      { method: 'DELETE', headers: H },
      ADMIN_ENV,
    );
    expect(del.status).toBe(200);
    expect((await del.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it('422 on an invalid studio id (too short)', async () => {
    const res = await anonApp.request(
      '/api/admin/studios',
      { method: 'POST', headers: H, body: JSON.stringify({ id: 'a', display_name: 'X' }) },
      ADMIN_ENV,
    );
    expect(res.status).toBe(422);
  });

  it('DELETE cascades pending team_invites (shared delete method, teams-self-serve)', async () => {
    const create = await anonApp.request(
      '/api/admin/studios',
      {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ id: 'sweep-team-invites', display_name: 'Sweep Invites' }),
      },
      ADMIN_ENV,
    );
    expect(create.status).toBe(200);
    const inviter = await seedUser({});
    await catalogFor().auth.authUpsertInvite('sweep-team-invites', 'pending@example.com', inviter);
    expect(await catalogFor().auth.authCountPendingInvites('sweep-team-invites')).toBe(1);

    const del = await anonApp.request(
      '/api/admin/studios/sweep-team-invites',
      { method: 'DELETE', headers: H },
      ADMIN_ENV,
    );
    expect(del.status).toBe(200);
    expect(await catalogFor().auth.authCountPendingInvites('sweep-team-invites')).toBe(0);
  });
});

describe('admin user memberships + disable/enable', () => {
  it('adds and removes a membership for a known builtin studio', async () => {
    const user = await seedUser({});
    const add = await anonApp.request(
      `/api/admin/users/${user}/memberships`,
      { method: 'POST', headers: H, body: JSON.stringify({ studio_id: 'test-studios' }) },
      ADMIN_ENV,
    );
    expect(add.status).toBe(200);
    const del = await anonApp.request(
      `/api/admin/users/${user}/memberships/test-studios`,
      { method: 'DELETE', headers: H },
      ADMIN_ENV,
    );
    expect(del.status).toBe(200);
  });

  it("the support membership delete deletes the member's grants in that team only (show-grants D2)", async () => {
    const cat = catalogFor();
    const user = await seedUser({});
    const team = await seedStudio();
    const other = await seedStudio();
    const show = await seedShow({ studioId: team });
    const otherShow = await seedShow({ studioId: other });
    const now = new Date().toISOString();
    for (const [studio, s] of [
      [team, show],
      [other, otherShow],
    ]) {
      await cat.auth.authAddMembershipWithRole(user, studio, 'member');
      await cat.auth.authGrantShow(user, s, user, now);
    }
    const del = await anonApp.request(
      `/api/admin/users/${user}/memberships/${team}`,
      { method: 'DELETE', headers: H },
      ADMIN_ENV,
    );
    expect(del.status).toBe(200);
    expect(await cat.auth.authListShowGrants(show)).toEqual([]);
    expect((await cat.auth.authListShowGrants(otherShow)).map((r) => r.user_id)).toEqual([user]);
  });

  it('disable then enable a user', async () => {
    const user = await seedUser({});
    const d = await anonApp.request(
      `/api/admin/users/${user}/disable`,
      { method: 'POST', headers: H },
      ADMIN_ENV,
    );
    expect(d.status).toBe(200);
    const e = await anonApp.request(
      `/api/admin/users/${user}/enable`,
      { method: 'POST', headers: H },
      ADMIN_ENV,
    );
    expect(e.status).toBe(200);
  });

  it('404 disabling an unknown user', async () => {
    const res = await anonApp.request(
      '/api/admin/users/no-such-user/disable',
      { method: 'POST', headers: H },
      ADMIN_ENV,
    );
    expect(res.status).toBe(404);
  });
});

describe('admin add-membership role field (teams-self-serve, task 4.1)', () => {
  it('legacy body (no role) creates a member membership, as before', async () => {
    const user = await seedUser({});
    const add = await anonApp.request(
      `/api/admin/users/${user}/memberships`,
      { method: 'POST', headers: H, body: JSON.stringify({ studio_id: 'test-studios' }) },
      ADMIN_ENV,
    );
    expect(add.status).toBe(200);
    expect(await catalogFor().auth.authGetMembershipRole(user, 'test-studios')).toBe('member');
  });

  it('rescues an orphaned team by promoting an existing member to admin (upsert)', async () => {
    const orphanTeam = 'orphan-team-rescue';
    await anonApp.request(
      '/api/admin/studios',
      {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ id: orphanTeam, display_name: 'Orphan' }),
      },
      ADMIN_ENV,
    );
    const user = await seedUser({});
    // Seed as a plain member first -- the team's last admin is gone (orphaned).
    await catalogFor().auth.authAddMembershipWithRole(user, orphanTeam, 'member');
    expect(await catalogFor().auth.authGetMembershipRole(user, orphanTeam)).toBe('member');

    const promote = await anonApp.request(
      `/api/admin/users/${user}/memberships`,
      {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ studio_id: orphanTeam, role: 'admin' }),
      },
      ADMIN_ENV,
    );
    expect(promote.status).toBe(200);
    // Upsert, not INSERT OR IGNORE -- the pre-existing membership's role is
    // actually updated, not silently left as 'member'.
    expect(await catalogFor().auth.authGetMembershipRole(user, orphanTeam)).toBe('admin');
  });

  it('re-POSTing a legacy (role-less) body on an existing admin membership downgrades it to member', async () => {
    // Deliberate, specced behavior (api-contract-freeze "Admin add-membership
    // role field"): the support plane is a precision tool, not last-admin
    // protected -- omitting `role` always means "member", even on update.
    const user = await seedUser({});
    await catalogFor().auth.authAddMembershipWithRole(user, 'test-studios', 'admin');
    expect(await catalogFor().auth.authGetMembershipRole(user, 'test-studios')).toBe('admin');

    const res = await anonApp.request(
      `/api/admin/users/${user}/memberships`,
      { method: 'POST', headers: H, body: JSON.stringify({ studio_id: 'test-studios' }) },
      ADMIN_ENV,
    );
    expect(res.status).toBe(200);
    expect(await catalogFor().auth.authGetMembershipRole(user, 'test-studios')).toBe('member');
  });
});

describe('admin owner upsert (owner-bootstrap 6.1, design D6)', () => {
  const post = (userId: string, body: unknown) =>
    anonApp.request(
      `/api/admin/users/${userId}/memberships`,
      { method: 'POST', headers: H, body: JSON.stringify(body) },
      ADMIN_ENV,
    );
  const roleOf = (userId: string, team: string) =>
    catalogFor().auth.authGetMembershipRole(userId, team);
  async function owners(team: string): Promise<string[]> {
    return (await catalogFor().auth.authListTeamMembers(team))
      .filter((m) => m.role === 'owner')
      .map((m) => m.id);
  }
  async function teamWithOwner(): Promise<{ owner: string }> {
    const owner = await seedUser({});
    await catalogFor().auth.authAddMembershipWithRole(owner, 'test-studios', 'owner');
    return { owner };
  }

  it("role: 'owner' makes the target owner and the old owner admin (exactly one owner)", async () => {
    const { owner } = await teamWithOwner();
    // The spec's rescue case: the old owner is disabled.
    const d = await anonApp.request(
      `/api/admin/users/${owner}/disable`,
      { method: 'POST', headers: H },
      ADMIN_ENV,
    );
    expect(d.status).toBe(200);
    const target = await seedUser({});
    const res = await post(target, { studio_id: 'test-studios', role: 'owner' });
    expect(res.status).toBe(200);
    expect(await roleOf(target, 'test-studios')).toBe('owner');
    expect(await roleOf(owner, 'test-studios')).toBe('admin');
    expect(await owners('test-studios')).toEqual([target]);
  });

  it("role: 'owner' for the current owner changes nothing", async () => {
    const { owner } = await teamWithOwner();
    const res = await post(owner, { studio_id: 'test-studios', role: 'owner' });
    expect(res.status).toBe(200);
    expect(await owners('test-studios')).toEqual([owner]);
  });

  it('a role-less body for the current owner gets 409 and changes nothing', async () => {
    const { owner } = await teamWithOwner();
    const res = await post(owner, { studio_id: 'test-studios' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      'Explicit role required to change the team owner.',
    );
    expect(await roleOf(owner, 'test-studios')).toBe('owner');
  });

  it("an explicit role: 'admin' for the owner succeeds and leaves the team ownerless", async () => {
    const { owner } = await teamWithOwner();
    const res = await post(owner, { studio_id: 'test-studios', role: 'admin' });
    expect(res.status).toBe(200);
    expect(await roleOf(owner, 'test-studios')).toBe('admin');
    expect(await owners('test-studios')).toEqual([]);
  });

  it('a legacy body still creates a member while the team has an owner', async () => {
    await teamWithOwner();
    const user = await seedUser({});
    const res = await post(user, { studio_id: 'test-studios' });
    expect(res.status).toBe(200);
    expect(await roleOf(user, 'test-studios')).toBe('member');
  });

  it('builtin is false in every studios_catalog entry and in a created studio', async () => {
    const create = await anonApp.request(
      '/api/admin/studios',
      {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ id: 'builtin-false-team', display_name: 'BF' }),
      },
      ADMIN_ENV,
    );
    expect(create.status).toBe(200);
    expect(((await create.json()) as { studio: { builtin: boolean } }).studio.builtin).toBe(false);
    const res = await anonApp.request('/api/admin/users', { method: 'GET', headers: H }, ADMIN_ENV);
    const body = (await res.json()) as { studios_catalog: Array<{ id: string; builtin: boolean }> };
    expect(body.studios_catalog.map((s) => s.id)).toContain('builtin-false-team');
    expect(body.studios_catalog.every((s) => s.builtin === false)).toBe(true);
  });
});

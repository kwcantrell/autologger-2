// Team management endpoint family (teams-self-serve, task 2.1; owner-bootstrap 5.1) —
// integration tests against the frozen contract: api-contract-freeze "Team management endpoint
// family" + team-management "Team roles: owner, admin and member" / "Self-serve team creation
// makes the creator owner" / "Owner-anchored team lifecycle" / "Email invites".

import { nowIso } from '@autologger/domain';
import { describe, expect, it } from 'vitest';
import { anonApp, env } from '../test/harness';
import { catalogFor, loginCookie, seedShow, seedStudio, seedUser, testDb } from '../test/helpers';

/** catalogFor() constructs a fresh Catalog whose in-memory studio registry
 * starts empty until `.init()` runs (normally done per-request by
 * authContext) — call this instead when a test needs registry reads
 * (studioNamesDict/isKnownStudio) after a mutation made through a *different*
 * Catalog instance (e.g. the one the anonApp.request() call used). */
async function initedCatalog() {
  const cat = catalogFor();
  await cat.init();
  return cat;
}

/** A team with an owner (the caller) and nobody else. */
async function seedTeamWithOwner(): Promise<{ team: string; ownerId: string; cookie: string }> {
  const team = await seedStudio();
  const ownerId = await seedUser();
  await catalogFor().auth.authAddMembershipWithRole(ownerId, team, 'owner');
  const cookie = await loginCookie(ownerId);
  return { team, ownerId, cookie };
}

/** A team with an owner and one admin; the admin is the caller (`cookie`). */
async function seedTeamWithAdmin(): Promise<{
  team: string;
  adminId: string;
  cookie: string;
  ownerId: string;
  ownerCookie: string;
}> {
  const { team, ownerId, cookie: ownerCookie } = await seedTeamWithOwner();
  const adminId = await seedUser();
  await catalogFor().auth.authAddMembershipWithRole(adminId, team, 'admin');
  const cookie = await loginCookie(adminId);
  return { team, adminId, cookie, ownerId, ownerCookie };
}

async function addToTeam(
  team: string,
  role: 'owner' | 'admin' | 'member' = 'member',
  opts: { email?: string } = {},
): Promise<{ userId: string; cookie: string }> {
  const userId = await seedUser({ email: opts.email });
  await catalogFor().auth.authAddMembershipWithRole(userId, team, role);
  const cookie = await loginCookie(userId);
  return { userId, cookie };
}

function jsonHeaders(cookie?: string): Record<string, string> {
  return cookie
    ? { Cookie: cookie, 'content-type': 'application/json' }
    : { 'content-type': 'application/json' };
}

async function req(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<Response> {
  return anonApp.request(
    path,
    {
      method,
      headers: jsonHeaders(opts.cookie),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
    { ...env },
  );
}

const roleOf = (userId: string, team: string) =>
  catalogFor().auth.authGetMembershipRole(userId, team);

async function detail(team: string, cookie: string) {
  const res = await req('GET', `/api/teams/${team}`, { cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    role: string;
    enabled_admin_count: number;
    invites?: unknown[];
    members: Array<{ id: string; role: string }>;
  };
}

describe('auth: 401 anonymous on every route', () => {
  it('every /api/teams/* route requires login', async () => {
    const team = 'some-team';
    const cases: Array<[string, string, unknown?]> = [
      ['POST', '/api/teams', { id: 'x', display_name: 'X' }],
      ['GET', `/api/teams/${team}`],
      ['PATCH', `/api/teams/${team}`, { display_name: 'X' }],
      ['DELETE', `/api/teams/${team}`],
      ['POST', `/api/teams/${team}/invites`, { email: 'a@example.com' }],
      ['DELETE', `/api/teams/${team}/invites/a@example.com`],
      ['POST', `/api/teams/${team}/members/some-user/role`, { role: 'admin' }],
      ['DELETE', `/api/teams/${team}/members/some-user`],
      ['POST', `/api/teams/${team}/leave`],
      ['POST', `/api/teams/${team}/owner`, { user_id: 'some-user' }],
    ];
    for (const [method, path, body] of cases) {
      const res = await req(method, path, { body });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('auth: masked 404 vs nonexistent', () => {
  it('a non-member and a nonexistent team get the identical masked 404', async () => {
    const { team } = await seedTeamWithOwner();
    const outsiderCookie = (await addToTeam(await seedStudio(), 'owner')).cookie;
    const resReal = await req('GET', `/api/teams/${team}`, { cookie: outsiderCookie });
    const resFake = await req('GET', '/api/teams/does-not-exist-at-all', {
      cookie: outsiderCookie,
    });
    expect(resReal.status).toBe(404);
    expect(resFake.status).toBe(404);
    expect(await resReal.json()).toEqual(await resFake.json());
  });

  it('masks a mutating route the same way', async () => {
    const { team } = await seedTeamWithOwner();
    const outsiderCookie = (await addToTeam(await seedStudio(), 'owner')).cookie;
    const res = await req('PATCH', `/api/teams/${team}`, {
      cookie: outsiderCookie,
      body: { display_name: 'x' },
    });
    expect(res.status).toBe(404);
  });
});

describe('auth: 403 member-on-admin-route', () => {
  it('a plain member gets 403 on an admin-only route', async () => {
    const { team } = await seedTeamWithOwner();
    const { cookie } = await addToTeam(team, 'member');
    const res = await req('PATCH', `/api/teams/${team}`, { cookie, body: { display_name: 'x' } });
    expect(res.status).toBe(403);
  });

  it('a plain member CAN call the member-level GET and leave routes', async () => {
    const { team } = await seedTeamWithOwner();
    const { cookie } = await addToTeam(team, 'member');
    const getRes = await req('GET', `/api/teams/${team}`, { cookie });
    expect(getRes.status).toBe(200);
    const leaveRes = await req('POST', `/api/teams/${team}/leave`, { cookie });
    expect(leaveRes.status).toBe(200);
  });
});

describe('auth: 403 admin-on-owner-route', () => {
  it('an admin gets 403 on a role change, delete and transfer, and nothing changes', async () => {
    const { team, cookie, ownerId } = await seedTeamWithAdmin();
    const { userId: m } = await addToTeam(team, 'member');
    const roleRes = await req('POST', `/api/teams/${team}/members/${m}/role`, {
      cookie,
      body: { role: 'admin' },
    });
    expect(roleRes.status).toBe(403);
    expect(((await roleRes.json()) as { detail: string }).detail).toBe('Owner role required.');
    const delRes = await req('DELETE', `/api/teams/${team}`, { cookie });
    expect(delRes.status).toBe(403);
    const transferRes = await req('POST', `/api/teams/${team}/owner`, {
      cookie,
      body: { user_id: m },
    });
    expect(transferRes.status).toBe(403);
    expect(await roleOf(m, team)).toBe('member');
    expect(await roleOf(ownerId, team)).toBe('owner');
    expect((await initedCatalog()).studios.studioNamesDict()[team]).toBeTruthy();
  });

  it('an admin gets 403 removing another admin, and 200 removing a member', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const { userId: otherAdmin } = await addToTeam(team, 'admin');
    const { userId: m } = await addToTeam(team, 'member');
    const adminRes = await req('DELETE', `/api/teams/${team}/members/${otherAdmin}`, { cookie });
    expect(adminRes.status).toBe(403);
    expect(((await adminRes.json()) as { detail: string }).detail).toBe('Owner role required.');
    expect(await roleOf(otherAdmin, team)).toBe('admin');
    const memberRes = await req('DELETE', `/api/teams/${team}/members/${m}`, { cookie });
    expect(memberRes.status).toBe(200);
    expect(await roleOf(m, team)).toBeNull();
  });
});

// owner-bootstrap D9: the former built-ins are ordinary teams on the team plane.
describe('former built-ins are ordinary teams', () => {
  it('a member of test-studios gets 200 on GET /api/teams/test-studios', async () => {
    const { cookie } = await addToTeam('test-studios', 'member');
    const res = await req('GET', '/api/teams/test-studios', { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string; role: string };
    expect(body).toMatchObject({ id: 'test-studios', name: 'Test Studio', role: 'member' });
  });

  it('a non-member gets the masked 404 on GET /api/teams/test-studios', async () => {
    const cookie = await loginCookie(await seedUser());
    const res = await req('GET', '/api/teams/test-studios', { cookie });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe('Team not found');
  });

  it('the claimed owner renames test-studios; a non-member gets the masked 404 on every operation', async () => {
    const ownerId = await seedUser();
    const claimed = await catalogFor().auth.authClaimOwnerlessStudios(ownerId);
    expect(claimed).toContain('test-studios');
    const cookie = await loginCookie(ownerId);
    const rename = await req('PATCH', '/api/teams/test-studios', {
      cookie,
      body: { display_name: 'Renamed Studio' },
    });
    expect(rename.status).toBe(200);
    expect((await initedCatalog()).studios.studioNamesDict()['test-studios']).toBe(
      'Renamed Studio',
    );

    const outsider = await loginCookie(await seedUser());
    const t = '/api/teams/test-studios';
    const cases: Array<[string, string, unknown?]> = [
      ['GET', t],
      ['PATCH', t, { display_name: 'X' }],
      ['DELETE', t],
      ['POST', `${t}/invites`, { email: 'a@example.com' }],
      ['DELETE', `${t}/invites/a@example.com`],
      ['POST', `${t}/members/${ownerId}/role`, { role: 'admin' }],
      ['DELETE', `${t}/members/${ownerId}`],
      ['POST', `${t}/leave`],
      ['POST', `${t}/owner`, { user_id: ownerId }],
    ];
    for (const [method, path, body] of cases) {
      const res = await req(method, path, { cookie: outsider, body });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(((await res.json()) as { detail: string }).detail).toBe('Team not found');
    }
    expect(await roleOf(ownerId, 'test-studios')).toBe('owner');
  });
});

describe('POST /api/teams — self-serve creation', () => {
  it('creates the team and the creator becomes its owner', async () => {
    const userId = await seedUser();
    const cookie = await loginCookie(userId);
    const res = await req('POST', '/api/teams', {
      cookie,
      body: { id: 'my-crew', display_name: 'My Crew' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'my-crew', name: 'My Crew', role: 'owner' });
    expect(await roleOf(userId, 'my-crew')).toBe('owner');

    const body = await detail('my-crew', cookie);
    expect(body.role).toBe('owner');

    const profile = (await (await req('GET', '/api/profile', { cookie })).json()) as {
      auth: { user: { teams: Array<{ id: string; role: string }> } };
    };
    expect(profile.auth.user.teams.find((t) => t.id === 'my-crew')).toMatchObject({
      role: 'owner',
    });
  });

  it('rejects a former built-in id as an existing team, no membership created', async () => {
    const userId = await seedUser();
    const cookie = await loginCookie(userId);
    const res = await req('POST', '/api/teams', {
      cookie,
      body: { id: 'test-studios', display_name: 'Nope' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toBe(
      'A team with that id already exists.',
    );
    expect(await roleOf(userId, 'test-studios')).toBeNull();
  });

  it('rejects a duplicate id', async () => {
    const cookie = await loginCookie(await seedUser());
    const existing = await seedStudio();
    const res = await req('POST', '/api/teams', {
      cookie,
      body: { id: existing, display_name: 'Dup' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects an id that fails the shared slug regex', async () => {
    const cookie = await loginCookie(await seedUser());
    const res = await req('POST', '/api/teams', {
      cookie,
      body: { id: 'Not_A_Slug!', display_name: 'Bad' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects an empty or too-long display name', async () => {
    const cookie = await loginCookie(await seedUser());
    const empty = await req('POST', '/api/teams', {
      cookie,
      body: { id: 'empty-name-team', display_name: '' },
    });
    expect(empty.status).toBe(400);
    const tooLong = await req('POST', '/api/teams', {
      cookie,
      body: { id: 'long-name-team', display_name: 'x'.repeat(201) },
    });
    expect(tooLong.status).toBe(400);
  });

  it('creation cap: owning 20 teams refuses the 21st', async () => {
    const userId = await seedUser();
    const cookie = await loginCookie(userId);
    for (let i = 0; i < 20; i += 1) {
      const res = await req('POST', '/api/teams', {
        cookie,
        body: { id: `cap-team-${i}`, display_name: `Cap Team ${i}` },
      });
      expect(res.status).toBe(200);
    }
    const overCap = await req('POST', '/api/teams', {
      cookie,
      body: { id: 'cap-team-21', display_name: 'Over Cap' },
    });
    expect(overCap.status).toBe(400);
    expect(((await overCap.json()) as { detail: string }).detail).toBe(
      'You already own 20 teams; the limit has been reached.',
    );
    expect(await roleOf(userId, 'cap-team-21')).toBeNull();
  });

  it('creation cap: owning 19 teams and admining 5 more allows another', async () => {
    const userId = await seedUser();
    for (let i = 0; i < 19; i += 1) {
      await catalogFor().auth.authAddMembershipWithRole(userId, await seedStudio(), 'owner');
    }
    for (let i = 0; i < 5; i += 1) {
      await catalogFor().auth.authAddMembershipWithRole(userId, await seedStudio(), 'admin');
    }
    const res = await req('POST', '/api/teams', {
      cookie: await loginCookie(userId),
      body: { id: 'cap-ok-team', display_name: 'Cap OK' },
    });
    expect(res.status).toBe(200);
    expect(await catalogFor().auth.authCountOwnedTeams(userId)).toBe(20);
  });
});

describe('PATCH /api/teams/:id — rename', () => {
  it('renames the display name only (owner and admin)', async () => {
    const { team, cookie, ownerCookie } = await seedTeamWithAdmin();
    const res = await req('PATCH', `/api/teams/${team}`, {
      cookie,
      body: { display_name: 'New Name' },
    });
    expect(res.status).toBe(200);
    expect((await initedCatalog()).studios.studioNamesDict()[team]).toBe('New Name');
    const byOwner = await req('PATCH', `/api/teams/${team}`, {
      cookie: ownerCookie,
      body: { display_name: 'Owner Name' },
    });
    expect(byOwner.status).toBe(200);
    expect((await initedCatalog()).studios.studioNamesDict()[team]).toBe('Owner Name');
  });

  it('rejects an empty or too-long display name', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const empty = await req('PATCH', `/api/teams/${team}`, { cookie, body: { display_name: '' } });
    expect(empty.status).toBe(400);
    const tooLong = await req('PATCH', `/api/teams/${team}`, {
      cookie,
      body: { display_name: 'x'.repeat(201) },
    });
    expect(tooLong.status).toBe(400);
  });
});

describe('DELETE /api/teams/:id — delete (owner)', () => {
  it('blocks while the team still has shows', async () => {
    const { team, cookie } = await seedTeamWithOwner();
    await seedShow({ studioId: team });
    const res = await req('DELETE', `/api/teams/${team}`, { cookie });
    expect(res.status).toBe(400);
    expect((await initedCatalog()).studios.studioNamesDict()[team]).toBeTruthy();
  });

  it('cascades memberships, invites, definition, and settings via the shared store method', async () => {
    const { team, cookie } = await seedTeamWithOwner();
    await addToTeam(team, 'member');
    await req('POST', `/api/teams/${team}/invites`, {
      cookie,
      body: { email: 'pending@example.com' },
    });
    expect(await catalogFor().auth.authCountPendingInvites(team)).toBe(1);

    const res = await req('DELETE', `/api/teams/${team}`, { cookie });
    expect(res.status).toBe(200);
    expect((await initedCatalog()).studios.studioNamesDict()[team]).toBeUndefined();
    expect(await catalogFor().auth.authListTeamMembers(team)).toHaveLength(0);
    expect(await catalogFor().auth.authListInvitesForTeam(team)).toHaveLength(0);
  });
});

describe('POST /api/teams/:id/invites — email invites', () => {
  it('grants immediate membership to an existing matching user (uniform 200, no pending row)', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const invitee = await seedUser({ email: 'invitee@example.com' });
    const res = await req('POST', `/api/teams/${team}/invites`, {
      cookie,
      body: { email: 'Invitee@Example.com' }, // exercises normalization
    });
    expect(res.status).toBe(200);
    expect(await roleOf(invitee, team)).toBe('member');
    expect(await catalogFor().auth.authCountPendingInvites(team)).toBe(0);
  });

  it('grants membership to ALL matching rows for a duplicated email', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const u1 = await seedUser({ email: 'dup@example.com' });
    const u2 = await seedUser({ email: 'dup@example.com' });
    const res = await req('POST', `/api/teams/${team}/invites`, {
      cookie,
      body: { email: 'dup@example.com' },
    });
    expect(res.status).toBe(200);
    expect(await roleOf(u1, team)).toBe('member');
    expect(await roleOf(u2, team)).toBe('member');
  });

  it('inviting an existing member — including the owner — is a strict no-op', async () => {
    const { team, cookie, ownerId } = await seedTeamWithAdmin();
    const ownerRow = await catalogFor().auth.authGetUserRowAny(ownerId);
    const res = await req('POST', `/api/teams/${team}/invites`, {
      cookie,
      body: { email: String(ownerRow?.email) },
    });
    expect(res.status).toBe(200);
    expect(await roleOf(ownerId, team)).toBe('owner'); // not demoted
  });

  it('an unknown email becomes a pending invite, idempotently', async () => {
    const { team, cookie } = await seedTeamWithOwner();
    const first = await req('POST', `/api/teams/${team}/invites`, {
      cookie,
      body: { email: 'new.person@example.com' },
    });
    expect(first.status).toBe(200);
    const second = await req('POST', `/api/teams/${team}/invites`, {
      cookie,
      body: { email: 'New.Person@Example.com' },
    });
    expect(second.status).toBe(200);
    expect(await catalogFor().auth.authListInvitesForTeam(team)).toHaveLength(1);
  });

  it('rejects an implausible email shape', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const res = await req('POST', `/api/teams/${team}/invites`, {
      cookie,
      body: { email: 'not-an-email' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects an email over 254 chars after normalization', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const longLocal = 'a'.repeat(250);
    const res = await req('POST', `/api/teams/${team}/invites`, {
      cookie,
      body: { email: `${longLocal}@x.com` }, // > 254 chars total, still under the schema's 320 shape cap
    });
    expect(res.status).toBe(400);
  });

  it('pending-invite cap: rejects a new pending invite at 200, but a re-invite of an existing pending stays idempotent', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const cat = catalogFor();
    // The 200 pending invites in one statement, the rows `authUpsertInvite` writes: 200 sequential
    // catalog transactions outlast the 5 s timeout under the full suite (teams-race-invite-seed).
    await testDb().run(
      `INSERT INTO team_invites (studio_id, email_norm, invited_by_user_id, invited_at_utc)
       SELECT ?, 'pending-' || g || '@example.com', ?, ? FROM generate_series(0, 199) AS g`,
      team,
      'seed-inviter',
      nowIso(),
    );
    const overCap = await req('POST', `/api/teams/${team}/invites`, {
      cookie,
      body: { email: 'one-too-many@example.com' },
    });
    expect(overCap.status).toBe(400);

    const reinvite = await req('POST', `/api/teams/${team}/invites`, {
      cookie,
      body: { email: 'pending-0@example.com' },
    });
    expect(reinvite.status).toBe(200);
    expect(await cat.auth.authCountPendingInvites(team)).toBe(200);
  });
});

describe('DELETE /api/teams/:id/invites/:email — revoke', () => {
  it('is idempotent whether or not the invite existed', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const res = await req('DELETE', `/api/teams/${team}/invites/nobody@example.com`, { cookie });
    expect(res.status).toBe(200);
  });

  it('removes an existing invite, decoding + normalizing the path segment', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    await req('POST', `/api/teams/${team}/invites`, { cookie, body: { email: 'foo@example.com' } });
    expect(await catalogFor().auth.authCountPendingInvites(team)).toBe(1);

    const encoded = encodeURIComponent(' Foo@Example.com ');
    const res = await req('DELETE', `/api/teams/${team}/invites/${encoded}`, { cookie });
    expect(res.status).toBe(200);
    expect(await catalogFor().auth.authCountPendingInvites(team)).toBe(0);
  });
});

describe('POST /api/teams/:id/members/:userId/role — role change (owner)', () => {
  it('promotes a member to admin', async () => {
    const { team, cookie } = await seedTeamWithOwner();
    const { userId } = await addToTeam(team, 'member');
    const res = await req('POST', `/api/teams/${team}/members/${userId}/role`, {
      cookie,
      body: { role: 'admin' },
    });
    expect(res.status).toBe(200);
    expect(await roleOf(userId, team)).toBe('admin');
  });

  it('demotes an admin to member', async () => {
    const { team, cookie } = await seedTeamWithOwner();
    const { userId } = await addToTeam(team, 'admin');
    const res = await req('POST', `/api/teams/${team}/members/${userId}/role`, {
      cookie,
      body: { role: 'member' },
    });
    expect(res.status).toBe(200);
    expect(await roleOf(userId, team)).toBe('member');
  });

  it('role change to the already-held role is idempotent 200', async () => {
    const { team, cookie } = await seedTeamWithOwner();
    const { userId } = await addToTeam(team, 'admin');
    const res = await req('POST', `/api/teams/${team}/members/${userId}/role`, {
      cookie,
      body: { role: 'admin' },
    });
    expect(res.status).toBe(200);
  });

  it('404s an unknown/non-member userId', async () => {
    const { team, cookie } = await seedTeamWithOwner();
    const stranger = await seedUser();
    const res = await req('POST', `/api/teams/${team}/members/${stranger}/role`, {
      cookie,
      body: { role: 'admin' },
    });
    expect(res.status).toBe(404);
  });

  it('400s an out-of-enum role value, owner included', async () => {
    const { team, cookie } = await seedTeamWithOwner();
    const { userId } = await addToTeam(team, 'member');
    for (const role of ['owner', 'superuser']) {
      const res = await req('POST', `/api/teams/${team}/members/${userId}/role`, {
        cookie,
        body: { role },
      });
      expect(res.status, role).toBe(400);
    }
    expect(await roleOf(userId, team)).toBe('member');
  });

  it("409s changing the owner's role, whoever asks", async () => {
    const { team, ownerId, ownerCookie } = await seedTeamWithAdmin();
    const res = await req('POST', `/api/teams/${team}/members/${ownerId}/role`, {
      cookie: ownerCookie,
      body: { role: 'member' },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe('Transfer ownership first.');
    expect(await roleOf(ownerId, team)).toBe('owner');
  });
});

describe('DELETE /api/teams/:id/members/:userId — remove', () => {
  it('removes a member', async () => {
    const { team, cookie } = await seedTeamWithOwner();
    const { userId } = await addToTeam(team, 'member');
    const res = await req('DELETE', `/api/teams/${team}/members/${userId}`, { cookie });
    expect(res.status).toBe(200);
    expect(await roleOf(userId, team)).toBeNull();
  });

  it('the owner removes an admin', async () => {
    const { team, adminId, ownerCookie } = await seedTeamWithAdmin();
    const res = await req('DELETE', `/api/teams/${team}/members/${adminId}`, {
      cookie: ownerCookie,
    });
    expect(res.status).toBe(200);
    expect(await roleOf(adminId, team)).toBeNull();
  });

  it('404s an unknown userId', async () => {
    const { team, cookie } = await seedTeamWithOwner();
    const stranger = await seedUser();
    const res = await req('DELETE', `/api/teams/${team}/members/${stranger}`, { cookie });
    expect(res.status).toBe(404);
  });

  it('409s removing the owner, by an admin or by the owner', async () => {
    const { team, ownerId, cookie, ownerCookie } = await seedTeamWithAdmin();
    for (const c of [cookie, ownerCookie]) {
      const res = await req('DELETE', `/api/teams/${team}/members/${ownerId}`, { cookie: c });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { detail: string }).detail).toBe('Transfer ownership first.');
    }
    expect(await roleOf(ownerId, team)).toBe('owner');
  });
});

describe('POST /api/teams/:id/leave', () => {
  it('lets a member leave', async () => {
    const { team } = await seedTeamWithOwner();
    const { userId, cookie } = await addToTeam(team, 'member');
    const res = await req('POST', `/api/teams/${team}/leave`, { cookie });
    expect(res.status).toBe(200);
    expect(await roleOf(userId, team)).toBeNull();
  });

  it('lets the last admin leave (no last-admin protection)', async () => {
    const { team, adminId, cookie } = await seedTeamWithAdmin();
    const res = await req('POST', `/api/teams/${team}/leave`, { cookie });
    expect(res.status).toBe(200);
    expect(await roleOf(adminId, team)).toBeNull();
  });

  it('409s the owner leaving', async () => {
    const { team, ownerId, cookie } = await seedTeamWithOwner();
    const res = await req('POST', `/api/teams/${team}/leave`, { cookie });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { detail: string }).detail).toBe('Transfer ownership first.');
    expect(await roleOf(ownerId, team)).toBe('owner');
  });
});

describe('POST /api/teams/:id/owner — transfer', () => {
  it('makes the target owner and the caller admin; the old owner can then leave', async () => {
    const { team, ownerId, cookie } = await seedTeamWithOwner();
    const { userId: m } = await addToTeam(team, 'member');
    const res = await req('POST', `/api/teams/${team}/owner`, { cookie, body: { user_id: m } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await roleOf(m, team)).toBe('owner');
    expect(await roleOf(ownerId, team)).toBe('admin');

    const leave = await req('POST', `/api/teams/${team}/leave`, { cookie });
    expect(leave.status).toBe(200);
    expect(await roleOf(ownerId, team)).toBeNull();
  });

  it('404s a non-member target and changes nothing', async () => {
    const { team, ownerId, cookie } = await seedTeamWithOwner();
    const stranger = await seedUser();
    const res = await req('POST', `/api/teams/${team}/owner`, {
      cookie,
      body: { user_id: stranger },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe('Member not found');
    expect(await roleOf(ownerId, team)).toBe('owner');
    expect(await roleOf(stranger, team)).toBeNull();
  });

  it('400s a disabled target and changes nothing', async () => {
    const { team, ownerId, cookie } = await seedTeamWithOwner();
    const { userId: m } = await addToTeam(team, 'member');
    await catalogFor().auth.authSetUserDisabled(m, true);
    const res = await req('POST', `/api/teams/${team}/owner`, { cookie, body: { user_id: m } });
    expect(res.status).toBe(400);
    expect(await roleOf(ownerId, team)).toBe('owner');
    expect(await roleOf(m, team)).toBe('member');
  });

  it('a transfer to self is 200 with no change', async () => {
    const { team, ownerId, cookie } = await seedTeamWithOwner();
    const res = await req('POST', `/api/teams/${team}/owner`, {
      cookie,
      body: { user_id: ownerId },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await roleOf(ownerId, team)).toBe('owner');
  });

  it('400s a bad body', async () => {
    const { team, ownerId, cookie } = await seedTeamWithOwner();
    for (const body of [{}, { user_id: '' }, { user_id: '   ' }, { user_id: 7 }]) {
      const res = await req('POST', `/api/teams/${team}/owner`, { cookie, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await roleOf(ownerId, team)).toBe('owner');
  });
});

describe('GET /api/teams/:id — owner, admin and member visibility', () => {
  it('the owner and admins see pending invites; members do not', async () => {
    const { team, cookie: adminCookie, ownerCookie } = await seedTeamWithAdmin();
    await req('POST', `/api/teams/${team}/invites`, {
      cookie: adminCookie,
      body: { email: 'pending@example.com' },
    });
    const { cookie: memberCookie } = await addToTeam(team, 'member');

    const ownerView = await detail(team, ownerCookie);
    expect(ownerView.invites).toHaveLength(1);
    expect(ownerView.members).toHaveLength(3);

    const adminView = await detail(team, adminCookie);
    expect(adminView.invites).toHaveLength(1);

    const memberView = await detail(team, memberCookie);
    expect(memberView.invites).toBeUndefined();
    expect(memberView.members).toHaveLength(3);
  });

  it('members carry {id,email,given_name,family_name,role}, owner first, then admins, then members', async () => {
    const { team, ownerId } = await seedTeamWithOwner();
    const { userId: m, cookie } = await addToTeam(team, 'member');
    const { userId: a } = await addToTeam(team, 'admin');
    const body = await detail(team, cookie);
    expect(body.members.map((x) => [x.id, x.role])).toEqual([
      [ownerId, 'owner'],
      [a, 'admin'],
      [m, 'member'],
    ]);
    const first = body.members[0] as Record<string, unknown>;
    expect(typeof first.email).toBe('string');
    expect(typeof first.given_name).toBe('string');
    expect(typeof first.family_name).toBe('string');
  });

  it('a brand-new team reports enabled_admin_count 0 (the owner is not counted)', async () => {
    const cookie = await loginCookie(await seedUser());
    expect(
      (await req('POST', '/api/teams', { cookie, body: { id: 'fresh-team', display_name: 'F' } }))
        .status,
    ).toBe(200);
    expect((await detail('fresh-team', cookie)).enabled_admin_count).toBe(0);
  });

  it('enabled_admin_count matches the number of non-disabled admins', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    await addToTeam(team, 'admin'); // second admin
    await addToTeam(team, 'member');
    expect((await detail(team, cookie)).enabled_admin_count).toBe(2);
  });

  it("enabled_admin_count is 0 when the team's only admin is disabled, while members still shows them as admin", async () => {
    const { team, adminId } = await seedTeamWithAdmin();
    await catalogFor().auth.authSetUserDisabled(adminId, true);
    // The disabled admin can no longer authenticate, so read via a second
    // member instead of their own (now-invalid) session.
    const { cookie: memberCookie } = await addToTeam(team, 'member');
    const body = await detail(team, memberCookie);
    expect(body.enabled_admin_count).toBe(0);
    const adminMember = body.members.find((m) => m.id === adminId);
    expect(adminMember).toMatchObject({ id: adminId, role: 'admin' });
    expect(adminMember).not.toHaveProperty('disabled');
    expect(adminMember).not.toHaveProperty('disabled_at_utc');
  });
});

describe('owner lifecycle walk-through', () => {
  it('the owner promotes member M, demotes M, then removes M, and the list reflects each step', async () => {
    const { team, ownerId, cookie } = await seedTeamWithOwner();
    const { userId: m } = await addToTeam(team, 'member');
    const roles = async () => (await detail(team, cookie)).members.map((x) => [x.id, x.role]);

    const promote = await req('POST', `/api/teams/${team}/members/${m}/role`, {
      cookie,
      body: { role: 'admin' },
    });
    expect(promote.status).toBe(200);
    expect(await roles()).toEqual([
      [ownerId, 'owner'],
      [m, 'admin'],
    ]);

    const demote = await req('POST', `/api/teams/${team}/members/${m}/role`, {
      cookie,
      body: { role: 'member' },
    });
    expect(demote.status).toBe(200);
    expect(await roles()).toEqual([
      [ownerId, 'owner'],
      [m, 'member'],
    ]);

    const remove = await req('DELETE', `/api/teams/${team}/members/${m}`, { cookie });
    expect(remove.status).toBe(200);
    expect(await roles()).toEqual([[ownerId, 'owner']]);
  });
});

// show-grants D5, D6, D11: the grant routes, the team detail's show_ids, revocation with the
// membership, and grants surviving role changes.
describe('show grants (show-grants D5, D6, D11)', () => {
  const grantPath = (team: string, show: string, user: string) =>
    `/api/teams/${team}/shows/${show}/grants/${user}`;
  const grantsOf = async (show: string) =>
    (await catalogFor().auth.authListShowGrants(show)).map((r) => String(r.user_id));
  const canAccess = (user: string, show: string) => catalogFor().auth.authCanAccessShow(user, show);

  async function setup() {
    const { team, ownerId, cookie: ownerCookie } = await seedTeamWithOwner();
    const admin = await addToTeam(team, 'admin');
    const member = await addToTeam(team, 'member');
    const showA = await seedShow({ studioId: team, name: 'A', code: 'A' });
    const showB = await seedShow({ studioId: team, name: 'B', code: 'B' });
    return { team, ownerId, ownerCookie, admin, member, showA, showB };
  }

  it('PUT grants a member and is idempotent: 200 {ok: true}', async () => {
    const t = await setup();
    for (let i = 0; i < 2; i++) {
      const res = await req('PUT', grantPath(t.team, t.showA, t.member.userId), {
        cookie: t.admin.cookie,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(await grantsOf(t.showA)).toEqual([t.member.userId]);
    expect(await canAccess(t.member.userId, t.showA)).toBe(true);
    expect(await canAccess(t.member.userId, t.showB)).toBe(false);
  });

  it('PUT to a non-member is 404 Member not found; to the owner or an admin is 200 and stores nothing', async () => {
    const t = await setup();
    const outsider = await seedUser();
    const res = await req('PUT', grantPath(t.team, t.showA, outsider), { cookie: t.admin.cookie });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Member not found' });
    for (const target of [t.ownerId, t.admin.userId]) {
      const r = await req('PUT', grantPath(t.team, t.showA, target), { cookie: t.admin.cookie });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    }
    expect(await grantsOf(t.showA)).toEqual([]);
  });

  it('a disabled member is grantable', async () => {
    const t = await setup();
    await catalogFor().auth.authSetUserDisabled(t.member.userId, true);
    const res = await req('PUT', grantPath(t.team, t.showA, t.member.userId), {
      cookie: t.ownerCookie,
    });
    expect(res.status).toBe(200);
    expect(await grantsOf(t.showA)).toEqual([t.member.userId]);
  });

  it('DELETE revokes and is 200 twice, and 200 for a non-member', async () => {
    const t = await setup();
    await req('PUT', grantPath(t.team, t.showA, t.member.userId), { cookie: t.admin.cookie });
    for (let i = 0; i < 2; i++) {
      const res = await req('DELETE', grantPath(t.team, t.showA, t.member.userId), {
        cookie: t.admin.cookie,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect(await grantsOf(t.showA)).toEqual([]);
    const nonMember = await req('DELETE', grantPath(t.team, t.showA, await seedUser()), {
      cookie: t.admin.cookie,
    });
    expect(nonMember.status).toBe(200);
  });

  it('a show of another team or an unknown show is 404 Show not found. for PUT and DELETE', async () => {
    const t = await setup();
    const foreignShow = await seedShow({ studioId: await seedStudio() });
    for (const show of [foreignShow, 'no-such-show']) {
      for (const method of ['PUT', 'DELETE']) {
        const res = await req(method, grantPath(t.team, show, t.member.userId), {
          cookie: t.admin.cookie,
        });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ detail: 'Show not found.' });
      }
    }
    expect(await grantsOf(foreignShow)).toEqual([]);
  });

  it('a member caller gets 403, a non-member the masked 404, anonymous 401; nothing changes', async () => {
    const t = await setup();
    const other = await addToTeam(t.team, 'member');
    const outsider = await loginCookie(await seedUser());
    await catalogFor().auth.authGrantShow(
      other.userId,
      t.showB,
      t.ownerId,
      new Date().toISOString(),
    );
    for (const method of ['PUT', 'DELETE']) {
      const show = method === 'PUT' ? t.showA : t.showB;
      const byMember = await req(method, grantPath(t.team, show, other.userId), {
        cookie: t.member.cookie,
      });
      expect(byMember.status).toBe(403);
      expect(await byMember.json()).toEqual({ detail: 'Admin role required.' });
      const byOutsider = await req(method, grantPath(t.team, show, other.userId), {
        cookie: outsider,
      });
      expect(byOutsider.status).toBe(404);
      expect(await byOutsider.json()).toEqual({ detail: 'Team not found' });
      const anon = await req(method, grantPath(t.team, show, other.userId));
      expect(anon.status).toBe(401);
    }
    expect(await grantsOf(t.showA)).toEqual([]);
    expect(await grantsOf(t.showB)).toEqual([other.userId]);
  });

  it('status order: 401, team 404, role 403, show 404, target 404', async () => {
    const t = await setup();
    const outsider = await loginCookie(await seedUser());
    const nobody = await seedUser();
    // Anonymous on an unknown team with an unknown show and target: 401.
    expect((await req('PUT', grantPath('no-team', 'no-show', nobody))).status).toBe(401);
    // A non-member on a real team, unknown show and target: the masked team 404.
    const r1 = await req('PUT', grantPath(t.team, 'no-show', nobody), { cookie: outsider });
    expect([r1.status, await r1.json()]).toEqual([404, { detail: 'Team not found' }]);
    // A member, unknown show and target: 403.
    const r2 = await req('PUT', grantPath(t.team, 'no-show', nobody), { cookie: t.member.cookie });
    expect(r2.status).toBe(403);
    // An admin, unknown show and non-member target: show 404 first.
    const r3 = await req('PUT', grantPath(t.team, 'no-show', nobody), { cookie: t.admin.cookie });
    expect([r3.status, await r3.json()]).toEqual([404, { detail: 'Show not found.' }]);
    // An admin, a real show and a non-member target: target 404.
    const r4 = await req('PUT', grantPath(t.team, t.showA, nobody), { cookie: t.admin.cookie });
    expect([r4.status, await r4.json()]).toEqual([404, { detail: 'Member not found' }]);
  });

  it('GET …/grants is not a route', async () => {
    const t = await setup();
    const res = await req('GET', `/api/teams/${t.team}/shows/${t.showA}/grants`, {
      cookie: t.admin.cookie,
    });
    expect(res.status).toBe(404);
  });

  it('the team detail carries members[].show_ids for owner and admin callers only', async () => {
    const t = await setup();
    await req('PUT', grantPath(t.team, t.showB, t.member.userId), { cookie: t.admin.cookie });
    await req('PUT', grantPath(t.team, t.showA, t.member.userId), { cookie: t.admin.cookie });
    // A stored grant held by an admin is inert and not reported.
    await catalogFor().auth.authGrantShow(
      t.admin.userId,
      t.showA,
      t.ownerId,
      new Date().toISOString(),
    );
    for (const cookie of [t.ownerCookie, t.admin.cookie]) {
      const res = await req('GET', `/api/teams/${t.team}`, { cookie });
      const body = (await res.json()) as { members: Array<{ id: string; show_ids?: string[] }> };
      const byId = Object.fromEntries(body.members.map((m) => [m.id, m.show_ids]));
      expect(byId).toEqual({
        [t.ownerId]: [],
        [t.admin.userId]: [],
        [t.member.userId]: [t.showA, t.showB].sort(),
      });
    }
    const asMember = await req('GET', `/api/teams/${t.team}`, { cookie: t.member.cookie });
    const body = (await asMember.json()) as { members: Array<Record<string, unknown>> };
    for (const m of body.members) expect(m).not.toHaveProperty('show_ids');
  });

  it('leave and remove delete the grants in that team, keep them elsewhere, and re-inviting restores no access', async () => {
    for (const how of ['leave', 'remove'] as const) {
      const t = await setup();
      const other = await seedStudio();
      const otherShow = await seedShow({ studioId: other });
      await catalogFor().auth.authAddMembershipWithRole(t.member.userId, other, 'member');
      const now = new Date().toISOString();
      await catalogFor().auth.authGrantShow(t.member.userId, t.showA, t.ownerId, now);
      await catalogFor().auth.authGrantShow(t.member.userId, t.showB, t.ownerId, now);
      await catalogFor().auth.authGrantShow(t.member.userId, otherShow, t.ownerId, now);
      const res =
        how === 'leave'
          ? await req('POST', `/api/teams/${t.team}/leave`, { cookie: t.member.cookie })
          : await req('DELETE', `/api/teams/${t.team}/members/${t.member.userId}`, {
              cookie: t.admin.cookie,
            });
      expect(res.status).toBe(200);
      expect(await grantsOf(t.showA)).toEqual([]);
      expect(await grantsOf(t.showB)).toEqual([]);
      expect(await grantsOf(otherShow)).toEqual([t.member.userId]);

      const user = await catalogFor().auth.authGetUserById(t.member.userId);
      const invite = await req('POST', `/api/teams/${t.team}/invites`, {
        cookie: t.admin.cookie,
        body: { email: String(user?.email) },
      });
      expect(invite.status).toBe(200);
      expect(await catalogFor().auth.authGetMembershipRole(t.member.userId, t.team)).toBe('member');
      expect(await canAccess(t.member.userId, t.showA)).toBe(false);
      expect(await canAccess(t.member.userId, t.showB)).toBe(false);
    }
  });

  it('a promoted then demoted member keeps their grant', async () => {
    const t = await setup();
    await req('PUT', grantPath(t.team, t.showA, t.member.userId), { cookie: t.admin.cookie });
    const role = (r: 'admin' | 'member') =>
      req('POST', `/api/teams/${t.team}/members/${t.member.userId}/role`, {
        cookie: t.ownerCookie,
        body: { role: r },
      });
    expect((await role('admin')).status).toBe(200);
    expect(await canAccess(t.member.userId, t.showB)).toBe(true);
    expect((await role('member')).status).toBe(200);
    expect(await grantsOf(t.showA)).toEqual([t.member.userId]);
    expect(await canAccess(t.member.userId, t.showA)).toBe(true);
    expect(await canAccess(t.member.userId, t.showB)).toBe(false);
  });
});

// Team management endpoint family (teams-self-serve, task 2.1) — integration
// tests against the frozen contract: api-contract-freeze delta's "Team
// management endpoint family" requirement + team-management delta's
// "Membership roles" / "Self-serve team creation" / "Team lifecycle and
// last-admin protection" / "Email invites" requirements.

import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import { catalogFor, loginCookie, seedShow, seedStudio, seedUser } from '../test/helpers';
import { BUILTIN_STUDIO_ORDER } from '../studio';

/** catalogFor() constructs a fresh Catalog whose in-memory studio registry
 * starts empty until `.init()` runs (normally done per-request by
 * authContext) — call this instead when a test needs registry reads
 * (studioNamesDict/isKnownStudio) after a mutation made through a *different*
 * Catalog instance (e.g. the one the app.request() call used). */
function initedCatalog() {
  const cat = catalogFor();
  cat.init();
  return cat;
}

async function seedTeamWithAdmin(): Promise<{ team: string; adminId: string; cookie: string }> {
  const team = await seedStudio();
  const adminId = await seedUser();
  catalogFor().auth.authAddMembershipWithRole(adminId, team, 'admin');
  const cookie = await loginCookie(adminId);
  return { team, adminId, cookie };
}

async function addToTeam(
  team: string,
  role: 'admin' | 'member' = 'member',
  opts: { email?: string } = {},
): Promise<{ userId: string; cookie: string }> {
  const userId = await seedUser({ email: opts.email });
  catalogFor().auth.authAddMembershipWithRole(userId, team, role);
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
  return app.request(
    path,
    {
      method,
      headers: jsonHeaders(opts.cookie),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
    { ...env },
  );
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
    ];
    for (const [method, path, body] of cases) {
      const res = await req(method, path, { body });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('auth: masked 404 vs nonexistent', () => {
  it('a non-member and a nonexistent team get the identical masked 404', async () => {
    const { team } = await seedTeamWithAdmin();
    const outsiderCookie = (await addToTeam(await seedStudio(), 'admin')).cookie;
    const resReal = await req('GET', `/api/teams/${team}`, { cookie: outsiderCookie });
    const resFake = await req('GET', '/api/teams/does-not-exist-at-all', { cookie: outsiderCookie });
    expect(resReal.status).toBe(404);
    expect(resFake.status).toBe(404);
    expect(await resReal.json()).toEqual(await resFake.json());
  });

  it('masks a mutating route the same way', async () => {
    const { team } = await seedTeamWithAdmin();
    const outsiderCookie = (await addToTeam(await seedStudio(), 'admin')).cookie;
    const res = await req('PATCH', `/api/teams/${team}`, {
      cookie: outsiderCookie,
      body: { display_name: 'x' },
    });
    expect(res.status).toBe(404);
  });
});

describe('auth: 403 member-on-admin-route', () => {
  it('a plain member gets 403 on an admin-only route', async () => {
    const { team } = await seedTeamWithAdmin();
    const { cookie } = await addToTeam(team, 'member');
    const res = await req('PATCH', `/api/teams/${team}`, { cookie, body: { display_name: 'x' } });
    expect(res.status).toBe(403);
  });

  it('a plain member CAN call the member-level GET and leave routes', async () => {
    const { team } = await seedTeamWithAdmin();
    await addToTeam(team, 'admin'); // second admin so leave below doesn't 409
    const { cookie } = await addToTeam(team, 'member');
    const getRes = await req('GET', `/api/teams/${team}`, { cookie });
    expect(getRes.status).toBe(200);
    const leaveRes = await req('POST', `/api/teams/${team}/leave`, { cookie });
    expect(leaveRes.status).toBe(200);
  });
});

describe('built-in teams excluded wholesale', () => {
  it('400s every /api/teams/:id/* operation on both built-in ids', async () => {
    const userId = await seedUser();
    const cookie = await loginCookie(userId);
    for (const bid of BUILTIN_STUDIO_ORDER) {
      const cases: Array<[string, string, unknown?]> = [
        ['GET', `/api/teams/${bid}`],
        ['PATCH', `/api/teams/${bid}`, { display_name: 'x' }],
        ['DELETE', `/api/teams/${bid}`],
        ['POST', `/api/teams/${bid}/invites`, { email: 'a@example.com' }],
        ['DELETE', `/api/teams/${bid}/invites/a@example.com`],
        ['POST', `/api/teams/${bid}/members/${userId}/role`, { role: 'admin' }],
        ['DELETE', `/api/teams/${bid}/members/${userId}`],
        ['POST', `/api/teams/${bid}/leave`],
      ];
      for (const [method, path, body] of cases) {
        const res = await req(method, path, { cookie, body });
        expect(res.status, `${method} ${path}`).toBe(400);
      }
    }
  });
});

describe('POST /api/teams — self-serve creation', () => {
  it('creates the team and the creator becomes its admin', async () => {
    const userId = await seedUser();
    const cookie = await loginCookie(userId);
    const res = await req('POST', '/api/teams', {
      cookie,
      body: { id: 'my-crew', display_name: 'My Crew' },
    });
    expect(res.status).toBe(200);
    expect(catalogFor().auth.authGetMembershipRole(userId, 'my-crew')).toBe('admin');

    const detail = await req('GET', '/api/teams/my-crew', { cookie });
    const body = (await detail.json()) as { role: string; name: string };
    expect(body.role).toBe('admin');
    expect(body.name).toBe('My Crew');
  });

  it('rejects a built-in id, no team created', async () => {
    const cookie = await loginCookie(await seedUser());
    const res = await req('POST', '/api/teams', {
      cookie,
      body: { id: 'test-studios', display_name: 'Nope' },
    });
    expect(res.status).toBe(400);
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

  it('creation cap: rejects a 21st team once the caller admins 20 non-built-in teams', async () => {
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
  });
});

describe('PATCH /api/teams/:id — rename', () => {
  it('renames the display name only', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const res = await req('PATCH', `/api/teams/${team}`, { cookie, body: { display_name: 'New Name' } });
    expect(res.status).toBe(200);
    expect(initedCatalog().studios.studioNamesDict()[team]).toBe('New Name');
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

describe('DELETE /api/teams/:id — delete', () => {
  it('blocks while the team still has shows', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    await seedShow({ studioId: team });
    const res = await req('DELETE', `/api/teams/${team}`, { cookie });
    expect(res.status).toBe(400);
    expect(initedCatalog().studios.studioNamesDict()[team]).toBeTruthy();
  });

  it('cascades memberships, invites, definition, and settings via the shared store method', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    await addToTeam(team, 'member');
    await req('POST', `/api/teams/${team}/invites`, { cookie, body: { email: 'pending@example.com' } });
    expect(catalogFor().auth.authCountPendingInvites(team)).toBe(1);

    const res = await req('DELETE', `/api/teams/${team}`, { cookie });
    expect(res.status).toBe(200);
    expect(initedCatalog().studios.studioNamesDict()[team]).toBeUndefined();
    expect(catalogFor().auth.authListTeamMembers(team)).toHaveLength(0);
    expect(catalogFor().auth.authListInvitesForTeam(team)).toHaveLength(0);
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
    expect(catalogFor().auth.authGetMembershipRole(invitee, team)).toBe('member');
    expect(catalogFor().auth.authCountPendingInvites(team)).toBe(0);
  });

  it('grants membership to ALL matching rows for a duplicated email', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const u1 = await seedUser({ email: 'dup@example.com' });
    const u2 = await seedUser({ email: 'dup@example.com' });
    const res = await req('POST', `/api/teams/${team}/invites`, { cookie, body: { email: 'dup@example.com' } });
    expect(res.status).toBe(200);
    expect(catalogFor().auth.authGetMembershipRole(u1, team)).toBe('member');
    expect(catalogFor().auth.authGetMembershipRole(u2, team)).toBe('member');
  });

  it('inviting an existing member — including the sole admin — is a strict no-op', async () => {
    const { team, cookie, adminId } = await seedTeamWithAdmin();
    const adminRow = catalogFor().auth.authGetUserRowAny(adminId);
    const res = await req('POST', `/api/teams/${team}/invites`, {
      cookie,
      body: { email: String(adminRow?.email) },
    });
    expect(res.status).toBe(200);
    expect(catalogFor().auth.authGetMembershipRole(adminId, team)).toBe('admin'); // not demoted
  });

  it('an unknown email becomes a pending invite, idempotently', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
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
    expect(catalogFor().auth.authListInvitesForTeam(team)).toHaveLength(1);
  });

  it('rejects an implausible email shape', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const res = await req('POST', `/api/teams/${team}/invites`, { cookie, body: { email: 'not-an-email' } });
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
    for (let i = 0; i < 200; i += 1) {
      cat.auth.authUpsertInvite(team, `pending-${i}@example.com`, 'seed-inviter');
    }
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
    expect(cat.auth.authCountPendingInvites(team)).toBe(200);
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
    expect(catalogFor().auth.authCountPendingInvites(team)).toBe(1);

    const encoded = encodeURIComponent(' Foo@Example.com ');
    const res = await req('DELETE', `/api/teams/${team}/invites/${encoded}`, { cookie });
    expect(res.status).toBe(200);
    expect(catalogFor().auth.authCountPendingInvites(team)).toBe(0);
  });
});

describe('POST /api/teams/:id/members/:userId/role — role change', () => {
  it('promotes a member to admin', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const { userId } = await addToTeam(team, 'member');
    const res = await req('POST', `/api/teams/${team}/members/${userId}/role`, {
      cookie,
      body: { role: 'admin' },
    });
    expect(res.status).toBe(200);
    expect(catalogFor().auth.authGetMembershipRole(userId, team)).toBe('admin');
  });

  it('demotes an admin to member when another enabled admin remains', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const { userId } = await addToTeam(team, 'admin');
    const res = await req('POST', `/api/teams/${team}/members/${userId}/role`, {
      cookie,
      body: { role: 'member' },
    });
    expect(res.status).toBe(200);
    expect(catalogFor().auth.authGetMembershipRole(userId, team)).toBe('member');
  });

  it('role change to the already-held role is idempotent 200', async () => {
    const { team, cookie, adminId } = await seedTeamWithAdmin();
    const res = await req('POST', `/api/teams/${team}/members/${adminId}/role`, {
      cookie,
      body: { role: 'admin' },
    });
    expect(res.status).toBe(200);
  });

  it('404s an unknown/non-member userId', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const stranger = await seedUser();
    const res = await req('POST', `/api/teams/${team}/members/${stranger}/role`, {
      cookie,
      body: { role: 'admin' },
    });
    expect(res.status).toBe(404);
  });

  it('400s an out-of-enum role value', async () => {
    const { team, cookie, adminId } = await seedTeamWithAdmin();
    const res = await req('POST', `/api/teams/${team}/members/${adminId}/role`, {
      cookie,
      body: { role: 'owner' },
    });
    expect(res.status).toBe(400);
  });

  it('409s demoting the last ENABLED admin — a disabled admin does not count', async () => {
    const { team, cookie, adminId } = await seedTeamWithAdmin();
    const { userId: disabledAdmin } = await addToTeam(team, 'admin');
    catalogFor().auth.authSetUserDisabled(disabledAdmin, true);
    const res = await req('POST', `/api/teams/${team}/members/${adminId}/role`, {
      cookie,
      body: { role: 'member' },
    });
    expect(res.status).toBe(409);
    expect(catalogFor().auth.authGetMembershipRole(adminId, team)).toBe('admin'); // unchanged
  });
});

describe('DELETE /api/teams/:id/members/:userId — remove', () => {
  it('removes a member', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const { userId } = await addToTeam(team, 'member');
    const res = await req('DELETE', `/api/teams/${team}/members/${userId}`, { cookie });
    expect(res.status).toBe(200);
    expect(catalogFor().auth.authGetMembershipRole(userId, team)).toBeNull();
  });

  it('404s an unknown userId', async () => {
    const { team, cookie } = await seedTeamWithAdmin();
    const stranger = await seedUser();
    const res = await req('DELETE', `/api/teams/${team}/members/${stranger}`, { cookie });
    expect(res.status).toBe(404);
  });

  it('409s removing the last ENABLED admin — a disabled admin does not count', async () => {
    const { team, cookie, adminId } = await seedTeamWithAdmin();
    const { userId: disabledAdmin } = await addToTeam(team, 'admin');
    catalogFor().auth.authSetUserDisabled(disabledAdmin, true);
    const res = await req('DELETE', `/api/teams/${team}/members/${adminId}`, { cookie });
    expect(res.status).toBe(409);
    expect(catalogFor().auth.authGetMembershipRole(adminId, team)).toBe('admin'); // unchanged
  });
});

describe('POST /api/teams/:id/leave', () => {
  it('lets a member leave', async () => {
    const { team } = await seedTeamWithAdmin();
    const { userId, cookie } = await addToTeam(team, 'member');
    const res = await req('POST', `/api/teams/${team}/leave`, { cookie });
    expect(res.status).toBe(200);
    expect(catalogFor().auth.authGetMembershipRole(userId, team)).toBeNull();
  });

  it('409s the last ENABLED admin leaving — a disabled admin does not count', async () => {
    const { team, cookie, adminId } = await seedTeamWithAdmin();
    const { userId: disabledAdmin } = await addToTeam(team, 'admin');
    catalogFor().auth.authSetUserDisabled(disabledAdmin, true);
    const res = await req('POST', `/api/teams/${team}/leave`, { cookie });
    expect(res.status).toBe(409);
    expect(catalogFor().auth.authGetMembershipRole(adminId, team)).toBe('admin'); // unchanged
  });
});

describe('GET /api/teams/:id — member vs admin visibility', () => {
  it('admins see pending invites; members do not', async () => {
    const { team, cookie: adminCookie } = await seedTeamWithAdmin();
    await req('POST', `/api/teams/${team}/invites`, {
      cookie: adminCookie,
      body: { email: 'pending@example.com' },
    });
    const { cookie: memberCookie } = await addToTeam(team, 'member');

    const adminView = (await (
      await req('GET', `/api/teams/${team}`, { cookie: adminCookie })
    ).json()) as { invites?: unknown[]; members: unknown[] };
    expect(adminView.invites).toHaveLength(1);
    expect(adminView.members).toHaveLength(2);

    const memberView = (await (
      await req('GET', `/api/teams/${team}`, { cookie: memberCookie })
    ).json()) as { invites?: unknown[]; members: unknown[] };
    expect(memberView.invites).toBeUndefined();
    expect(memberView.members).toHaveLength(2);
  });

  it('members carry {id,email,given_name,family_name,role}, admins first', async () => {
    const { team, cookie, adminId } = await seedTeamWithAdmin();
    const res = await req('GET', `/api/teams/${team}`, { cookie });
    const body = (await res.json()) as { members: Array<Record<string, unknown>> };
    expect(body.members[0]).toMatchObject({ id: adminId, role: 'admin' });
    expect(typeof body.members[0].email).toBe('string');
    expect(typeof body.members[0].given_name).toBe('string');
    expect(typeof body.members[0].family_name).toBe('string');
  });
});

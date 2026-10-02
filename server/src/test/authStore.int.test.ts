// teams-self-serve (design D1/D2): role-aware membership ops + invite storage.
import { describe, expect, it } from 'vitest';
import { env } from './harness';
import { catalogFor, seedStudio, seedUser } from './helpers';

describe('AuthStore: role-aware memberships (design D1)', () => {
  it('authAddMembershipWithRole creates with the given role', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser();
    await cat.auth.authAddMembershipWithRole(user, studio, 'admin');
    expect(await cat.auth.authGetMembershipRole(user, studio)).toBe('admin');
  });

  it('authAddMembershipWithRole is a no-op (role preserved) if already a member', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser();
    await cat.auth.authAddMembershipWithRole(user, studio, 'admin');
    await cat.auth.authAddMembershipWithRole(user, studio, 'member');
    expect(await cat.auth.authGetMembershipRole(user, studio)).toBe('admin');
  });

  it('authUpsertMembershipRole creates the membership when absent', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser();
    expect(await cat.auth.authGetMembershipRole(user, studio)).toBeNull();
    await cat.auth.authUpsertMembershipRole(user, studio, 'admin');
    expect(await cat.auth.authGetMembershipRole(user, studio)).toBe('admin');
  });

  it('authUpsertMembershipRole updates the role when present (promote/demote/rescue)', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser({ studios: [studio] }); // default role from column default: member
    expect(await cat.auth.authGetMembershipRole(user, studio)).toBe('member');
    await cat.auth.authUpsertMembershipRole(user, studio, 'admin');
    expect(await cat.auth.authGetMembershipRole(user, studio)).toBe('admin');
    await cat.auth.authUpsertMembershipRole(user, studio, 'member');
    expect(await cat.auth.authGetMembershipRole(user, studio)).toBe('member');
  });

  it('authGetMembershipRole returns null for a non-member', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser();
    expect(await cat.auth.authGetMembershipRole(user, studio)).toBeNull();
  });

  it('authCountEnabledAdmins counts admins whose accounts are enabled only', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const admin1 = await seedUser();
    const admin2 = await seedUser();
    const disabledAdmin = await seedUser();
    const member = await seedUser();
    await cat.auth.authAddMembershipWithRole(admin1, studio, 'admin');
    await cat.auth.authAddMembershipWithRole(admin2, studio, 'admin');
    await cat.auth.authAddMembershipWithRole(disabledAdmin, studio, 'admin');
    await cat.auth.authAddMembershipWithRole(member, studio, 'member');
    await cat.auth.authSetUserDisabled(disabledAdmin, true);
    expect(await cat.auth.authCountEnabledAdmins(studio)).toBe(2);
  });

  it('authCountEnabledAdmins is 0 for a team with no admins', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const member = await seedUser();
    await cat.auth.authAddMembershipWithRole(member, studio, 'member');
    expect(await cat.auth.authCountEnabledAdmins(studio)).toBe(0);
  });

  it('authListTeamMembers orders owner, admin, member (owner-bootstrap D11)', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const owner = await seedUser({ email: 'zz-owner@example.com' });
    const admin = await seedUser({ email: 'yy-admin@example.com' });
    const member = await seedUser({ email: 'aa-member@example.com' });
    await cat.auth.authAddMembershipWithRole(member, studio, 'member');
    await cat.auth.authAddMembershipWithRole(admin, studio, 'admin');
    await cat.auth.authAddMembershipWithRole(owner, studio, 'owner');
    const rows = await cat.auth.authListTeamMembers(studio);
    expect(rows.map((r) => [r.id, r.role])).toEqual([
      [owner, 'owner'],
      [admin, 'admin'],
      [member, 'member'],
    ]);
  });

  it('authCountEnabledAdmins does not count the owner (owner decision B)', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    await cat.auth.authAddMembershipWithRole(await seedUser(), studio, 'owner');
    expect(await cat.auth.authCountEnabledAdmins(studio)).toBe(0);
    await cat.auth.authAddMembershipWithRole(await seedUser(), studio, 'admin');
    expect(await cat.auth.authCountEnabledAdmins(studio)).toBe(1);
  });

  it('authListTeamMembers returns joined user fields + role, admins first', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const admin = await seedUser({ email: 'zz-admin@example.com' });
    const member = await seedUser({ email: 'aa-member@example.com' });
    await cat.auth.authAddMembershipWithRole(admin, studio, 'admin');
    await cat.auth.authAddMembershipWithRole(member, studio, 'member');
    const rows = await cat.auth.authListTeamMembers(studio);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.role)).toEqual(['admin', 'member']);
    const adminRow = rows.find((r) => r.id === admin);
    expect(adminRow).toMatchObject({
      id: admin,
      email: 'zz-admin@example.com',
      given_name: 'Test',
      family_name: 'User',
      role: 'admin',
    });
  });

  // owner-bootstrap D5: the creation cap counts owned teams only.
  it('authCountOwnedTeams counts owner memberships only', async () => {
    const cat = catalogFor();
    const user = await seedUser();
    await cat.auth.authAddMembershipWithRole(user, await seedStudio(), 'owner');
    await cat.auth.authAddMembershipWithRole(user, await seedStudio(), 'owner');
    await cat.auth.authAddMembershipWithRole(user, await seedStudio(), 'admin');
    await cat.auth.authAddMembershipWithRole(user, await seedStudio(), 'member');
    expect(await cat.auth.authCountOwnedTeams(user)).toBe(2);
    expect(await cat.auth.authCountOwnedTeams(await seedUser())).toBe(0);
  });

  it('authListTeamMembers scopes to the team', async () => {
    const cat = catalogFor();
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const userA = await seedUser();
    const userB = await seedUser();
    await cat.auth.authAddMembershipWithRole(userA, studioA, 'admin');
    await cat.auth.authAddMembershipWithRole(userB, studioB, 'admin');
    expect((await cat.auth.authListTeamMembers(studioA)).map((r) => r.id)).toEqual([userA]);
  });
});

describe('AuthStore: email invites (design D2)', () => {
  it('authUpsertInvite + authListInvitesForTeam round-trip', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const inviter = await seedUser();
    await cat.auth.authUpsertInvite(studio, 'person@example.com', inviter);
    const rows = await cat.auth.authListInvitesForTeam(studio);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      studio_id: studio,
      email_norm: 'person@example.com',
      invited_by_user_id: inviter,
    });
    expect(typeof rows[0]?.invited_at_utc).toBe('string');
  });

  it('authUpsertInvite is idempotent (re-inviting does not duplicate the row)', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const inviter1 = await seedUser();
    const inviter2 = await seedUser();
    await cat.auth.authUpsertInvite(studio, 'person@example.com', inviter1);
    await cat.auth.authUpsertInvite(studio, 'person@example.com', inviter2);
    const rows = await cat.auth.authListInvitesForTeam(studio);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invited_by_user_id).toBe(inviter2); // refreshed on re-invite
  });

  it('authListInvitesForTeam scopes to the team', async () => {
    const cat = catalogFor();
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const inviter = await seedUser();
    await cat.auth.authUpsertInvite(studioA, 'a@example.com', inviter);
    await cat.auth.authUpsertInvite(studioB, 'b@example.com', inviter);
    expect((await cat.auth.authListInvitesForTeam(studioA)).map((r) => r.email_norm)).toEqual([
      'a@example.com',
    ]);
  });

  it('authDeleteInvite removes the row and reports changes; idempotent on a second call', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const inviter = await seedUser();
    await cat.auth.authUpsertInvite(studio, 'person@example.com', inviter);
    expect(await cat.auth.authDeleteInvite(studio, 'person@example.com')).toBe(1);
    expect(await cat.auth.authListInvitesForTeam(studio)).toHaveLength(0);
    expect(await cat.auth.authDeleteInvite(studio, 'person@example.com')).toBe(0); // idempotent
  });

  it('authCountPendingInvites counts per team', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const inviter = await seedUser();
    await cat.auth.authUpsertInvite(studio, 'a@example.com', inviter);
    await cat.auth.authUpsertInvite(studio, 'b@example.com', inviter);
    expect(await cat.auth.authCountPendingInvites(studio)).toBe(2);
  });

  it('authConsumeInvitesForEmail selects+deletes every invite for a normalized email across teams', async () => {
    const cat = catalogFor();
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const inviter = await seedUser();
    await cat.auth.authUpsertInvite(studioA, 'new.person@example.com', inviter);
    await cat.auth.authUpsertInvite(studioB, 'new.person@example.com', inviter);
    await cat.auth.authUpsertInvite(studioA, 'someone.else@example.com', inviter);

    const consumed = await cat.auth.authConsumeInvitesForEmail('new.person@example.com');
    expect(consumed.map((r) => r.studio_id).sort()).toEqual([studioA, studioB].sort());
    expect((await cat.auth.authListInvitesForTeam(studioA)).map((r) => r.email_norm)).toEqual([
      'someone.else@example.com',
    ]);
    expect(await cat.auth.authListInvitesForTeam(studioB)).toHaveLength(0);
  });

  it('authConsumeInvitesForEmail returns [] and deletes nothing when no invite matches', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const inviter = await seedUser();
    await cat.auth.authUpsertInvite(studio, 'a@example.com', inviter);
    expect(await cat.auth.authConsumeInvitesForEmail('nobody@example.com')).toEqual([]);
    expect(await cat.auth.authCountPendingInvites(studio)).toBe(1);
  });

  it('authConsumeInvitesForEmail composes inside an outer catalog.tx() (materialization boundary)', async () => {
    // The router materializes invites inside one catalog.tx(...) alongside user
    // creation; authConsumeInvitesForEmail's own transaction joins that boundary
    // (async-catalog-stores D3) instead of conflicting with it.
    const cat = catalogFor();
    const studio = await seedStudio();
    const inviter = await seedUser();
    const newUser = await seedUser();
    await cat.auth.authUpsertInvite(studio, 'new.person@example.com', inviter);

    const consumed = await cat.tx(async (c) => {
      const rows = await c.auth.authConsumeInvitesForEmail('new.person@example.com');
      await c.auth.authAddMembershipWithRole(newUser, studio, 'member');
      return rows;
    });
    expect(consumed).toHaveLength(1);
    expect(await cat.auth.authListInvitesForTeam(studio)).toHaveLength(0);
  });
});

describe('AuthStore: authSetPrefs upsert (code-health-tail task 2.7, finding 5.7)', () => {
  it('creates the prefs row when absent', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser();
    expect(await cat.auth.authGetPrefs(user)).toBeNull();
    await cat.auth.authSetPrefs(user, studio, 'show-1');
    expect(await cat.auth.authGetPrefs(user)).toMatchObject({
      user_id: user,
      active_studio_id: studio,
      active_show_id: 'show-1',
    });
  });

  it('updates BOTH columns when the row exists (no stale column survives)', async () => {
    const cat = catalogFor();
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const user = await seedUser();
    await cat.auth.authSetPrefs(user, studioA, 'show-a');
    await cat.auth.authSetPrefs(user, studioB, 'show-b');
    expect(await cat.auth.authGetPrefs(user)).toMatchObject({
      user_id: user,
      active_studio_id: studioB,
      active_show_id: 'show-b',
    });
  });

  it('overwrites a row pre-seeded empty by authEnsurePrefsRow (the former ensure+UPDATE path)', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser();
    await cat.auth.authEnsurePrefsRow(user);
    expect(await cat.auth.authGetPrefs(user)).toMatchObject({
      active_studio_id: '',
      active_show_id: '',
    });
    await cat.auth.authSetPrefs(user, studio, 'show-1');
    expect(await cat.auth.authGetPrefs(user)).toMatchObject({
      user_id: user,
      active_studio_id: studio,
      active_show_id: 'show-1',
    });
  });
});

describe('AuthStore: user lookup by normalized email (design D2 multi-match)', () => {
  it('authListUsersByEmailNorm matches case/whitespace-insensitively via JS normalization', async () => {
    const cat = catalogFor();
    const user = await seedUser({ email: 'Some.Person@Example.com' });
    const matches = await cat.auth.authListUsersByEmailNorm('some.person@example.com');
    expect(matches.map((r) => r.id)).toEqual([user]);
  });

  it('authListUsersByEmailNorm returns ALL matching rows, including disabled accounts', async () => {
    const cat = catalogFor();
    const user1 = await seedUser({ email: 'dup@example.com' });
    const user2 = await seedUser({ email: 'dup@example.com' });
    await cat.auth.authSetUserDisabled(user2, true);
    const matches = await cat.auth.authListUsersByEmailNorm('dup@example.com');
    expect(matches.map((r) => r.id).sort()).toEqual([user1, user2].sort());
  });

  it('authListUsersByEmailNorm returns [] when no user matches', async () => {
    const cat = catalogFor();
    await seedUser({ email: 'someone@example.com' });
    expect(await cat.auth.authListUsersByEmailNorm('nobody@example.com')).toEqual([]);
  });
});

// owner-bootstrap D3, D6, D7: ownership writes keep at most one owner and change nothing on failure.
describe('AuthStore: team ownership (owner-bootstrap D3, D6, D7)', () => {
  async function team(): Promise<{ studio: string; owner: string; admin: string; member: string }> {
    const cat = catalogFor();
    const studio = await seedStudio();
    const owner = await seedUser();
    const admin = await seedUser();
    const member = await seedUser();
    await cat.auth.authAddMembershipWithRole(owner, studio, 'owner');
    await cat.auth.authAddMembershipWithRole(admin, studio, 'admin');
    await cat.auth.authAddMembershipWithRole(member, studio, 'member');
    return { studio, owner, admin, member };
  }
  async function roles(studio: string): Promise<Record<string, string>> {
    const rows = await catalogFor().auth.authListTeamMembers(studio);
    return Object.fromEntries(rows.map((r) => [r.id, r.role]));
  }

  it('authTransferOwnership makes the target owner and the old owner admin', async () => {
    const t = await team();
    await catalogFor().auth.authTransferOwnership(t.studio, t.owner, t.member);
    expect(await roles(t.studio)).toEqual({
      [t.owner]: 'admin',
      [t.admin]: 'admin',
      [t.member]: 'owner',
    });
  });

  it('authTransferOwnership throws and changes nothing when the target has no membership', async () => {
    const t = await team();
    const before = await roles(t.studio);
    await expect(
      catalogFor().auth.authTransferOwnership(t.studio, t.owner, await seedUser()),
    ).rejects.toThrow();
    expect(await roles(t.studio)).toEqual(before);
  });

  it('authTransferOwnership throws and changes nothing when the source is not the owner', async () => {
    const t = await team();
    const before = await roles(t.studio);
    await expect(
      catalogFor().auth.authTransferOwnership(t.studio, t.admin, t.member),
    ).rejects.toThrow();
    expect(await roles(t.studio)).toEqual(before);
  });

  it('authSetOwner demotes the current owner to admin and makes the target owner', async () => {
    const t = await team();
    await catalogFor().auth.authSetOwner(t.studio, t.member);
    expect(await roles(t.studio)).toEqual({
      [t.owner]: 'admin',
      [t.admin]: 'admin',
      [t.member]: 'owner',
    });
    const outsider = await seedUser();
    await catalogFor().auth.authSetOwner(t.studio, outsider);
    expect((await roles(t.studio))[outsider]).toBe('owner');
    expect((await roles(t.studio))[t.member]).toBe('admin');
  });

  it('authSetOwner on the current owner is a no-op', async () => {
    const t = await team();
    const before = await roles(t.studio);
    await catalogFor().auth.authSetOwner(t.studio, t.owner);
    expect(await roles(t.studio)).toEqual(before);
  });

  it('authClaimOwnerlessStudios claims every ownerless team, leaving owned teams and other roles alone', async () => {
    const cat = catalogFor();
    const owned = await team();
    const ownerless = await seedStudio();
    const otherAdmin = await seedUser();
    await cat.auth.authAddMembershipWithRole(otherAdmin, ownerless, 'admin');
    const memberOf = await seedStudio();
    const claimant = await seedUser();
    await cat.auth.authAddMembershipWithRole(claimant, memberOf, 'member');
    const expected = (
      await env.ports.catalog.all<{ id: string }>(
        `SELECT d.id FROM studio_definitions d WHERE NOT EXISTS (
           SELECT 1 FROM user_studio_memberships m WHERE m.studio_id = d.id AND m.role = 'owner')
         ORDER BY d.id`,
      )
    ).map((r) => r.id);
    expect(expected).toEqual(
      expect.arrayContaining(['test-studios', 'test-studio-2', ownerless, memberOf]),
    );
    const claimed = await cat.auth.authClaimOwnerlessStudios(claimant);
    expect([...claimed].sort()).toEqual(expected);
    expect(claimed).not.toContain(owned.studio);
    for (const sid of expected) {
      expect(await cat.auth.authGetMembershipRole(claimant, sid), sid).toBe('owner');
    }
    expect(await cat.auth.authGetMembershipRole(otherAdmin, ownerless)).toBe('admin');
    expect(await cat.auth.authGetMembershipRole(claimant, owned.studio)).toBeNull();
    expect(await roles(owned.studio)).toEqual({
      [owned.owner]: 'owner',
      [owned.admin]: 'admin',
      [owned.member]: 'member',
    });
    expect(await cat.auth.authClaimOwnerlessStudios(claimant)).toEqual([]);
  });
});

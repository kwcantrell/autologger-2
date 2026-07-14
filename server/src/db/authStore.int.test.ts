// teams-self-serve (design D1/D2): role-aware membership ops + invite storage.
import { describe, expect, it } from 'vitest';
import { catalogFor, seedStudio, seedUser } from '../test/helpers';

describe('AuthStore: role-aware memberships (design D1)', () => {
  it('authAddMembershipWithRole creates with the given role', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser();
    cat.auth.authAddMembershipWithRole(user, studio, 'admin');
    expect(cat.auth.authGetMembershipRole(user, studio)).toBe('admin');
  });

  it('authAddMembershipWithRole is a no-op (role preserved) if already a member', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser();
    cat.auth.authAddMembershipWithRole(user, studio, 'admin');
    cat.auth.authAddMembershipWithRole(user, studio, 'member');
    expect(cat.auth.authGetMembershipRole(user, studio)).toBe('admin');
  });

  it('authUpsertMembershipRole creates the membership when absent', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser();
    expect(cat.auth.authGetMembershipRole(user, studio)).toBeNull();
    cat.auth.authUpsertMembershipRole(user, studio, 'admin');
    expect(cat.auth.authGetMembershipRole(user, studio)).toBe('admin');
  });

  it('authUpsertMembershipRole updates the role when present (promote/demote/rescue)', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser({ studios: [studio] }); // default role from column default: member
    expect(cat.auth.authGetMembershipRole(user, studio)).toBe('member');
    cat.auth.authUpsertMembershipRole(user, studio, 'admin');
    expect(cat.auth.authGetMembershipRole(user, studio)).toBe('admin');
    cat.auth.authUpsertMembershipRole(user, studio, 'member');
    expect(cat.auth.authGetMembershipRole(user, studio)).toBe('member');
  });

  it('authGetMembershipRole returns null for a non-member', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser();
    expect(cat.auth.authGetMembershipRole(user, studio)).toBeNull();
  });

  it('authCountEnabledAdmins counts admins whose accounts are enabled only', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const admin1 = await seedUser();
    const admin2 = await seedUser();
    const disabledAdmin = await seedUser();
    const member = await seedUser();
    cat.auth.authAddMembershipWithRole(admin1, studio, 'admin');
    cat.auth.authAddMembershipWithRole(admin2, studio, 'admin');
    cat.auth.authAddMembershipWithRole(disabledAdmin, studio, 'admin');
    cat.auth.authAddMembershipWithRole(member, studio, 'member');
    cat.auth.authSetUserDisabled(disabledAdmin, true);
    expect(cat.auth.authCountEnabledAdmins(studio)).toBe(2);
  });

  it('authCountEnabledAdmins is 0 for a team with no admins', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const member = await seedUser();
    cat.auth.authAddMembershipWithRole(member, studio, 'member');
    expect(cat.auth.authCountEnabledAdmins(studio)).toBe(0);
  });

  it('authListTeamMembers returns joined user fields + role, admins first', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const admin = await seedUser({ email: 'zz-admin@example.com' });
    const member = await seedUser({ email: 'aa-member@example.com' });
    cat.auth.authAddMembershipWithRole(admin, studio, 'admin');
    cat.auth.authAddMembershipWithRole(member, studio, 'member');
    const rows = cat.auth.authListTeamMembers(studio);
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

  it('authListTeamMembers scopes to the team', async () => {
    const cat = catalogFor();
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const userA = await seedUser();
    const userB = await seedUser();
    cat.auth.authAddMembershipWithRole(userA, studioA, 'admin');
    cat.auth.authAddMembershipWithRole(userB, studioB, 'admin');
    expect(cat.auth.authListTeamMembers(studioA).map((r) => r.id)).toEqual([userA]);
  });
});

describe('AuthStore: email invites (design D2)', () => {
  it('authUpsertInvite + authListInvitesForTeam round-trip', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const inviter = await seedUser();
    cat.auth.authUpsertInvite(studio, 'person@example.com', inviter);
    const rows = cat.auth.authListInvitesForTeam(studio);
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
    cat.auth.authUpsertInvite(studio, 'person@example.com', inviter1);
    cat.auth.authUpsertInvite(studio, 'person@example.com', inviter2);
    const rows = cat.auth.authListInvitesForTeam(studio);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invited_by_user_id).toBe(inviter2); // refreshed on re-invite
  });

  it('authListInvitesForTeam scopes to the team', async () => {
    const cat = catalogFor();
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const inviter = await seedUser();
    cat.auth.authUpsertInvite(studioA, 'a@example.com', inviter);
    cat.auth.authUpsertInvite(studioB, 'b@example.com', inviter);
    expect(cat.auth.authListInvitesForTeam(studioA).map((r) => r.email_norm)).toEqual([
      'a@example.com',
    ]);
  });

  it('authDeleteInvite removes the row and reports changes; idempotent on a second call', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const inviter = await seedUser();
    cat.auth.authUpsertInvite(studio, 'person@example.com', inviter);
    expect(cat.auth.authDeleteInvite(studio, 'person@example.com')).toBe(1);
    expect(cat.auth.authListInvitesForTeam(studio)).toHaveLength(0);
    expect(cat.auth.authDeleteInvite(studio, 'person@example.com')).toBe(0); // idempotent
  });

  it('authCountPendingInvites counts per team', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const inviter = await seedUser();
    cat.auth.authUpsertInvite(studio, 'a@example.com', inviter);
    cat.auth.authUpsertInvite(studio, 'b@example.com', inviter);
    expect(cat.auth.authCountPendingInvites(studio)).toBe(2);
  });

  it('authDeleteAllInvitesForTeam cascades every invite for a team, leaves other teams alone', async () => {
    const cat = catalogFor();
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const inviter = await seedUser();
    cat.auth.authUpsertInvite(studioA, 'a@example.com', inviter);
    cat.auth.authUpsertInvite(studioA, 'b@example.com', inviter);
    cat.auth.authUpsertInvite(studioB, 'c@example.com', inviter);
    cat.auth.authDeleteAllInvitesForTeam(studioA);
    expect(cat.auth.authCountPendingInvites(studioA)).toBe(0);
    expect(cat.auth.authCountPendingInvites(studioB)).toBe(1);
  });

  it('authConsumeInvitesForEmail selects+deletes every invite for a normalized email across teams', async () => {
    const cat = catalogFor();
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const inviter = await seedUser();
    cat.auth.authUpsertInvite(studioA, 'new.person@example.com', inviter);
    cat.auth.authUpsertInvite(studioB, 'new.person@example.com', inviter);
    cat.auth.authUpsertInvite(studioA, 'someone.else@example.com', inviter);

    const consumed = cat.auth.authConsumeInvitesForEmail('new.person@example.com');
    expect(consumed.map((r) => r.studio_id).sort()).toEqual([studioA, studioB].sort());
    expect(cat.auth.authListInvitesForTeam(studioA).map((r) => r.email_norm)).toEqual([
      'someone.else@example.com',
    ]);
    expect(cat.auth.authListInvitesForTeam(studioB)).toHaveLength(0);
  });

  it('authConsumeInvitesForEmail returns [] and deletes nothing when no invite matches', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const inviter = await seedUser();
    cat.auth.authUpsertInvite(studio, 'a@example.com', inviter);
    expect(cat.auth.authConsumeInvitesForEmail('nobody@example.com')).toEqual([]);
    expect(cat.auth.authCountPendingInvites(studio)).toBe(1);
  });

  it('authConsumeInvitesForEmail composes inside an outer catalog.tx() (materialization boundary)', async () => {
    // The router materializes invites inside one ports.catalog.tx(...) alongside
    // user creation; authConsumeInvitesForEmail must not open its own nested
    // transaction that would conflict with that boundary.
    const cat = catalogFor();
    const studio = await seedStudio();
    const inviter = await seedUser();
    const newUser = await seedUser();
    cat.auth.authUpsertInvite(studio, 'new.person@example.com', inviter);

    const db = (cat.auth as unknown as { db: { tx<T>(fn: () => T): T } }).db;
    const consumed = db.tx(() => {
      const rows = cat.auth.authConsumeInvitesForEmail('new.person@example.com');
      cat.auth.authAddMembershipWithRole(newUser, studio, 'member');
      return rows;
    });
    expect(consumed).toHaveLength(1);
    expect(cat.auth.authListInvitesForTeam(studio)).toHaveLength(0);
  });
});

describe('AuthStore: user lookup by normalized email (design D2 multi-match)', () => {
  it('authListUsersByEmailNorm matches case/whitespace-insensitively via JS normalization', async () => {
    const cat = catalogFor();
    const user = await seedUser({ email: 'Some.Person@Example.com' });
    const matches = cat.auth.authListUsersByEmailNorm('some.person@example.com');
    expect(matches.map((r) => r.id)).toEqual([user]);
  });

  it('authListUsersByEmailNorm returns ALL matching rows, including disabled accounts', async () => {
    const cat = catalogFor();
    const user1 = await seedUser({ email: 'dup@example.com' });
    const user2 = await seedUser({ email: 'dup@example.com' });
    cat.auth.authSetUserDisabled(user2, true);
    const matches = cat.auth.authListUsersByEmailNorm('dup@example.com');
    expect(matches.map((r) => r.id).sort()).toEqual([user1, user2].sort());
  });

  it('authListUsersByEmailNorm returns [] when no user matches', async () => {
    const cat = catalogFor();
    await seedUser({ email: 'someone@example.com' });
    expect(cat.auth.authListUsersByEmailNorm('nobody@example.com')).toEqual([]);
  });
});

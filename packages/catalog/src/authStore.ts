// Users, studio memberships, per-user prefs, and admin user operations.
// Moved verbatim out of catalog.ts (Catalog). Self-contained on this.db.

import type { Row } from '@autologger/domain';
import { normalizeEmail, nowIso } from '@autologger/domain';
import type { CatalogDb } from '@autologger/ports';

export type TeamRole = 'admin' | 'member';

/** Consumption-based facade surface (persistence-package-extraction design D3):
 * the 29 members reached externally via `catalog.auth.x()` in `server/src`
 * (routers + `test/helpers.ts`) — every public `AuthStore` method except
 * `authListMembershipsForUser`, which is consumed only internally (by
 * `profileAssembler.ts`, same package, against the concrete class) and so is
 * NOT part of the externally-reached surface per the membership criterion.
 * Property-style function types (design D3 — contravariant `implements`
 * checking under `strictFunctionTypes`). */
export interface AuthStoreFacade {
  authGetUserByGoogleSub: (googleSub: string) => Row | null;
  authGetUserByGoogleSubAny: (googleSub: string) => Row | null;
  authGetUserById: (userId: string) => Row | null;
  authCreateUserGoogle: (opts: {
    googleSub: string;
    email: string;
    givenName: string;
    familyName: string;
    pictureUrl: string;
  }) => string;
  authUpdateUserProfile: (
    userId: string,
    fields: { email?: string; givenName?: string; familyName?: string; pictureUrl?: string },
  ) => boolean;
  authUpdateUserNames: (userId: string, givenName: string, familyName: string) => boolean;
  authUserHasStudio: (userId: string, studioId: string) => boolean;
  authListStudioIdsForUser: (userId: string) => string[];
  authAddMemberships: (userId: string, studioIds: string[]) => void;
  authGetPrefs: (userId: string) => Row | null;
  authEnsurePrefsRow: (userId: string) => void;
  authSetPrefs: (userId: string, activeStudioId: string, activeShowId: string) => void;
  authSeedPrefsFromGlobals: (userId: string, activeStudioId: string, activeShowId: string) => void;
  authListUsersAdmin: () => Row[];
  authGetUserRowAny: (userId: string) => Row | null;
  authSetUserDisabled: (userId: string, disabled: boolean) => void;
  authRemoveMembership: (userId: string, studioId: string) => boolean;
  authAddMembershipWithRole: (userId: string, studioId: string, role: TeamRole) => void;
  authUpsertMembershipRole: (userId: string, studioId: string, role: TeamRole) => void;
  authCountAdminTeams: (userId: string, excludeStudioIds: string[]) => number;
  authGetMembershipRole: (userId: string, studioId: string) => TeamRole | null;
  authCountEnabledAdmins: (studioId: string) => number;
  authListTeamMembers: (studioId: string) => Array<{
    id: string;
    email: string;
    given_name: string;
    family_name: string;
    role: TeamRole;
  }>;
  authUpsertInvite: (studioId: string, emailNorm: string, invitedByUserId: string) => void;
  authListInvitesForTeam: (studioId: string) => Row[];
  authDeleteInvite: (studioId: string, emailNorm: string) => number;
  authCountPendingInvites: (studioId: string) => number;
  authConsumeInvitesForEmail: (emailNorm: string) => Row[];
  authListUsersByEmailNorm: (emailNorm: string) => Row[];
}

export class AuthStore implements AuthStoreFacade {
  constructor(private db: CatalogDb) {}

  authGetUserByGoogleSub(googleSub: string): Row | null {
    return this.db.first<Row>(
      'SELECT * FROM users WHERE google_sub = ? AND disabled_at_utc IS NULL',
      googleSub,
    );
  }

  /** Fetch a user row by Google sub, INCLUDING disabled accounts (design D11) —
   * the OAuth callback resolves the sub against ALL rows before the
   * existing/new split so a disabled match can redirect (account_disabled)
   * instead of falling into the new-user branch and tripping the unique
   * `google_sub` constraint (the former latent 500). */
  authGetUserByGoogleSubAny(googleSub: string): Row | null {
    return this.db.first<Row>('SELECT * FROM users WHERE google_sub = ?', googleSub);
  }

  authGetUserById(userId: string): Row | null {
    return this.db.first<Row>(
      'SELECT * FROM users WHERE id = ? AND disabled_at_utc IS NULL',
      userId,
    );
  }

  authCreateUserGoogle(opts: {
    googleSub: string;
    email: string;
    givenName: string;
    familyName: string;
    pictureUrl: string;
  }): string {
    const uid = crypto.randomUUID();
    this.db.run(
      `INSERT INTO users (id, google_sub, email, given_name, family_name, picture_url, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      uid,
      opts.googleSub,
      opts.email,
      opts.givenName,
      opts.familyName,
      opts.pictureUrl,
      nowIso(),
    );
    return uid;
  }

  authUpdateUserProfile(
    userId: string,
    fields: { email?: string; givenName?: string; familyName?: string; pictureUrl?: string },
  ): boolean {
    // Read-modify-write: the merge reads the current row, so the pair runs in
    // one transaction (CatalogDb.tx nests as a savepoint under outer tx()).
    return this.db.tx(() => {
      const row = this.authGetUserById(userId);
      if (row === null) return false;
      const em = fields.email ?? String(row.email);
      const gn = fields.givenName ?? String(row.given_name);
      const fn = fields.familyName ?? String(row.family_name);
      const pic = fields.pictureUrl ?? String(row.picture_url);
      this.db.run(
        'UPDATE users SET email = ?, given_name = ?, family_name = ?, picture_url = ? WHERE id = ?',
        em,
        gn,
        fn,
        pic,
        userId,
      );
      return true;
    });
  }

  authUpdateUserNames(userId: string, givenName: string, familyName: string): boolean {
    return this.authUpdateUserProfile(userId, { givenName, familyName });
  }

  authUserHasStudio(userId: string, studioId: string): boolean {
    const row = this.db.first<Row>(
      'SELECT 1 FROM user_studio_memberships WHERE user_id = ? AND studio_id = ?',
      userId,
      studioId,
    );
    return row !== null;
  }

  authListStudioIdsForUser(userId: string): string[] {
    const results = this.db.all<Row>(
      'SELECT studio_id FROM user_studio_memberships WHERE user_id = ? ORDER BY studio_id',
      userId,
    );
    return results.map((r) => String(r.studio_id));
  }

  /** All (studio_id, role) pairs for a user, one query — the profile assembler's
   * `auth.user.teams[].role` field (teams-self-serve) needs role alongside id/name
   * without an N+1 over authGetMembershipRole per team. */
  authListMembershipsForUser(userId: string): Array<{ studioId: string; role: TeamRole }> {
    const results = this.db.all<Row>(
      'SELECT studio_id, role FROM user_studio_memberships WHERE user_id = ? ORDER BY studio_id',
      userId,
    );
    return results.map((r) => ({
      studioId: String(r.studio_id),
      role: String(r.role) as TeamRole,
    }));
  }

  authAddMemberships(userId: string, studioIds: string[]): void {
    const ids = studioIds.filter((sid) => sid);
    if (!ids.length) return;
    this.db.tx(() => {
      for (const sid of ids) {
        this.db.run(
          'INSERT OR IGNORE INTO user_studio_memberships (user_id, studio_id) VALUES (?, ?)',
          userId,
          sid,
        );
      }
    });
  }

  authGetPrefs(userId: string): Row | null {
    return this.db.first<Row>('SELECT * FROM user_prefs WHERE user_id = ?', userId);
  }

  authEnsurePrefsRow(userId: string): void {
    const row = this.db.first<Row>('SELECT 1 FROM user_prefs WHERE user_id = ?', userId);
    if (row === null) {
      this.db.run(
        "INSERT INTO user_prefs (user_id, active_studio_id, active_show_id) VALUES (?, '', '')",
        userId,
      );
    }
  }

  authSetPrefs(userId: string, activeStudioId: string, activeShowId: string): void {
    // Single upsert (user_prefs has no other columns to preserve), replacing
    // the former ensure-row + UPDATE pair — same authUpsertMembershipRole idiom.
    this.db.run(
      `INSERT INTO user_prefs (user_id, active_studio_id, active_show_id) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         active_studio_id = excluded.active_studio_id,
         active_show_id = excluded.active_show_id`,
      userId,
      activeStudioId,
      activeShowId,
    );
  }

  authSeedPrefsFromGlobals(userId: string, activeStudioId: string, activeShowId: string): void {
    const row = this.authGetPrefs(userId);
    if (row !== null && String(row.active_studio_id ?? '').trim()) return;
    this.authEnsurePrefsRow(userId);
    this.authSetPrefs(userId, activeStudioId, activeShowId);
  }

  // -- admin: users ------------------------------------------------------------

  authListUsersAdmin(): Row[] {
    return this.db.all<Row>(
      `SELECT id, google_sub, email, given_name, family_name, picture_url,
              created_at_utc, disabled_at_utc
       FROM users ORDER BY created_at_utc DESC`,
    );
  }

  /** Fetch a user row including disabled accounts (admin). */
  authGetUserRowAny(userId: string): Row | null {
    return this.db.first<Row>('SELECT * FROM users WHERE id = ?', userId);
  }

  authSetUserDisabled(userId: string, disabled: boolean): void {
    if (disabled) {
      this.db.run('UPDATE users SET disabled_at_utc = ? WHERE id = ?', nowIso(), userId);
    } else {
      this.db.run('UPDATE users SET disabled_at_utc = NULL WHERE id = ?', userId);
    }
  }

  authRemoveMembership(userId: string, studioId: string): boolean {
    const res = this.db.run(
      'DELETE FROM user_studio_memberships WHERE user_id = ? AND studio_id = ?',
      userId,
      studioId,
    );
    return res.changes > 0;
  }

  // -- teams-self-serve: role-aware memberships (design D1) --------------------

  /** Create a membership with an explicit role. No-op (role preserved) if the
   * membership already exists — used by team creation (never conflicts) and
   * invite grants (an existing member is left untouched, per D2). */
  authAddMembershipWithRole(userId: string, studioId: string, role: TeamRole): void {
    this.db.run(
      'INSERT OR IGNORE INTO user_studio_memberships (user_id, studio_id, role) VALUES (?, ?, ?)',
      userId,
      studioId,
      role,
    );
  }

  /** Insert-or-update a membership's role: creates the membership if absent,
   * otherwise updates its role. Used by the admin rescue path (support-plane
   * add-membership with an explicit role) and promote/demote. */
  authUpsertMembershipRole(userId: string, studioId: string, role: TeamRole): void {
    this.db.run(
      `INSERT INTO user_studio_memberships (user_id, studio_id, role) VALUES (?, ?, ?)
       ON CONFLICT (user_id, studio_id) DO UPDATE SET role = excluded.role`,
      userId,
      studioId,
      role,
    );
  }

  /** Count of teams the user admins, excluding the given studio ids (the
   * built-ins) — a single indexed query for the self-serve creation cap
   * (phase-2 review: avoids an N+1 over every membership the user holds). */
  authCountAdminTeams(userId: string, excludeStudioIds: string[]): number {
    const placeholders = excludeStudioIds.map(() => '?').join(', ');
    const exclude = excludeStudioIds.length > 0 ? `AND studio_id NOT IN (${placeholders})` : '';
    const row = this.db.first<Row>(
      `SELECT COUNT(*) AS n FROM user_studio_memberships
       WHERE user_id = ? AND role = 'admin' ${exclude}`,
      userId,
      ...excludeStudioIds,
    );
    return Number(row?.n ?? 0);
  }

  /** Role of (user, team), or null if no membership. */
  authGetMembershipRole(userId: string, studioId: string): TeamRole | null {
    const row = this.db.first<Row>(
      'SELECT role FROM user_studio_memberships WHERE user_id = ? AND studio_id = ?',
      userId,
      studioId,
    );
    return row === null ? null : (String(row.role) as TeamRole);
  }

  /** Count of ENABLED admins for a team — the last-admin-protection invariant is
   * over enabled admins only (a disabled admin row must not satisfy it). */
  authCountEnabledAdmins(studioId: string): number {
    const row = this.db.first<Row>(
      `SELECT COUNT(*) AS n
       FROM user_studio_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.studio_id = ? AND m.role = 'admin' AND u.disabled_at_utc IS NULL`,
      studioId,
    );
    return Number(row?.n ?? 0);
  }

  /** Members of a team joined with user fields, for the team detail endpoint. */
  authListTeamMembers(
    studioId: string,
  ): Array<{ id: string; email: string; given_name: string; family_name: string; role: TeamRole }> {
    const rows = this.db.all<Row>(
      `SELECT u.id AS id, u.email AS email, u.given_name AS given_name,
              u.family_name AS family_name, m.role AS role
       FROM user_studio_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.studio_id = ?
       ORDER BY m.role ASC, u.email ASC`,
      studioId,
    );
    return rows.map((r) => ({
      id: String(r.id),
      email: String(r.email),
      given_name: String(r.given_name),
      family_name: String(r.family_name),
      role: String(r.role) as TeamRole,
    }));
  }

  // -- teams-self-serve: email invites (design D2) ------------------------------
  // emailNorm is always pre-normalized by the caller (JS toLowerCase().trim());
  // these methods never apply SQL lower() — see 0004_team_roles_and_invites.sql.

  /** Idempotent upsert of a pending invite (one row per team+email; re-inviting
   * refreshes invited_by/invited_at). */
  authUpsertInvite(studioId: string, emailNorm: string, invitedByUserId: string): void {
    this.db.run(
      `INSERT INTO team_invites (studio_id, email_norm, invited_by_user_id, invited_at_utc)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (studio_id, email_norm) DO UPDATE SET
         invited_by_user_id = excluded.invited_by_user_id,
         invited_at_utc = excluded.invited_at_utc`,
      studioId,
      emailNorm,
      invitedByUserId,
      nowIso(),
    );
  }

  /** Pending invites for a team, for the admin-only pending-invite list. */
  authListInvitesForTeam(studioId: string): Row[] {
    return this.db.all<Row>(
      'SELECT * FROM team_invites WHERE studio_id = ? ORDER BY email_norm ASC',
      studioId,
    );
  }

  /** Delete one invite (idempotent — returns whether a row was actually removed). */
  authDeleteInvite(studioId: string, emailNorm: string): number {
    return this.db.run(
      'DELETE FROM team_invites WHERE studio_id = ? AND email_norm = ?',
      studioId,
      emailNorm,
    ).changes;
  }

  /** Count of pending invites for a team, for the 200-per-team cap. */
  authCountPendingInvites(studioId: string): number {
    const row = this.db.first<Row>(
      'SELECT COUNT(*) AS n FROM team_invites WHERE studio_id = ?',
      studioId,
    );
    return Number(row?.n ?? 0);
  }

  /** Sign-in materialization consumer: select then delete every pending invite
   * for a normalized email, returning the consumed rows (their studio_ids are
   * what the caller grants membership to). Plain synchronous statements — no
   * internal tx() — so it composes inside the router's outer catalog.tx(...). */
  authConsumeInvitesForEmail(emailNorm: string): Row[] {
    const rows = this.db.all<Row>('SELECT * FROM team_invites WHERE email_norm = ?', emailNorm);
    if (rows.length > 0) {
      this.db.run('DELETE FROM team_invites WHERE email_norm = ?', emailNorm);
    }
    return rows;
  }

  // -- teams-self-serve: user lookup by email (design D2 multi-match) ----------

  /** ALL user rows whose email of record normalizes to emailNorm, INCLUDING
   * disabled accounts (unlike authGetUserByGoogleSub, which filters disabled) —
   * membership is inert while disabled, and invite-matching must still see them
   * (D2). Matching is done in JS (never SQL lower()), same as invite/sign-in
   * normalization. */
  authListUsersByEmailNorm(emailNorm: string): Row[] {
    return this.db
      .all<Row>('SELECT * FROM users')
      .filter((u) => normalizeEmail(String(u.email)) === emailNorm);
  }
}

// Users, studio memberships, per-user prefs, and admin user operations.
// Moved verbatim out of catalog.ts (Catalog). Self-contained on this.db.

import type { Row } from '@autologger/domain';
import { normalizeEmail, nowIso } from '@autologger/domain';
import type { CatalogDb } from '@autologger/ports';

/** Team roles (owner-bootstrap D1): at most one `owner` per team, enforced by the database. */
export type TeamRole = 'owner' | 'admin' | 'member';

/** Consumption-based facade surface (persistence-package-extraction design D3):
 * the members reached externally via `catalog.auth.x()` in `server/src`
 * (routers + `test/helpers.ts`) — every public `AuthStore` method except
 * `authListMembershipsForUser`, which is consumed only internally (by
 * `profileAssembler.ts`, same package, against the concrete class) and so is
 * NOT part of the externally-reached surface per the membership criterion.
 * Property-style function types (design D3 — contravariant `implements`
 * checking under `strictFunctionTypes`). */
export interface AuthStoreFacade {
  authGetUserByGoogleSub: (googleSub: string) => Promise<Row | null>;
  authGetUserByGoogleSubAny: (googleSub: string) => Promise<Row | null>;
  authGetUserById: (userId: string) => Promise<Row | null>;
  authCreateUserGoogle: (opts: {
    id: string;
    googleSub: string;
    email: string;
    givenName: string;
    familyName: string;
    pictureUrl: string;
  }) => Promise<string | null>;
  authUpdateUserProfile: (
    userId: string,
    fields: { email?: string; givenName?: string; familyName?: string; pictureUrl?: string },
  ) => Promise<boolean>;
  authUpdateUserNames: (userId: string, givenName: string, familyName: string) => Promise<boolean>;
  authUserHasStudio: (userId: string, studioId: string) => Promise<boolean>;
  authListStudioIdsForUser: (userId: string) => Promise<string[]>;
  authAddMemberships: (userId: string, studioIds: string[]) => Promise<void>;
  authGetPrefs: (userId: string) => Promise<Row | null>;
  authEnsurePrefsRow: (userId: string) => Promise<void>;
  authSetPrefs: (userId: string, activeStudioId: string, activeShowId: string) => Promise<void>;
  authListUsersAdmin: () => Promise<Row[]>;
  authGetUserRowAny: (userId: string) => Promise<Row | null>;
  authSetUserDisabled: (userId: string, disabled: boolean) => Promise<void>;
  authRemoveMembership: (userId: string, studioId: string) => Promise<boolean>;
  authAddMembershipWithRole: (userId: string, studioId: string, role: TeamRole) => Promise<void>;
  authUpsertMembershipRole: (userId: string, studioId: string, role: TeamRole) => Promise<void>;
  authCountOwnedTeams: (userId: string) => Promise<number>;
  authTransferOwnership: (studioId: string, fromUserId: string, toUserId: string) => Promise<void>;
  authSetOwner: (studioId: string, userId: string) => Promise<void>;
  authClaimOwnerlessStudios: (userId: string) => Promise<string[]>;
  authGetMembershipRole: (userId: string, studioId: string) => Promise<TeamRole | null>;
  authGetMembershipRoleForShare: (userId: string, studioId: string) => Promise<TeamRole | null>;
  authReplaceActiveShowIf: (
    userId: string,
    studioId: string,
    expected: string | null,
    next: string,
  ) => Promise<void>;
  authSetExistingMembershipRole: (
    userId: string,
    studioId: string,
    role: TeamRole,
  ) => Promise<boolean>;
  authCountEnabledAdmins: (studioId: string) => Promise<number>;
  authListTeamMembers: (studioId: string) => Promise<Array<{
    id: string;
    email: string;
    given_name: string;
    family_name: string;
    role: TeamRole;
  }>>;
  authUpsertInvite: (studioId: string, emailNorm: string, invitedByUserId: string) => Promise<void>;
  authListInvitesForTeam: (studioId: string) => Promise<Row[]>;
  authDeleteInvite: (studioId: string, emailNorm: string) => Promise<number>;
  authCountPendingInvites: (studioId: string) => Promise<number>;
  authConsumeInvitesForEmail: (emailNorm: string) => Promise<Row[]>;
  authListUsersByEmailNorm: (emailNorm: string) => Promise<Row[]>;
  // show-grants D2: the access rule and the grant store.
  authCanAccessShow: (userId: string, showId: string) => Promise<boolean>;
  authCanAccessShowForShare: (userId: string, showId: string) => Promise<boolean>;
  authListAccessibleShowIds: (userId: string) => Promise<Set<string>>;
  authListShowGrants: (showId: string) => Promise<Row[]>;
  authListShowGrantsInStudio: (
    studioId: string,
  ) => Promise<Array<{ user_id: string; show_id: string }>>;
  authGrantShow: (
    userId: string,
    showId: string,
    grantedByUserId: string,
    grantedAtUtc: string,
  ) => Promise<void>;
  authRevokeShow: (userId: string, showId: string) => Promise<number>;
  authRevokeGrantsInStudio: (userId: string, studioId: string) => Promise<number>;
}

/** The show access rule (show-grants D2), as one SQL predicate over a show `s` joined to the
 * caller's membership `m` in the show's team: an owner or admin reaches every show of the team, a
 * member only a show they hold a grant for. A non-member has no `m` row, so no access, whatever
 * grant rows exist. Slice 6b copies this predicate into a policy (design D17). */
const SHOW_ACCESS_PREDICATE = `(m.role IN ('owner', 'admin')
       OR EXISTS (SELECT 1 FROM show_grants g WHERE g.user_id = m.user_id AND g.show_id = s.id))`;

export class AuthStore implements AuthStoreFacade {
  constructor(private db: CatalogDb) {}

  /** The same store over another handle, so a transaction body runs on it
   * (async-catalog-stores D3). */
  withDb(db: CatalogDb): AuthStore {
    return new AuthStore(db);
  }

  async authGetUserByGoogleSub(googleSub: string): Promise<Row | null> {
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
  async authGetUserByGoogleSubAny(googleSub: string): Promise<Row | null> {
    return this.db.first<Row>('SELECT * FROM users WHERE google_sub = ?', googleSub);
  }

  async authGetUserById(userId: string): Promise<Row | null> {
    return this.db.first<Row>(
      'SELECT * FROM users WHERE id = ? AND disabled_at_utc IS NULL',
      userId,
    );
  }

  async authCreateUserGoogle(opts: {
    id: string;
    googleSub: string;
    email: string;
    givenName: string;
    familyName: string;
    pictureUrl: string;
  }): Promise<string | null> {
    // null when a user with this id or Google subject already exists: a concurrent first sign-in
    // won (catalog-concurrency-hazards D5), or the id belongs to another account; the caller
    // re-reads by subject. No conflict target, so a clash on either key is never a 23505
    // (gotrue-sign-in D4: the id is the Supabase Auth user id, shared by racing sign-ins).
    const row = await this.db.first<Row>(
      `INSERT INTO users (id, google_sub, email, given_name, family_name, picture_url, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      opts.id,
      opts.googleSub,
      opts.email,
      opts.givenName,
      opts.familyName,
      opts.pictureUrl,
      nowIso(),
    );
    return row === null ? null : String(row.id);
  }

  async authUpdateUserProfile(
    userId: string,
    fields: { email?: string; givenName?: string; familyName?: string; pictureUrl?: string },
  ): Promise<boolean> {
    // Read-modify-write: the merge reads the current row, so the pair runs in
    // one transaction (joins an enclosing one; async-catalog-stores D3).
    return this.db.tx(async (t) => {
      const row = await this.withDb(t).authGetUserById(userId);
      if (row === null) return false;
      const em = fields.email ?? String(row.email);
      const gn = fields.givenName ?? String(row.given_name);
      const fn = fields.familyName ?? String(row.family_name);
      const pic = fields.pictureUrl ?? String(row.picture_url);
      await t.run(
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

  async authUpdateUserNames(userId: string, givenName: string, familyName: string): Promise<boolean> {
    return this.authUpdateUserProfile(userId, { givenName, familyName });
  }

  async authUserHasStudio(userId: string, studioId: string): Promise<boolean> {
    const row = await this.db.first<Row>(
      'SELECT 1 FROM user_studio_memberships WHERE user_id = ? AND studio_id = ?',
      userId,
      studioId,
    );
    return row !== null;
  }

  async authListStudioIdsForUser(userId: string): Promise<string[]> {
    const results = await this.db.all<Row>(
      'SELECT studio_id FROM user_studio_memberships WHERE user_id = ? ORDER BY studio_id',
      userId,
    );
    return results.map((r) => String(r.studio_id));
  }

  /** All (studio_id, role) pairs for a user, one query — the profile assembler's
   * `auth.user.teams[].role` field (teams-self-serve) needs role alongside id/name
   * without an N+1 over authGetMembershipRole per team. */
  async authListMembershipsForUser(userId: string): Promise<Array<{ studioId: string; role: TeamRole }>> {
    const results = await this.db.all<Row>(
      'SELECT studio_id, role FROM user_studio_memberships WHERE user_id = ? ORDER BY studio_id',
      userId,
    );
    return results.map((r) => ({
      studioId: String(r.studio_id),
      role: String(r.role) as TeamRole,
    }));
  }

  async authAddMemberships(userId: string, studioIds: string[]): Promise<void> {
    const ids = studioIds.filter((sid) => sid);
    if (!ids.length) return;
    await this.db.tx(async (t) => {
      for (const sid of ids) {
        await t.run(
          'INSERT INTO user_studio_memberships (user_id, studio_id) VALUES (?, ?) ON CONFLICT DO NOTHING',
          userId,
          sid,
        );
      }
    });
  }

  async authGetPrefs(userId: string): Promise<Row | null> {
    return this.db.first<Row>('SELECT * FROM user_prefs WHERE user_id = ?', userId);
  }

  async authEnsurePrefsRow(userId: string): Promise<void> {
    // Check and insert share one transaction (async-catalog-stores D2).
    await this.db.tx(async (t) => {
      const row = await t.first<Row>('SELECT 1 FROM user_prefs WHERE user_id = ?', userId);
      if (row === null) {
        await t.run(
          "INSERT INTO user_prefs (user_id, active_studio_id, active_show_id) VALUES (?, '', '')",
          userId,
        );
      }
    });
  }

  async authSetPrefs(userId: string, activeStudioId: string, activeShowId: string): Promise<void> {
    // Single upsert (user_prefs has no other columns to preserve), replacing
    // the former ensure-row + UPDATE pair — same authUpsertMembershipRole idiom.
    await this.db.run(
      `INSERT INTO user_prefs (user_id, active_studio_id, active_show_id) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         active_studio_id = excluded.active_studio_id,
         active_show_id = excluded.active_show_id`,
      userId,
      activeStudioId,
      activeShowId,
    );
  }

  /** Repair the active show only if it is still `expected` (the value the caller read), creating
   * the row with `studioId` if it is missing; the studio column is never touched, so a concurrent
   * profile update wins (catalog-concurrency-hazards D8). Postgres only. */
  async authReplaceActiveShowIf(
    userId: string,
    studioId: string,
    expected: string | null,
    next: string,
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO user_prefs (user_id, active_studio_id, active_show_id) VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET active_show_id = excluded.active_show_id
       WHERE user_prefs.active_show_id IS NOT DISTINCT FROM ?`,
      userId,
      studioId,
      next,
      expected,
    );
  }

  // -- admin: users ------------------------------------------------------------

  async authListUsersAdmin(): Promise<Row[]> {
    return this.db.all<Row>(
      `SELECT id, google_sub, email, given_name, family_name, picture_url,
              created_at_utc, disabled_at_utc
       FROM users ORDER BY created_at_utc DESC`,
    );
  }

  /** Fetch a user row including disabled accounts (admin). */
  async authGetUserRowAny(userId: string): Promise<Row | null> {
    return this.db.first<Row>('SELECT * FROM users WHERE id = ?', userId);
  }

  async authSetUserDisabled(userId: string, disabled: boolean): Promise<void> {
    if (disabled) {
      await this.db.run('UPDATE users SET disabled_at_utc = ? WHERE id = ?', nowIso(), userId);
    } else {
      await this.db.run('UPDATE users SET disabled_at_utc = NULL WHERE id = ?', userId);
    }
  }

  /** Delete a membership and, in the same transaction (which joins a caller's), the member's show
   * grants in that team, so no grant outlives its membership (show-grants D2). Every membership
   * delete goes through here: team remove, team leave and the support plane. */
  async authRemoveMembership(userId: string, studioId: string): Promise<boolean> {
    return this.db.tx(async (t) => {
      await this.withDb(t).authRevokeGrantsInStudio(userId, studioId);
      const res = await t.run(
        'DELETE FROM user_studio_memberships WHERE user_id = ? AND studio_id = ?',
        userId,
        studioId,
      );
      return res.changes > 0;
    });
  }

  // -- teams-self-serve: role-aware memberships (design D1) --------------------

  /** Create a membership with an explicit role. No-op (role preserved) if the
   * membership already exists — used by team creation (never conflicts) and
   * invite grants (an existing member is left untouched, per D2). */
  async authAddMembershipWithRole(userId: string, studioId: string, role: TeamRole): Promise<void> {
    await this.db.run(
      'INSERT INTO user_studio_memberships (user_id, studio_id, role) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      userId,
      studioId,
      role,
    );
  }

  /** Insert-or-update a membership's role: creates the membership if absent,
   * otherwise updates its role. Used by the admin rescue path (support-plane
   * add-membership with an explicit role) and promote/demote. */
  async authUpsertMembershipRole(userId: string, studioId: string, role: TeamRole): Promise<void> {
    await this.db.run(
      `INSERT INTO user_studio_memberships (user_id, studio_id, role) VALUES (?, ?, ?)
       ON CONFLICT (user_id, studio_id) DO UPDATE SET role = excluded.role`,
      userId,
      studioId,
      role,
    );
  }

  /** Change the role of an existing membership only; false when there is none, so a raced
   * removal is never undone by a role change (catalog-concurrency-hazards D2). */
  async authSetExistingMembershipRole(
    userId: string,
    studioId: string,
    role: TeamRole,
  ): Promise<boolean> {
    const res = await this.db.run(
      'UPDATE user_studio_memberships SET role = ? WHERE user_id = ? AND studio_id = ?',
      role,
      userId,
      studioId,
    );
    return res.changes > 0;
  }

  /** Count of teams the user owns — a single indexed query for the self-serve creation cap
   * (owner-bootstrap D5). */
  async authCountOwnedTeams(userId: string): Promise<number> {
    const row = await this.db.first<Row>(
      `SELECT COUNT(*) AS n FROM user_studio_memberships WHERE user_id = ? AND role = 'owner'`,
      userId,
    );
    return Number(row?.n ?? 0);
  }

  /** Hand a team's ownership from its owner to an existing member, who becomes owner while the
   * old owner becomes admin, in one transaction (owner-bootstrap D3). Demote first: the one-owner
   * index is checked row by row, so promoting first would collide with the old owner's row. Throws
   * (rolling back) when the source is not the owner or the target has no membership. */
  async authTransferOwnership(studioId: string, fromUserId: string, toUserId: string): Promise<void> {
    await this.db.tx(async (t) => {
      const demoted = await t.run(
        `UPDATE user_studio_memberships SET role = 'admin'
         WHERE studio_id = ? AND user_id = ? AND role = 'owner'`,
        studioId,
        fromUserId,
      );
      if (demoted.changes === 0) throw new Error('ownership transfer: the source is not the owner');
      const promoted = await t.run(
        `UPDATE user_studio_memberships SET role = 'owner' WHERE studio_id = ? AND user_id = ?`,
        studioId,
        toUserId,
      );
      if (promoted.changes === 0) throw new Error('ownership transfer: the target is not a member');
    });
  }

  /** Make `userId` the team's owner, demoting any other current owner to admin, in one
   * transaction (owner-bootstrap D6, the support plane's owner upsert). A no-op for the current
   * owner. */
  async authSetOwner(studioId: string, userId: string): Promise<void> {
    await this.db.tx(async (t) => {
      await t.run(
        `UPDATE user_studio_memberships SET role = 'admin'
         WHERE studio_id = ? AND role = 'owner' AND user_id <> ?`,
        studioId,
        userId,
      );
      await this.withDb(t).authUpsertMembershipRole(userId, studioId, 'owner');
    });
  }

  /** The bootstrap claim (owner-bootstrap D7): make `userId` owner of every team that has no
   * owner, inserting or upgrading only the claimant's rows, so other members keep their roles.
   * Returns the claimed team ids. */
  async authClaimOwnerlessStudios(userId: string): Promise<string[]> {
    const rows = await this.db.all<Row>(
      `INSERT INTO user_studio_memberships (user_id, studio_id, role)
       SELECT ?, d.id, 'owner' FROM studio_definitions d
       WHERE NOT EXISTS (SELECT 1 FROM user_studio_memberships m
                         WHERE m.studio_id = d.id AND m.role = 'owner')
       ON CONFLICT (user_id, studio_id) DO UPDATE SET role = 'owner'
       RETURNING studio_id`,
      userId,
    );
    return rows.map((r) => String(r.studio_id));
  }

  /** Role of (user, team), or null if no membership. */
  async authGetMembershipRole(userId: string, studioId: string): Promise<TeamRole | null> {
    const row = await this.db.first<Row>(
      'SELECT role FROM user_studio_memberships WHERE user_id = ? AND studio_id = ?',
      userId,
      studioId,
    );
    return row === null ? null : (String(row.role) as TeamRole);
  }

  /** Role of (user, team), or null, with the membership row locked for share until the
   * transaction ends: a concurrent demotion or removal waits for it, and one that already
   * committed fails it with a serialization error, so the re-run sees the new role
   * (catalog-concurrency-hazards D2). Postgres only; call it inside a transaction. */
  async authGetMembershipRoleForShare(userId: string, studioId: string): Promise<TeamRole | null> {
    const row = await this.db.first<Row>(
      'SELECT role FROM user_studio_memberships WHERE user_id = ? AND studio_id = ? FOR SHARE',
      userId,
      studioId,
    );
    return row === null ? null : (String(row.role) as TeamRole);
  }

  /** Count of ENABLED admins for a team, reported as `enabled_admin_count`. Only `admin` rows
   * count: the owner is not an admin here (owner-bootstrap owner decision B). */
  async authCountEnabledAdmins(studioId: string): Promise<number> {
    const row = await this.db.first<Row>(
      `SELECT COUNT(*) AS n
       FROM user_studio_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.studio_id = ? AND m.role = 'admin' AND u.disabled_at_utc IS NULL`,
      studioId,
    );
    return Number(row?.n ?? 0);
  }

  /** Members of a team joined with user fields, for the team detail endpoint. */
  async authListTeamMembers(
    studioId: string,
  ): Promise<
    Array<{ id: string; email: string; given_name: string; family_name: string; role: TeamRole }>
  > {
    const rows = await this.db.all<Row>(
      `SELECT u.id AS id, u.email AS email, u.given_name AS given_name,
              u.family_name AS family_name, m.role AS role
       FROM user_studio_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.studio_id = ?
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.email ASC`,
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
  // these methods never apply SQL lower() (former SQLite migration 0004).

  /** Idempotent upsert of a pending invite (one row per team+email; re-inviting
   * refreshes invited_by/invited_at). */
  async authUpsertInvite(studioId: string, emailNorm: string, invitedByUserId: string): Promise<void> {
    await this.db.run(
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
  async authListInvitesForTeam(studioId: string): Promise<Row[]> {
    return this.db.all<Row>(
      'SELECT * FROM team_invites WHERE studio_id = ? ORDER BY email_norm ASC',
      studioId,
    );
  }

  /** Delete one invite (idempotent — returns whether a row was actually removed). */
  async authDeleteInvite(studioId: string, emailNorm: string): Promise<number> {
    const res = await this.db.run(
      'DELETE FROM team_invites WHERE studio_id = ? AND email_norm = ?',
      studioId,
      emailNorm,
    );
    return res.changes;
  }

  /** Count of pending invites for a team, for the 200-per-team cap. */
  async authCountPendingInvites(studioId: string): Promise<number> {
    const row = await this.db.first<Row>(
      'SELECT COUNT(*) AS n FROM team_invites WHERE studio_id = ?',
      studioId,
    );
    return Number(row?.n ?? 0);
  }

  /** Sign-in materialization consumer: select then delete every pending invite
   * for a normalized email, returning the consumed rows (their studio_ids are
   * what the caller grants membership to). Select and delete share one
   * transaction, which joins the sign-up route's catalog.tx(...). */
  async authConsumeInvitesForEmail(emailNorm: string): Promise<Row[]> {
    return this.db.tx(async (t) => {
      const rows = await t.all<Row>('SELECT * FROM team_invites WHERE email_norm = ?', emailNorm);
      if (rows.length > 0) {
        await t.run('DELETE FROM team_invites WHERE email_norm = ?', emailNorm);
      }
      return rows;
    });
  }

  // -- teams-self-serve: user lookup by email (design D2 multi-match) ----------

  /** ALL user rows whose email of record normalizes to emailNorm, INCLUDING
   * disabled accounts (unlike authGetUserByGoogleSub, which filters disabled) —
   * membership is inert while disabled, and invite-matching must still see them
   * (D2). Matching is done in JS (never SQL lower()), same as invite/sign-in
   * normalization. */
  async authListUsersByEmailNorm(emailNorm: string): Promise<Row[]> {
    const users = await this.db.all<Row>('SELECT * FROM users');
    return users.filter((u) => normalizeEmail(String(u.email)) === emailNorm);
  }

  // -- show-grants: the access rule and the grant store (design D2) ------------

  /** Whether the user can access the show: owner or admin of its team, or a member with a grant
   * for it. An unknown show, a non-member and an ungranted member all get false. */
  async authCanAccessShow(userId: string, showId: string): Promise<boolean> {
    const row = await this.db.first<Row>(
      `SELECT 1 FROM shows s
       JOIN user_studio_memberships m ON m.studio_id = s.studio_id AND m.user_id = ?
       WHERE s.id = ? AND ${SHOW_ACCESS_PREDICATE}`,
      userId,
      showId,
    );
    return row !== null;
  }

  /** `authCanAccessShow` for use inside a write's transaction: the membership row and, for a
   * member, the grant row are locked for share until the transaction ends, so a revoke, removal or
   * demotion that commits meanwhile waits for, or fails, this reader and the re-run sees it.
   * Postgres only; call it inside a transaction. */
  async authCanAccessShowForShare(userId: string, showId: string): Promise<boolean> {
    const show = await this.db.first<Row>('SELECT studio_id FROM shows WHERE id = ?', showId);
    if (show === null) return false;
    const role = await this.authGetMembershipRoleForShare(userId, String(show.studio_id));
    if (role === null) return false;
    if (role === 'owner' || role === 'admin') return true;
    const grant = await this.db.first<Row>(
      'SELECT 1 FROM show_grants WHERE user_id = ? AND show_id = ? FOR SHARE',
      userId,
      showId,
    );
    return grant !== null;
  }

  /** Every show id the user can access, over all their teams, in one statement. */
  async authListAccessibleShowIds(userId: string): Promise<Set<string>> {
    const rows = await this.db.all<Row>(
      `SELECT s.id AS id FROM shows s
       JOIN user_studio_memberships m ON m.studio_id = s.studio_id AND m.user_id = ?
       WHERE ${SHOW_ACCESS_PREDICATE}`,
      userId,
    );
    return new Set(rows.map((r) => String(r.id)));
  }

  /** The grant rows of one show, ordered by user id. */
  async authListShowGrants(showId: string): Promise<Row[]> {
    return this.db.all<Row>(
      `SELECT user_id, show_id, can_write, granted_by_user_id, granted_at_utc
       FROM show_grants WHERE show_id = ? ORDER BY user_id`,
      showId,
    );
  }

  /** The (user_id, show_id) grant pairs of every show of a team, for the team detail. */
  async authListShowGrantsInStudio(
    studioId: string,
  ): Promise<Array<{ user_id: string; show_id: string }>> {
    const rows = await this.db.all<Row>(
      `SELECT g.user_id AS user_id, g.show_id AS show_id
       FROM show_grants g JOIN shows s ON s.id = g.show_id
       WHERE s.studio_id = ? ORDER BY g.user_id, g.show_id`,
      studioId,
    );
    return rows.map((r) => ({ user_id: String(r.user_id), show_id: String(r.show_id) }));
  }

  /** Grant a show (idempotent: an existing grant keeps its recorded granter and time). */
  async authGrantShow(
    userId: string,
    showId: string,
    grantedByUserId: string,
    grantedAtUtc: string,
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO show_grants (user_id, show_id, can_write, granted_by_user_id, granted_at_utc)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT (user_id, show_id) DO NOTHING`,
      userId,
      showId,
      grantedByUserId,
      grantedAtUtc,
    );
  }

  /** Revoke one grant (idempotent); returns the number of rows deleted. */
  async authRevokeShow(userId: string, showId: string): Promise<number> {
    const res = await this.db.run(
      'DELETE FROM show_grants WHERE user_id = ? AND show_id = ?',
      userId,
      showId,
    );
    return res.changes;
  }

  /** Revoke every grant the user holds on the shows of one team; returns the number deleted. */
  async authRevokeGrantsInStudio(userId: string, studioId: string): Promise<number> {
    const res = await this.db.run(
      `DELETE FROM show_grants g USING shows s
       WHERE g.show_id = s.id AND s.studio_id = ? AND g.user_id = ?`,
      studioId,
      userId,
    );
    return res.changes;
  }
}

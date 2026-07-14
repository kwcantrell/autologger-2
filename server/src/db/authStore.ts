// Users, studio memberships, per-user prefs, and admin user operations.
// Moved verbatim out of catalog.ts (Catalog). Self-contained on this.db.

import type { CatalogDb } from '../node/catalogStore';
import { nowIso } from './shared';
import type { Row } from './shared';

export class AuthStore {
  constructor(private db: CatalogDb) {}

  authGetUserByGoogleSub(googleSub: string): Row | null {
    return this.db.first<Row>(
      'SELECT * FROM users WHERE google_sub = ? AND disabled_at_utc IS NULL',
      googleSub,
    );
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
    this.authEnsurePrefsRow(userId);
    this.db.run(
      'UPDATE user_prefs SET active_studio_id = ?, active_show_id = ? WHERE user_id = ?',
      activeStudioId,
      activeShowId,
      userId,
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
}

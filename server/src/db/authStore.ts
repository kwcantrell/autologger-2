// Users, studio memberships, per-user prefs, and admin user operations.
// Moved verbatim out of catalog.ts (Catalog). Self-contained on this.db.

import type { CatalogDb } from '../node/catalogStore';
import { nowIso } from './shared';
import type { Row } from './shared';

export class AuthStore {
  constructor(private db: CatalogDb) {}

  async authGetUserByGoogleSub(googleSub: string): Promise<Row | null> {
    return this.db
      .prepare('SELECT * FROM users WHERE google_sub = ? AND disabled_at_utc IS NULL')
      .bind(googleSub)
      .first<Row>();
  }

  async authGetUserById(userId: string): Promise<Row | null> {
    return this.db
      .prepare('SELECT * FROM users WHERE id = ? AND disabled_at_utc IS NULL')
      .bind(userId)
      .first<Row>();
  }

  async authCreateUserGoogle(opts: {
    googleSub: string;
    email: string;
    givenName: string;
    familyName: string;
    pictureUrl: string;
  }): Promise<string> {
    const uid = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO users (id, google_sub, email, given_name, family_name, picture_url, created_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        uid,
        opts.googleSub,
        opts.email,
        opts.givenName,
        opts.familyName,
        opts.pictureUrl,
        nowIso(),
      )
      .run();
    return uid;
  }

  async authUpdateUserProfile(
    userId: string,
    fields: { email?: string; givenName?: string; familyName?: string; pictureUrl?: string },
  ): Promise<boolean> {
    const row = await this.authGetUserById(userId);
    if (row === null) return false;
    const em = fields.email ?? String(row.email);
    const gn = fields.givenName ?? String(row.given_name);
    const fn = fields.familyName ?? String(row.family_name);
    const pic = fields.pictureUrl ?? String(row.picture_url);
    await this.db
      .prepare(
        'UPDATE users SET email = ?, given_name = ?, family_name = ?, picture_url = ? WHERE id = ?',
      )
      .bind(em, gn, fn, pic, userId)
      .run();
    return true;
  }

  async authUpdateUserNames(
    userId: string,
    givenName: string,
    familyName: string,
  ): Promise<boolean> {
    return this.authUpdateUserProfile(userId, { givenName, familyName });
  }

  async authUserHasStudio(userId: string, studioId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 FROM user_studio_memberships WHERE user_id = ? AND studio_id = ?')
      .bind(userId, studioId)
      .first<Row>();
    return row !== null;
  }

  async authListStudioIdsForUser(userId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare('SELECT studio_id FROM user_studio_memberships WHERE user_id = ? ORDER BY studio_id')
      .bind(userId)
      .all<Row>();
    return (results ?? []).map((r) => String(r.studio_id));
  }

  async authAddMemberships(userId: string, studioIds: string[]): Promise<void> {
    const stmts = studioIds
      .filter((sid) => sid)
      .map((sid) =>
        this.db
          .prepare(
            'INSERT OR IGNORE INTO user_studio_memberships (user_id, studio_id) VALUES (?, ?)',
          )
          .bind(userId, sid),
      );
    if (stmts.length) await this.db.batch(stmts);
  }

  async authGetPrefs(userId: string): Promise<Row | null> {
    return this.db.prepare('SELECT * FROM user_prefs WHERE user_id = ?').bind(userId).first<Row>();
  }

  async authEnsurePrefsRow(userId: string): Promise<void> {
    const row = await this.db
      .prepare('SELECT 1 FROM user_prefs WHERE user_id = ?')
      .bind(userId)
      .first<Row>();
    if (row === null) {
      await this.db
        .prepare(
          "INSERT INTO user_prefs (user_id, active_studio_id, active_show_id) VALUES (?, '', '')",
        )
        .bind(userId)
        .run();
    }
  }

  async authSetPrefs(userId: string, activeStudioId: string, activeShowId: string): Promise<void> {
    await this.authEnsurePrefsRow(userId);
    await this.db
      .prepare('UPDATE user_prefs SET active_studio_id = ?, active_show_id = ? WHERE user_id = ?')
      .bind(activeStudioId, activeShowId, userId)
      .run();
  }

  async authSeedPrefsFromGlobals(
    userId: string,
    activeStudioId: string,
    activeShowId: string,
  ): Promise<void> {
    const row = await this.authGetPrefs(userId);
    if (row !== null && String(row.active_studio_id ?? '').trim()) return;
    await this.authEnsurePrefsRow(userId);
    await this.authSetPrefs(userId, activeStudioId, activeShowId);
  }

  // -- admin: users ------------------------------------------------------------

  async authListUsersAdmin(): Promise<Row[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, google_sub, email, given_name, family_name, picture_url,
                created_at_utc, disabled_at_utc
         FROM users ORDER BY created_at_utc DESC`,
      )
      .all<Row>();
    return results ?? [];
  }

  /** Fetch a user row including disabled accounts (admin). */
  async authGetUserRowAny(userId: string): Promise<Row | null> {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<Row>();
  }

  async authSetUserDisabled(userId: string, disabled: boolean): Promise<void> {
    if (disabled) {
      await this.db
        .prepare('UPDATE users SET disabled_at_utc = ? WHERE id = ?')
        .bind(nowIso(), userId)
        .run();
    } else {
      await this.db
        .prepare('UPDATE users SET disabled_at_utc = NULL WHERE id = ?')
        .bind(userId)
        .run();
    }
  }

  async authRemoveMembership(userId: string, studioId: string): Promise<boolean> {
    const res = await this.db
      .prepare('DELETE FROM user_studio_memberships WHERE user_id = ? AND studio_id = ?')
      .bind(userId, studioId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }
}

// Studio registry (built-ins merged with studio_definitions), app_settings,
// per-studio settings blobs, and admin studio create/delete. Moved verbatim
// out of d1.ts (Catalog) — this module owns the order/names registry state.

import type { CatalogDb } from '../node/d1Adapter';
import {
  BUILTIN_STUDIO_NAMES,
  BUILTIN_STUDIO_ORDER,
  blobToProfile,
  DEFAULT_STUDIO_ID,
  defaultSettingsBlob,
  SETTING_ACTIVE_STUDIO,
  studioConfigKey,
  ValidationError,
  validateSettingsBlob,
} from '../studio';
import type { SettingsBlob, StudioProfile } from '../studio';
import { nowIso } from './shared';
import type { Row } from './shared';

export class StudioRegistry {
  private order: string[] = [];
  private names: Record<string, string> = {};

  constructor(private db: CatalogDb) {}

  /** Must be awaited once per request before reads that depend on the studio registry. */
  async init(): Promise<void> {
    await this.refreshStudioRegistry();
  }

  // -- Studio registry (built-ins merged with studio_definitions rows) ---------

  async refreshStudioRegistry(): Promise<void> {
    const names: Record<string, string> = { ...BUILTIN_STUDIO_NAMES };
    const order: string[] = [...BUILTIN_STUDIO_ORDER];
    const builtin = new Set(BUILTIN_STUDIO_ORDER);
    const { results } = await this.db
      .prepare(
        'SELECT id, display_name, sort_order FROM studio_definitions ORDER BY sort_order ASC, id ASC',
      )
      .all<Row>();
    const extras: Array<[string, string, number]> = [];
    for (const r of results ?? []) {
      const sid = String(r.id);
      if (builtin.has(sid)) continue;
      extras.push([sid, String(r.display_name), Number(r.sort_order) || 0]);
    }
    extras.sort((a, b) => a[2] - b[2] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [sid, disp] of extras) {
      names[sid] = disp;
      order.push(sid);
    }
    this.order = order;
    this.names = names;
  }

  studioOrderTuple(): string[] {
    return this.order;
  }

  studioNamesDict(): Record<string, string> {
    return this.names;
  }

  isKnownStudio = (studioId: string): boolean => studioId in this.names;

  // -- app_settings ------------------------------------------------------------

  async getSetting(key: string, def: string | null = null): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .bind(key)
      .first<Row>();
    return row ? String(row.value) : def;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .bind(key, value)
      .run();
  }

  // -- studio settings blobs ---------------------------------------------------

  async getStudioSettingsBlob(studioIdIn: string): Promise<Record<string, unknown>> {
    let studioId = studioIdIn;
    if (!this.isKnownStudio(studioId)) studioId = DEFAULT_STUDIO_ID;
    const raw = await this.getSetting(studioConfigKey(studioId));
    if (!raw) {
      const blob = defaultSettingsBlob(studioId);
      await this.setSetting(studioConfigKey(studioId), JSON.stringify(blob));
      return blob as unknown as Record<string, unknown>;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      const blob = defaultSettingsBlob(studioId);
      await this.setSetting(studioConfigKey(studioId), JSON.stringify(blob));
      return blob as unknown as Record<string, unknown>;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      const blob = defaultSettingsBlob(studioId);
      await this.setSetting(studioConfigKey(studioId), JSON.stringify(blob));
      return blob as unknown as Record<string, unknown>;
    }
    const base = defaultSettingsBlob(studioId);
    const merged: Record<string, unknown> = { ...base, ...(data as Record<string, unknown>) };
    const dataCats = (data as Record<string, unknown>).categories;
    if (!Array.isArray(dataCats)) merged.categories = base.categories;
    return merged;
  }

  async saveStudioSettingsBlob(studioId: string, blob: Record<string, unknown>): Promise<void> {
    const normalized = validateSettingsBlob(blob, studioId, this.isKnownStudio);
    await this.setSetting(studioConfigKey(studioId), JSON.stringify(normalized));
  }

  async loadStudioProfile(studioId: string): Promise<StudioProfile> {
    const blob = await this.getStudioSettingsBlob(studioId);
    const name = this.names[studioId] ?? studioId;
    return blobToProfile(studioId, name, blob as unknown as SettingsBlob);
  }

  async resolveActiveStudio(): Promise<StudioProfile> {
    const raw = await this.getSetting(SETTING_ACTIVE_STUDIO);
    if (raw && this.isKnownStudio(raw)) return this.loadStudioProfile(raw);
    return this.loadStudioProfile(DEFAULT_STUDIO_ID);
  }

  async allStudioSettingsForAllowedStudios(
    allowedIds: Set<string> | null,
  ): Promise<Record<string, SettingsBlob>> {
    const out: Record<string, SettingsBlob> = {};
    for (const sid of this.order) {
      if (allowedIds !== null && !allowedIds.has(sid)) continue;
      const b = await this.getStudioSettingsBlob(sid);
      try {
        out[sid] = validateSettingsBlob(b, sid, this.isKnownStudio);
      } catch {
        out[sid] = validateSettingsBlob(
          defaultSettingsBlob(sid) as unknown as Record<string, unknown>,
          sid,
          this.isKnownStudio,
        );
      }
    }
    return out;
  }

  listStudiosBrief(): Array<{ id: string; name: string }> {
    return this.order.map((sid) => ({ id: sid, name: this.names[sid] }));
  }

  listStudiosBriefAllowed(allowedIds: Set<string> | null): Array<{ id: string; name: string }> {
    if (allowedIds === null) return this.listStudiosBrief();
    return this.order
      .filter((sid) => allowedIds.has(sid))
      .map((sid) => ({ id: sid, name: this.names[sid] }));
  }

  // -- admin: studio definitions -----------------------------------------------

  private static readonly STUDIO_ID_SLUG_RE = /^[a-z][a-z0-9-]{1,62}$/;

  /** admin_create_studio — insert a user-defined team (stable lowercase slug id). */
  async adminCreateStudio(studioId: string, displayName: string): Promise<void> {
    const sid = (studioId || '').trim();
    const disp = (displayName || '').trim();
    if (!sid || !disp) throw new ValidationError('Team id and display name are required.');
    if (!StudioRegistry.STUDIO_ID_SLUG_RE.test(sid)) {
      throw new ValidationError(
        'Team id must be a lowercase slug: start with a letter, then letters, digits, or hyphens (2-63 chars).',
      );
    }
    if (disp.length > 200) throw new ValidationError('Display name is too long.');
    if (BUILTIN_STUDIO_ORDER.includes(sid)) {
      throw new ValidationError('That team id is reserved for a built-in team.');
    }
    const existing = await this.db
      .prepare('SELECT 1 FROM studio_definitions WHERE id = ?')
      .bind(sid)
      .first<Row>();
    if (existing !== null) throw new ValidationError('A team with that id already exists.');
    await this.db
      .prepare(
        'INSERT INTO studio_definitions (id, display_name, sort_order, created_at_utc) VALUES (?, ?, 1000, ?)',
      )
      .bind(sid, disp, nowIso())
      .run();
    await this.refreshStudioRegistry();
  }

  /** admin_delete_studio — remove a user-defined team (blocks if shows exist). */
  async adminDeleteStudio(studioId: string): Promise<void> {
    const sid = (studioId || '').trim();
    if (BUILTIN_STUDIO_ORDER.includes(sid)) {
      throw new ValidationError('Cannot delete a built-in team.');
    }
    const cntRow = await this.db
      .prepare('SELECT COUNT(*) AS c FROM shows WHERE studio_id = ?')
      .bind(sid)
      .first<Row>();
    const nshows = Number(cntRow?.c ?? 0);
    if (nshows > 0) {
      throw new ValidationError(`Team still has ${nshows} show(s); delete or move them first.`);
    }
    await this.db.batch([
      this.db.prepare('DELETE FROM user_studio_memberships WHERE studio_id = ?').bind(sid),
      this.db.prepare('DELETE FROM studio_definitions WHERE id = ?').bind(sid),
      this.db.prepare('DELETE FROM app_settings WHERE key = ?').bind(studioConfigKey(sid)),
    ]);
    await this.refreshStudioRegistry();
  }
}

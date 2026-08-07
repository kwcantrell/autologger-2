// Studio registry (built-ins merged with studio_definitions), app_settings,
// per-studio settings blobs, and admin studio create/delete. Moved verbatim
// out of catalog.ts (Catalog) — this module owns the order/names registry state.

import type { Row, SettingsBlob, StudioProfile } from '@autologger/domain';
import {
  BUILTIN_STUDIO_NAMES,
  BUILTIN_STUDIO_ORDER,
  blobToProfile,
  DEFAULT_STUDIO_ID,
  defaultSettingsBlob,
  nowIso,
  SETTING_ACTIVE_STUDIO,
  studioConfigKey,
  ValidationError,
  validateSettingsBlob,
} from '@autologger/domain';
import type { CatalogDb } from '@autologger/ports';

/** Consumption-based facade surface (persistence-package-extraction design D3):
 * exactly the ten members reached externally via `catalog.studios.x()` in
 * `server/src` (routers + `test/helpers.ts`). `init()` is NOT here — it is
 * reached only through `Catalog.init()` (the `CatalogFacade` member), never
 * directly as `catalog.studios.init()`; internal cross-store calls (from
 * `sessionIndexStore.ts`/`profileAssembler.ts`, same package) use the
 * concrete `StudioRegistry` type and are unaffected by this narrower facade.
 * Property-style function types (design D3 — contravariant `implements`
 * checking under `strictFunctionTypes`). */
export interface StudioRegistryFacade {
  adminCreateStudio: (studioId: string, displayName: string) => void;
  adminDeleteStudio: (studioId: string) => void;
  getSetting: (key: string, def?: string | null) => string | null;
  isKnownStudio: (studioId: string) => boolean;
  listStudiosBrief: () => Array<{ id: string; name: string }>;
  renameStudio: (studioId: string, displayName: string) => void;
  saveStudioSettingsBlob: (studioId: string, blob: Record<string, unknown>) => void;
  setSetting: (key: string, value: string) => void;
  studioNamesDict: () => Record<string, string>;
  studioOrderTuple: () => string[];
}

export class StudioRegistry implements StudioRegistryFacade {
  private order: string[] = [];
  private names: Record<string, string> = {};

  constructor(private db: CatalogDb) {}

  /** Must run once per request before reads that depend on the studio registry. */
  init(): void {
    this.refreshStudioRegistry();
  }

  // -- Studio registry (built-ins merged with studio_definitions rows) ---------

  refreshStudioRegistry(): void {
    const names: Record<string, string> = { ...BUILTIN_STUDIO_NAMES };
    const order: string[] = [...BUILTIN_STUDIO_ORDER];
    const builtin = new Set(BUILTIN_STUDIO_ORDER);
    const results = this.db.all<Row>(
      'SELECT id, display_name, sort_order FROM studio_definitions ORDER BY sort_order ASC, id ASC',
    );
    const extras: Array<[string, string, number]> = [];
    for (const r of results) {
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

  getSetting(key: string, def: string | null = null): string | null {
    const row = this.db.first<Row>('SELECT value FROM app_settings WHERE key = ?', key);
    return row ? String(row.value) : def;
  }

  setSetting(key: string, value: string): void {
    this.db.run(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  // -- studio settings blobs ---------------------------------------------------

  getStudioSettingsBlob(studioIdIn: string): Record<string, unknown> {
    let studioId = studioIdIn;
    if (!this.isKnownStudio(studioId)) studioId = DEFAULT_STUDIO_ID;
    // Self-healing read (deliberate, ported behavior): a missing/corrupt blob
    // is rewritten with defaults during the read.
    const resetToDefault = (): Record<string, unknown> => {
      const blob = defaultSettingsBlob(studioId);
      this.setSetting(studioConfigKey(studioId), JSON.stringify(blob));
      return blob as unknown as Record<string, unknown>;
    };
    const raw = this.getSetting(studioConfigKey(studioId));
    if (!raw) return resetToDefault();
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return resetToDefault();
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return resetToDefault();
    const base = defaultSettingsBlob(studioId);
    const merged: Record<string, unknown> = { ...base, ...(data as Record<string, unknown>) };
    const dataCats = (data as Record<string, unknown>).categories;
    if (!Array.isArray(dataCats)) merged.categories = base.categories;
    return merged;
  }

  saveStudioSettingsBlob(studioId: string, blob: Record<string, unknown>): void {
    const normalized = validateSettingsBlob(blob, studioId, this.isKnownStudio);
    this.setSetting(studioConfigKey(studioId), JSON.stringify(normalized));
  }

  loadStudioProfile(studioId: string): StudioProfile {
    const blob = this.getStudioSettingsBlob(studioId);
    const name = this.names[studioId] ?? studioId;
    return blobToProfile(studioId, name, blob as unknown as SettingsBlob);
  }

  resolveActiveStudio(): StudioProfile {
    const raw = this.getSetting(SETTING_ACTIVE_STUDIO);
    if (raw && this.isKnownStudio(raw)) return this.loadStudioProfile(raw);
    return this.loadStudioProfile(DEFAULT_STUDIO_ID);
  }

  allStudioSettingsForAllowedStudios(allowedIds: Set<string> | null): Record<string, SettingsBlob> {
    const out: Record<string, SettingsBlob> = {};
    for (const sid of this.order) {
      if (allowedIds !== null && !allowedIds.has(sid)) continue;
      const b = this.getStudioSettingsBlob(sid);
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
  adminCreateStudio(studioId: string, displayName: string): void {
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
    const existing = this.db.first<Row>('SELECT 1 FROM studio_definitions WHERE id = ?', sid);
    if (existing !== null) throw new ValidationError('A team with that id already exists.');
    this.db.run(
      'INSERT INTO studio_definitions (id, display_name, sort_order, created_at_utc) VALUES (?, ?, 1000, ?)',
      sid,
      disp,
      nowIso(),
    );
    this.refreshStudioRegistry();
  }

  /** admin_delete_studio — remove a user-defined team (blocks if shows exist).
   * Shared by BOTH the admin plane (admin.ts) and the self-serve teams router
   * (teams.ts, design D4) so both cascades stay identical — including
   * team_invites, which the admin plane previously didn't know about. */
  adminDeleteStudio(studioId: string): void {
    const sid = (studioId || '').trim();
    if (BUILTIN_STUDIO_ORDER.includes(sid)) {
      throw new ValidationError('Cannot delete a built-in team.');
    }
    const cntRow = this.db.first<Row>('SELECT COUNT(*) AS c FROM shows WHERE studio_id = ?', sid);
    const nshows = Number(cntRow?.c ?? 0);
    if (nshows > 0) {
      throw new ValidationError(`Team still has ${nshows} show(s); delete or move them first.`);
    }
    this.db.tx(() => {
      this.db.run('DELETE FROM team_invites WHERE studio_id = ?', sid);
      this.db.run('DELETE FROM user_studio_memberships WHERE studio_id = ?', sid);
      this.db.run('DELETE FROM studio_definitions WHERE id = ?', sid);
      this.db.run('DELETE FROM app_settings WHERE key = ?', studioConfigKey(sid));
    });
    this.refreshStudioRegistry();
  }

  /** teams-self-serve (design D4): display-name-only rename, sharing
   * `adminCreateStudio`'s display-name validation. Ids are immutable after
   * creation — this never touches `studio_definitions.id`. */
  renameStudio(studioId: string, displayName: string): void {
    const sid = (studioId || '').trim();
    const disp = (displayName || '').trim();
    if (!disp) throw new ValidationError('Display name is required.');
    if (disp.length > 200) throw new ValidationError('Display name is too long.');
    if (BUILTIN_STUDIO_ORDER.includes(sid)) {
      throw new ValidationError('Cannot rename a built-in team.');
    }
    this.db.run('UPDATE studio_definitions SET display_name = ? WHERE id = ?', disp, sid);
    this.refreshStudioRegistry();
  }
}

// Studio registry (studio_definitions rows; owner-bootstrap D9), app_settings,
// per-studio settings blobs, and admin studio create/delete. Moved verbatim
// out of catalog.ts (Catalog) — this module owns the order/names registry state.

import type { Row, SettingsBlob, StudioProfile } from '@autologger/domain';
import {
  blobToProfile,
  defaultSettingsBlob,
  nowIso,
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
  adminCreateStudio: (studioId: string, displayName: string) => Promise<void>;
  insertStudioDefinition: (sid: string, disp: string) => Promise<void>;
  validateNewStudio: (studioId: string, displayName: string) => { sid: string; disp: string };
  studioExists: (studioId: string) => Promise<boolean>;
  adminDeleteStudio: (studioId: string) => Promise<void>;
  getSetting: (key: string, def?: string | null) => Promise<string | null>;
  isKnownStudio: (studioId: string) => boolean;
  listStudiosBrief: () => Array<{ id: string; name: string }>;
  renameStudio: (studioId: string, displayName: string) => Promise<void>;
  refreshAfterWrite: () => Promise<void>;
  saveStudioSettingsBlob: (studioId: string, blob: Record<string, unknown>) => Promise<void>;
  setSetting: (key: string, value: string) => Promise<void>;
  setSettingIf: (key: string, expected: string | null, value: string) => Promise<void>;
  studioNamesDict: () => Record<string, string>;
  studioOrderTuple: () => string[];
}

export class StudioRegistry implements StudioRegistryFacade {
  private order: string[] = [];
  private names: Record<string, string> = {};

  constructor(private db: CatalogDb) {}

  /** The same registry over another handle, carrying this snapshot, so a transaction body runs
   * on it without re-querying (async-catalog-stores D3). */
  withDb(db: CatalogDb): StudioRegistry {
    const bound = new StudioRegistry(db);
    bound.order = this.order;
    bound.names = this.names;
    return bound;
  }

  /** Must run once per request before reads that depend on the studio registry. */
  async init(): Promise<void> {
    await this.refreshStudioRegistry();
  }

  // -- Studio registry (studio_definitions rows only; owner-bootstrap D9) ------

  async refreshStudioRegistry(): Promise<void> {
    const names: Record<string, string> = {};
    const order: string[] = [];
    const results = await this.db.all<Row>(
      'SELECT id, display_name, sort_order FROM studio_definitions ORDER BY sort_order ASC, id ASC',
    );
    for (const r of results) {
      const sid = String(r.id);
      names[sid] = String(r.display_name);
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
    const row = await this.db.first<Row>('SELECT value FROM app_settings WHERE key = ?', key);
    return row ? String(row.value) : def;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.run(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  /** Set `key` only if it still holds `expected` (null: only if missing), so a concurrent write
   * wins (catalog-concurrency-hazards D8). */
  async setSettingIf(key: string, expected: string | null, value: string): Promise<void> {
    if (expected === null) {
      await this.db.run(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
        key,
        value,
      );
    } else {
      await this.db.run(
        'UPDATE app_settings SET value = ? WHERE key = ? AND value = ?',
        value,
        key,
        expected,
      );
    }
  }

  // -- studio settings blobs ---------------------------------------------------

  /** An unknown id gets the unpersisted default (owner-bootstrap D9: no default-team remap). */
  async getStudioSettingsBlob(studioId: string): Promise<Record<string, unknown>> {
    const key = studioConfigKey(studioId);
    const base = defaultSettingsBlob(studioId) as unknown as Record<string, unknown>;
    const parse = (raw: string | null): Record<string, unknown> | null => {
      if (!raw) return null;
      let data: unknown;
      try {
        data = JSON.parse(raw);
      } catch {
        return null;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
      const merged: Record<string, unknown> = { ...base, ...(data as Record<string, unknown>) };
      if (!Array.isArray((data as Record<string, unknown>).categories)) {
        merged.categories = base.categories;
      }
      return merged;
    };
    // Self-healing read (deliberate, ported behavior), without a transaction that concurrent
    // first reads could conflict on (catalog-concurrency-hazards D4): a missing blob is inserted
    // only if still missing and the team exists; a corrupt one is replaced only if unchanged.
    const raw = await this.getSetting(key);
    const stored = parse(raw);
    if (stored) return stored;
    if (raw) {
      await this.db.run(
        'UPDATE app_settings SET value = ? WHERE key = ? AND value = ?',
        JSON.stringify(base),
        key,
        raw,
      );
    } else {
      if (!(await this.studioExists(studioId))) return base;
      await this.db.run(
        'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
        key,
        JSON.stringify(base),
      );
    }
    return parse(await this.getSetting(key)) ?? base;
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

  /** Validation for a new team, shared by both planes; runs before any transaction. An existing
   * id, including a former built-in, is refused by `insertStudioDefinition`. */
  validateNewStudio(studioId: string, displayName: string): { sid: string; disp: string } {
    return StudioRegistry.validateNewStudio(studioId, displayName);
  }

  static validateNewStudio(studioId: string, displayName: string): { sid: string; disp: string } {
    const sid = (studioId || '').trim();
    const disp = (displayName || '').trim();
    if (!sid || !disp) throw new ValidationError('Team id and display name are required.');
    if (!StudioRegistry.STUDIO_ID_SLUG_RE.test(sid)) {
      throw new ValidationError(
        'Team id must be a lowercase slug: start with a letter, then letters, digits, or hyphens (2-63 chars).',
      );
    }
    if (disp.length > 200) throw new ValidationError('Display name is too long.');
    return { sid, disp };
  }

  /** Whether the team exists now (a definition row), read through this registry's
   * handle; the per-request snapshot can be stale, so writes that need the team re-check here,
   * inside their transaction (catalog-concurrency-hazards D3). */
  async studioExists(studioId: string): Promise<boolean> {
    return (await this.db.first<Row>('SELECT 1 FROM studio_definitions WHERE id = ?', studioId)) !== null;
  }

  /** Insert a validated team's definition on this registry's handle (inside the caller's
   * transaction). An id that still has shows is refused, and memberships, invites and settings
   * left under the id are removed, so a reused id starts empty (catalog-concurrency-hazards D2). */
  async insertStudioDefinition(sid: string, disp: string): Promise<void> {
    const existing = await this.db.first<Row>('SELECT 1 FROM studio_definitions WHERE id = ?', sid);
    if (existing !== null) throw new ValidationError('A team with that id already exists.');
    const shows = await this.db.first<Row>('SELECT 1 FROM shows WHERE studio_id = ? LIMIT 1', sid);
    if (shows !== null) throw new ValidationError('That team id is not available.');
    await this.db.run(
      'INSERT INTO studio_definitions (id, display_name, sort_order, created_at_utc) VALUES (?, ?, 1000, ?)',
      sid,
      disp,
      nowIso(),
    );
    await this.db.run('DELETE FROM team_invites WHERE studio_id = ?', sid);
    await this.db.run('DELETE FROM user_studio_memberships WHERE studio_id = ?', sid);
    await this.db.run('DELETE FROM app_settings WHERE key = ?', studioConfigKey(sid));
  }

  /** admin_create_studio — insert a user-defined team (stable lowercase slug id). */
  async adminCreateStudio(studioId: string, displayName: string): Promise<void> {
    const { sid, disp } = StudioRegistry.validateNewStudio(studioId, displayName);
    await this.db.tx(async (t) => this.withDb(t).insertStudioDefinition(sid, disp));
    await this.refreshAfterWrite();
  }

  /** admin_delete_studio — remove a user-defined team (blocks if shows exist).
   * Shared by BOTH the admin plane (admin.ts) and the self-serve teams router
   * (teams.ts, design D4) so both cascades stay identical — including
   * team_invites, which the admin plane previously didn't know about. */
  async adminDeleteStudio(studioId: string): Promise<void> {
    const sid = (studioId || '').trim();
    // The show count runs inside the delete's transaction (async-catalog-stores D2; closes the
    // delete half of ADR 0021 hazard 13).
    await this.db.tx(async (t) => {
      const cntRow = await t.first<Row>('SELECT COUNT(*) AS c FROM shows WHERE studio_id = ?', sid);
      const nshows = Number(cntRow?.c ?? 0);
      if (nshows > 0) {
        throw new ValidationError(`Team still has ${nshows} show(s); delete or move them first.`);
      }
      await t.run('DELETE FROM team_invites WHERE studio_id = ?', sid);
      await t.run('DELETE FROM user_studio_memberships WHERE studio_id = ?', sid);
      await t.run('DELETE FROM studio_definitions WHERE id = ?', sid);
      await t.run('DELETE FROM app_settings WHERE key = ?', studioConfigKey(sid));
    });
  }

  /** teams-self-serve (design D4): display-name-only rename, sharing
   * `adminCreateStudio`'s display-name validation. Ids are immutable after
   * creation — this never touches `studio_definitions.id`. */
  async renameStudio(studioId: string, displayName: string): Promise<void> {
    const sid = (studioId || '').trim();
    const disp = (displayName || '').trim();
    if (!disp) throw new ValidationError('Display name is required.');
    if (disp.length > 200) throw new ValidationError('Display name is too long.');
    await this.db.run('UPDATE studio_definitions SET display_name = ? WHERE id = ?', disp, sid);
  }

  /** Re-read the registry after a committed team write. Rename and delete don't refresh
   * themselves: inside a transaction the refresh would read every team, so writes in different
   * teams would conflict (catalog-concurrency-hazards D2). The snapshot only feeds display names
   * and the early gates, so a failed refresh warns instead of failing the committed write. */
  async refreshAfterWrite(): Promise<void> {
    try {
      await this.refreshStudioRegistry();
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      console.warn(
        `[catalog] studio registry refresh failed after a write (${typeof code === 'string' ? code : (e as Error)?.name})`,
      );
    }
  }
}

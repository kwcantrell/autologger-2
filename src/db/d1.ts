// D1 catalog query layer — ports the catalog methods of src/autologger/storage/db.py
// and the profile assembly (_profile_payload + helpers) from web/deps.py.
// KV-backed login sessions + OAuth CSRF state live in auth/identity.ts, not here.

import {
  BUILTIN_STUDIO_NAMES,
  BUILTIN_STUDIO_ORDER,
  blobToProfile,
  DEFAULT_STUDIO_ID,
  defaultSettingsBlob,
  emptyActiveStudioApiDict,
  newSessionTitlePrefix,
  normalizeEventPaletteNine,
  SETTING_ACTIVE_SHOW,
  SETTING_ACTIVE_STUDIO,
  type SettingsBlob,
  type StudioProfile,
  studioConfigKey,
  studioToApiDict,
  validateEventPalettePreset,
  validateSettingsBlob,
} from '../studio';

export interface AuthUser {
  id: string;
  email: string;
  google_sub: string;
  given_name: string;
  family_name: string;
  picture_url: string;
}

export interface ProfileCtx {
  oauthConfigured: boolean;
  adminMeta: Record<string, boolean>;
}

type Row = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function categoriesListFromShowRow(r: Row): unknown[] {
  try {
    const raw = JSON.parse(String(r.categories_json ?? '[]'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function hexColorsFromJson(rawJson: unknown, maxCount = 9): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(String(rawJson ?? '[]'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const x of raw.slice(0, maxCount)) {
    const s = String(x).trim();
    if (s.length === 7 && s.startsWith('#')) out.push(s.toLowerCase());
  }
  return out;
}

/** _show_api_dict — the per-show shape the React app's api/types.ts expects. */
export function showApiDict(r: Row): Record<string, unknown> {
  const pal = normalizeEventPaletteNine(hexColorsFromJson(r.event_palette_json));
  const presetRaw = String(r.event_palette_preset ?? '')
    .trim()
    .toLowerCase();
  const preset = validateEventPalettePreset(presetRaw || 'custom');
  const customRaw = hexColorsFromJson(r.event_palette_custom_json);
  const custom = customRaw.length === 0 ? [...pal] : normalizeEventPaletteNine(customRaw);
  return {
    id: String(r.id),
    studio_id: String(r.studio_id),
    name: String(r.name),
    show_code: String(r.show_code),
    next_episode: Number(r.next_episode) || 1,
    categories: categoriesListFromShowRow(r),
    event_palette: pal,
    event_palette_preset: preset,
    event_palette_custom: custom,
  };
}

export class Catalog {
  private order: string[] = [];
  private names: Record<string, string> = {};

  constructor(private db: D1Database) {}

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

  // -- users / auth ------------------------------------------------------------

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

  // -- shows -------------------------------------------------------------------

  async getShowRow(showId: string): Promise<Row | null> {
    return this.db.prepare('SELECT * FROM shows WHERE id = ?').bind(showId).first<Row>();
  }

  async getShowShowCode(showId: string): Promise<string> {
    const row = await this.getShowRow(showId);
    return row ? String(row.show_code ?? '').trim() : '';
  }

  async listShowsForStudio(studioId: string): Promise<Row[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM shows WHERE studio_id = ? ORDER BY name COLLATE NOCASE ASC')
      .bind(studioId)
      .all<Row>();
    return results ?? [];
  }

  async createShow(opts: {
    studioId: string;
    name: string;
    showCode: string;
    categoriesJson: string;
    paletteJson: string;
    paletteCustomJson: string;
  }): Promise<string> {
    const sid = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO shows
           (id, studio_id, name, show_code, next_episode, categories_json,
            event_palette_json, event_palette_preset, event_palette_custom_json, created_at_utc)
         VALUES (?, ?, ?, ?, 1, ?, ?, 'custom', ?, ?)`,
      )
      .bind(
        sid,
        opts.studioId,
        opts.name.trim(),
        opts.showCode.trim().toUpperCase(),
        opts.categoriesJson,
        opts.paletteJson,
        opts.paletteCustomJson,
        nowIso(),
      )
      .run();
    return sid;
  }

  async updateShowFields(
    showId: string,
    fields: {
      name?: string;
      show_code?: string;
      next_episode?: number;
      categories_json?: string;
      event_palette_json?: string;
      event_palette_preset?: string;
      event_palette_custom_json?: string;
    },
  ): Promise<boolean> {
    const row = await this.getShowRow(showId);
    if (row === null) return false;
    const nm = fields.name !== undefined ? fields.name.trim() : String(row.name);
    const sc =
      fields.show_code !== undefined
        ? fields.show_code.trim().toUpperCase()
        : String(row.show_code ?? '')
            .trim()
            .toUpperCase();
    const ne =
      fields.next_episode !== undefined ? fields.next_episode : Number(row.next_episode) || 1;
    const cj = fields.categories_json ?? String(row.categories_json ?? '[]');
    const pj = fields.event_palette_json ?? String(row.event_palette_json ?? '[]');
    const pp =
      fields.event_palette_preset !== undefined
        ? fields.event_palette_preset.trim().toLowerCase()
        : String(row.event_palette_preset ?? 'custom')
            .trim()
            .toLowerCase() || 'custom';
    const pcj = fields.event_palette_custom_json ?? String(row.event_palette_custom_json ?? '[]');
    await this.db
      .prepare(
        `UPDATE shows
           SET name = ?, show_code = ?, next_episode = ?, categories_json = ?,
               event_palette_json = ?, event_palette_preset = ?, event_palette_custom_json = ?
         WHERE id = ?`,
      )
      .bind(nm, sc, ne, cj, pj, pp, pcj, showId)
      .run();
    return true;
  }

  // -- profile assembly (_profile_payload + helpers) ---------------------------

  private async resolveActiveShowIdForStudio(
    studioId: string,
    preferredShowId: string,
  ): Promise<string> {
    const shows = await this.listShowsForStudio(studioId);
    const valid = new Set(shows.map((r) => String(r.id)));
    const raw = (preferredShowId || '').trim();
    if (raw && valid.has(raw)) return raw;
    if (shows.length) return String(shows[0].id);
    return '';
  }

  /** _profile_studio_for_user → [profile|null, activeShowId, allowedSet]. */
  async profileStudioForUser(userId: string): Promise<[StudioProfile | null, string, Set<string>]> {
    const allowed = await this.authListStudioIdsForUser(userId);
    const alset = new Set(allowed);
    if (alset.size === 0) return [null, '', alset];
    await this.authEnsurePrefsRow(userId);
    const row = await this.authGetPrefs(userId);
    const rawS = row ? String(row.active_studio_id ?? '').trim() : '';
    const rawSh = row ? String(row.active_show_id ?? '').trim() : '';
    let studioId = alset.has(rawS) ? rawS : '';
    if (!studioId) {
      for (const sid of this.order) {
        if (alset.has(sid)) {
          studioId = sid;
          break;
        }
      }
    }
    if (!studioId) studioId = DEFAULT_STUDIO_ID;
    const prefShow = rawS === studioId ? rawSh : '';
    const activeShowId = await this.resolveActiveShowIdForStudio(studioId, prefShow);
    return [await this.loadStudioProfile(studioId), activeShowId, alset];
  }

  async getEffectiveStudioForUser(
    user: AuthUser | null,
    oauthConfigured: boolean,
  ): Promise<StudioProfile | null> {
    if (user === null) {
      if (oauthConfigured) return null;
      return this.resolveActiveStudio();
    }
    const [prof] = await this.profileStudioForUser(user.id);
    return prof;
  }

  private async authSection(
    user: AuthUser | null,
    oauthConfigured: boolean,
  ): Promise<Record<string, unknown>> {
    if (user === null) return { logged_in: false, user: null, oauth_configured: oauthConfigured };
    const allowed = new Set(await this.authListStudioIdsForUser(user.id));
    const teams = this.order
      .filter((sid) => allowed.has(sid))
      .map((sid) => ({ id: sid, name: this.names[sid] }));
    return {
      logged_in: true,
      oauth_configured: oauthConfigured,
      user: {
        id: user.id,
        email: user.email,
        given_name: user.given_name,
        family_name: user.family_name,
        picture_url: user.picture_url,
        teams,
      },
    };
  }

  /** _profile_payload — byte-compatible with the Python server's /api/profile JSON. */
  async profilePayload(user: AuthUser | null, ctx: ProfileCtx): Promise<Record<string, unknown>> {
    const { oauthConfigured, adminMeta } = ctx;

    if (user === null && oauthConfigured) {
      return {
        active_studio_id: '',
        active_show_id: '',
        active_studio: emptyActiveStudioApiDict(),
        studios: [],
        studio_settings: await this.allStudioSettingsForAllowedStudios(new Set()),
        shows: [],
        new_session_defaults: { title_prefix: 'Episode ', default_frame_rate: 24.0 },
        admin: adminMeta,
        auth: await this.authSection(user, oauthConfigured),
      };
    }

    if (user === null) {
      const active = await this.resolveActiveStudio();
      const showsRaw = await this.listShowsForStudio(active.id);
      let activeShowId = '';
      const rawActiveShow = String((await this.getSetting(SETTING_ACTIVE_SHOW)) ?? '').trim();
      if (rawActiveShow && showsRaw.some((r) => String(r.id) === rawActiveShow)) {
        activeShowId = rawActiveShow;
      } else if (showsRaw.length) {
        activeShowId = String(showsRaw[0].id);
        await this.setSetting(SETTING_ACTIVE_SHOW, activeShowId);
      } else {
        await this.setSetting(SETTING_ACTIVE_SHOW, '');
      }
      const studioSettings = await this.allStudioSettingsForAllowedStudios(null);
      const studiosForList = this.listStudiosBrief();
      const showsOut: Record<string, unknown>[] = [];
      for (const s of studiosForList) {
        for (const r of await this.listShowsForStudio(s.id)) showsOut.push(showApiDict(r));
      }
      return {
        active_studio_id: active.id,
        active_show_id: activeShowId,
        active_studio: studioToApiDict(active),
        studios: studiosForList,
        studio_settings: studioSettings,
        shows: showsOut,
        new_session_defaults: {
          title_prefix: newSessionTitlePrefix(active.show_title_format),
          default_frame_rate: active.default_frame_rate,
        },
        admin: adminMeta,
        auth: await this.authSection(user, oauthConfigured),
      };
    }

    // Logged-in user.
    const [active, computedShowId, alset] = await this.profileStudioForUser(user.id);
    const studioSettings = await this.allStudioSettingsForAllowedStudios(alset);
    const studiosForList = this.listStudiosBriefAllowed(alset);
    let shapeActiveStudio: Record<string, unknown>;
    let nsDefaults: Record<string, unknown>;
    let showsOut: Record<string, unknown>[] = [];
    let activeShowId = '';

    if (active === null) {
      showsOut = [];
      activeShowId = '';
      await this.authEnsurePrefsRow(user.id);
      await this.authSetPrefs(user.id, '', '');
      shapeActiveStudio = emptyActiveStudioApiDict();
      nsDefaults = { title_prefix: 'Episode ', default_frame_rate: 24.0 };
    } else {
      const showsRaw = await this.listShowsForStudio(active.id);
      for (const s of studiosForList) {
        for (const r of await this.listShowsForStudio(s.id)) showsOut.push(showApiDict(r));
      }
      activeShowId = computedShowId;
      const validIds = new Set(showsRaw.map((r) => String(r.id)));
      if (!validIds.has(activeShowId)) {
        activeShowId = showsRaw.length ? String(showsRaw[0].id) : '';
        await this.authSetPrefs(user.id, active.id, activeShowId);
      }
      shapeActiveStudio = studioToApiDict(active);
      nsDefaults = {
        title_prefix: newSessionTitlePrefix(active.show_title_format),
        default_frame_rate: active.default_frame_rate,
      };
    }

    return {
      active_studio_id: active !== null ? active.id : '',
      active_show_id: activeShowId,
      active_studio: shapeActiveStudio,
      studios: studiosForList,
      studio_settings: studioSettings,
      shows: showsOut,
      new_session_defaults: nsDefaults,
      admin: adminMeta,
      auth: await this.authSection(user, oauthConfigured),
    };
  }
}

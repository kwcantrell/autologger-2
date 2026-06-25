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
  ValidationError,
  validateEventPalettePreset,
  validateSettingsBlob,
} from '../studio';
import { nowIso } from './shared';
import type { AuthUser, ProfileCtx, Row } from './shared';

export type { AuthUser, ProfileCtx, Row } from './shared';

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

  // -- sessions index (D1 metadata + live projection from the SessionDO) --------

  async getSessionStudioId(sessionId: string): Promise<string | null> {
    const r = await this.db
      .prepare(
        `SELECT sh.studio_id AS studio_id FROM sessions s
         LEFT JOIN shows sh ON sh.id = s.show_id WHERE s.id = ?`,
      )
      .bind(sessionId)
      .first<Row>();
    if (r === null) return null;
    const sid = String(r.studio_id ?? '').trim();
    return sid || null;
  }

  async getSessionIndexRow(
    sessionId: string,
    opts: { includeHidden?: boolean } = {},
  ): Promise<Row | null> {
    let q = 'SELECT * FROM sessions WHERE id = ?';
    if (!opts.includeHidden) q += ' AND COALESCE(ui_hidden, 0) = 0';
    return this.db.prepare(q).bind(sessionId).first<Row>();
  }

  /** Joined index row carrying show_code / show_name for deck titles. */
  async getSessionJoinedRow(
    sessionId: string,
    opts: { includeHidden?: boolean } = {},
  ): Promise<Row | null> {
    let q = `SELECT s.*, sh.show_code AS show_code, sh.name AS show_name
             FROM sessions s LEFT JOIN shows sh ON sh.id = s.show_id WHERE s.id = ?`;
    if (!opts.includeHidden) q += ' AND COALESCE(s.ui_hidden, 0) = 0';
    return this.db.prepare(q).bind(sessionId).first<Row>();
  }

  async listSessionsForShow(showId: string): Promise<Row[]> {
    const { results } = await this.db
      .prepare(
        `SELECT s.*, sh.show_code AS show_code, sh.name AS show_name
         FROM sessions s LEFT JOIN shows sh ON sh.id = s.show_id
         WHERE s.show_id = ? AND COALESCE(s.ui_hidden, 0) = 0
         ORDER BY s.created_at_utc DESC`,
      )
      .bind(showId)
      .all<Row>();
    return results ?? [];
  }

  async createSessionIndex(opts: {
    showId: string;
    title: string;
    frameRate: number;
    startOffsetFrames: number;
    episode: string;
    notes: string;
    startedAtUtc: string;
    createdAtUtc: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO sessions
           (id, show_id, title, archived, ui_hidden, frame_rate, start_offset_frames,
            episode, notes, started_at_utc, created_at_utc,
            event_count, is_rolling, current_take, transport_elapsed_frames)
         VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
      )
      .bind(
        id,
        opts.showId,
        opts.title,
        opts.frameRate,
        opts.startOffsetFrames,
        opts.episode,
        opts.notes,
        opts.startedAtUtc,
        opts.createdAtUtc,
      )
      .run();
    await this.bumpShowNextEpisodeFromEpisodeString(opts.showId, opts.episode);
    return id;
  }

  /** _bump_show_next_episode_from_episode_string. */
  async bumpShowNextEpisodeFromEpisodeString(showId: string, episode: string): Promise<void> {
    const ep = (episode || '').trim().toUpperCase();
    if (ep.startsWith('BONUS')) return;
    const m = /^(\d+)$/.exec(ep);
    if (!m) return;
    const n = Number(m[1]);
    if (n > 10000) return;
    await this.db
      .prepare('UPDATE shows SET next_episode = MAX(COALESCE(next_episode, 1), ?) WHERE id = ?')
      .bind(n + 1, showId)
      .run();
  }

  /** update_session — title + start_offset_frames. Throws ValidationError on empty title. */
  async updateSessionIndex(
    sessionId: string,
    fields: { title?: string; startOffsetFrames?: number },
  ): Promise<Row | null> {
    const row = await this.getSessionIndexRow(sessionId, { includeHidden: true });
    if (row === null) return null;
    const newTitle = fields.title !== undefined ? fields.title.trim() : String(row.title);
    if (!newTitle) throw new ValidationError('title must not be empty');
    const newOffset =
      fields.startOffsetFrames !== undefined
        ? fields.startOffsetFrames
        : Number(row.start_offset_frames ?? 0);
    if (newOffset < 0) throw new ValidationError('start_offset_frames must be >= 0');
    await this.db
      .prepare('UPDATE sessions SET title = ?, start_offset_frames = ? WHERE id = ?')
      .bind(newTitle, newOffset, sessionId)
      .run();
    return this.getSessionIndexRow(sessionId, { includeHidden: true });
  }

  async setSessionArchived(sessionId: string, archived: boolean): Promise<boolean> {
    const res = await this.db
      .prepare('UPDATE sessions SET archived = ? WHERE id = ?')
      .bind(archived ? 1 : 0, sessionId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async setSessionUiHidden(sessionId: string, hidden: boolean): Promise<boolean> {
    const res = await this.db
      .prepare('UPDATE sessions SET ui_hidden = ? WHERE id = ?')
      .bind(hidden ? 1 : 0, sessionId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async setSessionEpisodeDate(sessionId: string, dateStr: string): Promise<void> {
    await this.db
      .prepare('UPDATE sessions SET episode_date = ? WHERE id = ?')
      .bind(dateStr, sessionId)
      .run();
  }

  /** Mirror the DO's live projection onto the D1 sessions row for cheap listing. */
  async projectSessionLive(
    sessionId: string,
    p: {
      event_count: number;
      max_timecode_total_frames: number | null;
      is_rolling: boolean;
      current_take: number;
      transport_elapsed_frames: number;
      roll_started_at_utc: string | null;
    },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sessions SET event_count = ?, max_timecode_total_frames = ?,
           is_rolling = ?, current_take = ?, transport_elapsed_frames = ?, roll_started_at_utc = ?
         WHERE id = ?`,
      )
      .bind(
        p.event_count,
        p.max_timecode_total_frames,
        p.is_rolling ? 1 : 0,
        p.current_take,
        p.transport_elapsed_frames,
        p.roll_started_at_utc,
        sessionId,
      )
      .run();
  }

  /** get_session_show_categories — categories list + names from the session's show. */
  async getSessionShowCategories(
    sessionId: string,
  ): Promise<{ categories: unknown[]; showName: string; showCode: string } | null> {
    const row = await this.getSessionIndexRow(sessionId, { includeHidden: true });
    if (row === null) return null;
    const showId = String(row.show_id ?? '').trim();
    if (!showId) return null;
    const show = await this.getShowRow(showId);
    if (show === null) return null;
    let cats: unknown[] = [];
    try {
      const parsed = JSON.parse(String(show.categories_json ?? '[]'));
      if (Array.isArray(parsed)) cats = parsed;
    } catch {
      cats = [];
    }
    return {
      categories: cats,
      showName: String(show.name ?? ''),
      showCode: String(show.show_code ?? ''),
    };
  }

  /** studio_profile_for_session — categories from the session's show, else active studio. */
  async studioProfileForSession(sessionId: string): Promise<StudioProfile> {
    const raw = await this.getSessionShowCategories(sessionId);
    let stu = await this.getSessionStudioId(sessionId);
    if (!stu || !this.isKnownStudio(stu)) stu = (await this.resolveActiveStudio()).id;
    if (raw === null) return this.loadStudioProfile(stu);
    const name = this.names[stu] ?? stu;
    return blobToProfile(stu, name, {
      categories: raw.categories,
      show_title_format: '',
      default_frame_rate: 24.0,
    } as unknown as SettingsBlob);
  }

  // -- admin: users + studio definitions ---------------------------------------

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

  private static readonly STUDIO_ID_SLUG_RE = /^[a-z][a-z0-9-]{1,62}$/;

  /** admin_create_studio — insert a user-defined team (stable lowercase slug id). */
  async adminCreateStudio(studioId: string, displayName: string): Promise<void> {
    const sid = (studioId || '').trim();
    const disp = (displayName || '').trim();
    if (!sid || !disp) throw new ValidationError('Team id and display name are required.');
    if (!Catalog.STUDIO_ID_SLUG_RE.test(sid)) {
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

/** _dropdown_options_api_shape. */
function dropdownOptionsApiShape(raw: unknown): Array<{ label: string; needs_context: boolean }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; needs_context: boolean }> = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const lab = item.trim();
      if (lab) out.push({ label: lab, needs_context: false });
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const lab = String(o.label ?? o.name ?? '').trim();
      if (lab) out.push({ label: lab, needs_context: Boolean(o.needs_context ?? false) });
    }
  }
  return out;
}

/** _show_categories_api_shape — label/color/type/dropdown_options/on-off for the browser. */
export function showCategoriesApiShape(rawCategories: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rawCategories)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const c of rawCategories) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const lab = String(o.label ?? o.name ?? '').trim() || '—';
    const type = String(o.type ?? 'BUTTON').toUpperCase();
    out.push({
      id: String(o.id ?? ''),
      label: lab,
      color: String(o.color ?? '#7cb7ff'),
      type,
      dropdown_options: type === 'DROPDOWN' ? dropdownOptionsApiShape(o.dropdown_options) : [],
      on_label: String(o.on_label ?? ''),
      off_label: String(o.off_label ?? ''),
    });
  }
  return out;
}

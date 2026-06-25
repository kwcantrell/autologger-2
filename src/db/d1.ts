// D1 catalog query layer — ports the catalog methods of src/autologger/storage/db.py
// and the profile assembly (_profile_payload + helpers) from web/deps.py.
// KV-backed login sessions + OAuth CSRF state live in auth/identity.ts, not here.

import {
  DEFAULT_STUDIO_ID,
  emptyActiveStudioApiDict,
  newSessionTitlePrefix,
  SETTING_ACTIVE_SHOW,
  type StudioProfile,
  studioToApiDict,
} from '../studio';
import type { AuthUser, ProfileCtx } from './shared';
import { AuthStore } from './authStore';
import { SessionIndexStore } from './sessionIndexStore';
import { ShowsStore, showApiDict } from './showsStore';
import { StudioRegistry } from './studioRegistry';

export type { AuthUser, ProfileCtx, Row } from './shared';
export { showApiDict, showCategoriesApiShape } from './showsStore';

export class Catalog {
  readonly shows: ShowsStore;
  readonly studios: StudioRegistry;
  readonly auth: AuthStore;
  readonly sessions: SessionIndexStore;

  constructor(db: D1Database) {
    this.studios = new StudioRegistry(db);
    this.shows = new ShowsStore(db);
    this.auth = new AuthStore(db);
    this.sessions = new SessionIndexStore(db, this.studios, this.shows);
  }

  // --- shows delegates ---
  getShowRow = (showId: string) => this.shows.getShowRow(showId);
  getShowShowCode = (showId: string) => this.shows.getShowShowCode(showId);
  listShowsForStudio = (studioId: string) => this.shows.listShowsForStudio(studioId);
  createShow = (opts: Parameters<ShowsStore['createShow']>[0]) => this.shows.createShow(opts);
  updateShowFields = (showId: string, fields: Parameters<ShowsStore['updateShowFields']>[1]) =>
    this.shows.updateShowFields(showId, fields);

  // --- studio registry / settings delegates ---
  init = () => this.studios.init();
  isKnownStudio = (studioId: string) => this.studios.isKnownStudio(studioId);
  studioOrderTuple = () => this.studios.studioOrderTuple();
  studioNamesDict = () => this.studios.studioNamesDict();
  getSetting = (key: string, def: string | null = null) => this.studios.getSetting(key, def);
  setSetting = (key: string, value: string) => this.studios.setSetting(key, value);
  saveStudioSettingsBlob = (studioId: string, blob: Record<string, unknown>) =>
    this.studios.saveStudioSettingsBlob(studioId, blob);
  listStudiosBrief = () => this.studios.listStudiosBrief();
  adminCreateStudio = (studioId: string, displayName: string) =>
    this.studios.adminCreateStudio(studioId, displayName);
  adminDeleteStudio = (studioId: string) => this.studios.adminDeleteStudio(studioId);
  // internal-use delegates (kept until their callers are extracted in Tasks 6–7):
  private loadStudioProfile = (studioId: string) => this.studios.loadStudioProfile(studioId);
  private resolveActiveStudio = () => this.studios.resolveActiveStudio();
  private allStudioSettingsForAllowedStudios = (allowedIds: Set<string> | null) =>
    this.studios.allStudioSettingsForAllowedStudios(allowedIds);
  private listStudiosBriefAllowed = (allowedIds: Set<string> | null) =>
    this.studios.listStudiosBriefAllowed(allowedIds);

  // --- auth delegates ---
  authGetUserByGoogleSub = (googleSub: string) => this.auth.authGetUserByGoogleSub(googleSub);
  authGetUserById = (userId: string) => this.auth.authGetUserById(userId);
  authCreateUserGoogle = (opts: Parameters<AuthStore['authCreateUserGoogle']>[0]) =>
    this.auth.authCreateUserGoogle(opts);
  authUpdateUserProfile = (userId: string, fields: Parameters<AuthStore['authUpdateUserProfile']>[1]) =>
    this.auth.authUpdateUserProfile(userId, fields);
  authUpdateUserNames = (userId: string, givenName: string, familyName: string) =>
    this.auth.authUpdateUserNames(userId, givenName, familyName);
  authUserHasStudio = (userId: string, studioId: string) =>
    this.auth.authUserHasStudio(userId, studioId);
  authListStudioIdsForUser = (userId: string) => this.auth.authListStudioIdsForUser(userId);
  authAddMemberships = (userId: string, studioIds: string[]) =>
    this.auth.authAddMemberships(userId, studioIds);
  authGetPrefs = (userId: string) => this.auth.authGetPrefs(userId);
  authSetPrefs = (userId: string, activeStudioId: string, activeShowId: string) =>
    this.auth.authSetPrefs(userId, activeStudioId, activeShowId);
  authSeedPrefsFromGlobals = (userId: string, activeStudioId: string, activeShowId: string) =>
    this.auth.authSeedPrefsFromGlobals(userId, activeStudioId, activeShowId);
  authListUsersAdmin = () => this.auth.authListUsersAdmin();
  authGetUserRowAny = (userId: string) => this.auth.authGetUserRowAny(userId);
  authSetUserDisabled = (userId: string, disabled: boolean) =>
    this.auth.authSetUserDisabled(userId, disabled);
  authRemoveMembership = (userId: string, studioId: string) =>
    this.auth.authRemoveMembership(userId, studioId);
  // internal-use delegate (callers extracted in Task 7):
  private authEnsurePrefsRow = (userId: string) => this.auth.authEnsurePrefsRow(userId);

  // --- session index delegates ---
  getSessionStudioId = (sessionId: string) => this.sessions.getSessionStudioId(sessionId);
  getSessionIndexRow = (sessionId: string, opts: Parameters<SessionIndexStore['getSessionIndexRow']>[1] = {}) =>
    this.sessions.getSessionIndexRow(sessionId, opts);
  getSessionJoinedRow = (sessionId: string, opts: Parameters<SessionIndexStore['getSessionJoinedRow']>[1] = {}) =>
    this.sessions.getSessionJoinedRow(sessionId, opts);
  listSessionsForShow = (showId: string) => this.sessions.listSessionsForShow(showId);
  createSessionIndex = (opts: Parameters<SessionIndexStore['createSessionIndex']>[0]) =>
    this.sessions.createSessionIndex(opts);
  updateSessionIndex = (sessionId: string, fields: Parameters<SessionIndexStore['updateSessionIndex']>[1]) =>
    this.sessions.updateSessionIndex(sessionId, fields);
  setSessionArchived = (sessionId: string, archived: boolean) =>
    this.sessions.setSessionArchived(sessionId, archived);
  setSessionUiHidden = (sessionId: string, hidden: boolean) =>
    this.sessions.setSessionUiHidden(sessionId, hidden);
  projectSessionLive = (sessionId: string, p: Parameters<SessionIndexStore['projectSessionLive']>[1]) =>
    this.sessions.projectSessionLive(sessionId, p);
  getSessionShowCategories = (sessionId: string) => this.sessions.getSessionShowCategories(sessionId);
  studioProfileForSession = (sessionId: string) => this.sessions.studioProfileForSession(sessionId);

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
      for (const sid of this.studios.studioOrderTuple()) {
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
    const names = this.studios.studioNamesDict();
    const teams = this.studios
      .studioOrderTuple()
      .filter((sid) => allowed.has(sid))
      .map((sid) => ({ id: sid, name: names[sid] }));
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

// Assembles the /api/profile payload (frozen JSON shape; originally byte-compatible
// with the Python server) from the studio registry, auth store, and shows store. Moved verbatim out of
// catalog.ts (Catalog), with cross-store calls rewritten to the injected stores.

import {
  DEFAULT_STUDIO_ID,
  emptyActiveStudioApiDict,
  newSessionTitlePrefix,
  SETTING_ACTIVE_SHOW,
  studioToApiDict,
} from '../studio';
import type { StudioProfile } from '../studio';
import type { AuthStore } from './authStore';
import type { AuthUser, ProfileCtx } from './shared';
import { showApiDict } from './showsStore';
import type { ShowsStore } from './showsStore';
import type { StudioRegistry } from './studioRegistry';

export class ProfileAssembler {
  constructor(
    private studios: StudioRegistry,
    private auth: AuthStore,
    private shows: ShowsStore,
  ) {}

  private resolveActiveShowIdForStudio(studioId: string, preferredShowId: string): string {
    const shows = this.shows.listShowsForStudio(studioId);
    const valid = new Set(shows.map((r) => String(r.id)));
    const raw = (preferredShowId || '').trim();
    if (raw && valid.has(raw)) return raw;
    if (shows.length) return String(shows[0].id);
    return '';
  }

  /** _profile_studio_for_user → [profile|null, activeShowId, allowedSet]. */
  profileStudioForUser(userId: string): [StudioProfile | null, string, Set<string>] {
    const allowed = this.auth.authListStudioIdsForUser(userId);
    const alset = new Set(allowed);
    if (alset.size === 0) return [null, '', alset];
    this.auth.authEnsurePrefsRow(userId);
    const row = this.auth.authGetPrefs(userId);
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
    const activeShowId = this.resolveActiveShowIdForStudio(studioId, prefShow);
    return [this.studios.loadStudioProfile(studioId), activeShowId, alset];
  }

  getEffectiveStudioForUser(user: AuthUser | null, oauthConfigured: boolean): StudioProfile | null {
    if (user === null) {
      if (oauthConfigured) return null;
      return this.studios.resolveActiveStudio();
    }
    const [prof] = this.profileStudioForUser(user.id);
    return prof;
  }

  private authSection(user: AuthUser | null, oauthConfigured: boolean): Record<string, unknown> {
    if (user === null) return { logged_in: false, user: null, oauth_configured: oauthConfigured };
    const roleByStudioId = new Map(
      this.auth.authListMembershipsForUser(user.id).map((m) => [m.studioId, m.role]),
    );
    const names = this.studios.studioNamesDict();
    const teams = this.studios
      .studioOrderTuple()
      .filter((sid) => roleByStudioId.has(sid))
      .map((sid) => ({ id: sid, name: names[sid], role: roleByStudioId.get(sid) }));
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

  /** _profile_payload — frozen /api/profile JSON shape (originally byte-compatible
   * with the Python server's). */
  profilePayload(user: AuthUser | null, ctx: ProfileCtx): Record<string, unknown> {
    const { oauthConfigured, adminMeta } = ctx;

    if (user === null && oauthConfigured) {
      return {
        active_studio_id: '',
        active_show_id: '',
        active_studio: emptyActiveStudioApiDict(),
        studios: [],
        studio_settings: this.studios.allStudioSettingsForAllowedStudios(new Set()),
        shows: [],
        new_session_defaults: { title_prefix: 'Episode ', default_frame_rate: 24.0 },
        admin: adminMeta,
        auth: this.authSection(user, oauthConfigured),
      };
    }

    if (user === null) {
      const active = this.studios.resolveActiveStudio();
      const showsRaw = this.shows.listShowsForStudio(active.id);
      let activeShowId = '';
      const rawActiveShow = String(this.studios.getSetting(SETTING_ACTIVE_SHOW) ?? '').trim();
      if (rawActiveShow && showsRaw.some((r) => String(r.id) === rawActiveShow)) {
        activeShowId = rawActiveShow;
      } else if (showsRaw.length) {
        activeShowId = String(showsRaw[0].id);
        this.studios.setSetting(SETTING_ACTIVE_SHOW, activeShowId);
      } else {
        this.studios.setSetting(SETTING_ACTIVE_SHOW, '');
      }
      const studioSettings = this.studios.allStudioSettingsForAllowedStudios(null);
      const studiosForList = this.studios.listStudiosBrief();
      const showsOut: Record<string, unknown>[] = [];
      for (const s of studiosForList) {
        for (const r of this.shows.listShowsForStudio(s.id)) showsOut.push(showApiDict(r));
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
        auth: this.authSection(user, oauthConfigured),
      };
    }

    // Logged-in user.
    const [active, computedShowId, alset] = this.profileStudioForUser(user.id);
    const studioSettings = this.studios.allStudioSettingsForAllowedStudios(alset);
    const studiosForList = this.studios.listStudiosBriefAllowed(alset);
    let shapeActiveStudio: Record<string, unknown>;
    let nsDefaults: Record<string, unknown>;
    let showsOut: Record<string, unknown>[] = [];
    let activeShowId = '';

    if (active === null) {
      showsOut = [];
      activeShowId = '';
      this.auth.authEnsurePrefsRow(user.id);
      this.auth.authSetPrefs(user.id, '', '');
      shapeActiveStudio = emptyActiveStudioApiDict();
      nsDefaults = { title_prefix: 'Episode ', default_frame_rate: 24.0 };
    } else {
      const showsRaw = this.shows.listShowsForStudio(active.id);
      for (const s of studiosForList) {
        for (const r of this.shows.listShowsForStudio(s.id)) showsOut.push(showApiDict(r));
      }
      activeShowId = computedShowId;
      const validIds = new Set(showsRaw.map((r) => String(r.id)));
      if (!validIds.has(activeShowId)) {
        activeShowId = showsRaw.length ? String(showsRaw[0].id) : '';
        this.auth.authSetPrefs(user.id, active.id, activeShowId);
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
      auth: this.authSection(user, oauthConfigured),
    };
  }
}

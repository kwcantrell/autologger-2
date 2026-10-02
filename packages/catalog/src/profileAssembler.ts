// Assembles the /api/profile payload (frozen JSON shape; originally byte-compatible
// with the Python server) from the studio registry, auth store, and shows store. Moved verbatim out of
// catalog.ts (Catalog), with cross-store calls rewritten to the injected stores.

import type { AuthUser, ProfileCtx, Row, StudioProfile } from '@autologger/domain';
import {
  emptyActiveStudioApiDict,
  newSessionTitlePrefix,
  studioToApiDict,
} from '@autologger/domain';
import type { AuthStore } from './authStore';
import type { ShowsStore } from './showsStore';
import { showBriefApiDict } from './showsStore';
import type { StudioRegistry } from './studioRegistry';

/** Consumption-based facade surface (persistence-package-extraction design D3):
 * the 2 members reached externally via `catalog.profile.x()` in
 * `server/src`. `profileStudioForUser` is public on the class but consumed
 * only internally (within this class's own methods) — not part of the
 * externally-reached surface per the membership criterion, so it is NOT on
 * this facade. Property-style function types (design D3). */
export interface ProfileAssemblerFacade {
  getEffectiveStudioForUser: (user: AuthUser) => Promise<StudioProfile | null>;
  profilePayload: (user: AuthUser | null, ctx: ProfileCtx) => Promise<Record<string, unknown>>;
}

export class ProfileAssembler implements ProfileAssemblerFacade {
  constructor(
    private studios: StudioRegistry,
    private auth: AuthStore,
    private shows: ShowsStore,
  ) {}

  /** Resolves the active show id against a pre-fetched show list, so callers
   * fetch each studio's shows at most once per request (finding 5.7). */
  private resolveActiveShowIdForStudio(shows: Row[], preferredShowId: string): string {
    const valid = new Set(shows.map((r) => String(r.id)));
    const raw = (preferredShowId || '').trim();
    if (raw && valid.has(raw)) return raw;
    if (shows.length) return String(shows[0].id);
    return '';
  }

  /** _profile_studio_for_user → [profile|null, activeShowId, allowedSet,
   * activeStudioShows] — the 4th element hands the active studio's show rows
   * (already fetched to resolve the active show) back to the assembler so it
   * never re-queries them (finding 5.7). */
  async profileStudioForUser(
    userId: string,
  ): Promise<[StudioProfile | null, string, Set<string>, Row[]]> {
    const allowed = await this.auth.authListStudioIdsForUser(userId);
    const alset = new Set(allowed);
    if (alset.size === 0) return [null, '', alset, []];
    await this.auth.authEnsurePrefsRow(userId);
    const row = await this.auth.authGetPrefs(userId);
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
    // owner-bootstrap D10: no membership names a known team, so no profile (as with none).
    if (!studioId) return [null, '', alset, []];
    const prefShow = rawS === studioId ? rawSh : '';
    const activeShows = await this.shows.listShowsForStudio(studioId);
    const activeShowId = this.resolveActiveShowIdForStudio(activeShows, prefShow);
    return [await this.studios.loadStudioProfile(studioId), activeShowId, alset, activeShows];
  }

  /** The signed-in user's effective studio (require-login D5: there is no anonymous caller). */
  async getEffectiveStudioForUser(user: AuthUser): Promise<StudioProfile | null> {
    const [prof] = await this.profileStudioForUser(user.id);
    return prof;
  }

  private async authSection(
    user: AuthUser | null,
    oauthConfigured: boolean,
  ): Promise<Record<string, unknown>> {
    if (user === null) return { logged_in: false, user: null, oauth_configured: oauthConfigured };
    const roleByStudioId = new Map(
      (await this.auth.authListMembershipsForUser(user.id)).map((m) => [m.studioId, m.role]),
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
   * with the Python server's).
   *
   * `shows[]` carries the SLIM `showBriefApiDict` entry, not the full
   * `showApiDict` (profile-shows-slimming): the fan-out below covers every show
   * in every studio the caller can reach, so embedding each show's categories
   * and three palettes made this payload grow with the whole account's
   * configuration (measured 52 KB, 48 KB of it `shows[]`) on a request every
   * page load makes. The full per-show config is served by
   * `GET /api/shows?studio_id=…` and `GET /api/shows/:showId`, fetched on
   * demand by the modals that read it. */
  async profilePayload(user: AuthUser | null, ctx: ProfileCtx): Promise<Record<string, unknown>> {
    const { oauthConfigured, adminMeta } = ctx;

    // Signed out (require-login D5: there is no anonymous mode, so this is the only null-user
    // payload).
    if (user === null) {
      return {
        active_studio_id: '',
        active_show_id: '',
        active_studio: emptyActiveStudioApiDict(),
        studios: [],
        studio_settings: await this.studios.allStudioSettingsForAllowedStudios(new Set()),
        shows: [],
        new_session_defaults: { title_prefix: 'Episode ', default_frame_rate: 24.0 },
        admin: adminMeta,
        auth: await this.authSection(user, oauthConfigured),
      };
    }

    // Logged-in user.
    const [active, computedShowId, alset, activeShows] = await this.profileStudioForUser(user.id);
    const studioSettings = await this.studios.allStudioSettingsForAllowedStudios(alset);
    const studiosForList = this.studios.listStudiosBriefAllowed(alset);
    let shapeActiveStudio: Record<string, unknown>;
    let nsDefaults: Record<string, unknown>;
    let showsOut: Record<string, unknown>[] = [];
    let activeShowId = '';

    if (active === null) {
      showsOut = [];
      activeShowId = '';
      await this.auth.authEnsurePrefsRow(user.id);
      await this.auth.authSetPrefs(user.id, '', '');
      shapeActiveStudio = emptyActiveStudioApiDict();
      nsDefaults = { title_prefix: 'Episode ', default_frame_rate: 24.0 };
    } else {
      // profileStudioForUser already fetched the active studio's shows (5.7).
      const showsRaw = activeShows;
      // show-grants D7: `can_access` from one access-set query per profile, spread over the
      // brief entry (which stays a pure function of the row, like the /api/shows serializers).
      const accessible = await this.auth.authListAccessibleShowIds(user.id);
      for (const s of studiosForList) {
        const rows = s.id === active.id ? showsRaw : await this.shows.listShowsForStudio(s.id);
        for (const r of rows) {
          showsOut.push({ ...showBriefApiDict(r), can_access: accessible.has(String(r.id)) });
        }
      }
      activeShowId = computedShowId;
      const validIds = new Set(showsRaw.map((r) => String(r.id)));
      if (!validIds.has(activeShowId)) {
        activeShowId = showsRaw.length ? String(showsRaw[0].id) : '';
        await this.auth.authSetPrefs(user.id, active.id, activeShowId);
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

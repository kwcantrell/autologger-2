// Catalog — thin facade over the D1 domain stores (studioRegistry / authStore /
// showsStore / sessionIndexStore / profileAssembler). Preserves the per-request
// `new Catalog(db)` + init() + method surface that routers call via c.get('catalog').
// The flat delegate methods are a compatibility shim; the `readonly` store fields
// are the forward-looking API. KV login sessions + OAuth CSRF live in auth/identity.ts.

import type { AuthUser, ProfileCtx } from './shared';
import { AuthStore } from './authStore';
import { ProfileAssembler } from './profileAssembler';
import { SessionIndexStore } from './sessionIndexStore';
import { ShowsStore } from './showsStore';
import { StudioRegistry } from './studioRegistry';

export type { AuthUser, ProfileCtx, Row } from './shared';
export { showApiDict, showCategoriesApiShape } from './showsStore';

export class Catalog {
  readonly shows: ShowsStore;
  readonly studios: StudioRegistry;
  readonly auth: AuthStore;
  readonly sessions: SessionIndexStore;
  readonly profile: ProfileAssembler;

  constructor(db: D1Database) {
    this.studios = new StudioRegistry(db);
    this.shows = new ShowsStore(db);
    this.auth = new AuthStore(db);
    this.sessions = new SessionIndexStore(db, this.studios, this.shows);
    this.profile = new ProfileAssembler(this.studios, this.auth, this.shows);
  }

  // --- shows delegates ---
  getShowRow = (showId: string) => this.shows.getShowRow(showId);
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

  // --- profile delegates ---
  profilePayload = (user: AuthUser | null, ctx: ProfileCtx) =>
    this.profile.profilePayload(user, ctx);
  getEffectiveStudioForUser = (user: AuthUser | null, oauthConfigured: boolean) =>
    this.profile.getEffectiveStudioForUser(user, oauthConfigured);
}

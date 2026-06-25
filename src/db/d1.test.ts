import { describe, expect, it } from 'vitest';
import { Catalog } from './d1';

// A stub D1Database — construction must not touch it (init() is never called here).
const stubDb = {} as unknown as D1Database;

describe('Catalog facade', () => {
  const catalog = new Catalog(stubDb);

  it('exposes the domain stores as readonly props', () => {
    for (const key of ['studios', 'auth', 'shows', 'sessions', 'profile'] as const) {
      expect(catalog[key]).toBeDefined();
    }
  });

  it('delegates every router-called method as a function', () => {
    const surface = [
      'init', 'isKnownStudio', 'getSetting', 'setSetting', 'saveStudioSettingsBlob',
      'studioNamesDict', 'studioOrderTuple', 'listStudiosBrief',
      'adminCreateStudio', 'adminDeleteStudio',
      'authGetUserByGoogleSub', 'authGetUserById', 'authCreateUserGoogle',
      'authUpdateUserProfile', 'authUpdateUserNames', 'authUserHasStudio',
      'authListStudioIdsForUser', 'authAddMemberships', 'authGetPrefs', 'authSetPrefs',
      'authSeedPrefsFromGlobals', 'authListUsersAdmin', 'authGetUserRowAny',
      'authSetUserDisabled', 'authRemoveMembership',
      'getShowRow', 'createShow', 'listShowsForStudio', 'updateShowFields',
      'createSessionIndex', 'getSessionIndexRow', 'getSessionJoinedRow',
      'getSessionShowCategories', 'getSessionStudioId', 'listSessionsForShow',
      'projectSessionLive', 'setSessionArchived', 'setSessionUiHidden',
      'updateSessionIndex', 'studioProfileForSession',
      'profilePayload', 'getEffectiveStudioForUser',
    ] as const;
    for (const name of surface) {
      expect(typeof (catalog as unknown as Record<string, unknown>)[name]).toBe('function');
    }
  });
});

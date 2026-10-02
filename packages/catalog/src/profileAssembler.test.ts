// require-login D5: with no anonymous mode, `profilePayload(null, ctx)` is always the signed-out
// payload (the one `GET /api/profile` serves to a signed-out caller), whatever `oauthConfigured`
// says; it never reads or repairs the global active studio or show.
import { emptyActiveStudioApiDict } from '@autologger/domain';
import { describe, expect, it } from 'vitest';
import type { AuthStore } from './authStore';
import { ProfileAssembler } from './profileAssembler';
import type { ShowsStore } from './showsStore';
import type { StudioRegistry } from './studioRegistry';

const untouched = (what: string) => () => {
  throw new Error(`${what} must not be read for a signed-out caller`);
};

function assembler(): ProfileAssembler {
  const studios = {
    allStudioSettingsForAllowedStudios: async (allowed: Set<string> | null) => {
      if (allowed === null || allowed.size !== 0) throw new Error('expected the empty allowed set');
      return {};
    },
    resolveActiveStudio: untouched('the global active studio'),
    getSetting: untouched('a global setting'),
    setSetting: untouched('a global setting'),
    listStudiosBrief: untouched('the studio list'),
  } as unknown as StudioRegistry;
  const shows = { listShowsForStudio: untouched('a studio’s shows') } as unknown as ShowsStore;
  return new ProfileAssembler(studios, {} as AuthStore, shows);
}

describe('profilePayload(null, ctx) is the signed-out shape (require-login D5)', () => {
  for (const oauthConfigured of [true, false]) {
    it(`oauth_configured is taken from ctx (${oauthConfigured})`, async () => {
      const adminMeta = { restart_supported: false };
      const payload = await assembler().profilePayload(null, { oauthConfigured, adminMeta });
      expect(payload).toEqual({
        active_studio_id: '',
        active_show_id: '',
        active_studio: emptyActiveStudioApiDict(),
        studios: [],
        studio_settings: {},
        shows: [],
        new_session_defaults: { title_prefix: 'Episode ', default_frame_rate: 24.0 },
        admin: adminMeta,
        auth: { logged_in: false, user: null, oauth_configured: oauthConfigured },
      });
    });
  }
});

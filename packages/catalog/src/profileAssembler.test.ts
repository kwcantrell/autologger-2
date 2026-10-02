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

describe('profilePayload(user) sets shows[].can_access from the accessible set (show-grants D7)', () => {
  it('one authListAccessibleShowIds call decides each entry', async () => {
    const show = (id: string, studio: string) => ({
      id,
      studio_id: studio,
      name: `Show ${id}`,
      show_code: id.toUpperCase(),
      title_suffix: 'date',
    });
    const showsByStudio: Record<string, ReturnType<typeof show>[]> = {
      t1: [show('a', 't1'), show('b', 't1')],
      t2: [show('c', 't2')],
    };
    const studios = {
      allStudioSettingsForAllowedStudios: async () => ({}),
      listStudiosBriefAllowed: () => [
        { id: 't1', name: 'T1' },
        { id: 't2', name: 'T2' },
      ],
      studioOrderTuple: () => ['t1', 't2'],
      studioNamesDict: () => ({ t1: 'T1', t2: 'T2' }),
      loadStudioProfile: async (id: string) => ({
        id,
        name: id,
        categories: [],
        show_title_format: 'Episode {n}',
        default_frame_rate: 24,
      }),
    } as unknown as StudioRegistry;
    let accessCalls = 0;
    const auth = {
      authListStudioIdsForUser: async () => ['t1', 't2'],
      authEnsurePrefsRow: async () => {},
      authGetPrefs: async () => ({ active_studio_id: 't1', active_show_id: 'a' }),
      authSetPrefs: async () => {},
      authListMembershipsForUser: async () => [
        { studioId: 't1', role: 'member' },
        { studioId: 't2', role: 'admin' },
      ],
      authListAccessibleShowIds: async (userId: string) => {
        accessCalls += 1;
        expect(userId).toBe('u1');
        return new Set(['a', 'c']);
      },
    } as unknown as AuthStore;
    const shows = {
      listShowsForStudio: async (sid: string) => showsByStudio[sid] ?? [],
    } as unknown as ShowsStore;
    const payload = await new ProfileAssembler(studios, auth, shows).profilePayload(
      {
        id: 'u1',
        email: 'u1@example.com',
        given_name: '',
        family_name: '',
        picture_url: '',
      } as never,
      { oauthConfigured: true, adminMeta: {} },
    );
    const out = (payload.shows as Array<{ id: string; can_access: boolean }>).map((s) => [
      s.id,
      s.can_access,
    ]);
    expect(out).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);
    expect(accessCalls).toBe(1);
  });
});

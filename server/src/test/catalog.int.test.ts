import { ValidationError } from '@autologger/domain';
import { describe, expect, it } from 'vitest';
import { anonApp, env, envWith } from './harness';
import {
  adminHeader,
  catalogFor,
  loginCookie,
  seedSession,
  seedShow,
  seedStudio,
  seedUser,
} from './helpers';

describe('catalog studio + auth stores', () => {
  it('creates a studio that appears in the registry after init()', async () => {
    // The StudioRegistry is in-memory: isKnownStudio/listStudiosBrief read
    // `this.names`, populated by init() from studio_definitions.
    // So seed → init() (loads the new row) → it is now known.
    const id = await seedStudio({ name: 'Acme' });
    const cat = catalogFor();
    await cat.init();
    expect(cat.studios.isKnownStudio(id)).toBe(true);
    expect(cat.studios.isKnownStudio('definitely-not-a-studio')).toBe(false);
    expect(cat.studios.listStudiosBrief().some((s) => s.id === id)).toBe(true);
  });

  it('setSetting upserts (insert then update same key)', async () => {
    const cat = catalogFor();
    await cat.studios.setSetting('k', 'v1');
    await cat.studios.setSetting('k', 'v2');
    expect(await cat.studios.getSetting('k')).toBe('v2');
  });

  it('user membership: add, query, remove', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser({ studios: [studio] });
    expect(await cat.auth.authUserHasStudio(user, studio)).toBe(true);
    await cat.auth.authRemoveMembership(user, studio);
    expect(await cat.auth.authUserHasStudio(user, studio)).toBe(false);
  });
});

describe('catalog session index store', () => {
  // session-title-suffix (design D1, gate ruling 2026-08-02): createSessionIndex
  // no longer bumps any per-show next_episode counter — the column is
  // soft-retained (unused) at its create-time default, never advanced.
  it('createSessionIndex does not bump the show next_episode', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const before = Number((await cat.shows.getShowRow(show))?.next_episode ?? 0);
    await seedSession({ showId: show, episode: '005' });
    const after = Number((await cat.shows.getShowRow(show))?.next_episode ?? 0);
    expect(after).toBe(before);
  });

  it('getSessionStudioId resolves the owning studio', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const session = await seedSession({ showId: show });
    expect(await cat.sessions.getSessionStudioId(session)).toBe(studio);
  });

  it('getSessionStudioId returns null for an unknown session', async () => {
    // The audit's "orphan via deleted show" scenario can't be reproduced here:
    // the test-env catalog DB ENFORCES foreign keys, so DELETE FROM shows on a referenced
    // show fails with SQLITE_CONSTRAINT. We exercise the null path via an unknown id.
    const cat = catalogFor();
    expect(await cat.sessions.getSessionStudioId('no-such-session')).toBeNull();
  });

  it('listSessionsForShow scopes to the show (tenant isolation)', async () => {
    const cat = catalogFor();
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const showA = await seedShow({ studioId: studioA });
    const showB = await seedShow({ studioId: studioB });
    const sA = await seedSession({ showId: showA });
    await seedSession({ showId: showB });
    const list = await cat.sessions.listSessionsForShow(showA);
    expect(list.map((r) => String(r.id))).toEqual([sA]);
  });
});

// async-catalog-stores D2/D3. These force interleaving (same-tick calls); the production adapter
// yields only microtasks (design A7), so they guard slice 4 behaviour.
describe('catalog transactions', () => {
  it('a store transaction joins a failing route transaction and rolls back with it', async () => {
    const user = await seedUser();
    const cat = catalogFor();
    await expect(
      cat.tx(async (c) => {
        await c.auth.authUpdateUserProfile(user, { givenName: 'Inside' });
        throw new Error('route failed');
      }),
    ).rejects.toThrow('route failed');
    expect((await cat.auth.authGetUserById(user))?.given_name).toBe('Test');
    expect(await cat.auth.authUpdateUserProfile(user, { givenName: 'Top' })).toBe(true);
    expect((await cat.auth.authGetUserById(user))?.given_name).toBe('Top');
  });

  it('interleaved create-if-missing calls do not collide', async () => {
    const user = await seedUser();
    const cat = catalogFor();
    await Promise.all([cat.auth.authEnsurePrefsRow(user), cat.auth.authEnsurePrefsRow(user)]);
    expect(
      await env.ports.catalog.first('SELECT COUNT(*) AS n FROM user_prefs WHERE user_id = ?', user),
    ).toEqual({ n: 1 });

    const results = await Promise.allSettled([
      cat.studios.adminCreateStudio('dup-team', 'Dup'),
      cat.studios.adminCreateStudio('dup-team', 'Dup'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ValidationError);
    expect(
      await env.ports.catalog.first(
        "SELECT COUNT(*) AS n FROM studio_definitions WHERE id = 'dup-team'",
      ),
    ).toEqual({ n: 1 });
  });
});

// owner-bootstrap D9: the former built-ins are studio_definitions rows (migration 20261004000000),
// so the registry, creation, deletion, rename and settings treat them as ordinary teams.
describe('former built-in teams are data (owner-bootstrap D9)', () => {
  const ADMIN_ENV = envWith({ ADMIN_TOKEN: 'former-builtin-admin' });
  const ADMIN_H = { ...adminHeader('former-builtin-admin'), 'content-type': 'application/json' };

  async function teamAdminCookie(team: string): Promise<string> {
    const user = await seedUser();
    await catalogFor().auth.authAddMembershipWithRole(user, team, 'admin');
    return loginCookie(user);
  }

  it('a fresh registry lists test-studios and test-studio-2 first, in order, then created teams', async () => {
    await seedStudio({ id: 'zz-created' });
    await seedStudio({ id: 'aa-created' });
    const cat = catalogFor();
    await cat.init();
    expect(cat.studios.studioOrderTuple()).toEqual([
      'test-studios',
      'test-studio-2',
      'aa-created',
      'zz-created',
    ]);
    expect(cat.studios.studioNamesDict()).toMatchObject({
      'test-studios': 'Test Studio',
      'test-studio-2': 'Test Studio 2',
    });
  });

  it('creating test-studios through either plane gets the existing-id 400', async () => {
    const viaAdmin = await anonApp.request(
      '/api/admin/studios',
      {
        method: 'POST',
        headers: ADMIN_H,
        body: JSON.stringify({ id: 'test-studios', display_name: 'X' }),
      },
      ADMIN_ENV,
    );
    expect(viaAdmin.status).toBe(400);
    expect(((await viaAdmin.json()) as { detail: string }).detail).toBe(
      'A team with that id already exists.',
    );
    const cookie = await loginCookie(await seedUser());
    const viaTeams = await anonApp.request(
      '/api/teams',
      {
        method: 'POST',
        headers: { Cookie: cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'test-studios', display_name: 'X' }),
      },
      { ...env },
    );
    expect(viaTeams.status).toBe(400);
    expect(((await viaTeams.json()) as { detail: string }).detail).toBe(
      'A team with that id already exists.',
    );
  });

  it('deleting a former built-in is refused only for its shows, on either plane', async () => {
    const viaAdmin = await anonApp.request(
      '/api/admin/studios/test-studios',
      { method: 'DELETE', headers: ADMIN_H },
      ADMIN_ENV,
    );
    expect(viaAdmin.status).toBe(400);
    expect(((await viaAdmin.json()) as { detail: string }).detail).toMatch(/still has 1 show/);
    const cookie = await teamAdminCookie('test-studio-2');
    const viaTeams = await anonApp.request(
      '/api/teams/test-studio-2',
      { method: 'DELETE', headers: { Cookie: cookie } },
      { ...env },
    );
    expect(viaTeams.status).toBe(400);
    expect(((await viaTeams.json()) as { detail: string }).detail).toMatch(/still has 1 show/);
    // With its show gone the former built-in deletes like any team.
    await env.ports.catalog.run("DELETE FROM shows WHERE studio_id = 'test-studios'");
    const again = await anonApp.request(
      '/api/admin/studios/test-studios',
      { method: 'DELETE', headers: ADMIN_H },
      ADMIN_ENV,
    );
    expect(again.status).toBe(200);
    expect(await catalogFor().studios.studioExists('test-studios')).toBe(false);
  });

  it('renameStudio renames a former built-in', async () => {
    await catalogFor().studios.renameStudio('test-studios', 'Renamed Studio');
    const cat = catalogFor();
    await cat.init();
    expect(cat.studios.studioNamesDict()['test-studios']).toBe('Renamed Studio');
  });

  it('getStudioSettingsBlob of an unknown team returns the default and persists nothing', async () => {
    const before = await env.ports.catalog.all(
      "SELECT key, value FROM app_settings WHERE key LIKE 'studio_config:%' ORDER BY key",
    );
    const cat = catalogFor();
    await cat.init();
    const blob = (await cat.studios.getStudioSettingsBlob('nope')) as {
      categories: Array<{ name: string }>;
    };
    expect(blob.categories.map((c) => c.name)).toEqual(['Scene', 'Audio issue', 'Note']);
    const after = await env.ports.catalog.all(
      "SELECT key, value FROM app_settings WHERE key LIKE 'studio_config:%' ORDER BY key",
    );
    expect(after).toEqual(before);
  });

  it('a user whose only membership names an unknown team gets a null profile studio', async () => {
    const user = await seedUser();
    await catalogFor().auth.authAddMembershipWithRole(user, 'no-such-team', 'member');
    const cat = catalogFor();
    await cat.init();
    const [profile] = await cat.profile.profileStudioForUser(user);
    expect(profile).toBeNull();
  });
});

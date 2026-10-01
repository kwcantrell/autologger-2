import { ValidationError } from '@autologger/domain';
import { describe, expect, it } from 'vitest';
import { env } from './harness';
import { catalogFor, seedSession, seedShow, seedStudio, seedUser } from './helpers';

describe('catalog studio + auth stores', () => {
  it('creates a studio that appears in the registry after init()', async () => {
    // The StudioRegistry is in-memory: isKnownStudio/listStudiosBrief read
    // `this.names`, populated by init() from studio_definitions + built-ins.
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

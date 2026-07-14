import { describe, expect, it } from 'vitest';
import { catalogFor, seedSession, seedShow, seedStudio, seedUser } from '../test/helpers';

describe('catalog studio + auth stores', () => {
  it('creates a studio that appears in the registry after init()', async () => {
    // The StudioRegistry is in-memory: isKnownStudio/listStudiosBrief read
    // `this.names`, populated by init() from studio_definitions + built-ins.
    // So seed → init() (loads the new row) → it is now known.
    const id = await seedStudio({ name: 'Acme' });
    const cat = catalogFor();
    await cat.init();
    expect(cat.isKnownStudio(id)).toBe(true);
    expect(cat.isKnownStudio('definitely-not-a-studio')).toBe(false);
    expect(cat.listStudiosBrief().some((s) => s.id === id)).toBe(true);
  });

  it('setSetting upserts (insert then update same key)', async () => {
    const cat = catalogFor();
    await cat.setSetting('k', 'v1');
    await cat.setSetting('k', 'v2');
    expect(await cat.getSetting('k')).toBe('v2');
  });

  it('user membership: add, query, remove', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser({ studios: [studio] });
    expect(await cat.authUserHasStudio(user, studio)).toBe(true);
    await cat.authRemoveMembership(user, studio);
    expect(await cat.authUserHasStudio(user, studio)).toBe(false);
  });
});

describe('catalog session index store', () => {
  it('createSessionIndex bumps the show next_episode', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    await seedSession({ showId: show, episode: '005' });
    const row = await cat.getShowRow(show);
    expect(Number(row?.next_episode ?? 0)).toBeGreaterThanOrEqual(5);
  });

  it('getSessionStudioId resolves the owning studio', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const session = await seedSession({ showId: show });
    expect(await cat.getSessionStudioId(session)).toBe(studio);
  });

  it('getSessionStudioId returns null for an unknown session', async () => {
    // The audit's "orphan via deleted show" scenario can't be reproduced here:
    // the test-env catalog DB ENFORCES foreign keys, so DELETE FROM shows on a referenced
    // show fails with SQLITE_CONSTRAINT. We exercise the null path via an unknown id.
    const cat = catalogFor();
    expect(await cat.getSessionStudioId('no-such-session')).toBeNull();
  });

  it('listSessionsForShow scopes to the show (tenant isolation)', async () => {
    const cat = catalogFor();
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const showA = await seedShow({ studioId: studioA });
    const showB = await seedShow({ studioId: studioB });
    const sA = await seedSession({ showId: showA });
    await seedSession({ showId: showB });
    const list = await cat.listSessionsForShow(showA);
    expect(list.map((r) => String(r.id))).toEqual([sA]);
  });
});

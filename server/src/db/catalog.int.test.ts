import { describe, expect, it } from 'vitest';
import { catalogFor, seedSession, seedShow, seedStudio, seedUser } from '../test/helpers';

describe('catalog studio + auth stores', () => {
  it('creates a studio that appears in the registry after init()', async () => {
    // The StudioRegistry is in-memory: isKnownStudio/listStudiosBrief read
    // `this.names`, populated by init() from studio_definitions + built-ins.
    // So seed → init() (loads the new row) → it is now known.
    const id = seedStudio({ name: 'Acme' });
    const cat = catalogFor();
    cat.init();
    expect(cat.studios.isKnownStudio(id)).toBe(true);
    expect(cat.studios.isKnownStudio('definitely-not-a-studio')).toBe(false);
    expect(cat.studios.listStudiosBrief().some((s) => s.id === id)).toBe(true);
  });

  it('setSetting upserts (insert then update same key)', async () => {
    const cat = catalogFor();
    cat.studios.setSetting('k', 'v1');
    cat.studios.setSetting('k', 'v2');
    expect(cat.studios.getSetting('k')).toBe('v2');
  });

  it('user membership: add, query, remove', async () => {
    const cat = catalogFor();
    const studio = seedStudio();
    const user = seedUser({ studios: [studio] });
    expect(cat.auth.authUserHasStudio(user, studio)).toBe(true);
    cat.auth.authRemoveMembership(user, studio);
    expect(cat.auth.authUserHasStudio(user, studio)).toBe(false);
  });
});

describe('catalog session index store', () => {
  // session-title-suffix (design D1, gate ruling 2026-08-02): createSessionIndex
  // no longer bumps any per-show next_episode counter — the column is
  // soft-retained (unused) at its create-time default, never advanced.
  it('createSessionIndex does not bump the show next_episode', async () => {
    const cat = catalogFor();
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const before = Number(cat.shows.getShowRow(show)?.next_episode ?? 0);
    seedSession({ showId: show, episode: '005' });
    const after = Number(cat.shows.getShowRow(show)?.next_episode ?? 0);
    expect(after).toBe(before);
  });

  it('getSessionStudioId resolves the owning studio', async () => {
    const cat = catalogFor();
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const session = seedSession({ showId: show });
    expect(cat.sessions.getSessionStudioId(session)).toBe(studio);
  });

  it('getSessionStudioId returns null for an unknown session', async () => {
    // The audit's "orphan via deleted show" scenario can't be reproduced here:
    // the test-env catalog DB ENFORCES foreign keys, so DELETE FROM shows on a referenced
    // show fails with SQLITE_CONSTRAINT. We exercise the null path via an unknown id.
    const cat = catalogFor();
    expect(cat.sessions.getSessionStudioId('no-such-session')).toBeNull();
  });

  it('listSessionsForShow scopes to the show (tenant isolation)', async () => {
    const cat = catalogFor();
    const studioA = seedStudio();
    const studioB = seedStudio();
    const showA = seedShow({ studioId: studioA });
    const showB = seedShow({ studioId: studioB });
    const sA = seedSession({ showId: showA });
    seedSession({ showId: showB });
    const list = cat.sessions.listSessionsForShow(showA);
    expect(list.map((r) => String(r.id))).toEqual([sA]);
  });
});

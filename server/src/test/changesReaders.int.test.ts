// Characterization tests pinning the catalog change-detecting readers before
// the catalog seam is reshaped (de-cloudflare-strong-core task 3.1): the
// affected-row count from run() drives removed-membership and
// archived/hidden-session detection. Locks the boolean contract each caller
// branches on.

import { describe, expect, it } from 'vitest';
import { catalogFor, seedSession, seedShow, seedStudio, seedUser } from './helpers';

describe('change-detecting catalog readers (characterization)', () => {
  it('authRemoveMembership: true when a membership row was deleted, false when none matched', async () => {
    const studio = seedStudio();
    const user = seedUser({ studios: [studio] });
    const cat = catalogFor();
    expect(cat.auth.authRemoveMembership(user, studio)).toBe(true);
    // Second delete matches nothing — the count is the only signal.
    expect(cat.auth.authRemoveMembership(user, studio)).toBe(false);
    expect(cat.auth.authRemoveMembership(user, 'never-a-studio')).toBe(false);
  });

  it('setSessionArchived: true for an existing session, false for an unknown id', async () => {
    const show = seedShow({ studioId: seedStudio() });
    const session = seedSession({ showId: show });
    const cat = catalogFor();
    expect(cat.sessions.setSessionArchived(session, true)).toBe(true);
    expect(cat.sessions.setSessionArchived(session, false)).toBe(true);
    expect(cat.sessions.setSessionArchived('no-such-session', true)).toBe(false);
  });

  it('setSessionUiHidden: true for an existing session, false for an unknown id', async () => {
    const show = seedShow({ studioId: seedStudio() });
    const session = seedSession({ showId: show });
    const cat = catalogFor();
    expect(cat.sessions.setSessionUiHidden(session, true)).toBe(true);
    expect(cat.sessions.setSessionUiHidden('no-such-session', true)).toBe(false);
  });

  it('setSessionEpisodeDate: value round-trips through getSessionJoinedRow — the exact row shape serializeSessionEntry (GET /api/sessions/:id) serves', async () => {
    const show = seedShow({ studioId: seedStudio() });
    const session = seedSession({ showId: show });
    const cat = catalogFor();

    // Before any write, the joined row (what the detail route reads) carries
    // no episode_date — matches the "already nullable" frozen-shape claim.
    expect(cat.sessions.getSessionJoinedRow(session)?.episode_date).toBeNull();

    expect(cat.sessions.setSessionEpisodeDate(session, '2024-01-15')).toBe(true);
    const joined = cat.sessions.getSessionJoinedRow(session);
    expect(joined?.episode_date).toBe('2024-01-15');
    // Same column via the other read path the list route (listSessionsForShow)
    // feeds through serializeSessionEntry.
    const listed = cat.sessions.listSessionsForShow(show).find((r) => r.id === session);
    expect(listed?.episode_date).toBe('2024-01-15');

    expect(cat.sessions.setSessionEpisodeDate('no-such-session', '2024-02-02')).toBe(false);
  });

  it('setSessionEpisodeDate: a null/blank iso is a no-op — no UPDATE runs, existing value is untouched', async () => {
    const show = seedShow({ studioId: seedStudio() });
    const session = seedSession({ showId: show });
    const cat = catalogFor();

    expect(cat.sessions.setSessionEpisodeDate(session, null)).toBe(false);
    expect(cat.sessions.setSessionEpisodeDate(session, undefined)).toBe(false);
    expect(cat.sessions.setSessionEpisodeDate(session, '  ')).toBe(false);
    expect(cat.sessions.getSessionJoinedRow(session)?.episode_date).toBeNull();

    // A no-op write must not clobber a previously set value either.
    cat.sessions.setSessionEpisodeDate(session, '2024-03-03');
    expect(cat.sessions.setSessionEpisodeDate(session, null)).toBe(false);
    expect(cat.sessions.getSessionJoinedRow(session)?.episode_date).toBe('2024-03-03');
  });
});

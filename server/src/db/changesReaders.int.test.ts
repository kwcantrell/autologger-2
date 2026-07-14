// Characterization tests pinning the catalog change-detecting readers before
// the catalog seam is reshaped (de-cloudflare-strong-core task 3.1): the
// affected-row count from run() drives removed-membership and
// archived/hidden-session detection. Locks the boolean contract each caller
// branches on.

import { describe, expect, it } from 'vitest';
import { catalogFor, seedSession, seedShow, seedStudio, seedUser } from '../test/helpers';

describe('change-detecting catalog readers (characterization)', () => {
  it('authRemoveMembership: true when a membership row was deleted, false when none matched', async () => {
    const studio = await seedStudio();
    const user = await seedUser({ studios: [studio] });
    const cat = catalogFor();
    expect(cat.auth.authRemoveMembership(user, studio)).toBe(true);
    // Second delete matches nothing — the count is the only signal.
    expect(cat.auth.authRemoveMembership(user, studio)).toBe(false);
    expect(cat.auth.authRemoveMembership(user, 'never-a-studio')).toBe(false);
  });

  it('setSessionArchived: true for an existing session, false for an unknown id', async () => {
    const show = await seedShow({ studioId: await seedStudio() });
    const session = await seedSession({ showId: show });
    const cat = catalogFor();
    expect(cat.sessions.setSessionArchived(session, true)).toBe(true);
    expect(cat.sessions.setSessionArchived(session, false)).toBe(true);
    expect(cat.sessions.setSessionArchived('no-such-session', true)).toBe(false);
  });

  it('setSessionUiHidden: true for an existing session, false for an unknown id', async () => {
    const show = await seedShow({ studioId: await seedStudio() });
    const session = await seedSession({ showId: show });
    const cat = catalogFor();
    expect(cat.sessions.setSessionUiHidden(session, true)).toBe(true);
    expect(cat.sessions.setSessionUiHidden('no-such-session', true)).toBe(false);
  });
});

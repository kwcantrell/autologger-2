// show-grants D8: session create decides show access inside its transaction, reading the member's
// grant FOR SHARE, so a revoke racing the create gives a serial outcome: either the session exists
// (the create committed first) or the create gets 403 and no session row exists.

import { describe, expect, it } from 'vitest';
import { GatedCatalog } from '../test/gatedCatalog';
import { anonApp, env, envWith } from '../test/harness';
import { catalogFor, seedAccessMatrix } from '../test/helpers';

const J = { 'content-type': 'application/json' };
/** The create's grant read, inside its transaction (authCanAccessShowForShare). */
const GRANT_FOR_SHARE = /^SELECT 1 FROM show_grants WHERE user_id = \? AND show_id = \? FOR SHARE$/;

function create(cookie: string, showId: string, title: string, bindings = env) {
  return Promise.resolve(
    anonApp.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: { ...J, cookie },
        body: JSON.stringify({ show_id: showId, title, frame_rate: 24 }),
      },
      bindings,
    ),
  );
}

function revoke(m: Awaited<ReturnType<typeof seedAccessMatrix>>) {
  return Promise.resolve(
    anonApp.request(
      `/api/teams/${m.studioId}/shows/${m.showId}/grants/${m.granted.id}`,
      { method: 'DELETE', headers: { cookie: m.admin.cookie } },
      { ...env },
    ),
  );
}

async function sessionsTitled(showId: string, title: string): Promise<number> {
  const r = await env.ports.catalog.first<{ n: number }>(
    'SELECT COUNT(*) AS n FROM sessions WHERE show_id = ? AND title = ?',
    showId,
    title,
  );
  return Number(r?.n ?? 0);
}

describe('a revoke racing the member’s session create (show-grants D8)', () => {
  it('revoke first: the create gets 403 No access to this show. and no session row exists', async () => {
    const m = await seedAccessMatrix();
    await catalogFor().auth.authSetPrefs(m.granted.id, m.studioId, m.showId);
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.hold(GRANT_FOR_SHARE); // inside the create's transaction, before the grant read
    const pending = create(m.granted.cookie, m.showId, 'Raced A', envWith({}, { catalog: gated }));
    await h.reached;
    expect((await revoke(m)).status).toBe(200);
    h.release();
    const res = await pending;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ detail: 'No access to this show.' });
    expect(await sessionsTitled(m.showId, 'Raced A')).toBe(0);
  });

  it('create first (the grant row locked FOR SHARE): the session exists, then the revoke lands', async () => {
    const m = await seedAccessMatrix();
    await catalogFor().auth.authSetPrefs(m.granted.id, m.studioId, m.showId);
    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.holdAfter(GRANT_FOR_SHARE);
    const pending = create(m.granted.cookie, m.showId, 'Raced B', envWith({}, { catalog: gated }));
    await h.reached;
    const revoking = revoke(m); // waits on the grant row lock (or fails and retries)
    await new Promise((r) => setTimeout(r, 100));
    h.release();
    const res = await pending;
    expect(res.status).toBe(200);
    expect((await revoking).status).toBe(200);
    expect(await sessionsTitled(m.showId, 'Raced B')).toBe(1);
    expect(await catalogFor().auth.authCanAccessShow(m.granted.id, m.showId)).toBe(false);
  });
});

// catalog-policies (ADR 0021 slice 6b-2): routes keep their statuses under the catalog_user
// policies (core-ports-architecture "Policy outcomes keep each route's status"; api-contract-freeze
// "Writes whose access is revoked in flight change nothing").

import { createCatalog } from '@autologger/catalog';
import { describe, expect, it } from 'vitest';
import { anonApp, env } from '../test/harness';
import { loginCookie, seedShow, seedStudio, seedUser } from '../test/helpers';

const J = { 'content-type': 'application/json' };

async function send(
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
  e = env,
): Promise<Response> {
  return anonApp.request(
    path,
    {
      method,
      headers: { ...J, Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    e,
  );
}

describe('existence probes keep their statuses (design D6)', () => {
  it('POST /api/shows: 404 for an existing team of which the caller is not a member, 400 for a missing team', async () => {
    const mine = await seedStudio();
    const foreign = await seedStudio();
    const cookie = await loginCookie(await seedUser({ studios: [mine], role: 'owner' }));
    const res = await send('POST', '/api/shows', cookie, { studio_id: foreign, name: 'X' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: 'Unknown studio id.' });
    const missing = await send('POST', '/api/shows', cookie, {
      studio_id: 'no-such-team',
      name: 'X',
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ detail: 'Unknown studio id.' });
  });

  it("POST /api/sessions: another team's show is 400 Show does not belong to the active team.", async () => {
    const mine = await seedStudio();
    const foreign = await seedStudio();
    const foreignShow = await seedShow({ studioId: foreign });
    const cookie = await loginCookie(await seedUser({ studios: [mine], role: 'owner' }));
    const res = await send('POST', '/api/sessions', cookie, { show_id: foreignShow });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: 'Show does not belong to the active team.' });
  });

  it("a user-bound catalog's existence checks see other teams' rows", async () => {
    const mine = await seedStudio();
    const foreign = await seedStudio();
    const foreignShow = await seedShow({ studioId: foreign });
    const userId = await seedUser({ studios: [mine], role: 'owner' });
    const cat = createCatalog(env.ports.catalog).forUser(userId);
    expect(await cat.studios.studioExistsAnywhere(foreign)).toBe(true);
    expect(await cat.studios.studioExistsAnywhere('no-such-team')).toBe(false);
    expect(await cat.shows.showExistsAnywhere(foreignShow)).toBe(true);
    expect(await cat.shows.showExistsAnywhere('no-such-show')).toBe(false);
  });
});

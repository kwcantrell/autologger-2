// ADR 0021 hazard #5 (catalog-concurrency-hazards D8): the sessions list repairs a missing or stale
// active show, but never over a choice a concurrent profile update just stored.

import { describe, expect, it } from 'vitest';
import { GatedCatalog } from '../test/gatedCatalog';
import { app, env, envWith } from '../test/harness';
import { catalogFor, loginCookie, seedShow, seedStudio, seedUser } from '../test/helpers';

const J = { 'content-type': 'application/json' };

describe('active-show repair vs a concurrent profile update', () => {
  it('logged in: the profile’s choice survives the repair', async () => {
    const studio = await seedStudio();
    await seedShow({ studioId: studio, name: 'A first' });
    const chosen = await seedShow({ studioId: studio, name: 'B chosen' });
    const userId = await seedUser({ studios: [studio] });
    await catalogFor().auth.authSetPrefs(userId, studio, '');
    const cookie = await loginCookie(userId);

    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.hold(/^INSERT INTO user_prefs/);
    const list = app.request('/api/sessions', { method: 'GET', headers: { cookie } }, envWith({}, { catalog: gated }));
    await h.reached;
    const put = await app.request(
      '/api/profile',
      { method: 'PUT', headers: { ...J, cookie }, body: JSON.stringify({ active_studio_id: studio, active_show_id: chosen }) },
      { ...env },
    );
    expect(put.status).toBe(200);
    h.release();
    expect((await list).status).toBe(200);
    expect((await catalogFor().auth.authGetPrefs(userId))?.active_show_id).toBe(chosen);
  });

  it('anonymous: the profile’s choice survives the repair', async () => {
    const studio = 'test-studios';
    const chosen = await seedShow({ studioId: studio, name: 'Zz chosen' });
    await catalogFor().studios.setSetting('active_studio_id', studio);
    await env.ports.catalog.run("DELETE FROM app_settings WHERE key = 'active_show_id'");
    // Store the team's settings first, so the held write is the repair, not the settings default.
    const warm = catalogFor();
    await warm.init();
    await warm.studios.getStudioSettingsBlob(studio);

    const gated = new GatedCatalog(env.ports.catalog);
    const h = gated.hold(/^(INSERT INTO|UPDATE) app_settings/);
    const list = app.request('/api/sessions', { method: 'GET' }, envWith({}, { catalog: gated }));
    await h.reached;
    const put = await app.request(
      '/api/profile',
      { method: 'PUT', headers: J, body: JSON.stringify({ active_studio_id: studio, active_show_id: chosen }) },
      { ...env },
    );
    expect(put.status).toBe(200);
    h.release();
    expect((await list).status).toBe(200);
    expect(await catalogFor().studios.getSetting('active_show_id')).toBe(chosen);
  });
});

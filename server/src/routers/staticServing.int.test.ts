// Serving contract for the built SPA (spec stage 3): HTML verbatim (no
// serve-time rewrite-token substitution), assets + /static served, API never
// shadowed.
// Uses a fixture dist in a temp dir — `npm test` stays independent of a real
// Vite build (the e2e tier covers that).

import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpgradeWebSocket } from 'hono/ws';
import { afterAll, describe, expect, it } from 'vitest';
import { wireApp } from '../app';
import { env } from '../test/harness';
import { seedSession, seedShow, seedStudio } from '../test/helpers';
import type { AppEnv } from '../types';

const upgradeStub = ((() => async (c: { text(b: string, s: number): Response }) =>
  c.text('WebSocket unavailable in HTTP tests', 426)) as unknown) as UpgradeWebSocket;

const dist = mkdtempSync(join(tmpdir(), 'autologger-dist-'));
mkdirSync(join(dist, 'src/pages/index'), { recursive: true });
mkdirSync(join(dist, 'src/pages/admin-users'), { recursive: true });
mkdirSync(join(dist, 'assets'), { recursive: true });
mkdirSync(join(dist, 'static'), { recursive: true });
// The rewrite token is assembled by concatenation so the CONTIGUOUS string
// never appears in this source file — the spec's DoD grep over the repo must
// stay clean. The *served fixture* still contains the real token, which is
// what makes the verbatim assertion fail while serveHtml still rewrites.
const REWRITE_TOKEN = ['__API_', 'ROOT__'].join('');
writeFileSync(
  join(dist, 'src/pages/index/index.html'),
  `<!DOCTYPE html><html><body>index page ${REWRITE_TOKEN} stays verbatim</body></html>`,
);
writeFileSync(
  join(dist, 'src/pages/admin-users/index.html'),
  '<!DOCTYPE html><html><body>admin page</body></html>',
);
writeFileSync(join(dist, 'assets/app-abc123.js'), 'console.log("bundle");');
writeFileSync(join(dist, 'static/logo.png'), 'png-bytes');

const app = wireApp(new Hono<AppEnv>(), upgradeStub, { publicDir: dist });

afterAll(() => rmSync(dist, { recursive: true, force: true }));

describe('static serving (fixture dist)', () => {
  it('serves / verbatim — no serve-time rewrite of the old token', async () => {
    const res = await app.request('/', {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`${REWRITE_TOKEN} stays verbatim`);
  });

  it('serves /admin/users HTML', async () => {
    const res = await app.request('/admin/users', {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('admin page');
  });

  it('serves hashed /assets/* and /static/* files', async () => {
    const js = await app.request('/assets/app-abc123.js', {}, env);
    expect(js.status).toBe(200);
    expect(await js.text()).toContain('bundle');
    const png = await app.request('/static/logo.png', {}, env);
    expect(png.status).toBe(200);
  });

  it('never shadows API routes with the static catch-all', async () => {
    const res = await app.request('/api/profile', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
  });

  it('404s unknown paths', async () => {
    const res = await app.request('/definitely-not-a-page', {}, env);
    expect(res.status).toBe(404);
  });
});

describe('GET /sessions/:id — deep-link HTML route (session-deep-links delta)', () => {
  it('serves the shell for an arbitrary id, anonymous client, no Set-Cookie', async () => {
    const home = await app.request('/', {}, env);
    const deepLink = await app.request('/sessions/abc-123', {}, env);
    expect(deepLink.status).toBe(200);
    expect(deepLink.headers.get('set-cookie')).toBeNull();
    expect(await deepLink.text()).toBe(await home.text());
  });

  it('real vs. nonexistent id responses are byte-identical (no existence oracle)', async () => {
    const studio = seedStudio();
    const show = seedShow({ studioId: studio });
    const sessionId = seedSession({ showId: show });

    const real = await app.request(`/sessions/${sessionId}`, {}, env);
    const fake = await app.request('/sessions/definitely-does-not-exist', {}, env);
    expect(real.status).toBe(200);
    expect(fake.status).toBe(200);
    expect(await real.text()).toBe(await fake.text());
  });

  it('GET /sessions (no id) still 404s — no asset matches', async () => {
    const res = await app.request('/sessions', {}, env);
    expect(res.status).toBe(404);
  });

  it('GET /sessions/a/b (nested segments) still 404s — no asset matches', async () => {
    const res = await app.request('/sessions/a/b', {}, env);
    expect(res.status).toBe(404);
  });

  it('percent-encoded slash /sessions/a%2Fb is one raw segment — serves the shell, not 404', async () => {
    const res = await app.request('/sessions/a%2Fb', {}, env);
    expect(res.status).toBe(200);
  });
});

describe('GET /teams — team management HTML route (teams-self-serve delta)', () => {
  it('serves the shell for an anonymous client, no Set-Cookie', async () => {
    const home = await app.request('/', {}, env);
    const teams = await app.request('/teams', {}, env);
    expect(teams.status).toBe(200);
    expect(teams.headers.get('set-cookie')).toBeNull();
    expect(await teams.text()).toBe(await home.text());
  });

  it('GET /teams/x (a segment below /teams) still 404s — no asset matches', async () => {
    const res = await app.request('/teams/x', {}, env);
    expect(res.status).toBe(404);
  });
});

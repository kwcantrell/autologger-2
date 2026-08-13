import { expect, test } from '@playwright/test';
import { CHROMIUM_DATA_DIR, injectSessionCookie, seedSession } from './seededSession';

// serving-contract.spec.ts (nextjs-frontend-migration, task 4.1)
//
// Raw-HTTP contract coverage for the Next-served shell routes, run against
// the `chromium` project's hermetic server (REQUIRE_LOGIN=0). These assert
// the api-contract-freeze delta's scenarios directly ("Deep link serves the
// shell", "No existence oracle", "Non-matching paths stay 404", "Stray-path
// upgrade disposition" is covered elsewhere) and the web-frontend-platform
// delta's "Image optimizer is not served" scenario — coverage that did not
// exist under the old Vite static-serving path and is new to this change.
// Uses the `request` fixture (a fresh, cookie-free APIRequestContext bound
// to the project's baseURL) so headers are identical across calls and no
// login cookie is ever attached — matching the delta's "identical request
// headers... anonymous" framing.

// The (index) route group's layout.page.tsx sets this exact theme-color
// (design D4) via the `viewport` export — its presence in the response body
// proves a 200 is the actual shell document, not a coincidental 200 from
// some other handler.
const INDEX_THEME_COLOR = '#070b14';
// The (admin) route group's distinct theme-color (design D4).
const ADMIN_THEME_COLOR = '#1e2129';

test.describe('shell routing contract (raw HTTP, anonymous)', () => {
  test('GET / serves the 200 index shell with no Set-Cookie', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    expect(res.headers()['set-cookie']).toBeUndefined();
    const body = await res.text();
    expect(body).toContain(INDEX_THEME_COLOR);
  });

  // web-frontend-platform delta, "Server-rendered shell" requirement, and
  // api-contract-freeze delta, "Deep link serves the shell" scenario —
  // unconditional on session existence, no cookies set.
  test('GET /sessions/does-not-exist-xyz serves the 200 shell unconditionally (unknown-session-serves-shell)', async ({
    request,
  }) => {
    const res = await request.get('/sessions/does-not-exist-xyz');
    expect(res.status()).toBe(200);
    expect(res.headers()['set-cookie']).toBeUndefined();
    const body = await res.text();
    expect(body).toContain(INDEX_THEME_COLOR);
  });

  test('GET /teams serves the 200 shell with no Set-Cookie', async ({ request }) => {
    const res = await request.get('/teams');
    expect(res.status()).toBe(200);
    expect(res.headers()['set-cookie']).toBeUndefined();
    const body = await res.text();
    expect(body).toContain(INDEX_THEME_COLOR);
  });

  test('GET /admin/users serves the 200 admin shell with no Set-Cookie', async ({ request }) => {
    const res = await request.get('/admin/users');
    expect(res.status()).toBe(200);
    expect(res.headers()['set-cookie']).toBeUndefined();
    const body = await res.text();
    expect(body).toContain(ADMIN_THEME_COLOR);
  });

  // web-frontend-platform delta, "Shell routing from the shared route
  // definition" requirement / "Nested session path stays 404" scenario.
  test('GET /sessions/a/b (three raw segments) stays 404', async ({ request }) => {
    const res = await request.get('/sessions/a/b');
    expect(res.status()).toBe(404);
  });

  // Same requirement's "Percent-encoded slash stays a single segment"
  // scenario — `/sessions/a%2Fb` is ONE raw path segment (whose decoded
  // value happens to contain `/`), so it reaches the catch-all as
  // `['sessions', 'a%2Fb']` and serves the shell, matching pre-change
  // behavior. Must NOT be asserted as 404.
  test('GET /sessions/a%2Fb (percent-encoded slash, one raw segment) serves the 200 shell', async ({
    request,
  }) => {
    const res = await request.get('/sessions/a%2Fb');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain(INDEX_THEME_COLOR);
  });

  // web-frontend-platform delta's "Trailing slash stays 404" scenario, and
  // api-contract-freeze's "Non-matching paths stay 404" scenario — enforced
  // in the Hono bridge (app.ts) per the owner ruling recorded in design.md
  // D3 / the phase-2/3 ledger notes (skipTrailingSlashRedirect alone does
  // not suffice against Next 15.5.23's catch-all normalization). `maxRedirects:
  // 0` proves the 404 is immediate — no 308 canonicalizing redirect ever
  // fires, and no `Location` header is present.
  test('GET /teams/ (trailing slash) stays 404 with no redirect', async ({ request }) => {
    const res = await request.get('/teams/', { maxRedirects: 0 });
    expect(res.status()).toBe(404);
    expect(res.headers().location).toBeUndefined();
  });

  test('GET /sessions/abc/ (trailing slash) stays 404 with no redirect', async ({ request }) => {
    const res = await request.get('/sessions/abc/', { maxRedirects: 0 });
    expect(res.status()).toBe(404);
    expect(res.headers().location).toBeUndefined();
  });

  // web-frontend-platform delta's "Image optimizer is not served" scenario.
  // `images.unoptimized: true` (next.config.ts) makes Next's own request
  // handler answer this path with its own 404 (next-server.js: `imagesConfig
  // .unoptimized` short-circuits straight to `render404` before any upstream
  // fetch/resize happens) rather than an optimized image — asserted both
  // ways (never an image content-type; never a 200) so the test fails loudly
  // if a future Next version changes the disabled-optimizer status code.
  test('GET /_next/image is never an optimized image (image optimizer disabled)', async ({
    request,
  }) => {
    const res = await request.get('/_next/image?url=/static/logo-autologger-app.png&w=64&q=75');
    const contentType = res.headers()['content-type'] ?? '';
    expect(contentType.startsWith('image/'), `unexpected image content-type: ${contentType}`).toBe(
      false,
    );
    expect(res.status()).not.toBe(200);
  });
});

test.describe('no existence oracle (api-contract-freeze delta)', () => {
  // Seeds a session in each of the four states the delta names — existing,
  // deleted (ui_hidden), a foreign team's session, and a random nonexistent
  // id — then fetches `GET /sessions/<id>` for each with the `request`
  // fixture (fresh per test, no cookies, identical headers across calls).
  //
  // What this proves, precisely (per task 4.1's "implement the strongest
  // practical assertion and record exactly what it proves"):
  //   1. Same-id determinism: each id's shell body is byte-identical across
  //      two independent fetches.
  //   2. Cross-id identity modulo the echoed id: after substituting each
  //      id's own string for a common placeholder, all four canonicalized
  //      bodies are byte-identical — the ONLY difference between the four
  //      states' responses is the framework's echoed route param, exactly
  //      as design D6.1 declares ("Next embeds the requested route in the
  //      document... no part of any response derives from session or
  //      catalog data").
  //   3. No data leakage: none of the four bodies contain any of the seeded
  //      sessions' distinctive titles, so a leak that happened to dodge the
  //      substitution check in (2) (e.g. a title containing another id's
  //      substring) is still caught directly.
  // This does NOT prove byte-identity with `/` (D6.1 explicitly retires
  // that) and does not exercise authenticated/cookie-bearing requests (out
  // of scope for the HTML layer, which reads no cookies by design).
  test('shell HTML for existing/deleted/foreign-team/random session ids differs only in the echoed id', async ({
    request,
    browser,
    baseURL,
  }) => {
    test.skip(!baseURL, 'baseURL is required (set by the chromium project)');

    const unique = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    const EXISTING_TITLE = `E2E-ORACLE-EXISTING-${unique}`;
    const DELETED_TITLE = `E2E-ORACLE-DELETED-${unique}`;
    const FOREIGN_TITLE = `E2E-ORACLE-FOREIGN-${unique}`;

    // --- existing + deleted: seeded anonymously against the default
    // ('test-studios') studio — the chromium project's server has OAuth off,
    // so anonymous show/session creation is permitted (showsRouter/sessionsRouter
    // only gate on `user !== null` membership checks).
    const showRes = await request.post('/api/shows', {
      data: { studio_id: 'test-studios', name: `E2E Oracle Show ${unique}` },
    });
    expect(showRes.ok(), await showRes.text()).toBe(true);
    const { show } = (await showRes.json()) as { show: { id: string } };

    const existingCreateRes = await request.post('/api/sessions', {
      data: { show_id: show.id, title: EXISTING_TITLE, frame_rate: 24, start_offset_frames: 0 },
    });
    expect(existingCreateRes.ok(), await existingCreateRes.text()).toBe(true);
    const existingId = ((await existingCreateRes.json()) as { id: string }).id;

    const deletedCreateRes = await request.post('/api/sessions', {
      data: { show_id: show.id, title: DELETED_TITLE, frame_rate: 24, start_offset_frames: 0 },
    });
    expect(deletedCreateRes.ok(), await deletedCreateRes.text()).toBe(true);
    const deletedId = ((await deletedCreateRes.json()) as { id: string }).id;
    const delRes = await request.delete(`/api/sessions/${deletedId}`);
    expect(delRes.ok(), await delRes.text()).toBe(true);

    // --- foreign-team: a session under 'test-studio-2' (the OTHER built-in
    // studio — packages/domain/src/studio.ts BUILTIN_STUDIO_ORDER), created
    // by a real authenticated seeded user whose active studio is
    // 'test-studio-2' (an anonymous requester's effective studio always
    // resolves to the DEFAULT 'test-studios' — profileAssembler.ts
    // getEffectiveStudioForUser — so genuinely reaching the other studio
    // needs a real membership, not just a studio_id query param). Seeded via
    // a SEPARATE browser context carrying the login cookie; the shell fetch
    // itself below still uses the cookie-free `request` fixture.
    const foreignContext = await browser.newContext();
    let foreignId = '';
    try {
      const seeded = await seedSession({
        dataDir: CHROMIUM_DATA_DIR,
        label: `oracle-foreign-${unique}`,
        memberships: [{ studioId: 'test-studio-2', role: 'admin' }],
      });
      await injectSessionCookie(foreignContext, baseURL as string, seeded.token);

      const foreignShowRes = await foreignContext.request.post('/api/shows', {
        data: { studio_id: 'test-studio-2', name: `E2E Oracle Foreign Show ${unique}` },
      });
      expect(foreignShowRes.ok(), await foreignShowRes.text()).toBe(true);
      const { show: foreignShow } = (await foreignShowRes.json()) as { show: { id: string } };

      const foreignCreateRes = await foreignContext.request.post('/api/sessions', {
        data: {
          show_id: foreignShow.id,
          title: FOREIGN_TITLE,
          frame_rate: 24,
          start_offset_frames: 0,
        },
      });
      expect(foreignCreateRes.ok(), await foreignCreateRes.text()).toBe(true);
      foreignId = ((await foreignCreateRes.json()) as { id: string }).id;
    } finally {
      await foreignContext.close();
    }
    expect(foreignId, 'foreign-team session must have been created').not.toBe('');

    const randomId = `e2e-oracle-random-${crypto.randomUUID()}`;

    const ids: Record<string, string> = {
      existing: existingId,
      deleted: deletedId,
      foreign: foreignId,
      random: randomId,
    };

    // (1) Same-id determinism.
    const bodies: Record<string, string> = {};
    for (const [label, id] of Object.entries(ids)) {
      const r1 = await request.get(`/sessions/${id}`);
      const r2 = await request.get(`/sessions/${id}`);
      expect(r1.status(), label).toBe(200);
      expect(r2.status(), label).toBe(200);
      expect(r1.headers()['set-cookie'], label).toBeUndefined();
      const b1 = await r1.text();
      const b2 = await r2.text();
      expect(b1, `${label}: same id fetched twice must be byte-identical`).toBe(b2);
      bodies[label] = b1;
    }

    // (2) Cross-id identity after substituting each response's own echoed id.
    const canonical: Record<string, string> = {};
    for (const [label, id] of Object.entries(ids)) {
      canonical[label] = bodies[label].split(id).join('__SESSION_ID__');
    }
    const labels = Object.keys(canonical);
    const [firstLabel, ...restLabels] = labels;
    for (const label of restLabels) {
      expect(
        canonical[label],
        `${label} vs ${firstLabel}: shell bodies must be identical once the echoed id is substituted out`,
      ).toBe(canonical[firstLabel]);
    }

    // (3) No leakage of any seeded session's distinctive title into any of
    // the four responses (defense-in-depth beyond the substitution check).
    for (const title of [EXISTING_TITLE, DELETED_TITLE, FOREIGN_TITLE]) {
      for (const [label, body] of Object.entries(bodies)) {
        expect(body.includes(title), `${label} response leaked seeded title "${title}"`).toBe(
          false,
        );
      }
    }
  });
});

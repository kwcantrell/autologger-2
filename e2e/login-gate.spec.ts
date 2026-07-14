import { expect, type Page, test } from '@playwright/test';

// login-gate.spec.ts (add-login-screen, task 3.1)
//
// Runs against the `login-gate` Playwright project's own hermetic server
// (playwright.config.ts's second `webServer` entry: REQUIRE_LOGIN=1, dummy
// but "configured" Google creds — see that file for why "configured" here
// never means "reachable"). The shared `chromium` project's server forces
// OAuth off and the whole rest of the suite depends on that, so this file is
// carved out via testMatch/testIgnore rather than sharing a server.
//
// NEVER click `#login-btn-google` / `#login-btn-create-account` /
// `#login-error-retry` — all three navigate to `/auth/google/start`, which
// 302s to a real accounts.google.com with dummy creds. Every test below also
// blocks that host so a future "let's click through" regression fails loudly
// in CI instead of silently reaching (or hanging on) Google.

async function blockGoogleNavigation(page: Page): Promise<void> {
  await page.route('https://accounts.google.com/**', (route) => route.abort());
}

/**
 * Belt-and-braces alongside `blockGoogleNavigation`: a `request` listener that
 * flags any hit to accounts.google.com, so a future click-through regression
 * fails on an explicit assertion even if the route-abort itself were ever
 * loosened or bypassed.
 */
function trackGoogleHit(page: Page): () => boolean {
  let googleHit = false;
  page.on('request', (req) => {
    if (new URL(req.url()).hostname === 'accounts.google.com') googleHit = true;
  });
  return () => googleHit;
}

test.describe('login gate (REQUIRE_LOGIN=1, OAuth dummy-configured)', () => {
  test('renders the login view instead of the app shell; sign-in/create-account hrefs; no authenticated traffic', async ({
    page,
  }) => {
    const apiPaths: string[] = [];
    const webSocketUrls: string[] = [];
    let googleHit = false;

    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.hostname === 'accounts.google.com') googleHit = true;
      if (url.pathname.startsWith('/api/')) apiPaths.push(url.pathname);
    });
    page.on('websocket', (ws) => webSocketUrls.push(ws.url()));
    await blockGoogleNavigation(page);

    await page.goto('/');

    // Login view renders (its landmark is visible)...
    await expect(page.locator('#login-wordmark')).toBeVisible();
    // ...and the app shell never mounts. #v6-app is AppShell's own root
    // marker (see web/src/pages/index/AppShell.tsx); RootGate's
    // loading/error markers must also be gone by the time we've settled on
    // the login view.
    await expect(page.locator('#v6-app')).toHaveCount(0);
    await expect(page.locator('#root-gate-loading')).toHaveCount(0);
    await expect(page.locator('#root-gate-error')).toHaveCount(0);

    // Both entry controls navigate to the existing /auth/google/start route
    // (spec "Google sign-in entry") — href only, never clicked.
    await expect(page.locator('#login-btn-google')).toHaveAttribute('href', '/auth/google/start');
    await expect(page.locator('#login-btn-create-account')).toHaveAttribute(
      'href',
      '/auth/google/start',
    );

    // Settle: give any stray authenticated fetch or socket a beat to fire
    // before asserting silence (spec "Login-page render gate": no
    // authenticated /api/* requests or WebSocket connections while gated).
    await page.waitForTimeout(500);
    expect(apiPaths.every((p) => p === '/api/profile')).toBe(true);
    expect(apiPaths.length).toBeGreaterThan(0);
    expect(webSocketUrls).toEqual([]);
    expect(googleHit).toBe(false);
  });

  test('?login_error=state_invalid shows the expired message', async ({ page }) => {
    const googleHit = trackGoogleHit(page);
    await blockGoogleNavigation(page);
    await page.goto('/?login_error=state_invalid');

    await expect(page.locator('#login-wordmark')).toBeVisible();
    await expect(page.locator('#login-error-banner')).toContainText(
      'This sign-in attempt expired.',
    );
    await expect(page.locator('#login-error-retry')).toHaveAttribute('href', '/auth/google/start');
    expect(googleHit()).toBe(false);
  });

  test('an unrecognized login_error code shows the generic message', async ({ page }) => {
    const googleHit = trackGoogleHit(page);
    await blockGoogleNavigation(page);
    // Not one of the server's six known codes — the client must treat it
    // identically to the generic group (spec "Login-error rendering").
    await page.goto('/?login_error=some_future_code');

    await expect(page.locator('#login-wordmark')).toBeVisible();
    await expect(page.locator('#login-error-banner')).toContainText("Sign-in didn't complete.");
    expect(googleHit()).toBe(false);
  });

  // session-deep-links (task 8.3, spec: web-login-experience "Anonymous deep
  // link keeps its URL"). The gate is a render switch mounted ABOVE the
  // router (it covers every route, not just `/`), so an anonymous visit to a
  // session deep link must render the login view with the address bar left
  // exactly where it landed — no redirect to `/` — and must not fetch the
  // session (only GET /api/profile is allowed while gated). The sign-in
  // anchors' hrefs staying `/auth/google/start` at this URL is the contract
  // phase 6's post-login stash write depends on (a phase-6 review finding).
  test('anonymous deep link to /sessions/<id> renders the login view without redirecting, and keeps the sign-in hrefs', async ({
    page,
  }) => {
    const apiPaths: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname.startsWith('/api/')) apiPaths.push(url.pathname);
    });
    await blockGoogleNavigation(page);

    await page.goto('/sessions/deep-link-e2e-probe');

    await expect(page.locator('#login-wordmark')).toBeVisible();
    await expect(page.locator('#v6-app')).toHaveCount(0);

    // No redirect to `/` — the address bar stays on the deep link.
    await expect(page).toHaveURL('/sessions/deep-link-e2e-probe');

    // The sign-in affordances keep their plain hrefs at this URL — phase 6's
    // synchronous onClick stash write rides these same anchors.
    await expect(page.locator('#login-btn-google')).toHaveAttribute('href', '/auth/google/start');
    await expect(page.locator('#login-btn-create-account')).toHaveAttribute(
      'href',
      '/auth/google/start',
    );

    // No session data is fetched while gated — only /api/profile.
    await page.waitForTimeout(500);
    expect(apiPaths.every((p) => p === '/api/profile')).toBe(true);
    expect(apiPaths.length).toBeGreaterThan(0);
  });

  // teams-self-serve (task 7.3, spec: web-login-experience "Teams deep link
  // survives the sign-in round-trip" generalizes the same "Anonymous deep
  // link keeps its URL" contract to `/teams` — the stashable-route set now
  // includes `/teams` alongside `/sessions/:id` (task 5.1's shared
  // route-definition module). Mirrors the /sessions/<id> test above.
  test('anonymous visit to /teams renders the login view without redirecting, and keeps the sign-in hrefs', async ({
    page,
  }) => {
    const apiPaths: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname.startsWith('/api/')) apiPaths.push(url.pathname);
    });
    await blockGoogleNavigation(page);

    await page.goto('/teams');

    await expect(page.locator('#login-wordmark')).toBeVisible();
    await expect(page.locator('#v6-app')).toHaveCount(0);

    // No redirect to `/` — the address bar stays on /teams.
    await expect(page).toHaveURL('/teams');

    // The sign-in affordances keep their plain hrefs at this URL — the
    // synchronous onClick stash write rides these same anchors.
    await expect(page.locator('#login-btn-google')).toHaveAttribute('href', '/auth/google/start');
    await expect(page.locator('#login-btn-create-account')).toHaveAttribute(
      'href',
      '/auth/google/start',
    );

    // No teams data is fetched while gated — only /api/profile.
    await page.waitForTimeout(500);
    expect(apiPaths.every((p) => p === '/api/profile')).toBe(true);
    expect(apiPaths.length).toBeGreaterThan(0);
  });
});

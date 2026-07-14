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
    await blockGoogleNavigation(page);
    await page.goto('/?login_error=state_invalid');

    await expect(page.locator('#login-wordmark')).toBeVisible();
    await expect(page.locator('#login-error-banner')).toContainText(
      'This sign-in attempt expired.',
    );
    await expect(page.locator('#login-error-retry')).toHaveAttribute('href', '/auth/google/start');
  });

  test('an unrecognized login_error code shows the generic message', async ({ page }) => {
    await blockGoogleNavigation(page);
    // Not one of the server's six known codes — the client must treat it
    // identically to the generic group (spec "Login-error rendering").
    await page.goto('/?login_error=some_future_code');

    await expect(page.locator('#login-wordmark')).toBeVisible();
    await expect(page.locator('#login-error-banner')).toContainText("Sign-in didn't complete.");
  });
});

import { expect, test } from '@playwright/test';
import { CHROMIUM_DATA_DIR, injectSessionCookie, seedSession } from './seededSession';

// seeded-session.spec.ts (teams-self-serve, task 7.1)
//
// Trivial proof that the seeded-session fixture works end-to-end: seed a
// user directly into the chromium project's hermetic server DB, inject the
// resulting login cookie into a fresh browser context, and confirm an
// authenticated `GET /api/profile` (fetched by the app itself, not curl)
// resolves to the seeded user — not the anonymous fallback the rest of this
// suite otherwise runs as (`REQUIRE_LOGIN=0` on this project's server).
// See seededSession.ts for the seeding mechanism and WAL-concurrency notes.

test('seeded login cookie resolves to the seeded user on GET /api/profile', async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(!baseURL, 'baseURL is required (set by the chromium project)');

  const seeded = await seedSession({
    dataDir: CHROMIUM_DATA_DIR,
    label: 'proof',
    memberships: [{ studioId: 'test-studios', role: 'member' }],
  });
  await injectSessionCookie(context, baseURL as string, seeded.token);

  const profileResponse = page.waitForResponse(
    (res) => new URL(res.url()).pathname === '/api/profile' && res.request().method() === 'GET',
  );
  await page.goto('/');
  const res = await profileResponse;
  const body = (await res.json()) as {
    auth: { logged_in: boolean; user: { email: string } | null };
  };

  expect(body.auth.logged_in).toBe(true);
  expect(body.auth.user?.email).toBe(seeded.email);

  // Also confirm the app itself rendered the authenticated shell (not the
  // anonymous-dev workspace) — #v6-app is AppShell's own root marker.
  await expect(page.locator('#v6-app')).toBeVisible();
});

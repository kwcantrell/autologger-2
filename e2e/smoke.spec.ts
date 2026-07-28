import { expect, test } from '@playwright/test';
import { createSession } from './createSession';

test('workspace shell renders with no page errors', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await page.goto('/');
  // ui-refresh: the home placeholder is now the branded launch surface
  // (HomeRoute.tsx, `#home-launch`) — assert the wordmark + stable New
  // Session id rather than the retired placeholder copy.
  await expect(page.getByRole('heading', { name: 'AutoLogger' })).toBeVisible();
  await expect(page.locator('#home-new-session')).toBeVisible();
  expect(errors).toEqual([]);
});

test('/admin/users renders', async ({ page }) => {
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Admin Users' })).toBeVisible();
});

test('create a session, log via UI, and see an out-of-band event live (WS)', async ({ page }) => {
  // Scenario 2: create a session through the UI (shared helper). #ns-show is a
  // Radix Select trigger (not a native <select>); the anonymous default studio
  // owns exactly one show, so "Autolog Test Show" is preselected — assert,
  // don't select. session-deep-links (task 8.1): sessions are URL-driven — the
  // active session lives in the address bar (`/sessions/<id>`), not in a
  // `body.dataset.sessionId` attribute (that legacy spine was removed in
  // phase 3; see web-session-routing "Legacy selection spine retired") — the
  // helper asserts the URL.
  await createSession(page, { expectShowText: 'Autolog Test Show' });

  // Roll timecode so category buttons enable, then log via the "Scene" button.
  await page.locator('#btn-ctl-2').click();
  const sceneBtn = page
    .locator('#cat-strip-live-slot [data-category-id]')
    .filter({ hasText: 'Scene' });
  await expect(sceneBtn).toBeEnabled();
  await sceneBtn.click();
  // Row cells carry hashed CSS-module classes — anchor on tr[data-event-id].
  await expect(
    page.locator('#v4-log-sheet tr[data-event-id]').filter({ hasText: 'Scene' }).first(),
  ).toBeVisible();

  // Scenario 3: out-of-band POST; the row must appear with NO reload, focus
  // change, or page interaction — otherwise React Query's refetchOnWindowFocus
  // could fetch over HTTP and mask a dead WebSocket.
  const sessionId = new URL(page.url()).pathname.split('/').pop();
  expect(sessionId).toBeTruthy();
  const categoryId = await sceneBtn.getAttribute('data-category-id');
  expect(categoryId).toBeTruthy();
  await page.evaluate(
    async ({ sid, cat }) => {
      const res = await fetch(`/api/sessions/${sid}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: cat, message: 'e2e-live-probe' }),
      });
      if (!res.ok) throw new Error(`POST /events failed: ${res.status}`);
    },
    { sid: sessionId as string, cat: categoryId as string },
  );
  // While rolling, EventLogRow's `editable` branch renders the message cell
  // as an <input> (inline rolling edit) rather than a plain text span — an
  // input's value isn't part of its textContent, so `hasText` can't see it.
  // Multiple rows exist (the earlier "Scene" log too), so match the input by
  // its live value rather than position.
  await expect(
    page.locator(
      '#v4-log-sheet tr[data-event-id] input[aria-label="Message"][value="e2e-live-probe"]',
    ),
  ).toBeVisible({ timeout: 10_000 });
});

// session-deep-links (task 8.2): deep-link smoke, same hermetic (OAuth-off)
// server as the tests above. Covers "Deep-link reload restores the session"
// (web-session-routing) and the not-found resolution state.
test('deep-linking: a fresh reload on /sessions/<id> restores the session; a garbage id renders not-found', async ({
  page,
}) => {
  await createSession(page);
  const sessionUrl = page.url();

  // Fresh navigation (full page load, not an in-app transition) to the exact
  // same deep link: resolution re-runs from scratch and the workspace mounts
  // again for the same id — the session survives the reload.
  await page.goto(sessionUrl);
  await expect(page).toHaveURL(sessionUrl);
  await expect(page.locator('#v3-session-grid')).not.toHaveClass(/hidden/);
  await expect(page.locator('#session-route-not-found')).toHaveCount(0);

  // An id that was never created renders the not-found state (identical for
  // nonexistent, deleted, and unauthorized ids) — never the workspace — with
  // a way back to `/`.
  await page.goto('/sessions/does-not-exist-xyz');
  await expect(page.locator('#session-route-not-found')).toBeVisible();
  await expect(page.locator('#v3-session-grid')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to sessions' }).click();
  await expect(page).toHaveURL('/');
});

// web-session-console (task 8.2, phase-6 reviewer note): the narrow-viewport
// tab-strip scroll requirement ("Tab strip on narrow viewports" scenario)
// had no functional coverage — only the (screenshot-only, non-interactive)
// visual baselines touched a mobile viewport. Runs in this file (the
// `chromium` project's hermetic server) rather than visual.spec.ts, since
// it asserts real scroll geometry and keyboard/pointer reachability, not
// pixels.
test.describe('narrow viewport tab strip', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Feed tabs tablist scrolls horizontally and every tab stays reachable', async ({ page }) => {
    // The rail is an off-canvas drawer below 768px (V6Rail.tsx) — the shared
    // helper opens it (openRailIfMobile) before reaching New Session.
    await createSession(page);

    const feedTabs = page.getByRole('tablist', { name: 'Feed tabs' });
    await expect(feedTabs).toBeVisible();
    const [scrollWidth, clientWidth] = await feedTabs.evaluate((el) => [
      el.scrollWidth,
      el.clientWidth,
    ]);
    // Five single-line tab labels (Event Feed, Transcript, Topics, Assistant,
    // Dashboards) overflow a 390px-wide strip — the tablist scrolls
    // (`max-md:overflow-x-auto`) instead of wrapping.
    expect(scrollWidth).toBeGreaterThan(clientWidth);

    // The last tab, offscreen at rest, is reachable and clickable —
    // "every tab remains reachable by keyboard" (spec scenario), exercised
    // here via `scrollIntoViewIfNeeded` + a real click rather than a
    // screenshot.
    const dashboardsTab = feedTabs.getByRole('tab', { name: 'Dashboards' });
    await dashboardsTab.scrollIntoViewIfNeeded();
    await dashboardsTab.click();
    await expect(dashboardsTab).toHaveAttribute('aria-selected', 'true');
  });
});

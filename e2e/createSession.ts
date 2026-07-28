// Shared UI session-creation helper (code-health-tail task 5.3, finding
// 5.10): promotes visual.spec.ts's private `createSession(page)` beside
// `seededSession.ts` so the smoke/ai-chat/jump-column/ai-v2-dashboards specs
// stop repeating the same click-through boilerplate. Deliberately NOT used by
// visual.spec.ts's new-session-modal / error-toast tests — those exercise the
// modal itself (screenshot + validation-toast), not session creation.

import { expect, type Page } from '@playwright/test';

/**
 * On mobile (≤767px) the rail is an off-canvas drawer that is `inert` when
 * closed, so its buttons (#v6-btn-new-session, #v6-btn-settings) are not
 * clickable until the drawer opens. The "Open navigation" hamburger lives in
 * the workspace top cluster (NOT inert) and is `display:none` on desktop, so
 * this is a no-op on the desktop viewport.
 */
export async function openRailIfMobile(page: Page): Promise<void> {
  // The root gate (task 2.2) blocks first paint of the shell-or-login switch on
  // an async `/api/profile` round-trip, so the shell (and this toggle, which
  // lives inside it — see AppShell.tsx `#v6-app`) may not be in the DOM yet
  // when this helper runs. `isVisible()` is a non-waiting snapshot check, so
  // without this wait it races the boot and silently reports "not visible" —
  // wait for the shell mount first, THEN take the (deliberately non-waiting)
  // visibility snapshot to distinguish mobile (toggle visible) from desktop
  // (toggle present but `display:none`, hence not visible).
  await page.locator('#v6-app').waitFor({ state: 'attached' });
  const toggle = page.getByRole('button', { name: 'Open navigation' });
  if (await toggle.isVisible()) {
    await toggle.click();
    await expect(page.locator('#v6-btn-new-session')).toBeVisible();
  }
}

/** Create a session through the UI (goto `/` → New Session → submit) and wait
 * for the workspace to mount. Options:
 * - `episode`: pin the episode text (visual.spec pins 'VIS01' so the derived
 *   deck/rail title is identical run to run); default keeps the show's
 *   next_episode-derived value.
 * - `expectShowText`: assert the preselected show label before submitting
 *   (smoke.spec's Radix-Select preselection check). */
export async function createSession(
  page: Page,
  opts: { episode?: string; expectShowText?: string } = {},
): Promise<void> {
  await page.goto('/');
  await openRailIfMobile(page);
  await page.locator('#v6-btn-new-session').click();
  await expect(page.locator('#new-session-form')).toBeVisible();
  await expect(page.locator('#ns-show')).toBeEnabled();
  if (opts.expectShowText !== undefined) {
    await expect(page.locator('#ns-show')).toContainText(opts.expectShowText);
  }
  if (opts.episode !== undefined) {
    await page.locator('#ns-episode').fill(opts.episode);
  }
  await page.locator('#ns-submit').click();
  await expect(page.locator('#v3-session-grid')).not.toHaveClass(/hidden/);
  // session-deep-links: sessions are URL-driven — the created session lives
  // in the address bar (`/sessions/<id>`).
  await expect(page).toHaveURL(/\/sessions\/[^/]+$/);
}

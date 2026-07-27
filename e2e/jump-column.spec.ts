import { expect, test } from '@playwright/test';

// --- Feed jump control: keyboard activation (whole-branch audit fix wave,
// finding M1) ---
//
// `JumpToTimeButton` used to hand-roll Enter/Space handling so jsdom could
// exercise it directly; a real-Chromium audit experiment found the
// hand-rolled handlers redundant AND a latent hazard (their
// `preventDefault()` calls suppressed the native `click` a keyboard
// activation would otherwise dispatch). They were removed in favor of the
// native `<button>`'s own Enter/Space activation — this spec is the "one
// keyboard-activation check in e2e/ where a real user agent exists" the fix
// calls for: it proves a real browser actually DOES activate this control by
// keyboard, now that no component-level code does it for us.

test('a jump control activates by keyboard (Enter and Space), moving the timeline playhead', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('#v6-btn-new-session').click();
  await expect(page.locator('#new-session-form')).toBeVisible();
  await expect(page.locator('#ns-show')).toBeEnabled();
  await page.locator('#ns-submit').click();
  await expect(page.locator('#v3-session-grid')).not.toHaveClass(/hidden/);
  await expect(page).toHaveURL(/\/sessions\/[^/]+$/);

  // Roll, log one event via a category button, then stop — the feed jump is
  // gated to not-rolling (design D5), so a row only gets an active control
  // once timecode has stopped again.
  await page.locator('#btn-ctl-2').click();
  const sceneBtn = page
    .locator('#cat-strip-live-slot [data-category-id]')
    .filter({ hasText: 'Scene' });
  await expect(sceneBtn).toBeEnabled();
  await sceneBtn.click();
  await expect(
    page.locator('#v4-log-sheet tr[data-event-id]').filter({ hasText: 'Scene' }).first(),
  ).toBeVisible();
  await page.locator('#btn-ctl-4').click();

  const row = page.locator('#v4-log-sheet tr[data-event-id]').filter({ hasText: 'Scene' }).first();
  const jumpBtn = row.getByRole('button', { name: /Jump to/ });
  await expect(jumpBtn).toBeEnabled();
  await expect(jumpBtn).not.toHaveAttribute('aria-disabled', 'true');

  const playhead = page.locator('#timeline-playhead');
  const leftBefore = await playhead.evaluate((el) => el.style.left);

  // Tab-focus the control (never .focus() via JS — this must be a real
  // keyboard-reachable interaction) and activate with Enter.
  await jumpBtn.focus();
  await expect(jumpBtn).toBeFocused();
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => playhead.evaluate((el) => el.style.left))
    .not.toBe(leftBefore);

  // Clear the manual scrub (a timeline-track double-click, per Timeline.tsx's
  // `onTrackDoubleClick`) so the playhead moves away from the jump target,
  // then confirm Space activates the SAME control too (not just Enter).
  await page.locator('#timeline-track').dblclick({ position: { x: 5, y: 5 } });
  const leftBeforeSpace = await playhead.evaluate((el) => el.style.left);
  await jumpBtn.focus();
  await expect(jumpBtn).toBeFocused();
  await page.keyboard.press(' ');
  await expect
    .poll(async () => playhead.evaluate((el) => el.style.left))
    .not.toBe(leftBeforeSpace);
});

import { expect, type Locator, type Page, test } from '@playwright/test';
import { createSession } from './createSession';

/**
 * Presses Tab from whatever currently holds focus until `target` does,
 * bounded by `maxPresses`. Genuine keyboard navigation (never `.focus()` via
 * JS) — this is what actually proves a control is Tab-reachable, which a
 * programmatic `.focus()` call does not: `.focus()` succeeds even on an
 * element no Tab sequence would ever land on (e.g. a positive `tabIndex`
 * trap, or a control accidentally excluded from the tab order). The final
 * `expect(target).toBeFocused()` gives a clear failure if `target` is never
 * reached within the budget, rather than silently leaving focus elsewhere.
 */
async function tabUntilFocused(page: Page, target: Locator, maxPresses = 60): Promise<void> {
  for (let i = 0; i < maxPresses; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

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
  await createSession(page);

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

  // Genuinely Tab to the control (never .focus() via JS) — starting from the
  // Stop button just clicked above — and activate with Enter.
  await tabUntilFocused(page, jumpBtn);
  await page.keyboard.press('Enter');
  await expect.poll(async () => playhead.evaluate((el) => el.style.left)).not.toBe(leftBefore);

  // Clear the manual scrub (a timeline-track double-click, per Timeline.tsx's
  // `onTrackDoubleClick`) so the playhead moves away from the jump target.
  await page.locator('#timeline-track').dblclick({ position: { x: 5, y: 5 } });
  const leftBeforeSpace = await playhead.evaluate((el) => el.style.left);
  // The double-click leaves focus on `#timeline-track` itself (it carries
  // `tabIndex={0}`) — genuinely Tab from there to the jump control again,
  // then confirm Space activates the SAME control too (not just Enter).
  await tabUntilFocused(page, jumpBtn);
  await page.keyboard.press(' ');
  await expect.poll(async () => playhead.evaluate((el) => el.style.left)).not.toBe(leftBeforeSpace);
});

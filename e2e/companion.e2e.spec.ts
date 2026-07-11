// Binary-gated e2e: exercises the real Bitfocus Companion 4.3.4 admin UI
// against a freshly-packaged build of the companion module, driving the
// hermetic Playwright webServer (port 8791, REQUIRE_LOGIN=0). Skips entirely
// when the local Companion install isn't present (see companionAvailable()).
//
// Selectors below were pinned by hand against the real running Companion
// 4.3.4 admin UI (2026-07-10) — see task-9-report.md for the exploration
// trail (dialogs to dismiss on first load, the Add-connection confirm modal,
// the connection status icon, and the Triggers "Test actions" path used to
// fire the transport action deterministically without needing a physical
// surface/button).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import {
  type CompanionHandle,
  companionAvailable,
  launchCompanion,
  seedActiveSession,
} from './companion-harness.js';

const companionWorkspaceDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'companion');
const SERVER = 'http://127.0.0.1:8791';

test.describe('Companion module (headless)', () => {
  test.skip(!companionAvailable(), 'Companion install not present');

  let companion: CompanionHandle;

  test.beforeAll(async () => {
    companion = await launchCompanion(companionWorkspaceDir);
  });

  test.afterAll(async () => {
    await companion?.stop();
  });

  test('adds the connection, reaches OK, and a transport action rolls the take', async ({
    page,
  }) => {
    await seedActiveSession(SERVER);

    await page.goto(`${companion.adminUrl}/connections`);
    await dismissStartupDialogs(page);
    await addAutologgerConnection(page, SERVER);

    // Assertion: connection reaches OK status (green circle-check icon next
    // to the row — Companion 4.3.4 renders status as an icon, not text).
    await expect(statusIcon(page)).toHaveAttribute('color', '#33aa33', { timeout: 15000 });

    // Assertion: firing the transport action through Companion rolls the
    // take on the real server (poll GET /api/companion/state).
    await triggerTransportAction(page);
    await expect
      .poll(
        async () => {
          const res = await fetch(`${SERVER}/api/companion/state`);
          const body = (await res.json()) as { session?: { is_rolling?: boolean } };
          return body.session?.is_rolling;
        },
        { timeout: 10000 },
      )
      .toBe(true);
  });
});

/**
 * Companion 4.3.4 shows a "What's New" dialog stacked on top of a first-run
 * "Welcome" wizard on a fresh --config-dir. Both use Bootstrap's fade
 * transition, so a modal can still be mid-fade-out (and still intercepting
 * pointer events) right after its close button is clicked — settle on
 * `.modal.show` actually being gone from the DOM, not just on having clicked
 * something, and give the first appearance a moment to render before
 * concluding there's nothing to dismiss.
 */
async function dismissStartupDialogs(page: Page): Promise<void> {
  const openModal = page.locator('.modal.show, [role="dialog"][aria-modal="true"]').first();
  for (let i = 0; i < 6; i++) {
    if ((await openModal.count()) === 0) {
      // Nothing visible right now — give one more beat in case a second
      // modal is still animating in before treating the page as clear.
      await page.waitForTimeout(300);
      if ((await openModal.count()) === 0) return;
    }
    const closeBtn = openModal.getByRole('button', { name: 'Close' });
    try {
      await closeBtn.click({ timeout: 2000 });
    } catch {
      break;
    }
    // Wait out the Bootstrap fade-out so the (now-closing) modal's
    // pointer-events don't intercept the next dismiss/interaction.
    for (let waited = 0; waited < 2000 && (await openModal.count()) > 0; waited += 100) {
      await page.waitForTimeout(100);
    }
  }
}

async function addAutologgerConnection(page: Page, serverUrl: string): Promise<void> {
  // The "Add New Connection" panel's module search box is unlabeled
  // (placeholder-only); results render into #connection_add_search_results
  // with one "Add" button per matched module.
  await page.getByPlaceholder('Search ...').fill('autologger');
  const addBtn = page.locator('#connection_add_search_results button', { hasText: 'Add' }).first();
  await addBtn.click();

  // Clicking "Add" opens an "Add AutoLogger: AutoLogger" confirm modal
  // (label + module-version picker) that must be confirmed via its own
  // footer "Add" button before the connection is actually created.
  const modal = page.locator('.modal.show, [role="dialog"][aria-modal="true"]').first();
  await modal.locator('.modal-footer button', { hasText: 'Add' }).click();

  // Confirming navigates to /connections/<id>, the connection's edit panel,
  // where the module's config fields render (label text comes straight from
  // companion/src/config.ts's getConfigFields()).
  const panel = page.locator('.connections-panel.secondary-panel');
  const urlInput = panel.locator('input[type="text"]').nth(1); // 0 = Label, 1 = AutoLogger server URL
  await urlInput.fill(serverUrl);
  await panel.locator('button[type="submit"]', { hasText: 'Save' }).click();
}

/** The connection-list row's status icon: FontAwesome circle-check (green) / circle-xmark (red) / etc. */
function statusIcon(page: Page) {
  return page
    .locator('.collections-nesting-table-row-item', { hasText: 'autologger' })
    .locator('svg[data-icon="circle-check"]')
    .first();
}

/**
 * Companion has no "press this action once" button on a connection directly;
 * the deterministic path is a Trigger with a manually-runnable "Test actions"
 * button, which executes its action list immediately without needing a
 * physical surface or a bound button/page.
 */
async function triggerTransportAction(page: Page): Promise<void> {
  await page.goto(`${new URL(page.url()).origin}/triggers`);
  await page.getByRole('button', { name: /add trigger/i }).click();

  const addActionCombo = page
    .getByText('+ Add action')
    .locator('..')
    .locator('input, [role="combobox"]')
    .first();
  await addActionCombo.click();
  await addActionCombo.type('Transport', { delay: 30 });
  await page.getByText('autologger: Transport (roll/stop)', { exact: true }).click();

  // Default action option is "Toggle" — sufficient since the test asserts
  // is_rolling flips to true from a known false starting state.
  await page.getByRole('button', { name: /test actions/i }).click();
}

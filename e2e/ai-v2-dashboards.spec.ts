import { expect, test } from '@playwright/test';
import { CHROMIUM_DATA_DIR, injectSessionCookie, seedSession } from './seededSession';

// ai-v2-dashboards (task 6.2) — hermetic e2e over REAL SSE for the design
// turn -> question -> dashboard flow, plus the persist/reload round trip and
// the "Start blank" primary entry.
//
// Runs on the shared chromium project's hermetic server (:8791). That
// server's webServer entry (playwright.config.ts) sets AI_V2_ENABLED=1 and
// AI_V2_SDK_EXECUTABLE_PATH to server/src/test/fixtures/ai-v2-fake-agent.mjs
// — a real, protocol-faithful stand-in for the `claude` CLI on the Agent
// SDK's OWN stdio transport (`pathToClaudeCodeExecutable`, a pre-existing
// "test seam, never set in production" field threaded from that env var in
// aiV2.ts). See that fixture's header comment for the exact
// initialize/can_use_tool/mcp_message protocol it speaks. ZERO Anthropic
// credentials or network egress anywhere in this process — the fake agent
// never calls out, and no ANTHROPIC_API_KEY/AI_V2_API_KEY is set anywhere in
// this server's env.
//
// The design-turn/question/dashboard round trip needs a REAL principal (the
// pending-question registry binds the initiating user id, and an anonymous
// dev "user" cannot answer another turn's question by construction) — so
// this spec seeds a real user via the same seeded-session fixture
// teams-smoke.spec.ts/seeded-session.spec.ts already use, rather than the
// dev-anonymous flow ai-chat.spec.ts relies on.

test.describe('ai-v2-dashboards (seeded-session fixture, real SSE, fake agent)', () => {
  test('design turn: delta text, one question answered, a dashboard proposed, kept, and reloaded', async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!baseURL, 'baseURL is required (set by the chromium project)');

    const seeded = await seedSession({
      dataDir: CHROMIUM_DATA_DIR,
      label: 'aiv2-design',
      memberships: [{ studioId: 'test-studios', role: 'member' }],
    });
    await injectSessionCookie(context, baseURL as string, seeded.token);

    const pageErrors: Error[] = [];
    page.on('pageerror', (e) => pageErrors.push(e));

    await page.goto('/');
    await expect(page.locator('#v6-app')).toBeVisible();

    // Create a session as the seeded (real) principal.
    await page.locator('#v6-btn-new-session').click();
    await expect(page.locator('#new-session-form')).toBeVisible();
    await expect(page.locator('#ns-show')).toBeEnabled();
    await page.locator('#ns-submit').click();
    await expect(page).toHaveURL(/\/sessions\/[^/]+$/);

    // Feed tabs -> AI v2 (SessionWorkspace.tsx: role="tablist" aria-label
    // "Feed tabs", tab "AI v2").
    const feedTabs = page.getByRole('tablist', { name: 'Feed tabs' });
    await feedTabs.getByRole('tab', { name: 'AI v2' }).click();
    await expect(page.getByTestId('aiv2-panel')).toBeVisible();

    // Start a design turn — real fetch+SSE against the fake-agent-backed
    // route. No prior dashboard exists, so the empty-state CTA is showing.
    await page.getByRole('button', { name: 'Design with AI' }).click();

    // 1. Streamed delta text (the fake agent's first assistant message).
    const messages = page.getByTestId('aiv2-design-messages');
    await expect(messages).toContainText("Looking at this session's aggregates now.", {
      timeout: 15_000,
    });

    // 2. One AskUserQuestion, answered via a real option-card click -> a
    // real POST .../ai/v2/answer round trip (AiV2Design.tsx: clicking an
    // option auto-submits once every question in the set has an answer).
    const answerResponse = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname.endsWith('/ai/v2/answer') && res.request().method() === 'POST',
    );
    await expect(page.getByTestId('aiv2-question-pending')).toBeVisible({ timeout: 15_000 });
    const questionCard = page.getByTestId('aiv2-question-card');
    await expect(questionCard).toContainText('Which widget should we start with?');
    await questionCard.getByRole('button', { name: 'Speaker talk time' }).click();
    const answerRes = await answerResponse;
    expect(answerRes.status()).toBe(200);
    await expect(page.getByTestId('aiv2-question-pending')).toHaveCount(0);

    // Delta text after the answer (proves the SAME turn resumed post-answer,
    // not a fresh one).
    await expect(messages).toContainText('Proposing a starting dashboard with talk time.', {
      timeout: 15_000,
    });

    // 3. propose_dashboard -> a real `dashboard` SSE event -> rendered
    // through the REAL DashboardGrid/CatalogWidget components (no markup
    // path) with a Keep/Discard offer (design D10).
    await expect(page.getByTestId('aiv2-dashboard-proposal-banner')).toBeVisible({
      timeout: 15_000,
    });
    const grid = page.getByTestId('aiv2-dashboard-grid');
    await expect(grid).toBeVisible();
    await expect(grid.getByText('Speaker talk time')).toBeVisible();
    await expect(grid.locator('li')).toHaveCount(1);

    // 4. Keep -> persists via the REAL PUT .../ai/v2/dashboard route.
    const putResponse = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname.endsWith('/ai/v2/dashboard') &&
        res.request().method() === 'PUT',
    );
    await page.getByTestId('aiv2-dashboard-keep').click();
    const putRes = await putResponse;
    expect(putRes.status()).toBe(200);
    await expect(page.getByTestId('aiv2-dashboard-proposal-banner')).toHaveCount(0);
    await expect(page.getByTestId('aiv2-dashboard-edit')).toBeVisible();

    // 5. Reload — the saved dashboard renders from stored config (+ session
    // data), not from any in-memory turn state.
    await page.reload();
    await expect(page.locator('#v6-app')).toBeVisible();
    await feedTabs.getByRole('tab', { name: 'AI v2' }).click();
    const gridAfterReload = page.getByTestId('aiv2-dashboard-grid');
    await expect(gridAfterReload).toBeVisible();
    await expect(gridAfterReload.getByText('Speaker talk time')).toBeVisible();
    await expect(gridAfterReload.locator('li')).toHaveCount(1);
    await expect(page.getByTestId('aiv2-dashboard-proposal-banner')).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });

  test('"Start blank" persists an empty dashboard (200, not 422) and reload renders it', async ({
    page,
    context,
    baseURL,
  }) => {
    test.skip(!baseURL, 'baseURL is required (set by the chromium project)');

    const seeded = await seedSession({
      dataDir: CHROMIUM_DATA_DIR,
      label: 'aiv2-blank',
      memberships: [{ studioId: 'test-studios', role: 'member' }],
    });
    await injectSessionCookie(context, baseURL as string, seeded.token);

    await page.goto('/');
    await expect(page.locator('#v6-app')).toBeVisible();

    await page.locator('#v6-btn-new-session').click();
    await expect(page.locator('#new-session-form')).toBeVisible();
    await expect(page.locator('#ns-show')).toBeEnabled();
    await page.locator('#ns-submit').click();
    await expect(page).toHaveURL(/\/sessions\/[^/]+$/);

    const feedTabs = page.getByRole('tablist', { name: 'Feed tabs' });
    await feedTabs.getByRole('tab', { name: 'AI v2' }).click();
    await expect(page.getByTestId('aiv2-panel')).toBeVisible();

    // Primary entry point per the Phase 5 review finding: "Start blank" —
    // no agent turn at all.
    await expect(page.getByTestId('aiv2-start-blank')).toBeVisible();
    const putResponse = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname.endsWith('/ai/v2/dashboard') &&
        res.request().method() === 'PUT',
    );
    await page.getByTestId('aiv2-start-blank').click();
    const putRes = await putResponse;
    // The empty dashboard ({ widgets: [], interactions: [] }) SHALL persist
    // (200), never 422 — the Phase 5 review's explicit ask.
    expect(putRes.status()).toBe(200);

    // Drops straight into the editor (AiV2Panel.startBlank: editingDashboard
    // = true) with zero widgets.
    await expect(page.getByTestId('aiv2-dashboard-editor')).toBeVisible();
    await expect(page.getByTestId('aiv2-editor-widget')).toHaveCount(0);

    // Reload — renders from the persisted empty config, not the "No
    // dashboard for this session yet" empty-CTA state.
    await page.reload();
    await expect(page.locator('#v6-app')).toBeVisible();
    await feedTabs.getByRole('tab', { name: 'AI v2' }).click();
    await expect(page.getByText('No dashboard for this session yet')).toHaveCount(0);
    // A truly empty dashboard's <ul> renders with zero widgets (zero-size,
    // so `toBeVisible` would be flaky here) — its presence in the DOM plus
    // the "Session overview"/Edit affordance (the saved, non-editing view)
    // is the honest signal that the EMPTY config round-tripped through
    // persistence, not the "no dashboard yet" empty-CTA state.
    await expect(page.getByRole('heading', { name: 'Session overview' })).toBeVisible();
    await expect(page.getByTestId('aiv2-dashboard-edit')).toBeVisible();
    await expect(page.getByTestId('aiv2-dashboard-grid')).toHaveCount(1);
    await expect(page.getByTestId('aiv2-dashboard-grid').locator('li')).toHaveCount(0);
  });
});

import { expect, test } from '@playwright/test';

// ai-topics-chat (task 5.2) — hermetic happy-path chat e2e.
//
// This is the client↔server SSE seam flagged by the whole-branch scope review
// as otherwise untested: a real browser `fetch` POSTs to `.../ai/chat`, the
// server spawns the hermetic fake-`claude` fixture (CLAUDE_CLI_PATH, wired in
// playwright.config.ts's chromium webServer — see the FAKE_CLAUDE_CLI comment
// there), and the fixture's canned stream-json is relayed back as REAL SSE
// over REAL HTTP (no mocked fetch/EventSource, no stubbed response) — the
// same path server/src/routers/ai.int.test.ts drives at the HTTP-handler
// level, exercised here end-to-end through the actual DOM/React client
// (web/src/pages/index/components/AiChat.tsx's `parseSseFrames` reader loop).
//
// Hermetic: CLAUDE_CLI_PATH points at server/src/test/fixtures/fake-claude.mjs
// (design D10) — a plain Node script that prints canned output. No real
// Anthropic credentials or network egress anywhere in this test.
//
// The fixture's "success" mode (server/src/test/fixtures/fake-claude.mjs)
// emits a `create_topic` tool_use with summary "Fixture topic", then the
// assistant text "Created a fixture topic." — this test asserts on both
// exact strings plus the tool-activity chip, which is the observable proof
// that a real `tool` SSE event (naming `create_topic`) reached the client.
//
// NOT asserted: the created row actually landing in the Topics subtab. The
// fixture is a CLI stdout double only (design D10) — it prints canned
// stream-json but never itself acts as an MCP client against the loopback
// listener, so no real `create_topic` DB write happens on this path (that
// would require teaching the fixture to speak real MCP/Streamable-HTTP,
// which is new runtime surface out of scope for a Phase 5 gate task, and
// would touch the already-reviewed, shared Phase 3 fixture every other
// hermetic AI-chat test also depends on). The two things that assertion
// would have covered are independently covered already: create_topic's
// DB-write correctness (task 2.2's int tests, aiMcpServer) and the
// client-side query-invalidation-on-tool-event mechanism (task 4.2's
// AiChat.test.tsx, "create_topic liveness" describe block, via a mocked SSE
// stream). This e2e instead confirms the Topics subtab is reachable and
// renders cleanly in the same conversation, without unmounting Chat.

test('hermetic chat turn: send a message, see the streamed reply, and the AI-created topic appear', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (e) => pageErrors.push(e));

  // Create a session through the UI (same flow as smoke.spec.ts) — this
  // server runs anonymous (REQUIRE_LOGIN=0), so no login/session-seeding is
  // needed for the chat endpoint itself.
  await page.goto('/');
  await page.locator('#v6-btn-new-session').click();
  await expect(page.locator('#new-session-form')).toBeVisible();
  await expect(page.locator('#ns-show')).toBeEnabled();
  await page.locator('#ns-submit').click();
  await expect(page.locator('#v3-session-grid')).not.toHaveClass(/hidden/);
  await expect(page).toHaveURL(/\/sessions\/[^/]+$/);

  // Top-level Feed tabs → AI (SessionWorkspace.tsx: role="tablist" aria-label
  // "Feed tabs"). `exact: true` — ai-v2-dashboards (task 6.2) added a
  // sibling "AI v2" tab, and Playwright's default `name` match is a
  // case-insensitive substring, so an unqualified "AI" would resolve to both
  // tabs (strict-mode violation) now that the AI v2 tab actually renders in
  // a fresh `web/dist` build.
  const feedTabs = page.getByRole('tablist', { name: 'Feed tabs' });
  await feedTabs.getByRole('tab', { name: 'AI', exact: true }).click();

  // AI subtabs default to Chat (AiPanel.tsx: role="tablist" aria-label "AI
  // tabs") — click it anyway for an explicit, order-independent assertion.
  const aiTabs = page.getByRole('tablist', { name: 'AI tabs' });
  await aiTabs.getByRole('tab', { name: 'Chat' }).click();
  await expect(page.getByTestId('ai-chat-panel')).toBeVisible();

  // Send a message — real fetch+SSE turn against the hermetic fixture.
  const input = page.getByPlaceholder('Message the AI assistant…');
  await input.fill('What happened in this session?');
  await page.getByRole('button', { name: 'Send' }).click();

  const transcript = page.getByTestId('ai-chat-transcript');
  await expect(transcript).toContainText('What happened in this session?');

  // Tool-activity chip for the fixture's create_topic tool_use (short name,
  // mcp__autologger__ prefix stripped server-side — aiChatRelay.ts).
  await expect(page.getByTestId('ai-chat-tool-chip')).toContainText('Using tool: create_topic');

  // Streamed assistant reply (the fixture's canned terminal text).
  await expect(transcript).toContainText('Created a fixture topic.', { timeout: 15_000 });

  // Stop control reverts to Send once the turn completes (isStreaming false).
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  await expect(page.getByTestId('ai-chat-not-configured')).toHaveCount(0);
  await expect(page.getByTestId('ai-chat-error')).toHaveCount(0);

  // Switching to Topics (see the file header for why no row is asserted
  // here) must not unmount Chat or the conversation above — the subtab
  // renders cleanly, mounted-hidden per design D9.
  await aiTabs.getByRole('tab', { name: 'Topics' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Topics' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Topics feed' })).toBeVisible();

  // Switching back to Chat: the conversation (including the tool chip and
  // streamed reply) is still intact — no unmount, no cleared state.
  await aiTabs.getByRole('tab', { name: 'Chat' }).click();
  await expect(transcript).toContainText('Created a fixture topic.');
  await expect(page.getByTestId('ai-chat-tool-chip')).toContainText('Using tool: create_topic');

  expect(pageErrors).toEqual([]);
});

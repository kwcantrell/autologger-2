import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
// Gate the `companion` project's test selection on the binary's presence at
// config-load time (not just a runtime test.skip) so `npx playwright test
// --list` reports zero tests for the project on machines without the local
// Companion install, matching the brief's "runs only when the Companion
// binary exists" contract. The install location (COMPANION_DIR env var, with
// this machine's path as fallback) lives in the harness — one source of truth.
import { companionAvailable } from './e2e/companion-harness';

const here = dirname(fileURLToPath(import.meta.url));

// ai-topics-chat (task 5.2): the hermetic fake-`claude` CLI fixture (design D10,
// task 3.1) — same file server/src/routers/ai.int.test.ts points CLAUDE_CLI_PATH
// at. Pointing the chromium project's server at it flips aiChatConfigured() true
// with NO real Anthropic credentials or network access anywhere in the process
// (the fixture is a plain Node script that prints canned stream-json). This is
// what keeps ai-chat.spec.ts's happy-path chat e2e hermetic.
const FAKE_CLAUDE_CLI = join(here, 'packages', 'ai-runtime', 'fixtures', 'fake-claude.mjs');

// ai-v2-dashboards (task 6.2): a protocol-faithful fake agent for the AI v2
// design turn's Agent-SDK transport (`pathToClaudeCodeExecutable` — a
// pre-existing "test seam, never set in production" field on
// `BuildDesignTurnOptionsParams`, aiV2SdkSpawn.ts). Different transport from
// the AI chat's CLI-argv fake above: this one speaks the SDK's own
// bidirectional stdio control protocol (initialize handshake, `can_use_tool`,
// `mcp_message`) so a hermetic e2e can drive a real design turn — delta text,
// one AskUserQuestion, one propose_dashboard MCP call — with zero Anthropic
// spend. See server/src/test/fixtures/ai-v2-fake-agent.mjs for the protocol
// notes and e2e/ai-v2-dashboards.spec.ts for the driving test.
const FAKE_AI_V2_AGENT = join(here, 'server', 'src', 'test', 'fixtures', 'ai-v2-fake-agent.mjs');

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'http://127.0.0.1:8791',
  },
  webServer: [
    {
      // Wipe e2e server state in the SAME shell invocation Playwright uses to
      // spawn the server — globalSetup is NOT guaranteed to run before webServer
      // starts (Playwright's task order is: plugin setup incl. webServer, THEN
      // globalSetups), so rm-then-start must be one atomic command here, not
      // split across globalSetup + webServer.command. A crashed prior run
      // (SIGKILL teardown) must not leak DBs/WAL files into this run.
      command: `node -e "require('node:fs').rmSync(process.env.DATA_DIR,{recursive:true,force:true})" && npm run start -w server`,
      url: 'http://127.0.0.1:8791/api/profile',
      // Never adopt a leftover orphan started with different env.
      reuseExistingServer: false,
      // 3x the pre-Next 30s budget (nextjs-frontend-migration, task 3.4): `npm run
      // start -w server` now also runs Next's prod `prepare()` (route-manifest load
      // + first-request compile bookkeeping) before the server starts listening,
      // on top of the existing catalog/session-store boot work.
      timeout: 90_000,
      env: {
        PORT: '8791',
        HOST: '127.0.0.1',
        REQUIRE_LOGIN: '0',
        // Absolute — the server script's cwd is server/, so a relative path
        // would land at server/e2e/.data.
        DATA_DIR: join(here, 'e2e', '.data'),
        // Hermetic: explicit empty strings BEAT server/.env values (process env
        // wins over --env-file). A developer's real Google creds would otherwise
        // flip oauthConfigured() and 401 the anonymous smoke flow.
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
        PUBLIC_BASE_URL: '',
        IP_ALLOWLIST: '',
        API_TOKEN: '',
        ADMIN_TOKEN: '',
        // Same hermeticity rule applies to transcription (deepgram-transcription,
        // task 5.2): a developer's real DEEPGRAM_API_KEY in server/.env would
        // otherwise flip deepgramConfigured() true for this "hermetic" server,
        // both breaking the 503-path smoke assertion and risking a real billed
        // DeepGram call if a spec ever exercises the generate endpoint.
        DEEPGRAM_API_KEY: '',
        // ai-topics-chat (task 5.2): fixture stands in for the real `claude` CLI —
        // see the FAKE_CLAUDE_CLI comment above. Hermetic, no real credentials.
        CLAUDE_CLI_PATH: FAKE_CLAUDE_CLI,
        // ai-v2-dashboards (task 6.2): AI v2 is off by default (design D9,
        // "defaults OFF") — flip it on for this hermetic server only, and
        // point the SDK transport at the fake agent above so no design turn
        // here ever reaches a real `claude` binary or Anthropic network call.
        // No AI_V2_API_KEY: this server binds 127.0.0.1, so
        // aiV2CredentialsRefused() takes the loopback-fallback branch rather
        // than refusing — irrelevant anyway since the fake agent never
        // authenticates for real.
        AI_V2_ENABLED: '1',
        AI_V2_SDK_EXECUTABLE_PATH: FAKE_AI_V2_AGENT,
      },
    },
    {
      // Second hermetic server (add-login-screen, task 3.1): the server above
      // deliberately forces OAuth off and the whole existing suite depends on
      // that, so the login-gate smoke gets its own project + webServer instead
      // of flipping env vars on the shared one. Dummy (never-contacted) Google
      // creds flip oauthConfigured() true — "configured" here means the three
      // env vars are non-empty, NOT that Google is ever reached; the spec below
      // asserts hrefs only and blocks any accounts.google.com navigation.
      // REQUIRE_LOGIN=1 is the change's headline posture: it is what proves
      // `/api/profile` stays anonymous-allowed under strict login, which a
      // profile-payload stub could never verify.
      command: `node -e "require('node:fs').rmSync(process.env.DATA_DIR,{recursive:true,force:true})" && npm run start -w server`,
      url: 'http://127.0.0.1:8792/api/profile',
      reuseExistingServer: false,
      // 3x the pre-Next 30s budget (nextjs-frontend-migration, task 3.4): `npm run
      // start -w server` now also runs Next's prod `prepare()` (route-manifest load
      // + first-request compile bookkeeping) before the server starts listening,
      // on top of the existing catalog/session-store boot work.
      timeout: 90_000,
      env: {
        PORT: '8792',
        HOST: '127.0.0.1',
        REQUIRE_LOGIN: '1',
        // Own DATA_DIR: this webServer entry boots CONCURRENTLY with the one
        // above — sharing e2e/.data would race the other entry's rm-then-start
        // (both wipe-then-create at once), corrupting either or both DBs.
        DATA_DIR: join(here, 'e2e', '.data-oauth'),
        // Dummy but self-consistent (never contacted — see comment above):
        // PUBLIC_BASE_URL matches this server's own origin so oauthConfigured()
        // reads true without pointing at anything real.
        GOOGLE_CLIENT_ID: 'e2e-dummy-client-id',
        GOOGLE_CLIENT_SECRET: 'e2e-dummy-client-secret',
        PUBLIC_BASE_URL: 'http://127.0.0.1:8792',
        IP_ALLOWLIST: '',
        API_TOKEN: '',
        ADMIN_TOKEN: '',
        // See the hermeticity comment on the server above (deepgram-transcription
        // task 5.2): keeps this server's transcript generate endpoint off even if
        // server/.env carries a real key.
        DEEPGRAM_API_KEY: '',
        // Same rule for the AI CLI (auto-generate-event-logs 6.2 hardening):
        // without this override, a real CLAUDE_CLI_PATH in server/.env would
        // reach this server. No spec here touches a generate endpoint (and
        // REQUIRE_LOGIN=1 would 401 first), but parity with DEEPGRAM_API_KEY
        // closes the latent gap.
        CLAUDE_CLI_PATH: '',
      },
    },
  ],
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixels: 0, // strict default; per-shot exceptions only, frozen with baselines
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
      testIgnore: [/visual\.spec\.ts/, /companion\.e2e\.spec\.ts/, /login-gate\.spec\.ts/],
    },
    {
      name: 'login-gate',
      // Scoped to its own server (REQUIRE_LOGIN=1, dummy-configured OAuth) via
      // testMatch, so the shared chromium project's OAuth-off server never
      // collects it (see the chromium testIgnore entry above).
      testMatch: /login-gate\.spec\.ts/,
      use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:8792' },
    },
    {
      name: 'companion',
      testMatch: /companion\.e2e\.spec\.ts/,
      // Binary-gated: no tests are collected at all when Companion isn't
      // installed locally (see the companionAvailable import above), rather
      // than relying solely on the in-file test.skip().
      testIgnore: companionAvailable() ? undefined : /companion\.e2e\.spec\.ts/,
      fullyParallel: false,
      // beforeAll packages the module (npm run package -w companion, an
      // esbuild bundle) and boots real Companion before any assertion runs;
      // the default 30s budget is too tight for that plus the multi-step
      // admin-UI flow that follows.
      timeout: 60_000,
      use: { browserName: 'chromium' },
    },
    {
      name: 'visual-desktop',
      testMatch: /visual\.spec\.ts/,
      // Serial: one hermetic server, wiped once per invocation — cross-test
      // interleaving would make the home shot's rail contents run-order-dependent.
      // (workers is capped via --workers=1 in the npm scripts; it is not a
      // per-project option.)
      fullyParallel: false,
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
    {
      name: 'visual-mobile',
      testMatch: /visual\.spec\.ts/,
      fullyParallel: false,
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        launchOptions: {
          args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        },
      },
    },
  ],
});

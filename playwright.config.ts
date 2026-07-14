import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

// Gate the `companion` project's test selection on the binary's presence at
// config-load time (not just a runtime test.skip) so `npx playwright test
// --list` reports zero tests for the project on machines without the local
// Companion install, matching the brief's "runs only when the Companion
// binary exists" contract.
const COMPANION_LAUNCHER = '/home/kalen/companion-x64/companion_headless.sh';

const here = dirname(fileURLToPath(import.meta.url));

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
      timeout: 30_000,
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
      timeout: 30_000,
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
      // installed locally (see COMPANION_LAUNCHER above), rather than relying
      // solely on the in-file test.skip().
      testIgnore: existsSync(COMPANION_LAUNCHER) ? undefined : /companion\.e2e\.spec\.ts/,
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

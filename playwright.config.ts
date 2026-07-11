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
  webServer: {
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
      testIgnore: [/visual\.spec\.ts/, /companion\.e2e\.spec\.ts/],
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

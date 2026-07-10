import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

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
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});

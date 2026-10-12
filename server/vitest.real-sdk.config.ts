import { defineConfig } from 'vitest/config';

// The opt-in real Anthropic test for the AI SDK route (ai-sdk-agent-harness task 9.3). It drives
// the real routes, so it needs the integration harness (a Postgres catalog clone per test, wired by
// setup.int.ts; needs a docker daemon). The `unit` project of vitest.config.ts also collects
// `src/test/aiSdk.real.test.ts` and reports it skipped: the file runs only when this config sets
// `AI_SDK_REAL_HARNESS=1` and the operator sets `REAL_LLM_ANTHROPIC_KEY`. Run it with:
//
//   REAL_LLM_ANTHROPIC_KEY=... npx vitest run --config vitest.real-sdk.config.ts   (in server/)
export default defineConfig({
  test: {
    name: 'real-sdk',
    include: ['src/test/aiSdk.real.test.ts'],
    environment: 'node',
    env: { AI_SDK_REAL_HARNESS: '1' },
    setupFiles: ['./src/test/setup.int.ts'],
    globalSetup: ['./src/test/pgIntegrationSetup.ts'],
    hookTimeout: 600_000,
    testTimeout: 300_000,
  },
});

import { defineConfig } from 'vitest/config';

// Three test tiers as vitest projects (migrated from the removed vitest.workspace.ts
// file — vitest 4 dropped workspace-file support in favor of `test.projects`):
// - unit: `*.test.ts`, plain node, no bindings (plus the repo-level test/pg harness unit tests).
// - integration: `*.int.test.ts`, the real bindings over a Postgres catalog clone per test, wired
//   via setup.int.ts (catalog-on-postgres D6; needs a docker daemon).
// - pg: `*.pg.test.ts`, against the pinned supabase/postgres image started by
//   ../test/pg/globalSetup.ts (catalog-pg-schema design D6; needs a docker daemon).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', '../test/pg/*.test.ts'],
          exclude: ['src/**/*.int.test.ts', 'src/**/*.pg.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts'],
          environment: 'node',
          setupFiles: ['./src/test/setup.int.ts'],
          globalSetup: ['./src/test/pgIntegrationSetup.ts'],
          hookTimeout: 600_000,
        },
      },
      {
        test: {
          name: 'pg',
          include: ['src/**/*.pg.test.ts'],
          environment: 'node',
          globalSetup: ['../test/pg/globalSetup.ts'],
          hookTimeout: 600_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});

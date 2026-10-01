import { defineConfig } from 'vitest/config';

// Two projects (postgres-catalog-adapter design D8):
// - unit: `*.test.ts`, plain node.
// - pg: `*.pg.test.ts`, against the pinned supabase/postgres image started by the repo-level
//   test/pg/globalSetup.ts (catalog-pg-schema design D6; needs a docker daemon).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.pg.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'pg',
          include: ['src/**/*.pg.test.ts'],
          environment: 'node',
          globalSetup: ['../../test/pg/globalSetup.ts'],
          hookTimeout: 600_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});

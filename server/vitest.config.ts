import { defineConfig } from 'vitest/config';

// Three test tiers as vitest projects (migrated from the removed vitest.workspace.ts
// file — vitest 4 dropped workspace-file support in favor of `test.projects`):
// - unit: `*.test.ts`, plain node, no bindings (plus the repo-level test/pg harness unit tests).
// - integration: `*.int.test.ts`, the real bindings over a Postgres catalog clone per test, wired
//   via setup.int.ts (catalog-on-postgres D6; needs a docker daemon).
// - pg: `*.pg.test.ts`, against the pinned supabase/postgres image started by
//   ../test/pg/globalSetup.ts (catalog-pg-schema design D6; needs a docker daemon).
// SKIP_DB_TESTS=1 leaves out integration and pg; the lifecycle gate sets it when no
// db_test_paths changed (ci-db-test-selection D2).
const skipDbTests = process.env.SKIP_DB_TESTS === '1';

// The `pg` container keeps the app role's production connection limit of 45, and every `pg` file
// connects as that role: a file holding the server's catalog adapter can open 12 connections
// (3 root, 5 transaction, 4 session slots), authCreateUser.pg.test.ts opens two adapters (24),
// and the other files a few raw clients each. vitest's default is one worker per core but one, so
// on a 20-core machine 19 files ran at once and passed 45 ("too many connections for role"). Two
// files at once stay under it on any machine (24 + 14 < 45); vitest runs a project with its own
// maxWorkers in its own group, after the unit and integration files.
export const PG_MAX_WORKERS = 2;

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
      ...(skipDbTests
        ? []
        : [
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
                maxWorkers: PG_MAX_WORKERS,
                sequence: { groupOrder: 1 },
              },
            },
          ]),
    ],
  },
});

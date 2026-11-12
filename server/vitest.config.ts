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

// The `integration` container lets the app role open 280 connections (pgIntegrationSetup.ts)
// under max_connections=300 (test/pg/globalSetup.ts), 3 of them reserved for superusers. vitest's
// default of one file per core but one held about 145 app connections at 19 files here (7.6 a
// file), so it would pass 280 on a machine with about 38 or more cores. One file at its worst holds
// 40 app-role and 42 client connections (frameBus.int.test.ts: the harness's catalog adapter and two
// server processes on the Postgres frame bus, 12 + 2 × 14, plus a `postgres` admin client and the
// harness's next template clone). Six files at that worst stay under both limits on any machine:
// 6 × 40 = 240 ≤ 280 and 6 × 42 + 3 others = 255 ≤ 297. src/test/integrationConnectionBudget.ts
// holds the arithmetic and vitestConfig.test.ts pins this bound under it. A project with its own
// maxWorkers runs in its own group: unit files first, then integration, then pg.
export const INTEGRATION_MAX_WORKERS = 6;

export default defineConfig({
  test: {
    // `npm run test:coverage -w server` (vitest run --coverage): v8 coverage of the server's full
    // run (unit + integration + pg) over the server's and the workspace packages' sources, which
    // the server imports as TypeScript (hence allowExternal). Off unless --coverage is passed.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', '../packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', 'src/test/**', '../packages/*/src/**/test/**'],
      allowExternal: true,
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: './coverage',
    },
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
                maxWorkers: INTEGRATION_MAX_WORKERS,
                sequence: { groupOrder: 1 },
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
                sequence: { groupOrder: 2 },
              },
            },
          ]),
    ],
  },
});

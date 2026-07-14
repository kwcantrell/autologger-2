import { defineConfig } from 'vitest/config';

// Two test tiers as vitest projects (migrated from the removed vitest.workspace.ts
// file — vitest 4 dropped workspace-file support in favor of `test.projects`):
// - unit: `*.test.ts`, plain node, no bindings.
// - integration: `*.int.test.ts`, real SQLite harness wired via setup.int.ts.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.int.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts'],
          environment: 'node',
          setupFiles: ['./src/test/setup.int.ts'],
        },
      },
    ],
  },
});

import { defineWorkersProject, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    // Pure / node tier — fakes, no bindings. Excludes integration files.
    test: {
      name: 'unit',
      include: ['src/**/*.test.ts'],
      exclude: ['src/**/*.int.test.ts'],
      environment: 'node',
    },
  },
  defineWorkersProject(async () => {
    const migrations = await readD1Migrations(path.resolve('src/db/migrations'));
    return {
      test: {
        name: 'workers',
        include: ['src/**/*.int.test.ts'],
        setupFiles: ['./src/test/setup.int.ts'],
        poolOptions: {
          workers: {
            isolatedStorage: true,
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
          },
        },
      },
    };
  }),
]);

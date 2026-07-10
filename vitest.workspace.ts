import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
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
]);

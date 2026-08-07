import { configDefaults, defineConfig } from 'vitest/config';

// Node environment only for now (task 1.1 scaffold): the extraction pipeline
// (phase 3+) and this placeholder `docs:check` entry both run under plain
// Node/tsx, not a browser. A jsdom project for component/routing tests is
// added when the site pages land (tasks 6.3/7.3 — mermaid render() cannot run
// under jsdom regardless, per design.md D9).
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts', 'model/**/*.test.ts'],
    // extractImports' fixture trees (task 3.1) deliberately include a
    // `*.test.ts` file (classification/compA/index.test.ts) whose filename
    // matters to the production/test classifier under test — it is fixture
    // data, not a real vitest suite, so it must never be collected as one.
    exclude: [...configDefaults.exclude, '**/__fixtures__/**'],
    environment: 'node',
  },
});

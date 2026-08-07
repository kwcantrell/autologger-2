import { defineConfig } from 'vitest/config';

// Node environment only for now (task 1.1 scaffold): the extraction pipeline
// (phase 3+) and this placeholder `docs:check` entry both run under plain
// Node/tsx, not a browser. A jsdom project for component/routing tests is
// added when the site pages land (tasks 6.3/7.3 — mermaid render() cannot run
// under jsdom regardless, per design.md D9).
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    environment: 'node',
  },
});

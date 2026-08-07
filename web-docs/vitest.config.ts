import { configDefaults, defineConfig } from 'vitest/config';

// Node environment only for now (task 1.1 scaffold): the extraction pipeline
// (phase 3+) and `docs:check` both run under plain Node/tsx, not a browser.
// Task 6.3's DOM-shimmed mermaid parser (src/lib/mermaidValidate.ts) does
// NOT need a vitest jsdom *environment/project* — it bootstraps its own
// throwaway jsdom document via the `jsdom` npm package directly, which works
// fine under this plain-'node' environment (verified: its tests pass here).
// A real jsdom vitest project is still deferred to task 7.3's component/
// routing tests (mermaid render() cannot run under jsdom regardless, per
// design.md D9), which need actual DOM-rendering assertions this config
// doesn't provide today.
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

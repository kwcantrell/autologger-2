import path from 'path';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

// Standalone config, not derived from anything else: the retired `vite.config.ts`
// carried the MPA `build.rollupOptions` (multiple HTML entries), the tailwind
// plugin, and a dev-only proxy, none of which the test tier needs (nextjs-frontend-
// migration, task 3.4 — the Vite build path is gone; `next build` is now web's
// build). The react plugin (JSX transform) and the alias block are small enough to
// duplicate verbatim here instead.
//
// Two environment tiers as vitest projects (mirrors the shape `server/vitest.
// config.ts` already uses for its unit/integration split). Booting jsdom is by far
// the dominant cost of this workspace's suite — measured at 102s of `environment`
// time across workers for a 37s wall-clock run, against 8s of `transform` — and a
// third of these files never touch a DOM. Splitting by need rather than paying it
// uniformly:
//
// - `node`   — pure-logic tests (`.test.ts`), no DOM, no setup file. This includes
//              the repo-scanning guard tests (`webBoundaries`, `apiResponseShapes`,
//              `windowCoordinationBan`), which read source text off disk and only
//              mention DOM identifiers inside string literals.
// - `jsdom`  — every component test (`.test.tsx`, which renders through
//              `@testing-library/react`) plus the `.test.ts` files enumerated in
//              `DOM_TEST_TS` below.
//
// `src/test/setup.ts` stays wired to the jsdom project ONLY: it imports
// `@testing-library/react`'s `cleanup` and patches `window.matchMedia` /
// `window.localStorage`, none of which is meaningful — or importable — without a
// DOM.
const aliases = {
  '@/api': path.resolve(__dirname, 'src/api'),
  '@/shared': path.resolve(__dirname, 'src/shared'),
  '@/pages': path.resolve(__dirname, 'src/pages'),
};

/**
 * `.test.ts` files that DO need a DOM despite not being component tests, and so
 * run in the jsdom project rather than the node one. Kept as an explicit list
 * because the alternative — a filename convention — would have to be applied to
 * existing files by renaming them.
 *
 * A file belongs here when it touches browser globals the node environment does
 * not provide (`window`, `sessionStorage`/`localStorage`, `requestAnimationFrame`,
 * `AudioContext`, DOM nodes). Misfiling is self-correcting in the safe direction:
 * a DOM-needing test left in the node project fails loudly on the missing global
 * rather than silently passing.
 */
const DOM_TEST_TS = [
  'src/pages/index/components/aiV2/dashboardPersistence.test.ts',
  'src/pages/index/utils/micLevelMeter.test.ts',
  'src/pages/index/utils/revealEventInFeed.test.ts',
  // Both CSV exporters drive a real `document.createElement('a')` + object-URL
  // download, so they need a document even though neither renders a component.
  'src/pages/index/utils/topicsCsv.test.ts',
  'src/pages/index/utils/transcriptCsv.test.ts',
  'src/shared/utils/loginReturnPath.test.ts',
  'src/shared/utils/loginReturnStash.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: { alias: aliases },
        test: {
          name: 'node',
          include: ['src/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...DOM_TEST_TS],
          environment: 'node',
        },
      },
      {
        plugins: [react()],
        resolve: { alias: aliases },
        test: {
          name: 'jsdom',
          include: ['src/**/*.test.tsx', ...DOM_TEST_TS],
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
        },
      },
    ],
  },
});

// @autologger/ai-runtime fixtures-directory constant (openspec/changes/
// ai-runtime-package task 1.1; design D2/D4 — the same pattern
// @autologger/transcription's TRANSCRIPTION_FIXTURES_DIR and
// @autologger/media-import's MEDIA_IMPORT_FIXTURES_DIR already established,
// applied unchanged here). Split into its own module — rather than living
// inline in index.ts, the barrel — so this package's own tests can import
// the single constant directly without importing the barrel itself: index.ts
// is deliberately NOT a re-export barrel for this package's production
// modules (ruling E4 — they're consumed through the "./*" subpath export
// instead), but an in-package test reaching this one constant through
// index.ts would still set up a needless import cycle through the very
// module it is testing. Re-exported from index.ts
// unchanged, so every staying app-side reader (per design D2: four
// integration-test files, one of them at two sites, plus
// `playwright.config.ts`'s one fixture) and this package's own in-package
// tests all resolve through this ONE expression — never independently
// written path computations for "the fixtures directory" that could
// silently drift onto different on-disk copies.
//
// Scaffolded ahead of content (design D8, point 3: the atlas glob and this
// constant land together with the scaffold so a committed non-empty `src/`
// is never an orphan tracked file with nothing to route it). Task 3.3 moved
// the four in-package-read AI fixtures (`fake-claude.mjs`,
// `fake-claude-error.mjs`, `fake-claude-exit-before-stdin.mjs`,
// `ai-v2-sdk-spawn-recorder.mjs`) into the directory this constant points at.

import { fileURLToPath } from 'node:url';

/**
 * Resolved path to this package's fixtures directory (design D4 — the
 * `@autologger/catalog`'s `CATALOG_MIGRATIONS_DIR` pattern for shipping
 * non-TS assets from a source-only package, applied unchanged). Holds the
 * four moving AI fixtures (task 3.3). Resolved via `import.meta.url` from
 * inside the package so it works identically under `tsx` (dev/prod) and
 * vitest, regardless of process cwd.
 */
export const AI_RUNTIME_FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url));

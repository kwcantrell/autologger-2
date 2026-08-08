// @autologger/transcription fixtures-directory constant (design D4; the
// shape phase 3's fix wave settled for @autologger/media-import's
// MEDIA_IMPORT_FIXTURES_DIR — packages/media-import/src/fixturesDir.ts —
// applied unchanged here). Split into its own module — rather than living
// inline in index.ts, the barrel — so this package's OWN tests
// (audioMerge.test.ts, deepgram.test.ts, transcriptRemap.test.ts) can import
// the single constant directly, without importing the barrel itself:
// index.ts also re-exports those same modules, and an in-package test
// importing the barrel to reach one constant would set up a needless import
// cycle through the very module it is testing. Re-exported from index.ts
// unchanged, so the staying app-side consumer
// (server/src/routers/transcribe.int.test.ts) and this package's own three
// in-package tests all resolve through this ONE expression — never
// independently written path computations for "the fixtures directory"
// that could silently drift onto different on-disk copies (the seam
// property recorded in the apply ledger's phase 4 partition).

import { fileURLToPath } from 'node:url';

/**
 * Resolved path to this package's fixtures directory (design D4 — the
 * `@autologger/catalog`'s `CATALOG_MIGRATIONS_DIR` pattern for shipping
 * non-TS assets from a source-only package, applied unchanged). Holds
 * `audio/` (10 committed tiny test-audio files) and
 * `deepgram-enrichment-response.json` (a captured real DeepGram response
 * pinning remap behavior) — read by this package's own audioMerge.test.ts /
 * deepgram.test.ts / transcriptRemap.test.ts and by the staying
 * server/src/routers/transcribe.int.test.ts. Resolved via `import.meta.url`
 * from inside the package so it works identically under `tsx` (dev/prod)
 * and vitest, regardless of process cwd.
 */
export const TRANSCRIPTION_FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url));

// @autologger/media-import fixtures-directory constant (fix wave, phase 3
// review Minor 2). Split into its own module — rather than living inline in
// index.ts, the barrel — so this package's OWN tests (ytdlp.test.ts) can
// import the single constant directly, without importing the barrel itself:
// index.ts also re-exports ytdlp.ts, and an in-package test importing the
// barrel to reach one constant would set up a needless import cycle through
// the very module it is testing. Re-exported from index.ts unchanged, so the
// staying app-side consumer (`server/src/routers/
// sessions.youtubeImport.int.test.ts`) and this package's own `ytdlp.test.ts`
// both resolve through this ONE expression — never two independently
// written path computations for "the fixtures directory" that could
// silently drift onto different on-disk copies (the seam property recorded
// in the apply ledger's Phase 3 section).

import { fileURLToPath } from 'node:url';

/**
 * Resolved path to this package's fixtures directory (design D4 — the
 * `@autologger/catalog`'s `CATALOG_MIGRATIONS_DIR` pattern for shipping a
 * non-TS asset directory from a source-only package, applied unchanged).
 * Holds `fake-ytdlp.mjs`, the hermetic yt-dlp test double read by this
 * package's own `ytdlp.test.ts` and by the staying `server/src/routers/
 * sessions.youtubeImport.int.test.ts` — one on-disk copy, two readers, both
 * through this one constant. Resolved via `import.meta.url` from inside the
 * package so it works identically under `tsx` (dev/prod) and vitest,
 * regardless of process cwd.
 */
export const MEDIA_IMPORT_FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url));

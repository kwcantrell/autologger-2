// youtube-audio-import (design D6, task 5.4) — startup sweep of stale
// per-request import temp directories left under the blob store's scratch
// root by a crashed/killed prior process. The route handler's `finally`
// (task 5.3) removes its own temp dir on every NORMAL exit path (success,
// failure, timeout, bound breach); this sweep only covers the case that
// skips a `finally` entirely — a process crash/OOM/SIGKILL mid-download
// (design D6: "A startup sweep of stale import temp dirs covers
// `finally`-skipping crashes"). Synchronous, mirroring the rest of
// `node/config.ts`'s startup wiring (`mkdirSync` et al.) — runs once, at
// boot, before the server starts serving requests.
//
// Safety: matches ONLY the prefix this feature's own temp dirs are created
// with (`YOUTUBE_IMPORT_TMP_PREFIX`, also used by the route handler's
// `mkdtemp` call) — never a blanket wipe of the scratch root, which other
// features (e.g. transcript generation's `${sessionId}-`-prefixed dirs)
// also spool through. Never touches the blob store's actual audio prefix —
// the scratch root is already outside it (design D6 / `BlobStore`).

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Prefix every per-request youtube-import temp dir is created with — the
 * route handler does
 * `mkdtemp(join(scratchRoot(), \`${YOUTUBE_IMPORT_TMP_PREFIX}${sessionId}-\`))`.
 * The ONLY string this sweep matches against, so it structurally cannot
 * remove another feature's scratch-root temp dirs. */
export const YOUTUBE_IMPORT_TMP_PREFIX = 'youtube-import-';

/** Remove every stale youtube-import temp dir directly under `scratchRoot`
 * (design D6 orphan cleanup). Best-effort: a missing scratch root, or a
 * single entry that fails to remove (e.g. a permissions oddity), is
 * skipped rather than thrown — this must never block server startup. */
export function sweepStaleYoutubeImportTempDirs(scratchRoot: string): void {
  let entries: string[];
  try {
    entries = readdirSync(scratchRoot);
  } catch {
    return; // Scratch root doesn't exist yet (fresh DATA_DIR) — nothing to sweep.
  }
  for (const name of entries) {
    if (!name.startsWith(YOUTUBE_IMPORT_TMP_PREFIX)) continue;
    try {
      rmSync(join(scratchRoot, name), { recursive: true, force: true });
    } catch {
      // Best-effort — never let one stubborn entry block startup.
    }
  }
}

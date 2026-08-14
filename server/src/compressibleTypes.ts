// The single definition of "which responses this app's `compress()` acts on".
// Root-level (not under `routers/`) because it is shared by `app.ts` — which
// both registers `compress()` with it and pre-measures bodies for its size
// threshold — and by `routers/audio.ts`, whose mime clamp exists precisely to
// keep audio responses OUT of this set.

import { COMPRESSIBLE_CONTENT_TYPE_REGEX } from 'hono/compress';

/** The `/api/*` compressible-type filter: hono's default compressible-type
 * regex plus `application/x-ndjson` (export.jsonl), which that regex omits.
 * Shared by `compress()`, `measureCompressibleBody`, and the audio router's
 * `normalizeAudioMimeType` so the three can never disagree about which
 * responses are in scope. */
export const isCompressibleResponseType = (type: string): boolean =>
  COMPRESSIBLE_CONTENT_TYPE_REGEX.test(type) || /^application\/x-ndjson\b/i.test(type);

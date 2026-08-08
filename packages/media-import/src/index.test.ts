import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MEDIA_IMPORT_FIXTURES_DIR } from './index';

// feature-service-packages task 3.1 — replaces the scaffold placeholder
// (task 2.1) now that the package holds real production modules and their
// own tests (ytdlp.test.ts, ytdlp.realbinary.test.ts,
// youtubeImportGuard.test.ts). Pins the one piece of this barrel's own
// behavior those tests don't already cover: the exported fixtures
// directory constant resolves to a real directory containing the fixture
// both this package's and the app's tests read.
describe('@autologger/media-import package entry', () => {
  it('MEDIA_IMPORT_FIXTURES_DIR resolves to the package fixtures directory containing fake-ytdlp.mjs', () => {
    expect(existsSync(MEDIA_IMPORT_FIXTURES_DIR)).toBe(true);
    expect(existsSync(join(MEDIA_IMPORT_FIXTURES_DIR, 'fake-ytdlp.mjs'))).toBe(true);
  });
});

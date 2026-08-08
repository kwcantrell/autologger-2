import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TRANSCRIPTION_FIXTURES_DIR } from './index';

// feature-service-packages task 4.1 — replaces the scaffold placeholder
// (task 2.1) now that the package holds real production modules and their
// own tests (audioMerge.test.ts, deepgram.test.ts, transcriptRemap.test.ts,
// transcriptGenerationLock.test.ts). Pins the one piece of this barrel's own
// behavior those tests don't already cover: the exported fixtures directory
// constant resolves to a real directory containing the fixtures both this
// package's and the app's tests read.
describe('@autologger/transcription package entry', () => {
  it('TRANSCRIPTION_FIXTURES_DIR resolves to the package fixtures directory containing audio/ and the DeepGram enrichment fixture', () => {
    expect(existsSync(TRANSCRIPTION_FIXTURES_DIR)).toBe(true);
    expect(existsSync(join(TRANSCRIPTION_FIXTURES_DIR, 'audio'))).toBe(true);
    expect(existsSync(join(TRANSCRIPTION_FIXTURES_DIR, 'deepgram-enrichment-response.json'))).toBe(
      true,
    );
  });
});

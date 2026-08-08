import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_RUNTIME_FIXTURES_DIR } from './index';

// Barrel-level pin (openspec/changes/ai-runtime-package task 3.3), mirroring
// @autologger/transcription's and @autologger/media-import's index tests: the
// fixtures-directory constant this package exports resolves to a real
// directory holding the four fixtures that moved in with the runtime's own
// tests. The app-side integration tests reach the SAME four files through
// this same constant imported from `@autologger/ai-runtime`, so a broken
// resolution here is a broken resolution there.
describe('@autologger/ai-runtime barrel', () => {
  it('AI_RUNTIME_FIXTURES_DIR resolves to the package fixtures directory holding the four moved AI fixtures', () => {
    expect(existsSync(AI_RUNTIME_FIXTURES_DIR)).toBe(true);
    for (const name of [
      'fake-claude.mjs',
      'fake-claude-error.mjs',
      'fake-claude-exit-before-stdin.mjs',
      'ai-v2-sdk-spawn-recorder.mjs',
    ]) {
      expect(existsSync(join(AI_RUNTIME_FIXTURES_DIR, name))).toBe(true);
    }
  });
});

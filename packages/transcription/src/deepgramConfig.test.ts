import type { Config } from '@autologger/ports';
import { describe, expect, it } from 'vitest';
import { deepgramConfigured, deepgramModel } from './deepgramConfig';

// feature-service-packages task 4.3. Relocates the two `deepgramConfigured`/
// `deepgramModel` cases that lived in server/src/env.test.ts (deleted, not
// moved, by task 4.1 — see .apply/task-4a-report.md's "Concerns") back into
// this package's own suite, unchanged in meaning, now that the predicates
// live here (design D5). `resolveYtDlpPath`'s cases stay in env.test.ts (E2)
// and are not touched by this file.
const E = (o: Partial<Config>): Config => o as unknown as Config;

describe('deepgramConfig', () => {
  it('deepgramConfigured is true only when DEEPGRAM_API_KEY is set to a non-blank value', () => {
    expect(deepgramConfigured(E({}))).toBe(false);
    expect(deepgramConfigured(E({ DEEPGRAM_API_KEY: '' }))).toBe(false);
    expect(deepgramConfigured(E({ DEEPGRAM_API_KEY: '   ' }))).toBe(false);
    expect(deepgramConfigured(E({ DEEPGRAM_API_KEY: 'dg-key' }))).toBe(true);
  });

  it('deepgramModel defaults to nova-3 and is overridable via DEEPGRAM_MODEL', () => {
    expect(deepgramModel(E({}))).toBe('nova-3');
    expect(deepgramModel(E({ DEEPGRAM_MODEL: '' }))).toBe('nova-3');
    expect(deepgramModel(E({ DEEPGRAM_MODEL: 'nova-2' }))).toBe('nova-2');
  });
});

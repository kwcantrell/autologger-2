// batch-autogenerate task 3.2 (design D6): `transcriptOutcomeOf` maps each transcript generation
// error to its typed outcome. A pure mapping, so it runs in the unit tier (moved from
// transcript.int.test.ts, which needs Postgres only for its `runTranscript` cases).

import { TranscriptGenerateError } from '@autologger/transcription';
import { describe, expect, it } from 'vitest';
import { transcriptOutcomeOf } from './transcript';

describe('transcriptOutcomeOf (design D6)', () => {
  it('maps an oversize group (and every generation error code) to its outcome', () => {
    expect(transcriptOutcomeOf(new TranscriptGenerateError('oversize', 'big'))).toEqual({
      kind: 'error',
      code: 'oversize',
      detail: 'big',
    });
    expect(
      transcriptOutcomeOf(
        Object.assign(new TranscriptGenerateError('upstream', 'x'), { upstreamStatus: 429 }),
      ),
    ).toMatchObject({ kind: 'error', code: 'rate-limited' });
  });
});

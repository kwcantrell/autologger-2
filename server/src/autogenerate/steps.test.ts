// batch-autogenerate D5, D9 (owner decision 2026-11-10): the events runner's outcomes in the
// worker's terms; the aggregate instruction bound is a failure (`generation-failed`), shown in the
// report's failures, not a precondition skip.

import { describe, expect, it } from 'vitest';
import { eventsResult } from './steps';

describe('eventsResult', () => {
  it('the instruction-size bound fails the step generation-failed', () => {
    expect(
      eventsResult({ kind: 'precondition', code: 'too-many-instructions', detail: 'x' }),
    ).toEqual({ kind: 'fail', outcome: 'generation-failed', notProviderFault: true });
  });

  it('the other preconditions skip with their code', () => {
    for (const code of ['no-transcript', 'no-anchors', 'no-instructions'] as const) {
      expect(eventsResult({ kind: 'precondition', code, detail: 'x' })).toEqual({
        kind: 'skip',
        outcome: code,
      });
    }
  });
});

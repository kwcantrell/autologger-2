// Run lease lifetimes (session-run-leases D2). Constants only, so this runs in the unit tier (moved
// from runLease.int.test.ts, whose other cases claim leases on catalog.session_leases).
import { LeaseStore } from '@autologger/session-core/leaseStore';
import { describe, expect, it } from 'vitest';

const TTL = 40_000;

describe('silent run leases (session-run-leases D2)', () => {
  it('the run kinds live 40 s; the recording TTL is unchanged', () => {
    expect(LeaseStore.TTL_MS).toEqual({
      recording: LeaseStore.LEASE_STALE_MS,
      'ai-turn': TTL,
      'transcript-generation': TTL,
      'youtube-import': TTL,
    });
  });
});

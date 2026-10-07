import { LeaseStore, type RunLeaseKind } from '@autologger/session-core/leaseStore';
import { RUN_LEASE_KINDS } from '@autologger/storage';
import { describe, expect, expectTypeOf, it } from 'vitest';

// The lease directory's run-kind allow-list (run-status-and-sweeper D5) is session-core's
// `RunLeaseKind`, both ways: a new run kind must be added to the sweeper's delete on purpose, and
// `recording` is never on it. Storage cannot import session-core, so the pin lives here.
describe('RUN_LEASE_KINDS (run-status-and-sweeper D5)', () => {
  it('is exactly RunLeaseKind', () => {
    expectTypeOf<(typeof RUN_LEASE_KINDS)[number]>().toEqualTypeOf<RunLeaseKind>();
    const runKinds = Object.keys(LeaseStore.TTL_MS).filter((k) => k !== 'recording');
    expect([...RUN_LEASE_KINDS].sort()).toEqual(runKinds.sort());
    expect(RUN_LEASE_KINDS).not.toContain('recording');
  });
});

// Route-level helpers for the silent run leases (session-run-leases D4, D6): a live lease held as
// another process would hold it, the session's lease rows, and an observer of the claims and
// releases this process's runs make. Test infrastructure.

import { LeaseStore, type RunLeaseKind } from '@autologger/session-core/leaseStore';
import { SERVER_BOOT_ID } from '@autologger/session-core/runLease';
import { userCaller } from '@autologger/session-core/sessionCaller';
import { vi } from 'vitest';
import { defaultUser, env } from './harness';
import { insertRaw, rawRows, testStorage } from './session/sessionRows';

/** Claims a live `kind` lease on `sessionId` for the default user under a holder id no run of
 * this process uses: what a second process running the same request would hold. Returns the
 * holder id. */
export async function holdAsAnotherProcess(sessionId: string, kind: RunLeaseKind): Promise<string> {
  const holderId = `srv:another-process:${crypto.randomUUID()}`;
  const hub = (await env.ports.sessions.get(sessionId)).as(userCaller((await defaultUser()).id));
  if (!(await hub.claimRunLease(kind, holderId))) throw new Error(`could not hold ${kind}`);
  return holderId;
}

/** Writes a `kind` lease on `sessionId` for the default user that expired 10 s ago: what a
 * process that died mid-run leaves behind. Returns the holder id. */
export async function expiredLeaseOfAnotherProcess(
  sessionId: string,
  kind: RunLeaseKind,
): Promise<string> {
  const holderId = `srv:dead-process:${crypto.randomUUID()}`;
  const now = Date.now();
  await insertRaw(testStorage(sessionId), 'session_leases', {
    kind,
    holder_client_id: holderId,
    holder_user_id: (await defaultUser()).id,
    heartbeat_at_ms: now - 50_000,
    expires_at_ms: now - 10_000,
  });
  return holderId;
}

/** The session's lease rows, by kind. */
export async function runLeaseRows(
  sessionId: string,
): Promise<Array<{ kind: string; holder_client_id: string }>> {
  return (await rawRows(testStorage(sessionId), 'session_leases', {
    columns: 'kind, holder_client_id',
    orderBy: 'kind',
  })) as Array<{ kind: string; holder_client_id: string }>;
}

/** The session's lease rows with their holding user, by kind. */
export async function runLeaseHolders(
  sessionId: string,
): Promise<Array<{ kind: string; holder_user_id: string | null }>> {
  return (await rawRows(testStorage(sessionId), 'session_leases', {
    columns: 'kind, holder_user_id',
    orderBy: 'kind',
  })) as Array<{ kind: string; holder_user_id: string | null }>;
}

/** Pass-through spies on `LeaseStore`'s run-lease methods, keeping only the calls this process's
 * runs make (holder `srv:<SERVER_BOOT_ID>:…`). `restore()` removes the spies. */
export function observeRunLeases() {
  const claim = vi.spyOn(LeaseStore.prototype, 'claimRunLease');
  const release = vi.spyOn(LeaseStore.prototype, 'releaseRunLease');
  const ours = (calls: Array<[RunLeaseKind, string]>, kind: RunLeaseKind) =>
    calls
      .filter(([k, h]) => k === kind && h.startsWith(`srv:${SERVER_BOOT_ID}:`))
      .map(([, h]) => h);
  return {
    claim,
    /** Holder ids of every claim (renewals included) of `kind`, in order. */
    claims: (kind: RunLeaseKind) => ours(claim.mock.calls, kind),
    /** Holder ids of every release of `kind`, in order. */
    releases: (kind: RunLeaseKind) => ours(release.mock.calls, kind),
    restore: () => {
      claim.mockRestore();
      release.mockRestore();
    },
  };
}

/** Makes the next run-lease claim throw, as a failing database would. */
export function failNextRunLeaseClaim() {
  return vi
    .spyOn(LeaseStore.prototype, 'claimRunLease')
    .mockRejectedValueOnce(new Error('run lease claim failed (test)'));
}

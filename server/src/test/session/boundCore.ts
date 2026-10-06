// The bound-core harness (session-tables D12, panel finding 8): a real SessionCore on a typed
// runtime over one session's Postgres storage, replacing the SQLite fake runtime (fakeCore.ts).
// The root core holds no SQL handle, so store calls run in `run` (one write transaction over a
// transaction-bound core, as the hub's writes do: its broadcasts flush and its alarm is armed after
// COMMIT) or `read` (one snapshot, as the hub's reads do). Test infrastructure.

import { AudioStore } from '@autologger/session-core/audioStore';
import { DashboardStore } from '@autologger/session-core/dashboardStore';
import { EventStore } from '@autologger/session-core/eventStore';
import { LeaseStore } from '@autologger/session-core/leaseStore';
import type { SessionCaller } from '@autologger/session-core/sessionCaller';
import type { AttachedSocket, SessionRuntime } from '@autologger/session-core/sessionCore';
import { SessionCore } from '@autologger/session-core/sessionCore';
import { TopicStore } from '@autologger/session-core/topicStore';
import { TranscriptStore } from '@autologger/session-core/transcriptStore';
import { TransportStore } from '@autologger/session-core/transportStore';
import { createSessionRow, TEST_CALLER, type TestStorage, testStorage } from './sessionRows';

/** The stores over one bound core, as a hub body receives them. */
export interface BoundStores {
  core: SessionCore;
  events: EventStore;
  transport: TransportStore;
  audio: AudioStore;
  lease: LeaseStore;
  transcript: TranscriptStore;
  topics: TopicStore;
  dashboards: DashboardStore;
}

export interface BoundCore {
  /** The root core: no SQL handle; its broadcasts reach the sockets at once. */
  core: SessionCore;
  storage: TestStorage;
  /** `fn` over a transaction-bound core in one write transaction; after COMMIT its broadcasts
   * flush and its alarm is armed. */
  run<T>(fn: (s: BoundStores) => Promise<T>): Promise<T>;
  /** `fn` over a snapshot-bound core in one read-only snapshot. */
  read<T>(fn: (s: BoundStores) => Promise<T>): Promise<T>;
  /** `run` and `read` for `caller` (session-leases D3): the storage binds it, and the bound core
   * names it, so `core.callerUserId` is the user's id. Same runtime, sockets, alarms and time. */
  as(caller: SessionCaller): Pick<BoundCore, 'run' | 'read'>;
  /** Raw frames sent to the default browser socket, in order. */
  sent: string[];
  /** The same frames, JSON-parsed. */
  broadcasts: unknown[];
  alarms: number[];
  sockets: Set<AttachedSocket>;
  /** Mutable time base backing the default clock (`clock.now()` reads it). */
  time: { now: number };
}

function storesOn(core: SessionCore): BoundStores {
  return {
    core,
    events: new EventStore(core),
    transport: new TransportStore(core),
    audio: new AudioStore(core),
    lease: new LeaseStore(core),
    transcript: new TranscriptStore(core),
    topics: new TopicStore(core),
    dashboards: new DashboardStore(core),
  };
}

/** A bound-core harness over `storage` (session `sessionId`), seeded as a hub open seeds it. The
 * clock reads the mutable `time.now` unless `now` is given. `run` and `read` run as `TEST_CALLER`
 * with no caller on the bound core, unless `caller` is given (then as that caller, named on the
 * bound core); the seed always runs as `TEST_CALLER`. */
export async function boundCoreOn(
  storage: TestStorage,
  sessionId: string = storage.sessionId,
  opts: { now?: () => number; caller?: SessionCaller } = {},
): Promise<BoundCore> {
  const sent: string[] = [];
  const broadcasts: unknown[] = [];
  const alarms: number[] = [];
  const time = { now: 1_000_000 };
  const sockets = new Set<AttachedSocket>();
  sockets.add({
    send: (d) => {
      sent.push(d);
      broadcasts.push(JSON.parse(d));
    },
    role: 'browser',
  });
  const runtime: SessionRuntime = {
    sessionId,
    clock: { now: opts.now ?? (() => time.now) },
    sockets: () => sockets,
    setAlarm: (atMs) => alarms.push(atMs),
  };
  const core = new SessionCore(runtime);
  const runAs =
    (caller: SessionCaller | null) =>
    async <T>(fn: (s: BoundStores) => Promise<T>): Promise<T> => {
      let bound: SessionCore | null = null;
      try {
        const value = await storage.tx(caller ?? TEST_CALLER, (t) => {
          bound?.discardHeldBroadcasts();
          bound?.discardHeldAlarm();
          bound = core.forTransaction(t, caller);
          return fn(storesOn(bound));
        });
        const committed = bound as SessionCore | null;
        committed?.flushHeldBroadcasts();
        committed?.armHeldAlarm();
        return value;
      } catch (err) {
        const failed = bound as SessionCore | null;
        failed?.discardHeldBroadcasts();
        failed?.discardHeldAlarm();
        throw err;
      }
    };
  const readAs =
    (caller: SessionCaller | null) =>
    <T>(fn: (s: BoundStores) => Promise<T>): Promise<T> =>
      storage.snapshot(caller ?? TEST_CALLER, (t) => fn(storesOn(core.forSnapshot(t, caller))));
  const as = (caller: SessionCaller) => ({ run: runAs(caller), read: readAs(caller) });
  const run = runAs(opts.caller ?? null);
  const read = readAs(opts.caller ?? null);
  await runAs(null)((s) => s.core.seed());
  return { core, storage, run, read, as, sent, broadcasts, alarms, sockets, time };
}

/** A fresh session (its catalog row) with a bound-core harness over it. */
export async function boundCore(
  opts: { now?: () => number; caller?: SessionCaller } = {},
): Promise<BoundCore> {
  const sessionId = await createSessionRow();
  return boundCoreOn(testStorage(sessionId), sessionId, opts);
}

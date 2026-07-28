// Shared typed fake-runtime/real-core test helper (code-health-tail task 5.2,
// finding 5.10). The pattern the head change established in
// sessionCore.test.ts: a REAL SessionCore over in-memory SQLite, driven
// through a TYPED fake `SessionRuntime` — no `as unknown as SessionCore`
// casts, no SQL string-sniffing stubs. Domain-store unit tests build on this
// so the seam stays substitutable and the fakes can't drift from the real
// core's behavior.

import Database from 'better-sqlite3';
import { sqliteSessionSql } from '../session/SessionHub';
import type { AttachedSocket, SessionRuntime } from '../session/sessionCore';
import { SessionCore } from '../session/sessionCore';

export interface FakeRuntime {
  core: SessionCore;
  /** Raw frames sent to the default browser socket, in order. */
  sent: string[];
  /** The same frames, JSON-parsed — convenient for broadcast assertions. */
  broadcasts: unknown[];
  alarms: number[];
  sockets: Set<AttachedSocket>;
  /** Mutable time base backing the default clock (`clock.now()` reads it). */
  time: { now: number };
}

/** A real SessionCore (schema initialized) on a typed fake runtime: in-memory
 * SQL, one capturing browser socket, captured alarms, and an injectable clock
 * (default: the mutable `time.now` base; pass `now` to use e.g. `Date.now`
 * under vitest fake timers). */
export function fakeRuntime(opts: { now?: () => number } = {}): FakeRuntime {
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
    sql: sqliteSessionSql(new Database(':memory:')),
    clock: { now: opts.now ?? (() => time.now) },
    sockets: () => sockets,
    setAlarm: (atMs) => alarms.push(atMs),
  };
  const core = new SessionCore(runtime);
  core.initSchema();
  return { core, sent, broadcasts, alarms, sockets, time };
}

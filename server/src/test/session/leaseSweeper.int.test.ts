// The lease sweeper across two processes (run-status-and-sweeper D6; core-ports-architecture
// "Expired leases are swept by every process", "A crashed recorder's lease is freed without anyone
// opening the session"): two apps on one database and the Postgres frame bus. A recording lease
// claimed through app A expires with no alarm armed on app B (B never opened the session); one
// sweeper tick on B frees it through the hub's write path, so the revision advances once and A's
// socket gets `lease.changed`. Expired run rows are deleted silently, live ones are kept, and a
// second tick, on A, deletes nothing. When B already has the hub open (so its open freed nothing),
// the tick's own `expireStaleLeases` write frees the lease. Ticks are driven with
// `sweepLeasesOnce`, the timer's body.

import { userCaller } from '@autologger/session-core/sessionCaller';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepLeasesOnce } from '../../startupPurge';
import { loginCookie, seedSession, seedShow, seedStudio, seedUser } from '../helpers';
import {
  expiredLeaseOfAnotherProcess,
  liveLeaseOfAnotherProcess,
  runLeaseRows,
} from '../runLeases';
import { type BusProcess, busProcess, closeBusProcesses } from './busProcesses';
import { catalogRoot } from './sessionRows';

afterEach(async () => {
  vi.restoreAllMocks();
  await closeBusProcesses();
});

async function revision(sessionId: string): Promise<number> {
  const [row] = await catalogRoot()
    .bindSystem('test')
    .all<{ revision: number }>('SELECT revision FROM sessions WHERE id = ?', sessionId);
  return Number(row?.revision);
}

async function recordingRows(sessionId: string) {
  return catalogRoot()
    .bindSystem('test')
    .all<{ holder_client_id: string }>(
      "SELECT holder_client_id FROM session_leases WHERE session_id = ? AND kind = 'recording'",
      sessionId,
    );
}

/** A browser socket on `port` for `sessionId`, keeping every frame it receives. */
async function connect(port: number, sessionId: string, cookie: string) {
  const frames: { type?: string }[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/ws`, {
      headers: { cookie },
    } as unknown as string[]);
    w.addEventListener('open', () => resolve(w));
    w.addEventListener('error', (e) => reject(e));
  });
  ws.addEventListener('message', (e) => {
    try {
      frames.push(JSON.parse(typeof e.data === 'string' ? e.data : '{}'));
    } catch {
      frames.push({});
    }
  });
  return { ws, leaseChanged: () => frames.filter((f) => f.type === 'lease.changed').length };
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** One sweeper tick on `p`, with what its directory calls returned; it must not warn. */
async function tick(p: BusProcess) {
  const leases = p.bindings.ports.leases;
  const deleted = vi.spyOn(leases, 'deleteExpiredRunLeases');
  const listed = vi.spyOn(leases, 'expiredRecordingSessions');
  const warn = vi.fn();
  await sweepLeasesOnce({
    leases,
    sessions: p.bindings.ports.sessions,
    clock: p.bindings.ports.clock,
    warn,
  });
  expect(warn).not.toHaveBeenCalled();
  const out = {
    runRowsDeleted: await deleted.mock.results[0]?.value,
    recordingSessions: await listed.mock.results[0]?.value,
  };
  deleted.mockRestore();
  listed.mockRestore();
  return out;
}

describe('the lease sweeper across two processes (run-status-and-sweeper D6)', () => {
  it('a tick on B frees the expired recording lease claimed on A (revision +1, lease.changed on A), deletes expired run rows silently, and a second tick on A deletes nothing', async () => {
    const studio = await seedStudio();
    const owner = await seedUser({ studios: [studio], role: 'owner' });
    const show = await seedShow({ studioId: studio });
    const recorded = await seedSession({ showId: show });
    const ran = await seedSession({ showId: show });
    const [a, b] = [await busProcess(), await busProcess()];

    // A: a browser socket on the session and the recording lease claimed through A's hub.
    const sock = await connect(a.port, recorded, await loginCookie(owner));
    const hubA = (await a.bindings.ports.sessions.get(recorded)).as(userCaller(owner));
    expect(await hubA.claimLease('tab-a')).toBe(true);
    await until(() => sock.leaseChanged() === 1);
    // The recorder's process stops heartbeating: the lease is past its expiry. A's own alarm is
    // still armed at the original expiry, and B has never opened the session.
    const now = Date.now();
    await catalogRoot()
      .bindSystem('test')
      .run(
        "UPDATE session_leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE session_id = ? AND kind = 'recording'",
        now - 60_000,
        now - 1_000,
        recorded,
      );
    // A dead process's expired run lease, and a live one, on another session.
    const deadRun = await expiredLeaseOfAnotherProcess(ran, 'ai-turn');
    const liveRun = await liveLeaseOfAnotherProcess(ran, 'transcript-generation', now);
    const [recordedBefore, ranBefore] = [await revision(recorded), await revision(ran)];
    expect(await runLeaseRows(ran)).toHaveLength(2);

    expect(await tick(b)).toEqual({ runRowsDeleted: 1, recordingSessions: [recorded] });

    expect(await recordingRows(recorded)).toEqual([]);
    expect(await revision(recorded)).toBe(recordedBefore + 1);
    await until(() => sock.leaseChanged() === 2);
    const kept = await runLeaseRows(ran);
    expect(kept).toEqual([{ kind: 'transcript-generation', holder_client_id: liveRun }]);
    expect(kept.map((r) => r.holder_client_id)).not.toContain(deadRun);
    expect(await revision(ran)).toBe(ranBefore);

    expect(await tick(a)).toEqual({ runRowsDeleted: 0, recordingSessions: [] });
    expect(await revision(recorded)).toBe(recordedBefore + 1);
    expect(await revision(ran)).toBe(ranBefore);
    await new Promise((r) => setTimeout(r, 200));
    expect(sock.leaseChanged()).toBe(2);
    sock.ws.close();
  });

  it("with the hub already open on B, the tick's expireStaleLeases write frees the lease once", async () => {
    const studio = await seedStudio();
    const owner = await seedUser({ studios: [studio], role: 'owner' });
    const show = await seedShow({ studioId: studio });
    const recorded = await seedSession({ showId: show });
    const [a, b] = [await busProcess(), await busProcess()];
    const sock = await connect(a.port, recorded, await loginCookie(owner));
    const hubA = (await a.bindings.ports.sessions.get(recorded)).as(userCaller(owner));
    expect(await hubA.claimLease('tab-a')).toBe(true);
    // B opens the session while the lease is live: its open frees nothing, and its alarm is armed
    // at the original expiry, which the test never reaches.
    const hubB = await b.bindings.ports.sessions.get(recorded);
    await until(() => sock.leaseChanged() === 1);
    const now = Date.now();
    await catalogRoot()
      .bindSystem('test')
      .run(
        "UPDATE session_leases SET heartbeat_at_ms = ?, expires_at_ms = ? WHERE session_id = ? AND kind = 'recording'",
        now - 60_000,
        now - 1_000,
        recorded,
      );
    const before = await revision(recorded);
    const sweepWrite = vi.spyOn(hubB, 'as');

    expect(await tick(b)).toEqual({ runRowsDeleted: 0, recordingSessions: [recorded] });

    expect(sweepWrite).toHaveBeenCalledWith({ kind: 'system', reason: 'session-lease-sweep' });
    expect(await b.bindings.ports.sessions.get(recorded)).toBe(hubB);
    expect(await recordingRows(recorded)).toEqual([]);
    expect(await revision(recorded)).toBe(before + 1);
    await until(() => sock.leaseChanged() === 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(sock.leaseChanged()).toBe(2);
    sock.ws.close();
  });
});

// Startup hygiene for the KV store (async-session-callers D2): purge expired entries once, before
// the server listens (after the catalog readiness wait, catalog-on-postgres D2). A failure
// only warns: reads still treat expired entries as absent, so it must not block boot.
import type { Clock, KvStore, LeaseDirectory, PresenceRegistry } from '@autologger/ports';
import { type SessionHubRegistryFacade, systemCaller } from '@autologger/session-core';

export async function purgeExpiredAtBoot(
  kv: KvStore,
  warn: (msg: string) => void = console.warn,
): Promise<void> {
  try {
    await kv.purgeExpired();
  } catch (e) {
    const kind = e instanceof Error ? e.name : 'error';
    warn(
      `autologger: startup KV purge failed (${kind}); expired entries are still ignored on read`,
    );
  }
}

/** Purge expired KV entries every 10 minutes while running, so rows such as sign-in states don't
 * pile up until a restart (catalog-concurrency-hazards D10). Unref'd, warn-only; main.ts clears it
 * on shutdown. */
export function startPeriodicPurge(
  kv: KvStore,
  warn: (msg: string) => void = console.warn,
  intervalMs = 10 * 60_000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    kv.purgeExpired().catch((e: unknown) => {
      const code = (e as { code?: unknown })?.code;
      warn(
        `autologger: periodic KV purge failed (${typeof code === 'string' ? code : e instanceof Error ? e.name : 'error'})`,
      );
    });
  }, intervalMs);
  timer.unref();
  return timer;
}

/** The sweeper's caller: freeing an expired recording lease is session-wide, not any user's
 * (run-status-and-sweeper D6; a reviewed reason in catalogSystem.repo.test.ts). */
const SWEEP_CALLER = systemCaller('session-lease-sweep');

const errorKind = (e: unknown): string => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'error';
};

export interface LeaseSweepDeps {
  leases: LeaseDirectory;
  /** Companion presence: rows older than PRESENCE_SWEEP_MS are deleted first (companion-devices D4). */
  presence: PresenceRegistry;
  sessions: SessionHubRegistryFacade;
  clock: Clock;
  warn?: (msg: string) => void;
  /** The most recording sessions freed per tick; the rest wait for later ticks. */
  batch?: number;
}

/** Presence rows last updated longer ago than this are deleted by every sweeper tick. */
const PRESENCE_SWEEP_MS = 60_000;

/** One lease-sweeper tick (run-status-and-sweeper D6): delete presence rows older than 60 s
 * (companion-devices D4, first, so a failing listing below never skips it), delete the expired
 * run rows (silent), then
 * free each listed session's expired recording lease, one at a time, through the hub's write path
 * (revision bump, `lease.changed` to every process, alarm re-arm). Warn-only: a failed step or
 * session warns and the tick goes on. Idempotent across processes: a second sweep deletes nothing. */
export async function sweepLeasesOnce({
  leases,
  presence,
  sessions,
  clock,
  warn = console.warn,
  batch = 100,
}: LeaseSweepDeps): Promise<void> {
  try {
    await presence.deleteOlderThan(clock.now() - PRESENCE_SWEEP_MS);
  } catch (e) {
    warn(`autologger: lease sweep: presence delete failed (${errorKind(e)})`);
  }
  try {
    await leases.deleteExpiredRunLeases(clock.now());
  } catch (e) {
    warn(`autologger: lease sweep: run-lease delete failed (${errorKind(e)})`);
  }
  let ids: string[];
  try {
    ids = await leases.expiredRecordingSessions(clock.now(), batch);
  } catch (e) {
    warn(`autologger: lease sweep: listing expired recording leases failed (${errorKind(e)})`);
    return;
  }
  for (const id of ids) {
    try {
      await (await sessions.get(id)).as(SWEEP_CALLER).expireStaleLeases();
    } catch (e) {
      warn(`autologger: lease sweep: session ${id} failed (${errorKind(e)})`);
    }
  }
}

/** Every process sweeps expired session leases every minute, with no election (core-ports-
 * architecture "Expired leases are swept by every process"). No tick at start, so it never delays
 * `listen()`; ticks never overlap (a busy flag). Unref'd; main.ts clears it on shutdown. */
export function startLeaseSweeper(deps: LeaseSweepDeps & { intervalMs?: number }): NodeJS.Timeout {
  const { intervalMs = 60_000, warn = console.warn, ...rest } = deps;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void sweepLeasesOnce({ ...rest, warn })
      .catch((e: unknown) => warn(`autologger: lease sweep failed (${errorKind(e)})`))
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref();
  return timer;
}

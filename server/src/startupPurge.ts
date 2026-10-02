// Startup hygiene for the KV store (async-session-callers D2): purge expired entries once, before
// the server listens (after the catalog readiness wait, catalog-on-postgres D2). A failure
// only warns: reads still treat expired entries as absent, so it must not block boot.
import type { KvStore } from '@autologger/ports';

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

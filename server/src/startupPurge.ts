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

// Boot-time catalog readiness (catalog-on-postgres D2): before listening, wait until the catalog
// answers a `kv` query. The stack's migrations service may still be creating the schema, the db
// may be restarting, or a rotation may be mid-way, so every error is retried, inside one budget
// that also bounds each attempt (a connect to an unreachable host takes its own 5 s timeout).
// Logs name error codes only, never messages, which can echo values.
import type { CatalogDb } from '@autologger/ports';

const TIMEOUT = Symbol('timeout');

function codeOf(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === 'string' && code) return code;
  return e instanceof Error ? e.name : 'error';
}

export async function waitForCatalog(
  db: CatalogDb,
  opts: { budgetMs?: number; log?: (line: string) => void } = {},
): Promise<void> {
  const budgetMs = opts.budgetMs ?? 30_000;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const deadline = Date.now() + budgetMs;
  const seen = new Set<string>();
  let last = 'timeout';
  let backoff = 500;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cutoff = new Promise<typeof TIMEOUT>((r) => {
      timer = setTimeout(() => r(TIMEOUT), remaining);
    });
    try {
      const r = await Promise.race([db.first('SELECT 1 AS ok FROM kv LIMIT 1'), cutoff]);
      if (r !== TIMEOUT) return;
      last = 'timeout';
      break;
    } catch (e) {
      last = codeOf(e);
      if (!seen.has(last)) {
        seen.add(last);
        log(`autologger: catalog not ready (${last}); retrying for up to ${budgetMs / 1000} s`);
      }
    } finally {
      clearTimeout(timer);
    }
    const wait = Math.min(backoff, deadline - Date.now());
    if (wait <= 0) break;
    await new Promise((r) => setTimeout(r, wait));
    backoff = Math.min(backoff * 2, 2_000);
  }
  throw new Error(`catalog not ready after ${budgetMs / 1000} s (last: ${last})`);
}

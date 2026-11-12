// The log-import job store over the server's real Postgres KV (shared-request-state D4): a failed
// record write is warned about and carried by the next one. The package's unit suite covers this
// over its in-memory kv; on the server tier it used to be reached only by a job whose last write
// landed after its test's teardown had closed the catalog, which the harness no longer
// lets happen by chance.

import { afterEach, expect, it, vi } from 'vitest';
import { env } from './harness';

afterEach(() => {
  vi.restoreAllMocks();
});

it('a failed job write on the real KV is warned about and carried by the next one', async () => {
  const jobs = env.ports.logImportJobs;
  const job = await jobs.create('user-1');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(env.ports.kv, 'replaceIf').mockRejectedValueOnce(new Error('catalog blip'));
  await jobs.appendLine(job.id, 'lost-then-carried');
  expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
    /write failed \(catalog blip\)/,
  );
  await jobs.appendLine(job.id, 'next');
  await jobs.release(job.id);
  expect((await jobs.get(job.id))?.lines).toEqual(['lost-then-carried', 'next']);
});

// media-worker B.6 (design D5, D6): the operator's enqueue script emits guarded, value-free SQL.
// Its selection runs over Postgres in enqueueMediaJobs.int.test.ts.
import { describe, expect, it } from 'vitest';
import { enqueueStatements, parseArgs, renderSql } from '../../scripts/enqueueMediaJobs';

describe('enqueueMediaJobs SQL', () => {
  it('ingest jobs for rows with null peaks, null duration or a WAV mime, coalesced on the live index', () => {
    const [ingest, ...rest] = enqueueStatements({ merge: false });
    expect(rest).toEqual([]);
    expect(ingest).toMatch(/insert into catalog\.media_jobs/i);
    expect(ingest).toMatch(/'ingest'/);
    expect(ingest).toMatch(/waveform_peaks_json is null/i);
    expect(ingest).toMatch(/duration_ms is null/i);
    expect(ingest).toMatch(/wav/i);
    expect(ingest).toMatch(
      /on conflict \(kind, session_id, target\) where status in \('queued', 'running', 'done'\) do nothing/i,
    );
    expect(ingest).not.toMatch(/'merge'/);
  });

  it('--merge is the only path that emits merge jobs, for every multi-chunk recording', () => {
    const stmts = enqueueStatements({ merge: true });
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(/'merge'/);
    expect(stmts[0]).toMatch(/having count\(\*\) >= 2/i);
    expect(stmts[0]).not.toMatch(/media_status is not null/i);
    expect(stmts[0]).toMatch(/do nothing/i);
  });

  it('renders one transaction and prints no ids, keys or other row values', () => {
    const sql = renderSql(enqueueStatements({ merge: false }));
    expect(sql.startsWith('begin;\n')).toBe(true);
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
    expect(sql).not.toMatch(/audio\/|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('parses --merge and refuses anything else', () => {
    expect(parseArgs([])).toEqual({ merge: false });
    expect(parseArgs(['--merge'])).toEqual({ merge: true });
    expect(() => parseArgs(['--bogus'])).toThrow();
  });
});

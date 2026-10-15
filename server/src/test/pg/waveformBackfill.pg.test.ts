// supabase-11a-legacy-import follow-up B: the SQL `server/scripts/backfillWaveforms.ts` emits, applied the way
// the runbook does (`docker exec -i <db> psql -X -U postgres` from stdin) to a migrated catalog:
// only rows still NULL are filled (with floor -48), filled rows are untouched, a second apply is a
// no-op, and the export query yields the CSV the script reads.

import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, testPg } from '../../../../test/pg/testDb';
import {
  buildUpdateSql,
  EXPORT_QUERY,
  parseSegmentsCsv,
  peaksJson,
} from '../../../scripts/backfillWaveforms';

const T = '2026-10-11T00:00:00.000Z';
const open: postgres.Sql[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

function psql(
  db: string,
  input: string,
  extra: string[] = [],
): { status: number | null; out: string; err: string } {
  const r = spawnSync(
    'docker',
    ['exec', '-i', testPg().container, 'psql', '-X', '-q', '-U', 'postgres', '-d', db, ...extra],
    { input, encoding: 'utf8' },
  );
  return { status: r.status, out: r.stdout, err: r.stderr };
}

async function seed(): Promise<{ db: string; sql: postgres.Sql }> {
  const t = await createTestDatabase();
  const sql = postgres({ ...t.admin, max: 1, onnotice: () => {} });
  open.push(sql);
  await sql`insert into catalog.sessions (id) values ('s1'), ('s2')`;
  const seg = (
    sid: string,
    id: string,
    ord: number,
    peaks: string | null,
    floor: number | null,
  ) => sql`
    insert into catalog.session_audio_segments
      (session_id, id, ordinal, mime_type, r2_key, waveform_peaks_json, waveform_db_floor, created_at_utc)
    values (${sid}, ${id}, ${ord}, 'audio/wav', ${`audio/${sid}/${String(ord).padStart(4, '0')}_${id}.wav`},
            ${peaks}, ${floor}, ${T})`;
  await seg('s1', 'a', 1, null, null);
  await seg('s1', 'b', 2, '[0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5]', -72);
  await seg('s2', 'c', 1, null, null);
  return { db: t.name, sql };
}

const P1 = Float32Array.from({ length: 4096 }, (_, i) => (i % 97) / 96);
const P2 = Float32Array.from({ length: 300 }, (_, i) => Math.sqrt(i / 299));

describe('applying the backfill SQL with psql', () => {
  it('fills only NULL rows, keeps filled ones, and is a no-op the second time', async () => {
    const { db, sql } = await seed();
    const exported = psql(db, `${EXPORT_QUERY};\n`);
    expect(exported.status, exported.err).toBe(0);
    const rows = parseSegmentsCsv(exported.out);
    expect(rows).toEqual([
      { session_id: 's1', id: 'a', r2_key: 'audio/s1/0001_a.wav' },
      { session_id: 's2', id: 'c', r2_key: 'audio/s2/0001_c.wav' },
    ]);

    // The run also carries s1/b (a browser stored peaks after the export): it must stay as is.
    const updates = buildUpdateSql([
      { row: rows[0], peaks: P1 },
      { row: { session_id: 's1', id: 'b', r2_key: 'audio/s1/0002_b.wav' }, peaks: P1 },
      { row: rows[1], peaks: P2 },
    ]);
    const first = psql(db, updates);
    expect(first.status, first.err).toBe(0);
    const after = await sql`select session_id, id, waveform_peaks_json, waveform_db_floor
                            from catalog.session_audio_segments order by session_id, id`;
    expect(
      after.map((r) => [r.session_id, r.id, r.waveform_peaks_json, r.waveform_db_floor]),
    ).toEqual([
      ['s1', 'a', peaksJson(P1), -48],
      ['s1', 'b', '[0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5]', -72],
      ['s2', 'c', peaksJson(P2), -48],
    ]);
    // Stored text parses back to the same Float32 values the browser would hold.
    expect(Float32Array.from(JSON.parse(after[0].waveform_peaks_json))).toEqual(P1);

    const again = psql(db, buildUpdateSql([{ row: rows[0], peaks: P2 }]));
    expect(again.status, again.err).toBe(0);
    const [a] =
      await sql`select waveform_peaks_json from catalog.session_audio_segments where id = 'a'`;
    expect(a.waveform_peaks_json).toBe(peaksJson(P1));
    expect(psql(db, `${EXPORT_QUERY};\n`).out.trim()).toBe('session_id,id,r2_key');
  });

  it('an error rolls the whole file back (ON_ERROR_STOP + one transaction)', async () => {
    const { db, sql } = await seed();
    const good = buildUpdateSql([
      { row: { session_id: 's1', id: 'a', r2_key: 'audio/s1/0001_a.wav' }, peaks: P1 },
    ]);
    const broken = good.replace('commit;', 'select 1/0;\ncommit;');
    const r = psql(db, broken);
    expect(r.status).not.toBe(0);
    const [a] =
      await sql`select waveform_peaks_json from catalog.session_audio_segments where id = 'a'`;
    expect(a.waveform_peaks_json).toBeNull();
  });
});

// supabase-11a-legacy-import follow-up C: the SQL `server/scripts/convertWavToFlac.ts` emits,
// applied the way the runbook does (`docker exec -i <db> psql -X -U postgres` from stdin) to a
// migrated catalog: the export selects the WAV rows, each UPDATE switches key + mime only while
// the row still holds the WAV key (peaks kept), a second apply is a no-op, a failure rolls the
// file back, and the referenced-keys export feeds the cleanup.

import { spawnSync } from 'node:child_process';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, testPg } from '../../../../test/pg/testDb';
import { parseSegmentsCsv } from '../../../scripts/blobSegmentRows';
import {
  buildConvertSql,
  EXPORT_QUERY,
  flacKeyFor,
  REFERENCED_QUERY,
} from '../../../scripts/convertWavToFlac';

const T = '2026-10-11T00:00:00.000Z';
const open: postgres.Sql[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.end()));
});

function psql(db: string, input: string): { status: number | null; out: string; err: string } {
  const r = spawnSync(
    'docker',
    ['exec', '-i', testPg().container, 'psql', '-X', '-q', '-U', 'postgres', '-d', db],
    { input, encoding: 'utf8' },
  );
  return { status: r.status, out: r.stdout, err: r.stderr };
}

async function seed(): Promise<{ db: string; sql: postgres.Sql }> {
  const t = await createTestDatabase();
  const sql = postgres({ ...t.admin, max: 1, onnotice: () => {} });
  open.push(sql);
  await sql`insert into catalog.sessions (id) values ('s1'), ('s2')`;
  const seg = (sid: string, id: string, ord: number, mime: string, key: string) => sql`
    insert into catalog.session_audio_segments
      (session_id, id, ordinal, mime_type, r2_key, waveform_peaks_json, waveform_db_floor, created_at_utc)
    values (${sid}, ${id}, ${ord}, ${mime}, ${key}, '[0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5]', -48, ${T})`;
  await seg('s1', 'a', 1, 'audio/wav', 'audio/s1/0001_a.wav');
  await seg('s1', 'b', 2, 'audio/mpeg', 'audio/s1/0002_b.mp3');
  await seg('s1', 'c', 3, 'audio/x-wav', 'audio/s1/0003_c.wav');
  await seg('s2', 'd', 1, 'audio/webm;codecs=opus', 'audio/s2/0001_d.webm');
  await seg('s2', 'e', 2, 'audio/wav', 'audio/s2/0002_e.WAV');
  return { db: t.name, sql };
}

const rowsOf = async (sql: postgres.Sql) =>
  (
    await sql`select session_id, id, mime_type, r2_key, waveform_peaks_json
              from catalog.session_audio_segments order by session_id, ordinal`
  ).map((r) => [r.session_id, r.id, r.mime_type, r.r2_key, r.waveform_peaks_json]);

describe('applying the WAV -> FLAC SQL with psql', () => {
  it('exports the WAV rows; switches key + mime only while the WAV key is current; idempotent', async () => {
    const { db, sql } = await seed();
    const exported = psql(db, `${EXPORT_QUERY};\n`);
    expect(exported.status, exported.err).toBe(0);
    const rows = parseSegmentsCsv(exported.out);
    expect(rows.map((r) => r.id)).toEqual(['a', 'c', 'e']);

    // c changed after the export (re-uploaded, say): its UPDATE must not apply.
    await sql`update catalog.session_audio_segments set r2_key = 'audio/s1/0003_c.webm' where id = 'c'`;
    const updates = buildConvertSql(rows.map((row) => ({ row, flacKey: flacKeyFor(row.r2_key) })));
    const first = psql(db, updates);
    expect(first.status, first.err).toBe(0);
    const peaks = '[0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5]';
    expect(await rowsOf(sql)).toEqual([
      ['s1', 'a', 'audio/flac', 'audio/s1/0001_a.flac', peaks],
      ['s1', 'b', 'audio/mpeg', 'audio/s1/0002_b.mp3', peaks],
      ['s1', 'c', 'audio/x-wav', 'audio/s1/0003_c.webm', peaks],
      ['s2', 'd', 'audio/webm;codecs=opus', 'audio/s2/0001_d.webm', peaks],
      ['s2', 'e', 'audio/flac', 'audio/s2/0002_e.flac', peaks],
    ]);
    const before = await rowsOf(sql);
    const again = psql(db, updates);
    expect(again.status, again.err).toBe(0);
    expect(await rowsOf(sql)).toEqual(before);
    // Only c is left for a next export (its mime still says wav).
    expect(parseSegmentsCsv(psql(db, `${EXPORT_QUERY};\n`).out).map((r) => r.id)).toEqual(['c']);

    const referenced = parseSegmentsCsv(psql(db, `${REFERENCED_QUERY};\n`).out);
    expect(referenced.map((r) => r.r2_key)).toEqual([
      'audio/s1/0001_a.flac',
      'audio/s1/0002_b.mp3',
      'audio/s1/0003_c.webm',
      'audio/s2/0001_d.webm',
      'audio/s2/0002_e.flac',
    ]);
  });

  it('an error rolls the whole file back (ON_ERROR_STOP + one transaction)', async () => {
    const { db, sql } = await seed();
    const good = buildConvertSql([
      {
        row: { session_id: 's1', id: 'a', r2_key: 'audio/s1/0001_a.wav' },
        flacKey: 'audio/s1/0001_a.flac',
      },
    ]);
    const r = psql(db, good.replace('commit;', 'select 1/0;\ncommit;'));
    expect(r.status).not.toBe(0);
    const [a] =
      await sql`select r2_key, mime_type from catalog.session_audio_segments where id = 'a'`;
    expect([a.r2_key, a.mime_type]).toEqual(['audio/s1/0001_a.wav', 'audio/wav']);
  });
});

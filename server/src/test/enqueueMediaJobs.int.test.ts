// media-worker B.6: the operator's enqueue SQL over Postgres. Ingest jobs for rows missing peaks or
// a duration or stored as WAV; merges only with --merge, legacy (NULL media_status) recordings
// included; re-running adds nothing.
import { describe, expect, it } from 'vitest';
import { enqueueStatements } from '../../scripts/enqueueMediaJobs';
import { seededSession } from './helpers';
import { catalogRoot } from './session/sessionRows';

const sys = () => catalogRoot().bindSystem('test-seed');

async function legacyRow(
  sid: string,
  id: string,
  ro: number | null,
  over: { peaks?: boolean; duration?: boolean; mime?: string } = {},
) {
  await sys().run(
    `INSERT INTO session_audio_segments (session_id, id, ordinal, mime_type, r2_key, recording_ordinal,
       created_at_utc, waveform_peaks_json, duration_ms)
     VALUES (?, ?, 1, ?, ?, ?, '2026-01-01T00:00:00Z', ?, ?)`,
    sid,
    id,
    over.mime ?? 'audio/webm',
    `audio/${sid}/0001_${id}.webm`,
    ro,
    over.peaks ? '[0,0,0,0,0,0,0,0]' : null,
    over.duration ? 1000 : null,
  );
}

const run = async (merge: boolean) => {
  for (const st of enqueueStatements({ merge })) await sys().run(st);
};

const jobs = (sid: string) =>
  sys().all<{ kind: string; target: string; input_bytes: number }>(
    'SELECT kind, target, input_bytes FROM media_jobs WHERE session_id = ? ORDER BY kind, target',
    sid,
  );

describe('enqueueMediaJobs over Postgres', () => {
  it('selects the rows that need ingest, merges only with --merge, and is idempotent', async () => {
    const { sessionId: sid } = await seededSession();
    await legacyRow(sid, 'a-needs-peaks', 1, { duration: true });
    await legacyRow(sid, 'b-needs-duration', 1, { peaks: true });
    await legacyRow(sid, 'c-wav', null, { peaks: true, duration: true, mime: 'audio/wav' });
    await legacyRow(sid, 'd-complete', 2, { peaks: true, duration: true });
    await run(false);
    await run(false);
    expect((await jobs(sid)).map((j) => `${j.kind}:${j.target}`)).toEqual([
      'ingest:a-needs-peaks',
      'ingest:b-needs-duration',
      'ingest:c-wav',
    ]);
    expect((await jobs(sid))[0]?.input_bytes).toBe(1500 * 1024 * 1024);
    await run(true);
    await run(true);
    expect((await jobs(sid)).filter((j) => j.kind === 'merge').map((j) => j.target)).toEqual(['1']);
  });
});

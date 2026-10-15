// Task 6.1 (chunked-live-recording) — server-side integration confirmation for
// multi-chunk live recording uploads. NO server production code changes: this
// documents EXISTING `POST /api/sessions/:id/audio/segments` behavior that the
// client-owned chunk pipeline (design D6) and the single-flight requirement's
// dedupe hook in specs/live-recording-chunks/spec.md rely on.
import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import { seededSession } from '../test/helpers';

type SegmentDict = {
  id: string;
  ordinal: number;
  started_at_utc: string | null;
  ended_at_utc: string | null;
  mime_type: string;
  recording_ordinal: number | null;
};

async function uploadSegment(
  session: string,
  opts: { recordingOrdinal: number; startedAtUtc: string; endedAtUtc: string },
): Promise<SegmentDict> {
  const qs = new URLSearchParams({
    recording_ordinal: String(opts.recordingOrdinal),
    started_at_utc: opts.startedAtUtc,
    ended_at_utc: opts.endedAtUtc,
  });
  const res = await app.request(
    `/api/sessions/${session}/audio/segments?${qs.toString()}`,
    { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array([9, 9]) },
    { ...env },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as SegmentDict;
}

async function listSegments(session: string): Promise<SegmentDict[]> {
  const res = await app.request(
    `/api/sessions/${session}/audio/segments`,
    { method: 'GET' },
    { ...env },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { segments: SegmentDict[] };
  return body.segments;
}

describe('multi-chunk live recording segment uploads (task 6.1)', () => {
  it('two chunks sharing recording_ordinal both appear with correct metadata in capture order', async () => {
    const session = (await seededSession()).sessionId;
    const chunk1 = await uploadSegment(session, {
      recordingOrdinal: 1,
      startedAtUtc: '2026-08-12T10:00:00.000Z',
      endedAtUtc: '2026-08-12T10:00:05.000Z',
    });
    const chunk2 = await uploadSegment(session, {
      recordingOrdinal: 1,
      startedAtUtc: '2026-08-12T10:00:05.000Z',
      endedAtUtc: '2026-08-12T10:00:10.000Z',
    });

    const segments = await listSegments(session);
    expect(segments).toHaveLength(2);

    // Capture-ordered ordinals: the first upload gets the lower ordinal.
    expect(chunk1.ordinal).toBeLessThan(chunk2.ordinal);
    const [first, second] = segments;
    expect(first?.id).toBe(chunk1.id);
    expect(second?.id).toBe(chunk2.id);

    // Per-segment metadata round-trips correctly for both chunks.
    expect(first).toMatchObject({
      recording_ordinal: 1,
      started_at_utc: '2026-08-12T10:00:00.000Z',
      ended_at_utc: '2026-08-12T10:00:05.000Z',
      mime_type: 'audio/webm',
    });
    expect(second).toMatchObject({
      recording_ordinal: 1,
      started_at_utc: '2026-08-12T10:00:05.000Z',
      ended_at_utc: '2026-08-12T10:00:10.000Z',
      mime_type: 'audio/webm',
    });
  });

  it('a replayed recording window answers the first segment and stores no second row (media-worker D18)', async () => {
    // Superseded premise: until media-worker the server was append-only here and the client's
    // dedupe was the only guard. Now the POST is idempotent per (recording_ordinal,
    // started_at_utc) window (api-contract-freeze "Segment upload is idempotent per recording
    // window"); the client keeps its dedupe as the first guard.
    const session = (await seededSession()).sessionId;
    const startedAtUtc = '2026-08-12T11:00:00.000Z';
    const endedAtUtc = '2026-08-12T11:00:05.000Z';
    const first = await uploadSegment(session, { recordingOrdinal: 2, startedAtUtc, endedAtUtc });
    const retry = await uploadSegment(session, { recordingOrdinal: 2, startedAtUtc, endedAtUtc });
    expect(retry.id).toBe(first.id);
    const segments = await listSegments(session);
    const matches = segments.filter(
      (s) => s.recording_ordinal === 2 && s.started_at_utc === startedAtUtc,
    );
    expect(matches.map((s) => s.id)).toEqual([first.id]);
  });
});

// session-tables design D5 (A11): a `recording_ordinal` digit string whose number is not a safe
// integer is treated as absent, as a non-digit value already is, so it never reaches a session
// `bigint` out of range; the segment is stored and the response stays 200.
describe('POST …/audio/segments with an oversized recording_ordinal', () => {
  it('answers 200 and stores the segment with no recording ordinal', async () => {
    const session = (await seededSession()).sessionId;
    const res = await app.request(
      `/api/sessions/${session}/audio/segments?recording_ordinal=123456789012345678901`,
      { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array([9, 9]) },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as SegmentDict).recording_ordinal).toBeNull();
    const listed = await listSegments(session);
    expect(listed).toHaveLength(1);
    expect(listed[0].recording_ordinal).toBeNull();
  });
});

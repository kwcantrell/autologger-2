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
    const session = seededSession().sessionId;
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

  it('documents the client dedupe premise: identical recording_ordinal+started_at_utc creates a second row', async () => {
    // This test documents the SERVER-SIDE premise the "lost response does not
    // duplicate" scenario in specs/live-recording-chunks/spec.md relies on:
    // the server is append-only and does NOT dedupe on
    // (recording_ordinal, started_at_utc). Dedupe is entirely client-side —
    // per the single-flight requirement, before re-attempting an ambiguously
    // failed chunk the client refetches the segments list and treats an
    // existing segment with the same recording_ordinal + started_at_utc as
    // that chunk's already-persisted success, never re-uploading it. This
    // test proves that premise by showing the server itself would happily
    // create a duplicate row if the client ever DID re-POST — i.e. the
    // client-side check is load-bearing, not a redundant belt-and-suspenders
    // guard against a server that already refuses duplicates.
    const session = seededSession().sessionId;
    const startedAtUtc = '2026-08-12T11:00:00.000Z';
    const endedAtUtc = '2026-08-12T11:00:05.000Z';

    const first = await uploadSegment(session, {
      recordingOrdinal: 2,
      startedAtUtc,
      endedAtUtc,
    });
    const retry = await uploadSegment(session, {
      recordingOrdinal: 2,
      startedAtUtc,
      endedAtUtc,
    });

    // Append-only: a second, distinct row was created rather than being
    // rejected or merged into the first.
    expect(retry.id).not.toBe(first.id);

    const segments = await listSegments(session);
    const matches = segments.filter(
      (s) => s.recording_ordinal === 2 && s.started_at_utc === startedAtUtc,
    );
    // Both rows are visible on the segments list, distinguishable only by
    // sharing the same (recording_ordinal, started_at_utc) pair — exactly
    // the signal the client-side dedupe hook keys off of to recognize an
    // already-uploaded chunk after a lost response.
    expect(matches).toHaveLength(2);
    expect(matches.map((s) => s.id).sort()).toEqual([first.id, retry.id].sort());
  });
});

// supabase-11a-legacy-import follow-up B — pinning test: the server-side backfill
// (`server/scripts/backfillWaveforms.ts`) computes peaks with
// `packages/domain/src/waveformPeaks.ts`; the browser computes them with this
// directory's `waveformDecode.ts` (`computeDbPeaks01`) and `waveformMerge.ts`
// (constants, bucket-count rule). `web/` does not import `packages/`
// (web-package-boundary), so the two are separate copies; this test feeds both
// the same PCM and asserts BIT-IDENTICAL peaks, so stored backfilled peaks are
// indistinguishable from browser-stored ones and the copies cannot drift.
//
// TEST-ONLY cross-workspace import (dynamic, resolved by vitest at run time;
// nothing under web/src imports packages/ in production code).

import { describe, expect, it } from 'vitest';
import { computeDbPeaks01 } from './waveformDecode';
import * as client from './waveformMerge';

const shared = await import('../../../../packages/domain/src/waveformPeaks.ts');

function fakeAudioBuffer(channels: Float32Array[]): AudioBuffer {
  return {
    length: channels[0]?.length ?? 0,
    numberOfChannels: channels.length,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer;
}

function pcm(len: number, seed: number, gain: number): Float32Array {
  let s = seed;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out[i] = gain * ((s / 2147483648) * 2 - 1) * Math.abs(Math.sin(i / 4801));
  }
  return out;
}

function viaShared(channels: Float32Array[], bucketCount: number, dbFloor: number): Float32Array {
  const n = channels.length;
  const len = channels[0].length;
  const acc = new shared.DbPeaksAccumulator(len, bucketCount, dbFloor);
  const chunk = 4093; // deliberately not a divisor of anything
  for (let f = 0; f < len; f += chunk) {
    const m = Math.min(chunk, len - f);
    const inter = new Float32Array(m * n);
    for (let i = 0; i < m; i++) for (let c = 0; c < n; c++) inter[i * n + c] = channels[c][f + i];
    acc.pushInterleaved(inter, n);
  }
  return acc.finish();
}

describe('server backfill peaks == browser peaks (same PCM)', () => {
  const cases: Array<[string, Float32Array[], number]> = [
    [
      'stereo, decoded alone (4096)',
      [pcm(48_000 * 5 + 3, 1, 0.9), pcm(48_000 * 5 + 3, 2, 0.4)],
      4096,
    ],
    ['mono, timeline share (1000)', [pcm(44_100 * 2, 3, 1)], 1000],
    ['fewer frames than buckets', [pcm(700, 4, 0.5)], 4096],
    ['six channels', Array.from({ length: 6 }, (_, c) => pcm(20_000, 10 + c, c / 6)), 256],
    ['silence', [new Float32Array(9600), new Float32Array(9600)], 512],
  ];
  for (const [name, chans, buckets] of cases) {
    it(name, () => {
      const browser = computeDbPeaks01(fakeAudioBuffer(chans), buckets, client.WF_DB_FLOOR);
      const backfill = viaShared(chans, buckets, shared.WF_DB_FLOOR);
      expect(backfill).toEqual(browser);
      // The PUT body / stored JSON is the same text.
      expect(JSON.stringify(Array.from(backfill, Number))).toBe(
        JSON.stringify(Array.from(browser, (x) => Number(x))),
      );
    });
  }

  it('the constants and the bucket-count rule are the same', () => {
    expect(shared.WF_DB_FLOOR).toBe(client.WF_DB_FLOOR);
    expect(shared.WF_TIMELINE_BUCKETS).toBe(client.WF_TIMELINE_BUCKETS);
    expect(shared.WF_SEGMENT_DECODE_MIN).toBe(client.WF_SEGMENT_DECODE_MIN);
    expect(shared.WF_SEGMENT_DECODE_MAX).toBe(client.WF_SEGMENT_DECODE_MAX);
    for (const [d, span] of [
      [0, 0],
      [0.01, 0.01],
      [0.3, 0.3],
      [12, 12],
      [60, 600],
      [1, 3600],
      [7200, 7200],
      [Number.NaN, 10],
    ]) {
      expect(shared.segmentWaveformDecodeBucketCount(d, span)).toBe(
        client.segmentWaveformDecodeBucketCount(d, span),
      );
    }
  });

  it('backfilled peaks render on the merged timeline like browser-stored ones', () => {
    const chans = [pcm(48_000 * 4, 7, 0.8)];
    const buckets = shared.segmentWaveformDecodeBucketCount(4, 4);
    const browser = computeDbPeaks01(fakeAudioBuffer(chans), buckets, client.WF_DB_FLOOR);
    const backfill = viaShared(chans, buckets, shared.WF_DB_FLOOR);
    const clip = {
      segmentId: 's1',
      url: '/a',
      startSec: 0,
      endSec: 4,
      duration: 4,
      missingAudio: false,
    };
    const fromBrowser = client.mergeAudioClipsIntoTimelinePeaks(
      4,
      [clip],
      new Map([['s1', browser]]),
    );
    const fromBackfill = client.mergeAudioClipsIntoTimelinePeaks(
      4,
      [clip],
      new Map([['s1', backfill]]),
    );
    expect(fromBackfill).toEqual(fromBrowser);
    // Stored with floor -48, the client uses them as-is (no legacy remap).
    expect(client.remapWaveformPeaksDbEnvelope(backfill, -48, -48)).toEqual(backfill);
  });
});

import { act } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioSegment } from '../../../api/types';
import type { SeamAwareClip } from '../../../shared/utils/audioClips';
import { renderStrict } from '../../../test/renderStrict';
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer';

// media-worker D16 (web-session-console "A merged recording lays out by its seams"): a merged
// segment is laid out as one clip per seam; playback seeks inside its single media file by the
// seam's media offset and plays through the seams without reloading the element, and the playhead
// follows each seam's own wall-clock position.

beforeAll(() => {
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
});

const MERGED: AudioSegment = {
  id: 'm',
  ordinal: 0,
  recording_ordinal: 1,
  started_at_utc: null,
  ended_at_utc: null,
  mime_type: 'audio/webm',
  url: 'blob:m',
  waveform_peaks: null,
  waveform_db_floor: null,
  duration_ms: 90_000,
  media_status: 'done',
  seams: null,
};

// The seam clips of `MERGED`: chunks at timeline 10, 40.03, 70.08 (rollover gaps 30/50 ms), each
// 30 s of media.
const seamClip = (startSec: number, endSec: number, mediaOffsetSec: number): SeamAwareClip => ({
  segmentId: 'm',
  url: 'blob:m',
  startSec,
  endSec,
  duration: 30,
  missingAudio: false,
  mediaOffsetSec,
  mediaDurationSec: 90,
});
const CLIPS = [seamClip(10, 40.03, 0), seamClip(40.03, 70.08, 30), seamClip(70.08, 100.08, 60)];

let els: HTMLAudioElement[];
let times: Map<HTMLAudioElement, number>;
let loads: number;
let originalAudio: typeof Audio;
let rafCallbacks: FrameRequestCallback[];

beforeEach(() => {
  els = [];
  times = new Map();
  loads = 0;
  rafCallbacks = [];
  originalAudio = window.Audio;
  HTMLMediaElement.prototype.load = () => {
    loads += 1;
  };
  window.Audio = new Proxy(originalAudio, {
    construct(target, args) {
      const el = Reflect.construct(target, args) as HTMLAudioElement;
      // jsdom has no media pipeline: back currentTime/readyState with plain values.
      Object.defineProperty(el, 'currentTime', {
        get: () => times.get(el) ?? 0,
        set: (v: number) => times.set(el, v),
        configurable: true,
      });
      els.push(el);
      return el;
    },
  }) as unknown as typeof Audio;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  window.Audio = originalAudio;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function el(): HTMLAudioElement {
  const e = els.at(-1);
  if (!e) throw new Error('no Audio() yet');
  return e;
}

function runFrame() {
  const cbs = rafCallbacks.splice(0);
  for (const cb of cbs) cb(0);
}

describe('AudioPlayer with a merged segment’s seam clips', () => {
  it('a seek into the third seam lands at that seam’s media time', () => {
    const ref = createRef<AudioPlayerHandle>();
    renderStrict(<AudioPlayer ref={ref} segments={[MERGED]} clips={CLIPS} />);
    act(() => ref.current?.seekToTimelineSecAndPlay(85.5));
    act(() => {
      el().dispatchEvent(new Event('loadedmetadata'));
    });
    // 60 s into the merged file (the seam offset) plus 15.42 s into the third chunk.
    expect(el().currentTime).toBeCloseTo(75.42, 6);
  });

  it('plays through the seams without reloading and keeps the playhead on each seam', () => {
    const ref = createRef<AudioPlayerHandle>();
    const secs: (number | null)[] = [];
    renderStrict(
      <AudioPlayer
        ref={ref}
        segments={[MERGED]}
        clips={CLIPS}
        onPlaybackSecChange={(s) => secs.push(s)}
      />,
    );
    act(() => ref.current?.seekToTimelineSecAndPlay(12));
    act(() => {
      el().dispatchEvent(new Event('loadedmetadata'));
    });
    expect(el().currentTime).toBeCloseTo(2, 6);
    const loadsAfterStart = loads;
    const srcAfterStart = el().src;

    // The media element plays on through the merged file: 5 s into the second seam's media.
    times.set(el(), 35);
    act(() => runFrame());
    expect(secs.at(-1)).toBeCloseTo(45.03, 6);
    // ... and into the third seam: the 50 ms rollover gap is skipped, never played twice.
    times.set(el(), 61);
    act(() => runFrame());
    expect(secs.at(-1)).toBeCloseTo(71.08, 6);

    expect(loads).toBe(loadsAfterStart);
    expect(el().src).toBe(srcAfterStart);
    expect(ref.current?.isPlaying()).toBe(true);
  });

  it('the playhead of a plain segment is unchanged (clip start plus media time)', () => {
    const plain: AudioSegment = { ...MERGED, id: 'p', url: 'blob:p', duration_ms: null };
    const ref = createRef<AudioPlayerHandle>();
    const secs: (number | null)[] = [];
    renderStrict(
      <AudioPlayer
        ref={ref}
        segments={[plain]}
        clips={[
          {
            segmentId: 'p',
            url: 'blob:p',
            startSec: 5,
            endSec: 15,
            duration: 10,
            missingAudio: false,
          },
        ]}
        onPlaybackSecChange={(s) => secs.push(s)}
      />,
    );
    act(() => ref.current?.seekToTimelineSecAndPlay(7));
    act(() => {
      el().dispatchEvent(new Event('loadedmetadata'));
    });
    expect(el().currentTime).toBeCloseTo(2, 6);
    times.set(el(), 4);
    act(() => runFrame());
    expect(secs.at(-1)).toBeCloseTo(9, 6);
  });
});

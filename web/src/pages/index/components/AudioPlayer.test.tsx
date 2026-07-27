import { fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioSegment } from '../../../api/types';
import type { AudioClipLite } from '../../../shared/utils/waveformMerge';
import { renderStrict } from '../../../test/renderStrict';
import { AudioPlayer, type AudioPlayerHandle } from './AudioPlayer';

// --- AudioPlayer Space guard set (ui-refresh, task 4.4) ---
//
// D14 / spec "Global single-key handlers yield to dialogs and interactive
// targets": the pre-existing global Space play/pause handler must not fire
// while any `[role="dialog"]` is open, nor when the key press is consumed by
// a focused interactive element (a focused button's Space activation wins).
// jsdom has no real media pipeline, so `HTMLMediaElement.play/pause/load`
// are stubbed at the prototype level; the handler still runs for real
// through a mounted `AudioPlayer` and its imperative `isPlaying()` probe.

beforeAll(() => {
  HTMLMediaElement.prototype.load = () => {};
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
});

const SEGMENT: AudioSegment = {
  id: 'seg-1',
  session_id: 'sess-1',
  ordinal: 0,
  recording_ordinal: 0,
  started_at_utc: null,
  ended_at_utc: null,
  duration_sec: 10,
  file_path: '/tmp/seg-1',
  mime_type: 'audio/webm',
  url: 'blob:seg-1',
  waveform_peaks: null,
  waveform_db_floor: null,
};

const CLIP: AudioClipLite = {
  segmentId: 'seg-1',
  url: 'blob:seg-1',
  startSec: 0,
  endSec: 10,
  duration: 10,
  missingAudio: false,
};

function renderPlayer() {
  const ref = createRef<AudioPlayerHandle>();
  renderStrict(<AudioPlayer ref={ref} segments={[SEGMENT]} clips={[CLIP]} />);
  return ref;
}

afterEach(() => {
  document.querySelectorAll('button[data-test-probe], [role="dialog"]').forEach((el) => {
    el.remove();
  });
});

// --- Play-capable seek path (feed-row-seek, task 4.1) ---
//
// `seekToTimelineSecAndPlay` is the second, play-capable counterpart to the
// existing `seekToTimelineSec` (which only resumes when the player was
// already playing — MarkerNav's non-playing path). These tests pin three
// properties normative in the spec ("A feed jump starts playback from that
// point"):
//   1. on a PAUSED player, the new path starts playback from the target
//   2. on a PLAYING player, the new path continues from the new position
//      without restarting (no pause() call in between)
//   3. the EXISTING `seekToTimelineSec` path is unchanged: it still only
//      resumes when the player was already playing — paused stays paused
//
// jsdom's HTMLMediaElement never actually loads media, so both seek paths
// wait for a real `loadedmetadata` event before applying the offset/play
// (the same mechanism `playClip` already relies on for the toggle() tests
// above). We capture the `Audio()` instance the component creates via a
// constructor proxy and dispatch that event ourselves.
describe('AudioPlayer play-capable seek path', () => {
  let createdAudioEls: HTMLAudioElement[];
  let originalAudioCtor: typeof Audio;

  beforeEach(() => {
    createdAudioEls = [];
    originalAudioCtor = window.Audio;
    window.Audio = new Proxy(originalAudioCtor, {
      construct(target, args) {
        const instance = Reflect.construct(target, args) as HTMLAudioElement;
        createdAudioEls.push(instance);
        return instance;
      },
    }) as unknown as typeof Audio;
  });

  afterEach(() => {
    window.Audio = originalAudioCtor;
    // `vi.spyOn` on a shared prototype method (HTMLMediaElement.prototype.pause)
    // is not auto-restored between tests in this project's vitest config (no
    // restoreMocks/clearMocks) — an un-restored spy from one test wraps the
    // still-stubbed pause() and its call count leaks into the next test's
    // assertion. Restore explicitly.
    vi.restoreAllMocks();
  });

  function lastAudioEl(): HTMLAudioElement {
    const el = createdAudioEls[createdAudioEls.length - 1];
    if (!el) throw new Error('no Audio() instance created yet');
    return el;
  }

  function loadMetadata() {
    lastAudioEl().dispatchEvent(new Event('loadedmetadata'));
  }

  it('a play-capable path starts playback from the target on a paused player', () => {
    const ref = renderPlayer();
    expect(ref.current?.isPlaying()).toBe(false);

    ref.current?.seekToTimelineSecAndPlay(5);
    // Playing state reflects immediately (matches playClip's synchronous
    // UI-feedback pattern), even before metadata resolves.
    expect(ref.current?.isPlaying()).toBe(true);

    loadMetadata();
    expect(ref.current?.isPlaying()).toBe(true);
  });

  it('a playing player continues from the new position without restarting', () => {
    const ref = renderPlayer();
    ref.current?.toggle();
    expect(ref.current?.isPlaying()).toBe(true);
    loadMetadata(); // resolve toggle's own pending metadata wait

    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    ref.current?.seekToTimelineSecAndPlay(7);
    expect(ref.current?.isPlaying()).toBe(true);
    loadMetadata(); // resolve the seek's pending metadata wait

    expect(ref.current?.isPlaying()).toBe(true);
    expect(pauseSpy).not.toHaveBeenCalled();
  });

  it('the existing seekToTimelineSec path is unchanged: paused stays paused', () => {
    const ref = renderPlayer();
    ref.current?.seekToTimelineSec(2);
    loadMetadata();
    expect(ref.current?.isPlaying()).toBe(false);

    ref.current?.seekToTimelineSec(7);
    loadMetadata();
    expect(ref.current?.isPlaying()).toBe(false);
  });

  it('the existing seekToTimelineSec path still resumes without restarting when already playing', () => {
    const ref = renderPlayer();
    ref.current?.toggle();
    expect(ref.current?.isPlaying()).toBe(true);
    loadMetadata();

    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    ref.current?.seekToTimelineSec(7);
    loadMetadata();

    expect(ref.current?.isPlaying()).toBe(true);
    expect(pauseSpy).not.toHaveBeenCalled();
  });
});

describe('AudioPlayer global Space handler', () => {
  it('toggles playback on Space in the baseline case (sanity)', () => {
    const ref = renderPlayer();
    expect(ref.current?.isPlaying()).toBe(false);
    fireEvent.keyDown(document.body, { code: 'Space' });
    expect(ref.current?.isPlaying()).toBe(true);
  });

  it('does not toggle playback while a [role="dialog"] is open', () => {
    const ref = renderPlayer();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    try {
      fireEvent.keyDown(document.body, { code: 'Space' });
      expect(ref.current?.isPlaying()).toBe(false);
    } finally {
      dialog.remove();
    }
  });

  it('does not toggle playback when Space activates a focused button (spec scenario)', () => {
    const ref = renderPlayer();
    const button = document.createElement('button');
    button.setAttribute('data-test-probe', '');
    document.body.appendChild(button);
    button.focus();
    try {
      fireEvent.keyDown(button, { code: 'Space' });
      expect(ref.current?.isPlaying()).toBe(false);
    } finally {
      button.remove();
    }
  });
});

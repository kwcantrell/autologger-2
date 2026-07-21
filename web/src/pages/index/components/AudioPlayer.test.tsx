import { fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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

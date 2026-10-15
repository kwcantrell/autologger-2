import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SeamAwareClip } from '../../../../shared/utils/audioClips';
import type { AudioClipLite } from '../../../../shared/utils/waveformMerge';
import { TimelineWaveform } from './TimelineWaveform';

const clips: AudioClipLite[] = [
  { segmentId: 's1', url: '/a', startSec: 0, endSec: 10, duration: 10, missingAudio: false },
];
const base = { activeSec: 0, totalSec: 10, clips };
const peaks = new Float32Array(16).fill(0.5);

describe('TimelineWaveform labels', () => {
  it('shows Generating only while decoding', () => {
    const { rerender } = render(<TimelineWaveform {...base} mergedPeaks={null} isDecoding />);
    expect(screen.queryByText('Generating waveform…')).not.toBeNull();
    rerender(<TimelineWaveform {...base} mergedPeaks={null} isDecoding={false} />);
    expect(screen.queryByText('Generating waveform…')).toBeNull();
  });

  it('shows Waveform unavailable after decoding finished with no peaks', () => {
    render(<TimelineWaveform {...base} mergedPeaks={null} isDecoding={false} unavailable />);
    expect(screen.queryByText('Waveform unavailable')).not.toBeNull();
    expect(screen.queryByText('Generating waveform…')).toBeNull();
  });

  it('renders existing peaks with no generating label when some segments failed', () => {
    const { container } = render(
      <TimelineWaveform {...base} mergedPeaks={peaks} isDecoding={false} unavailable />,
    );
    expect(container.querySelector('svg path')).not.toBeNull();
    expect(screen.queryByText('Generating waveform…')).toBeNull();
    expect(screen.queryByText('Waveform unavailable')).toBeNull();
  });
});

// media-worker D16 (web-session-console): the waveform slot reflects the server's media processing.
describe('TimelineWaveform labels for server media status (media-worker D16)', () => {
  const statusClip = (
    id: string,
    startSec: number,
    mediaStatus: SeamAwareClip['mediaStatus'],
    finalizing = false,
  ): SeamAwareClip => ({
    segmentId: id,
    url: `/${id}`,
    startSec,
    endSec: startSec + 5,
    duration: 5,
    missingAudio: false,
    mediaStatus,
    ...(finalizing ? { finalizing } : {}),
  });

  it('shows Finalizing recording… while a multi-segment recording has a pending segment', () => {
    const c = [statusClip('a', 0, 'done', true), statusClip('b', 5, 'pending', true)];
    render(<TimelineWaveform {...base} clips={c} mergedPeaks={null} isDecoding={false} />);
    expect(screen.queryByText('Finalizing recording…')).not.toBeNull();
    expect(screen.queryByText('Generating waveform…')).toBeNull();
  });

  it('shows Finalizing recording… over existing peaks too', () => {
    const c = [statusClip('a', 0, 'done', true), statusClip('b', 5, 'pending', true)];
    render(<TimelineWaveform {...base} clips={c} mergedPeaks={peaks} isDecoding={false} />);
    expect(screen.queryByText('Finalizing recording…')).not.toBeNull();
  });

  it('shows Generating waveform… while a single segment is pending, without a browser decode', () => {
    const c = [statusClip('a', 0, 'pending')];
    render(<TimelineWaveform {...base} clips={c} mergedPeaks={null} isDecoding={false} />);
    expect(screen.queryByText('Generating waveform…')).not.toBeNull();
    expect(screen.queryByText('Finalizing recording…')).toBeNull();
  });

  it('shows Waveform unavailable for a failed segment', () => {
    const c = [statusClip('a', 0, 'failed')];
    render(<TimelineWaveform {...base} clips={c} mergedPeaks={null} isDecoding={false} />);
    expect(screen.queryByText('Waveform unavailable')).not.toBeNull();
    expect(screen.queryByText('Generating waveform…')).toBeNull();
  });
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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

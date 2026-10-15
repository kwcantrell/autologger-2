import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimelineClips } from './TimelineClips';

type Clips = Parameters<typeof TimelineClips>[0]['clips'];

describe('TimelineClips keys (media-worker: seam clips share a segment id)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders every seam clip of a merged segment without a duplicate-key warning', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const clips = [
      { segmentId: 'merged', url: '/a', startSec: 0, endSec: 20, mediaOffsetSec: 0 },
      { segmentId: 'merged', url: '/a', startSec: 20, endSec: 40, mediaOffsetSec: 20.34 },
      { segmentId: 'merged', url: '/a', startSec: 40, endSec: 60, mediaOffsetSec: 40.26 },
      { segmentId: 'other', url: '/b', startSec: 60, endSec: 70 },
    ] as unknown as Clips;
    const { container } = render(<TimelineClips clips={clips} totalSec={70} activeClipIdx={-1} />);
    expect(container.querySelectorAll('#timeline-clips > div')).toHaveLength(4);
    const dupKey = errors.mock.calls.some((args) => String(args[0]).includes('same key'));
    expect(dupKey).toBe(false);
  });
});

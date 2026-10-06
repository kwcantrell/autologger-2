import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LogEvent } from '../../../../api/types';
import { TimelineMarkers } from './TimelineMarkers';

// shadcn-port-workspace D8: an internal event's marker colour (var(--muted) on the wire) resolves
// to the legacy muted grey, not shadcn's 6% --muted tint.
function ev(over: Partial<LogEvent>): LogEvent {
  return {
    event_id: 'ev-1',
    category: 'internal',
    category_label: 'Internal',
    category_color: 'var(--muted)',
    message: 'Recording 1 Started',
    timecode: '00:00:01:00',
    timecode_total_frames: 24,
    wall_time_utc: '2026-07-21T00:00:01Z',
    ...over,
  } as LogEvent;
}

const noop = () => {};

describe('TimelineMarkers colour', () => {
  it('internal markers use the legacy muted grey; hex colours pass through', () => {
    const { container } = render(
      <TimelineMarkers
        events={[ev({}), ev({ event_id: 'ev-2', category: 'scene', category_color: '#4488ff' })]}
        status={null}
        totalSec={10}
        selectedEventId={null}
        onMouseOver={noop}
        onMouseMove={noop}
        onMouseOut={noop}
        onClick={noop}
      />,
    );
    const mcol = (id: string) =>
      (
        container.querySelector(`button[data-event-id="${id}"]`) as HTMLElement
      ).style.getPropertyValue('--mcol');
    expect(mcol('ev-1')).toBe('var(--legacy-muted)');
    expect(mcol('ev-2')).toBe('#4488ff');
  });
});

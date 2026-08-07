import { screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionStatus } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { MaximizeLogStrip } from './MaximizeLogStrip';

// --- MaximizeLogStrip session-meta title (session-title-suffix, task 2.3) ---
//
// Spec "Session meta shows session title instead of Episode N": the fused strip's
// session-meta line renders the session's stored `title`, sourced from `title`
// alone — the `?? deck_title` fallback this line used to carry is now vestigial
// (design D5: every `deck_title` emitter mirrors `title` server-side) and was
// dropped. These tests pin that `title` is authoritative and no literal `Episode`
// label ever renders. Heavy sibling children (Timeline, TransportControls,
// CategoryButtonStrip, MarkerNav, TimecodeDisplay) pull in react-query hooks and
// audio/session context this component doesn't own — mocked out so only
// MaximizeLogStrip's own session-meta derivation is under test.

vi.mock('./CategoryButtonStrip', () => ({ CategoryButtonStrip: () => null }));
vi.mock('./MarkerNav', () => ({ MarkerNav: () => null }));
vi.mock('./TimecodeDisplay', () => ({ TimecodeDisplay: () => null }));
// `Timeline` (real component) is what actually renders `stripTrailing` into the DOM in
// `stripOnly` mode — MaximizeLogStrip passes the session-meta block to it as a prop rather
// than rendering it directly. A bare `() => null` stub would discard `stripTrailing`
// entirely and make every session-meta assertion below vacuously pass; this mock renders it.
vi.mock('./Timeline', () => ({
  Timeline: (props: { stripTrailing?: ReactNode }) => <>{props.stripTrailing}</>,
}));
vi.mock('./TransportControls', () => ({ TransportControls: () => null }));

function baseProps() {
  return {
    sessionId: 'session-1',
    events: [],
    audioClips: [],
    totalSec: 0,
    mergedPeaks: null,
    audioPlaybackSec: null,
    onSeekAudio: vi.fn(),
    onAudioRecord: vi.fn(),
    onAudioPlay: vi.fn(),
    isPlaying: false,
    onOpenShortcuts: vi.fn(),
    liveDock: false,
    onOffState: new Map(),
    onToggle: vi.fn(),
    statusText: 'Stopped',
    isRecording: false,
  };
}

describe('MaximizeLogStrip session-meta title', () => {
  it('shows the stored session title, not an Episode label', () => {
    const status = {
      title: 'HD_260802',
      deck_title: 'HD_260802',
      show_code: 'HD',
      show_name: '',
      session_created_at_utc: '2026-08-02T00:00:00.000Z',
      now_utc: '2026-08-02T00:00:00.000Z',
    } as unknown as SessionStatus;

    renderStrict(<MaximizeLogStrip {...baseProps()} status={status} />);

    const meta = document.getElementById('session-deck-title');
    expect(meta?.textContent ?? '').toContain('HD_260802');
    expect(meta?.textContent ?? '').not.toContain('Episode');
  });

  it('uses title alone — a divergent deck_title is never shown (vestigial fallback dropped)', () => {
    const status = {
      title: '',
      deck_title: 'STALE_DECK_TITLE',
      show_code: 'HD',
      show_name: '',
      session_created_at_utc: '2026-08-02T00:00:00.000Z',
      now_utc: '2026-08-02T00:00:00.000Z',
    } as unknown as SessionStatus;

    renderStrict(<MaximizeLogStrip {...baseProps()} status={status} />);

    const meta = document.getElementById('session-deck-title');
    expect(meta?.textContent ?? '').not.toContain('STALE_DECK_TITLE');
  });

  it('renders the title in the session-name slot distinct from the show heading', () => {
    const status = {
      title: 'HD_260802_002',
      deck_title: 'HD_260802_002',
      show_code: 'HD',
      show_name: 'Home Depot Live',
      session_created_at_utc: '2026-08-02T00:00:00.000Z',
      now_utc: '2026-08-02T00:00:00.000Z',
    } as unknown as SessionStatus;

    renderStrict(<MaximizeLogStrip {...baseProps()} status={status} />);

    expect(screen.getByText('Home Depot Live')).not.toBeNull();
    expect(screen.getByText('HD_260802_002')).not.toBeNull();
  });
});

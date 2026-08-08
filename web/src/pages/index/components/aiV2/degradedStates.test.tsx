import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderStrict } from '../../../../test/renderStrict';
import { EventDensityWidget, SessionDurationWidget } from './StatWidgets';
import { TalkTimeBySpeakerWidget } from './TalkTimeBySpeakerWidget';
import { TranscriptExcerptWidget } from './TranscriptExcerptWidget';

// --- Degraded-state rendering (ai-v2-dashboards, task 4.7) ---
//
// Spec "Data unavailability is a rendered state, never a zero": a widget
// whose backing data is absent/degenerate renders an explicit unavailable
// state naming the reason, and never a zero/empty-series as though measured.
//
// Components here are prop-driven (they never compute an aggregate
// themselves — see widgetTypes.ts's module header), so these tests construct
// the exact `{available: false, reason}` shape packages/ai-runtime/src/aggregates.ts
// produces for the two real-world scenarios that collapse to it:
//   - MANUAL fixture: a transcript entered by hand, where start_sec/end_sec
//     are never written (schema default 0 — TranscriptStore.insertTranscriptWord
//     writes only 6 columns, D2a).
//   - ANCHORLESS fixture: a DeepGram transcript that couldn't be anchored to
//     recorded audio, where transcriptRemap.ts writes literal start_sec: 0,
//     end_sec: 0 for every word (D2a).
// aggregates.ts's own `wordTimingsAreDegenerate` check treats both as the
// SAME signature and returns the SAME `{available:false, reason}` shape
// (documented in its module header) — so both fixtures below are
// independently constructed `available:false` aggregate objects carrying the
// verbatim `NO_TIMING_REASON` text copied from that module, proving the
// widgets render correctly from each, not just from one hand-picked case.

const NO_TIMING_REASON =
  'This transcript has no word timings (manually entered, or not anchored to recorded audio).';

const MANUAL_ENTRY_FIXTURE = {
  scenario: 'manually-entered transcript (start_sec/end_sec never written)',
  available: false as const,
  reason: NO_TIMING_REASON,
};

const ANCHORLESS_FIXTURE = {
  scenario: 'anchorless DeepGram transcript (transcriptRemap writes literal zeros)',
  available: false as const,
  reason: NO_TIMING_REASON,
};

describe.each([MANUAL_ENTRY_FIXTURE, ANCHORLESS_FIXTURE])('degraded rendering — $scenario', ({
  reason,
}) => {
  it('session_duration: renders "unavailable" naming the reason, never a 0:00:00 timecode', () => {
    renderStrict(<SessionDurationWidget data={{ available: false, reason, durationSec: null }} />);
    expect(screen.getByTestId('aiv2-widget-unavailable')).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByText('00:00:00')).toBeNull();
    expect(screen.queryByText(/^0:00/)).toBeNull();
  });

  it('talk_time_by_speaker: renders "unavailable" naming the reason, never a zero-width bar per speaker', () => {
    renderStrict(<TalkTimeBySpeakerWidget data={{ available: false, reason, bySpeaker: [] }} />);
    expect(screen.getByTestId('aiv2-widget-unavailable')).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryAllByTestId('aiv2-talk-time-row')).toHaveLength(0);
  });

  it('event_density: renders "unavailable" naming the reason, never "0.0 events per minute"', () => {
    renderStrict(<EventDensityWidget data={{ available: false, reason, eventsPerMinute: null }} />);
    expect(screen.getByTestId('aiv2-widget-unavailable')).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByText('0.0')).toBeNull();
  });
});

describe('degraded rendering — transcript_excerpt (partial degradation, D2b)', () => {
  it('renders the real quote while honestly showing "—" for timestamp and "Speaker N" for an unresolved name — never a fabricated 0:00 or invented name', () => {
    renderStrict(
      <TranscriptExcerptWidget
        data={{
          available: true,
          reason: null,
          speaker: '1',
          text: 'If we lock the export pipeline this quarter, everything downstream gets simpler.',
          timestampSec: null,
        }}
      />,
    );
    expect(
      screen.getByText(
        'If we lock the export pipeline this quarter, everything downstream gets simpler.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Speaker 2')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('0:00')).toBeNull();
  });

  it('renders the full unavailable state when there is no transcript text at all', () => {
    renderStrict(
      <TranscriptExcerptWidget
        data={{
          available: false,
          reason: 'This session has no transcript words yet.',
          speaker: null,
          text: '',
          timestampSec: null,
        }}
      />,
    );
    expect(screen.getByTestId('aiv2-widget-unavailable')).toBeTruthy();
    expect(screen.getByText('This session has no transcript words yet.')).toBeTruthy();
  });
});

describe('healthy control — the same widgets render real values when data is available', () => {
  it('session_duration renders a real, non-degraded duration', () => {
    renderStrict(
      <SessionDurationWidget data={{ available: true, reason: null, durationSec: 90 }} />,
    );
    expect(screen.queryByTestId('aiv2-widget-unavailable')).toBeNull();
    expect(screen.getByText('00:01:30')).toBeTruthy();
  });
});

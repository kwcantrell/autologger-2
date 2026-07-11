import { describe, expect, it } from 'vitest';
import { showIdChanged, toFeedbackFlags, toVariableValues, type ServerStatePayload } from './state.js';

const NONE: ServerStatePayload = {
  connected_clients: 0,
  active_session_id: null,
  session: null,
  last_command: null,
};

const LIVE: ServerStatePayload = {
  connected_clients: 2,
  active_session_id: 's1',
  session: {
    id: 's1',
    title: 'Ep 1',
    deck_title: 'SHOW - 1',
    timecode: '01:00:00:00',
    frame_rate: 24,
    is_rolling: true,
    current_take: 3,
    is_recording: false,
    is_playing: true,
    logged_event_count: 7,
    events_stream_revision: 9,
    show_id: 'sh1',
    show_name: 'The Show',
    show_code: 'SHOW',
  },
  last_command: { id: 'c1', type: 'record-start', ok: false, error: 'no listener', delivered_to: null },
};

describe('toVariableValues', () => {
  it('uses sentinels when no session', () => {
    const v = toVariableValues(NONE);
    expect(v.timecode).toBe('—');
    expect(v.session_title).toBe('—');
    expect(v.connected_clients).toBe(0);
  });

  it('maps live session fields and surfaces last_command', () => {
    const v = toVariableValues(LIVE);
    expect(v.timecode).toBe('01:00:00:00');
    expect(v.take).toBe(3);
    expect(v.deck_title).toBe('SHOW - 1');
    expect(v.command_delivered).toBe('no'); // ok:false
    expect(v.command_error).toBe('no listener');
  });
});

describe('toFeedbackFlags', () => {
  it('all false when no session', () => {
    expect(toFeedbackFlags(NONE)).toEqual({ rolling: false, recording: false, playing: false, session_active: false });
  });
  it('reflects live flags', () => {
    expect(toFeedbackFlags(LIVE)).toEqual({ rolling: true, recording: false, playing: true, session_active: true });
  });
});

describe('showIdChanged', () => {
  it('true when show_id differs, false when same', () => {
    expect(showIdChanged(NONE, LIVE)).toBe(true);
    expect(showIdChanged(LIVE, LIVE)).toBe(false);
    expect(showIdChanged(null, NONE)).toBe(false);
  });
});

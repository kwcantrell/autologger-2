import { act, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { useEvents } from '../../../api/hooks/useEvents';
import { useSessionStatus } from '../../../api/hooks/useSessionStatus';
import { useTopics } from '../../../api/hooks/useTopics';
import { useTranscriptWords } from '../../../api/hooks/useTranscriptWords';
import type { LogEvent, SessionTopic, TranscriptWord } from '../../../api/types';
import {
  consumeLoginReturnStash,
  LOGIN_RETURN_STASH_KEY,
  stashLoginReturnPathIfDeepLink,
} from '../../../shared/utils/loginReturnStash';
import { sessionTimeToTimelineSec } from '../../../shared/utils/timelineSec';
import { register } from '../coordination/registry';
import { setNavigationImplForTesting } from '../navigation';
import { jumpTimelineToSec } from '../utils/timelineJump';
import { MOMENT_TIMELINE_WAIT_MS, MomentDeepLink, parseMomentParams } from './MomentDeepLink';

// catalog-search task 5.7 (design D8; web-session-routing "Moment deep links"): `/sessions/:id`
// takes one moment parameter (`t`, then `topic`, then `event`). It is applied once the session's
// status has resolved and the timeline has registered, through `jumpTimelineToSec` (moves the
// playhead, never plays), placed by the feed's own rules and gates; never while rolling; then the
// parameter is removed with a history replace. A link into the session already open applies the
// same way without a remount.

vi.mock('../../../api/hooks/useSessionStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/hooks/useSessionStatus')>()),
  useSessionStatus: vi.fn(),
}));
vi.mock('../../../api/hooks/useTopics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/hooks/useTopics')>()),
  useTopics: vi.fn(),
}));
vi.mock('../../../api/hooks/useTranscriptWords', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/hooks/useTranscriptWords')>()),
  useTranscriptWords: vi.fn(),
}));
vi.mock('../../../api/hooks/useEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/hooks/useEvents')>()),
  useEvents: vi.fn(),
}));
vi.mock('../utils/timelineJump', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/timelineJump')>();
  return { ...actual, jumpTimelineToSec: vi.fn(actual.jumpTimelineToSec) };
});

const jumpMock = vi.mocked(jumpTimelineToSec);
const statusMock = vi.mocked(useSessionStatus);
const topicsMock = vi.mocked(useTopics);
const wordsMock = vi.mocked(useTranscriptWords);
const eventsMock = vi.mocked(useEvents);

type QueryLike = { data?: unknown; isError?: boolean; isSuccess?: boolean; isPending?: boolean };
const q = (v: QueryLike) => v as never;

function setStatus(
  status: { is_rolling: boolean; frame_rate?: number } | undefined,
  isError = false,
) {
  statusMock.mockReturnValue(
    q({
      data: status ? { frame_rate: 25, ...status } : undefined,
      isError,
      isPending: !status && !isError,
    }),
  );
}

const TOPIC: SessionTopic = {
  id: 'tp-1',
  session_time: '00:01:02:05',
  duration_sec: 30,
  topic_level: 1,
  summary: 'Budget',
  ordinal: 0,
  created_at_utc: '2026-10-06T10:00:00.000Z',
  version: 1,
};

function word(session_time: string): TranscriptWord {
  return {
    id: `w-${session_time}`,
    session_time,
    speaker: 'A',
    word: 'budget',
    start_sec: 1,
    end_sec: 2,
    ordinal: 0,
    version: 1,
  } as TranscriptWord;
}

function event(id: string, frames: number | null, fps: number | null): LogEvent {
  return {
    event_id: id,
    category: 'c',
    category_label: 'C',
    category_color: null,
    message: 'm',
    timecode: null,
    timecode_total_frames: frames,
    frame_rate: fps,
    wall_time_utc: null,
    metadata: {},
    version: 1,
  };
}

// The timeline's owners register these (Timeline.tsx, useZoomRail.ts, SessionWorkspace.tsx).
const handles = {
  setManualScrubSec: vi.fn(),
  scrollTimelineToSec: vi.fn(),
  seekAudio: vi.fn(),
  seekAudioAndPlay: vi.fn(),
};
function registerTimeline() {
  register('setManualScrubSec', handles.setManualScrubSec);
  register('scrollTimelineToSec', handles.scrollTimelineToSec);
  register('seekAudio', handles.seekAudio);
  register('seekAudioAndPlay', handles.seekAudioAndPlay);
}

let memory: ReturnType<typeof memoryLocation>;

function renderDeepLink(path: string, sessionId = 's1') {
  memory = memoryLocation({ path, record: true });
  setNavigationImplForTesting((p, o) => memory.navigate(p, o));
  const ui = (id: string) => (
    <StrictMode>
      <Router hook={memory.hook}>
        <MomentDeepLink sessionId={id} />
      </Router>
    </StrictMode>
  );
  const view = render(ui(sessionId));
  return { rerender: ({ id }: { id: string }) => view.rerender(ui(id)) };
}

const flush = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  jumpMock.mockClear();
  for (const h of Object.values(handles)) h.mockReset();
  setStatus({ is_rolling: false });
  topicsMock.mockReturnValue(q({ data: [TOPIC], isSuccess: true }));
  wordsMock.mockReturnValue(q({ data: [word('00:00:01:00')], isSuccess: true }));
  eventsMock.mockReturnValue(
    q({
      data: { events: [event('ev-1', 250, 25), event('ev-bad', null, 25)] },
      isSuccess: true,
    }),
  );
});

afterEach(() => {
  setNavigationImplForTesting(null);
  vi.useRealTimers();
});

describe('parseMomentParams', () => {
  it('reads t, then topic, then event', () => {
    expect(parseMomentParams('t=754.2')).toEqual({ kind: 't', sec: 754.2 });
    expect(parseMomentParams('t=0')).toEqual({ kind: 't', sec: 0 });
    expect(parseMomentParams('topic=a&t=5&event=b')).toEqual({ kind: 't', sec: 5 });
    expect(parseMomentParams('event=b&topic=a')).toEqual({ kind: 'topic', id: 'a' });
    expect(parseMomentParams('event=b')).toEqual({ kind: 'event', id: 'b' });
    expect(parseMomentParams('foo=1')).toBeNull();
    expect(parseMomentParams('')).toBeNull();
  });

  it('an unparseable t (or an empty id) is an unusable target, not a fallback to the next', () => {
    for (const bad of ['abc', '-1', '1e3', '', 'Infinity', '12.']) {
      expect(parseMomentParams(`t=${bad}&topic=a`)).toEqual({ kind: 'invalid' });
    }
    expect(parseMomentParams('topic=')).toEqual({ kind: 'invalid' });
    expect(parseMomentParams('event=')).toEqual({ kind: 'invalid' });
  });
});

describe('MomentDeepLink: ?t=', () => {
  it('waits for status and the timeline, then moves the timeline once, with no playback', async () => {
    setStatus(undefined);
    const { rerender } = renderDeepLink('/sessions/s1?t=754.2');
    await flush(100);
    expect(jumpMock).not.toHaveBeenCalled();

    setStatus({ is_rolling: false });
    rerender({ id: 's1' });
    await flush(100);
    // Status resolved, but no timeline yet.
    expect(jumpMock).not.toHaveBeenCalled();
    expect(memory.history).toEqual(['/sessions/s1?t=754.2']);

    registerTimeline();
    await flush(200);
    expect(jumpMock).toHaveBeenCalledTimes(1);
    expect(jumpMock).toHaveBeenCalledWith(754.2);
    expect(handles.setManualScrubSec).toHaveBeenCalledWith(754.2);
    expect(handles.scrollTimelineToSec).toHaveBeenCalledWith(754.2, undefined);
    expect(handles.seekAudio).toHaveBeenCalledWith(754.2);
    expect(handles.seekAudioAndPlay).not.toHaveBeenCalled();
    // Removed with a replace: the one entry, without the parameter.
    expect(memory.history).toEqual(['/sessions/s1']);

    rerender({ id: 's1' });
    await flush(500);
    expect(jumpMock).toHaveBeenCalledTimes(1);
  });

  it('keeps other query parameters when it removes the moment', async () => {
    registerTimeline();
    renderDeepLink('/sessions/s1?x=1&t=5');
    await flush(100);
    expect(jumpMock).toHaveBeenCalledWith(5);
    expect(memory.history).toEqual(['/sessions/s1?x=1']);
  });

  it('?t=abc gives no seek and no error, and the parameter is removed', async () => {
    registerTimeline();
    renderDeepLink('/sessions/s1?t=abc');
    await flush(100);
    expect(jumpMock).not.toHaveBeenCalled();
    expect(memory.history).toEqual(['/sessions/s1']);
  });

  it('a rolling session gives no seek, and the parameter is removed', async () => {
    registerTimeline();
    setStatus({ is_rolling: true });
    renderDeepLink('/sessions/s1?t=30');
    await flush(100);
    expect(jumpMock).not.toHaveBeenCalled();
    expect(handles.setManualScrubSec).not.toHaveBeenCalled();
    expect(memory.history).toEqual(['/sessions/s1']);
  });

  it('a status that fails to load gives no seek, and the parameter is removed', async () => {
    registerTimeline();
    setStatus(undefined, true);
    renderDeepLink('/sessions/s1?t=30');
    await flush(100);
    expect(jumpMock).not.toHaveBeenCalled();
    expect(memory.history).toEqual(['/sessions/s1']);
  });

  it('a timeline that never registers gives up without a seek', async () => {
    renderDeepLink('/sessions/s1?t=30');
    await flush(MOMENT_TIMELINE_WAIT_MS + 500);
    expect(jumpMock).not.toHaveBeenCalled();
    expect(memory.history).toEqual(['/sessions/s1']);
  });
});

describe('MomentDeepLink: ?topic= and ?event=', () => {
  it('a topic is placed where its feed row would jump', async () => {
    registerTimeline();
    renderDeepLink('/sessions/s1?topic=tp-1');
    await flush(100);
    const expected = sessionTimeToTimelineSec(TOPIC.session_time, 25);
    expect(expected).not.toBeNull();
    expect(jumpMock).toHaveBeenCalledWith(expected);
    expect(handles.seekAudioAndPlay).not.toHaveBeenCalled();
    expect(memory.history).toEqual(['/sessions/s1']);
    // The topic and its gate's inputs were asked for.
    expect(topicsMock).toHaveBeenCalledWith('s1');
    expect(wordsMock).toHaveBeenCalledWith('s1', { enabled: true });
  });

  it('a topic waits for the transcript words its gate reads', async () => {
    registerTimeline();
    wordsMock.mockReturnValue(q({ data: undefined, isPending: true }));
    const { rerender } = renderDeepLink('/sessions/s1?topic=tp-1');
    await flush(200);
    expect(jumpMock).not.toHaveBeenCalled();
    expect(memory.history).toEqual(['/sessions/s1?topic=tp-1']);
    wordsMock.mockReturnValue(q({ data: [word('00:00:01:00')], isSuccess: true }));
    rerender({ id: 's1' });
    await flush(100);
    expect(jumpMock).toHaveBeenCalledTimes(1);
  });

  it('a wholly anchorless transcript gates the topic: no seek (the feed gate)', async () => {
    registerTimeline();
    wordsMock.mockReturnValue(q({ data: [word(''), word(' ')], isSuccess: true }));
    renderDeepLink('/sessions/s1?topic=tp-1');
    await flush(100);
    expect(jumpMock).not.toHaveBeenCalled();
    expect(memory.history).toEqual(['/sessions/s1']);
  });

  it('an unknown topic gives no seek', async () => {
    registerTimeline();
    renderDeepLink('/sessions/s1?topic=nope');
    await flush(100);
    expect(jumpMock).not.toHaveBeenCalled();
    expect(memory.history).toEqual(['/sessions/s1']);
  });

  it('an event is placed from its frame count', async () => {
    registerTimeline();
    renderDeepLink('/sessions/s1?event=ev-1');
    await flush(100);
    expect(jumpMock).toHaveBeenCalledWith(10);
    expect(memory.history).toEqual(['/sessions/s1']);
  });

  it('an unplaceable event (no frame count) gives no seek', async () => {
    registerTimeline();
    renderDeepLink('/sessions/s1?event=ev-bad');
    await flush(100);
    expect(jumpMock).not.toHaveBeenCalled();
    expect(memory.history).toEqual(['/sessions/s1']);
  });

  it('an event waits for the events to load', async () => {
    registerTimeline();
    eventsMock.mockReturnValue(q({ data: undefined, isPending: true }));
    const { rerender } = renderDeepLink('/sessions/s1?event=ev-1');
    await flush(200);
    expect(jumpMock).not.toHaveBeenCalled();
    eventsMock.mockReturnValue(q({ data: { events: [event('ev-1', 250, 25)] }, isSuccess: true }));
    rerender({ id: 's1' });
    await flush(100);
    expect(jumpMock).toHaveBeenCalledWith(10);
  });
});

describe('MomentDeepLink: precedence and same-session links', () => {
  it('t wins over topic and event; topic wins over event', async () => {
    registerTimeline();
    renderDeepLink('/sessions/s1?event=ev-1&topic=tp-1&t=7');
    await flush(100);
    expect(jumpMock.mock.calls).toEqual([[7]]);
    expect(memory.history).toEqual(['/sessions/s1']);

    jumpMock.mockClear();
    act(() => memory.navigate('/sessions/s1?event=ev-1&topic=tp-1'));
    await flush(100);
    expect(jumpMock.mock.calls).toEqual([[sessionTimeToTimelineSec(TOPIC.session_time, 25)]]);
  });

  it('a link to the session already open applies without a remount', async () => {
    registerTimeline();
    renderDeepLink('/sessions/s1');
    await flush(100);
    expect(jumpMock).not.toHaveBeenCalled();

    act(() => memory.navigate('/sessions/s1?t=30', { replace: true }));
    await flush(100);
    expect(jumpMock.mock.calls).toEqual([[30]]);
    expect(memory.history).toEqual(['/sessions/s1']);

    // And again, to the same moment: a new link applies again.
    act(() => memory.navigate('/sessions/s1?t=30'));
    await flush(100);
    expect(jumpMock.mock.calls).toEqual([[30], [30]]);
    expect(memory.history).toEqual(['/sessions/s1', '/sessions/s1']);
  });
});

describe('the login-return stash keeps the moment query', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    sessionStorage.clear();
  });

  it('stashes /sessions/<id>?t=30 and returns to it', () => {
    window.history.replaceState(null, '', '/sessions/s1?t=30');
    stashLoginReturnPathIfDeepLink();
    expect(sessionStorage.getItem(LOGIN_RETURN_STASH_KEY)).toBe('/sessions/s1?t=30');
    const nav = vi.fn();
    consumeLoginReturnStash(nav);
    expect(nav).toHaveBeenCalledWith('/sessions/s1?t=30', { replace: true });
  });
});

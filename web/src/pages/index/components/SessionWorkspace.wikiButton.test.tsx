import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

// --- The "Wiki page" button in the session workspace (show-wiki task 5.7, design D7; show-wiki
// "Wiki screens" entry points, scenario "Session page from the workspace") ---
//
// The button sits at the end of the feed-tab row. A press lists the session's page
// (`?kind=session&session_id=<id>`) and opens it; with none, it creates a `session` page titled
// after the session and opens that; a `409 Session already has a page.` opens the page it names.
// The mock roster mirrors `SessionWorkspace.momentDeepLink.test.tsx`; only the network
// (`apiFetch`) answers the wiki calls.

const useSessionStatusMock = vi.fn();
const useEventsMock = vi.fn();
const useAudioClipsMock = vi.fn();
const useWaveformsMock = vi.fn();
const useCompanionPresenceMock = vi.fn();
const useSessionSocketMock = vi.fn();
const useRecoveryStopWarningMock = vi.fn();
const useRemoteRecordingGateMock = vi.fn();

vi.mock('../../../api/hooks/useSessionStatus', () => ({
  useSessionStatus: (...args: unknown[]) => useSessionStatusMock(...args),
}));
vi.mock('../../../api/hooks/useEvents', () => ({
  useEvents: (...args: unknown[]) => useEventsMock(...args),
  eventsKeys: { all: (id: string) => ['events', id] },
  WORKSPACE_EVENTS_LIMIT: 500,
}));
vi.mock('../hooks/useAudioClips', () => ({
  useAudioClips: (...args: unknown[]) => useAudioClipsMock(...args),
}));
vi.mock('../hooks/useWaveforms', () => ({
  useWaveforms: (...args: unknown[]) => useWaveformsMock(...args),
}));
vi.mock('../../../api/hooks/useCompanionPresence', () => ({
  useCompanionPresence: (...args: unknown[]) => useCompanionPresenceMock(...args),
}));
vi.mock('../../../api/hooks/useSessionSocket', () => ({
  useSessionSocket: (...args: unknown[]) => useSessionSocketMock(...args),
}));
vi.mock('../hooks/useRecoveryStopWarning', () => ({
  useRecoveryStopWarning: (...args: unknown[]) => useRecoveryStopWarningMock(...args),
}));
vi.mock('../hooks/useRemoteRecordingGate', () => ({
  useRemoteRecordingGate: (...args: unknown[]) => useRemoteRecordingGateMock(...args),
}));
vi.mock('../../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../api/client')>()),
  apiFetch: vi.fn(),
}));
vi.mock('../../../shared/components/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../../shared/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../../../shared/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('../hooks/AudioClipsContext', () => ({
  AudioClipsProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('./AiPanel', () => ({ AiPanel: () => null }));
vi.mock('./AiV2Panel', () => ({ AiV2Panel: () => null }));
vi.mock('./AudioPlayer', () => ({ AudioPlayer: () => null }));
vi.mock('./AudioRecorder', () => ({ AudioRecorder: () => null }));
vi.mock('./AudioSaveOverlay', () => ({ AudioSaveOverlay: () => null }));
vi.mock('./ChunkRescueBanner', () => ({ ChunkRescueBanner: () => null }));
vi.mock('./CategoryButtonStrip', () => ({ CategoryButtonStrip: () => null }));
vi.mock('./EventLogSheet', () => ({
  EventLogSheet: () => <div data-testid="event-log-sheet-stub" />,
  eventRowTimelineSec: () => null,
}));
vi.mock('./ExportFeed', () => ({ ExportFeed: () => null }));
vi.mock('./MarkerNav', () => ({ MarkerNav: () => null }));
vi.mock('./TimecodeDisplay', () => ({
  TimecodeDisplay: () => <div data-testid="timecode-display-stub" />,
}));
vi.mock('./Timeline', () => ({ Timeline: () => <div data-testid="timeline-stub" /> }));
vi.mock('./TopicsFeed', () => ({
  TopicsFeed: () => <div data-testid="topics-feed-stub" />,
}));
vi.mock('./TranscribeFeed', () => ({
  TranscribeFeed: () => <div data-testid="transcribe-feed-stub" />,
}));
vi.mock('./TransportControls', () => ({
  getTransportState: (rolling: boolean, recording: boolean) =>
    recording ? 'audio-recording' : rolling ? 'rolling' : 'stop',
  TransportControls: () => <div data-testid="transport-controls-stub" />,
}));

import { ApiError, apiFetch } from '../../../api/client';
import type { WikiPage } from '../../../api/types';
import { setNavigationImplForTesting } from '../navigation';
import { SessionWorkspace } from './SessionWorkspace';

const apiFetchMock = vi.mocked(apiFetch);
const LIST = 'shows/sh-1/wiki/pages?kind=session&session_id=sess-a';

function sessionPage(id: string): WikiPage {
  return {
    id,
    show_id: 'sh-1',
    kind: 'session',
    title: 'Town hall',
    body_md: '',
    aliases: [],
    session_id: 'sess-a',
    revision: 1,
    merged_into: null,
    deleted: false,
    created_at_utc: '2026-10-01T10:00:00.000Z',
    created_by_name: 'Kai Lee',
    updated_at_utc: '2026-10-01T10:00:00.000Z',
    updated_by_name: 'Kai Lee',
  };
}

/** A tiny wiki server: the session's page list and create, recorded in `calls`. */
function serveWiki(onCreate: () => WikiPage | Promise<WikiPage>) {
  const pages: WikiPage[] = [];
  const calls: string[] = [];
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === LIST) {
      return {
        pages: pages.map(({ id, kind, title, aliases, session_id, revision }) => ({
          id,
          kind,
          title,
          aliases,
          session_id,
          revision,
          updated_at_utc: '2026-10-01T10:00:00.000Z',
          updated_by_name: 'Kai Lee',
        })),
        truncated: false,
      };
    }
    if (method === 'POST' && path === 'shows/sh-1/wiki/pages') {
      const page = await onCreate();
      pages.push(page);
      return page;
    }
    return {};
  });
  return { calls };
}

function renderWorkspace() {
  const memory = memoryLocation({ path: '/sessions/sess-a', record: true });
  setNavigationImplForTesting((p, o) => memory.navigate(p, o));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Router hook={memory.hook}>
        <SessionWorkspace sessionId="sess-a" />
      </Router>
    </QueryClientProvider>,
  );
  return { memory };
}

const wikiButton = () => screen.getByRole('button', { name: 'Wiki page' });

describe('SessionWorkspace: the Wiki page button', () => {
  beforeEach(() => {
    useSessionStatusMock.mockReturnValue({
      data: {
        is_rolling: false,
        audio_recording_lease_alive: false,
        frame_rate: 25,
        title: 'Town hall',
        show_id: 'sh-1',
      },
    });
    useEventsMock.mockReturnValue({ data: { events: [] } });
    useAudioClipsMock.mockReturnValue({ clips: [], totalSec: 0, segments: [] });
    useWaveformsMock.mockReturnValue({ mergedPeaks: null, isDecoding: false });
    useCompanionPresenceMock.mockReturnValue({ data: null });
    useSessionSocketMock.mockReturnValue(undefined);
    useRecoveryStopWarningMock.mockReturnValue(null);
    useRemoteRecordingGateMock.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    setNavigationImplForTesting(null);
    vi.clearAllMocks();
  });

  it('sits at the end of the feed-tab row', () => {
    serveWiki(() => sessionPage('wp-1'));
    renderWorkspace();
    const tablist = screen.getByRole('tablist', { name: 'Feed tabs' });
    const row = tablist.parentElement;
    expect(row).not.toBeNull();
    expect(row?.lastElementChild).toBe(wikiButton());
    expect(tablist.compareDocumentPosition(wikiButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  // show-wiki-ai task 6.3 (D7 category 4): "Update wiki" sits immediately before "Wiki page".
  it('Update wiki sits immediately before Wiki page, which stays last', () => {
    serveWiki(() => sessionPage('wp-1'));
    renderWorkspace();
    const update = screen.getByRole('button', { name: 'Update wiki' });
    expect(update.nextElementSibling).toBe(wikiButton());
    expect(wikiButton().parentElement?.lastElementChild).toBe(wikiButton());
  });

  it('the first press creates the session page titled after the session and opens it; the second opens the same page', async () => {
    const { calls } = serveWiki(() => sessionPage('wp-1'));
    const { memory } = renderWorkspace();
    // Nothing is asked before a press.
    expect(calls).toEqual([]);

    fireEvent.click(wikiButton());
    await waitFor(() => expect(memory.history.at(-1)).toBe('/wiki/wp-1'));
    expect(calls).toEqual([`GET ${LIST}`, 'POST shows/sh-1/wiki/pages']);
    const post = apiFetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      kind: 'session',
      title: 'Town hall',
      session_id: 'sess-a',
    });

    memory.navigate('/sessions/sess-a');
    fireEvent.click(wikiButton());
    await waitFor(() => expect(memory.history.at(-1)).toBe('/wiki/wp-1'));
    expect(calls).toEqual([`GET ${LIST}`, 'POST shows/sh-1/wiki/pages', `GET ${LIST}`]);
  });

  it('a 409 Session already has a page opens the page it names', async () => {
    const { calls } = serveWiki(() => {
      throw new ApiError(409, 'Session already has a page.', {
        detail: 'Session already has a page.',
        page_id: 'wp-9',
      });
    });
    const { memory } = renderWorkspace();
    fireEvent.click(wikiButton());
    await waitFor(() => expect(memory.history.at(-1)).toBe('/wiki/wp-9'));
    expect(calls).toEqual([`GET ${LIST}`, 'POST shows/sh-1/wiki/pages']);
  });
});

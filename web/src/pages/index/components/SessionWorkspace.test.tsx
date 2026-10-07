import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderStrict, StrictWrapper } from '../../../test/renderStrict';
import { getTransportStatus } from '../coordination/transportStatus';
import { useTranscriptWordsGate } from '../hooks/TranscriptWordsGateContext';
import { SessionWorkspace } from './SessionWorkspace';

// Radix Tabs activate on mouse-down (and on keyboard focus), not on click (shadcn-port-workspace
// A1); `@testing-library/user-event` is not a dependency, so drive the real activation event.
function clickTab(name: string | RegExp) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

// --- SessionWorkspace tests (mounted-hidden tab discipline) ---
//
// SessionWorkspace only ever mounts with a session id now (design D10,
// GATE-OVERRIDDEN): the old empty-id placeholder branch and its
// `#v3-session-placeholder` ↔ `#v3-session-grid` visibility-swap tests are
// retired along with it — SessionRoute mount tests (home vs. workspace) and
// HomeRoute's own component tests cover that swap now (task 5.1;
// SessionRoute.test.tsx, HomeRoute.test.tsx). Every data/socket/audio hook
// and heavy child below is mocked at the module boundary — this is a
// rendering test, not an integration test.

vi.mock('../../../api/client', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
  // AiV2Design (and AiChat) import `API_ROOT` directly for their raw `fetch`
  // calls — omitting it here left it `undefined` for every consumer of this
  // mocked module, latent until a test actually exercised a real send (this
  // AI v2 tab's mid-stream test is the first one that does).
  API_ROOT: '/api',
}));

vi.mock('../../../api/hooks/useCompanionPresence', () => ({
  useCompanionPresence: () => {},
}));

vi.mock('../../../api/hooks/useEvents', () => ({
  eventsKeys: { all: (sessionId: string) => ['events', sessionId] },
  useEvents: () => ({ data: undefined }),
  WORKSPACE_EVENTS_LIMIT: 2000,
}));

// ai-v2-dashboards task 5.6: AiV2Panel (exercised for real here, see below)
// now calls these three hooks too, via `useAiV2WidgetData`. They all use the
// REAL `useQuery` under the hood, which the wholesale `@tanstack/react-query`
// mock below does not provide — mocked at the module boundary, matching
// `useEvents` above, so AiV2Panel's widget-data hook never reaches it.
// Spied rather than a bare stub (perf plan B4) so the deferred-words gate test
// below can read the `enabled` option this workspace's only REAL words
// consumer in this file — AiV2Panel's `useAiV2WidgetData` — was called with.
const { transcriptWordsSpy } = vi.hoisted(() => ({
  transcriptWordsSpy: vi.fn((_sessionId: string | null, _opts?: { enabled?: boolean }) => ({
    data: undefined,
  })),
}));
vi.mock('../../../api/hooks/useTranscriptWords', () => ({
  useTranscriptWords: transcriptWordsSpy,
}));

vi.mock('../../../api/hooks/useTopics', () => ({
  topicsQueryKey: (sessionId: string) => ['topics', sessionId],
  useTopics: () => ({ data: undefined }),
}));

vi.mock('../../../api/hooks/useShowCategories', () => ({
  useShowCategories: () => ({ data: undefined }),
}));

vi.mock('../../../api/hooks/useSessionSocket', () => ({
  useSessionSocket: () => {},
}));

// Per-session status, keyed by id (redesign-show-ignition 2.2): undefined for
// every session unless a test seeds it, which is what the rest of this file
// relies on.
const { statusBySession } = vi.hoisted(() => ({
  statusBySession: new Map<string, Record<string, unknown>>(),
}));
vi.mock('../../../api/hooks/useSessionStatus', () => ({
  useSessionStatus: (sessionId: string | null) => ({
    data: sessionId ? statusBySession.get(sessionId) : undefined,
  }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('../../../shared/components/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('../../../shared/hooks/useDebugTransportOverride', () => ({
  useDebugTransportOverride: () => null,
}));

vi.mock('../../../shared/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../../shared/utils/loadingVideo', () => ({
  AUTOLOGGER_LOADING_VIDEO_SRC: '',
}));

vi.mock('../hooks/useAudioClips', () => ({
  useAudioClips: () => ({ clips: [], totalSec: 0, segments: [] }),
}));

vi.mock('../hooks/useRecoveryStopWarning', () => ({
  useRecoveryStopWarning: () => null,
}));

vi.mock('../hooks/useRemoteRecordingGate', () => ({
  useRemoteRecordingGate: () => false,
}));

vi.mock('../hooks/useWaveforms', () => ({
  useWaveforms: () => ({ mergedPeaks: null, isDecoding: false }),
}));

vi.mock('./AudioPlayer', () => ({ AudioPlayer: () => null }));
vi.mock('./AudioRecorder', () => ({ AudioRecorder: () => null }));
vi.mock('./AudioSaveOverlay', () => ({ AudioSaveOverlay: () => null }));
vi.mock('./CategoryButtonStrip', () => ({ CategoryButtonStrip: () => null }));
vi.mock('./EventLogSheet', () => ({
  EventLogSheet: () => <div data-testid="event-log-sheet-stub" />,
}));
vi.mock('./ExportFeed', () => ({ ExportFeed: () => null }));
vi.mock('./MarkerNav', () => ({ MarkerNav: () => null }));
vi.mock('./TimecodeDisplay', () => ({ TimecodeDisplay: () => null }));
vi.mock('./Timeline', () => ({ Timeline: () => null }));
// TopicsFeed/TranscribeFeed are top-level tab panels since ui-refresh
// (design D5 lifted them out of AiPanel's former nested subtabs into
// SessionWorkspace directly). They render a marker (rather than null) so
// the "feeds unchanged, still present" assertions below have something to
// find.
vi.mock('./TopicsFeed', () => ({
  TopicsFeed: () => <div data-testid="topics-feed-stub" />,
}));
// The stub also publishes the deferred-words gate it reads from context (perf
// plan B4) — this is the value the REAL TranscribeFeed passes straight through
// as `useTranscriptWords(sessionId, { enabled })`, so asserting on it asserts
// the wiring without unmocking the whole feed.
vi.mock('./TranscribeFeed', () => ({
  TranscribeFeed: () => (
    <div data-testid="transcribe-feed-stub" data-words-gate={String(useTranscriptWordsGate())} />
  ),
}));
vi.mock('./TransportControls', () => ({
  getTransportState: () => 'stop',
  TransportControls: () => null,
}));

// --- AI tab / subtab restructure + mount discipline (ai-topics-chat, task
// 4.1; spec: "AI tab and subtab arrangement") ---
//
// Two top-level feed tabs (Event Feed | AI); the AI tab nests three subtabs
// (Chat | Transcribe | Topics, default Chat). Design D9's mount discipline:
// every subtab/top-tab panel is mounted-hidden (rendered unconditionally,
// visibility toggled via the `hidden` attribute) rather than the repo's
// default conditional mount, specifically so the Chat panel's hoisted state
// and in-flight SSE turn (owned by AiPanel, consumed by AiChat once task 4.2
// lands) survive every switch. AiChat/AiPanel are exercised for real here
// (not mocked) — proving genuine no-unmount requires the real DOM node.
//
// No `@testing-library/jest-dom` matchers in this workspace — these tests
// read the `hidden` attribute/`aria-selected` via plain DOM APIs.

function isHidden(el: Element | null): boolean {
  expect(el).not.toBeNull();
  return (el as HTMLElement).hasAttribute('hidden');
}

describe('SessionWorkspace tab restructure', () => {
  it('feed tabs: arrow keys move activation, tabs control their panels, inactive panels are hidden', async () => {
    renderStrict(<SessionWorkspace sessionId="sess-1" />);
    const tabs = within(screen.getByRole('tablist', { name: 'Feed tabs' })).getAllByRole('tab');
    // Every tab is linked to its (mounted) panel; exactly one panel is visible.
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.hasAttribute('hidden')).toBe(tab.getAttribute('aria-selected') !== 'true');
    }
    const eventPanel = screen.getByTestId('event-log-sheet-stub').closest('[role="tabpanel"]');
    const first = screen.getByRole('tab', { name: 'Event Feed' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Transcript' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Transcript' }));
    expect(isHidden(screen.getByTestId('transcribe-feed-stub').closest('[role="tabpanel"]'))).toBe(
      false,
    );
    // Same node, now hidden: switching never unmounts a panel.
    expect(screen.getByTestId('event-log-sheet-stub').closest('[role="tabpanel"]')).toBe(
      eventPanel,
    );
    expect(isHidden(eventPanel)).toBe(true);
  });

  it('renders the six top-level tabs and defaults to Event Feed', () => {
    renderStrict(<SessionWorkspace sessionId="sess-1" />);

    const tablist = screen.getByRole('tablist', { name: 'Feed tabs' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Event Feed',
      'Transcript',
      'Topics',
      'Assistant',
      'Dashboards',
      'Export',
    ]);
    expect(screen.getByRole('tab', { name: 'Event Feed' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Assistant' }).getAttribute('aria-selected')).toBe(
      'false',
    );
    expect(isHidden(screen.getByTestId('event-log-sheet-stub').closest('[role="tabpanel"]'))).toBe(
      false,
    );
  });

  it('opening Assistant shows the chat, with Transcript/Topics mounted-hidden beside it', () => {
    renderStrict(<SessionWorkspace sessionId="sess-1" />);

    clickTab('Assistant');

    expect(screen.getByRole('tab', { name: 'Assistant' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    // Feeds unchanged: TranscribeFeed/TopicsFeed stay mounted in the DOM even
    // while the Assistant tab is active.
    expect(isHidden(screen.getByTestId('ai-chat-panel').closest('[role="tabpanel"]'))).toBe(false);
    expect(isHidden(screen.getByTestId('transcribe-feed-stub').closest('[role="tabpanel"]'))).toBe(
      true,
    );
    expect(isHidden(screen.getByTestId('topics-feed-stub').closest('[role="tabpanel"]'))).toBe(
      true,
    );
  });

  it('feed presence: switching to the Transcript/Topics tabs reveals the unchanged feeds', () => {
    renderStrict(<SessionWorkspace sessionId="sess-1" />);
    clickTab('Assistant');

    clickTab('Transcript');
    expect(isHidden(screen.getByTestId('transcribe-feed-stub').closest('[role="tabpanel"]'))).toBe(
      false,
    );
    expect(isHidden(screen.getByTestId('ai-chat-panel').closest('[role="tabpanel"]'))).toBe(true);

    clickTab('Topics');
    expect(isHidden(screen.getByTestId('topics-feed-stub').closest('[role="tabpanel"]'))).toBe(
      false,
    );
    expect(isHidden(screen.getByTestId('transcribe-feed-stub').closest('[role="tabpanel"]'))).toBe(
      true,
    );
  });

  // Gate-intent: this asserts DOM *node identity* (`toBe`, i.e. `===`), not
  // just visibility/attribute toggling. A conditional-mount implementation
  // (`{feedTab === 'assistant' && <AiPanel/>}`) would remove the element from
  // the tree on switch-away and create a brand-new element+DOM node on
  // switch-back — `querySelector` would return a *different* node object (or
  // null while hidden), so this assertion would fail. A mounted-hidden
  // implementation keeps the same element/DOM node across the switch, only
  // toggling the `hidden` attribute — this assertion passes only for that
  // shape, which is the one the spec requires.
  it('keeps the same Chat DOM node mounted across data-tab switches (no unmount)', () => {
    const { container } = renderStrict(<SessionWorkspace sessionId="sess-1" />);
    clickTab('Assistant');

    const chatNodeOnChat = container.querySelector('[data-testid="ai-chat-panel"]');
    expect(chatNodeOnChat).not.toBeNull();

    clickTab('Topics');
    const chatNodeOnTopics = container.querySelector('[data-testid="ai-chat-panel"]');
    expect(chatNodeOnTopics).toBe(chatNodeOnChat); // same node object => never unmounted
    expect(isHidden(chatNodeOnTopics?.closest('[role="tabpanel"]') ?? null)).toBe(true);

    clickTab('Transcript');
    expect(container.querySelector('[data-testid="ai-chat-panel"]')).toBe(chatNodeOnChat);

    clickTab('Assistant');
    const chatNodeBack = container.querySelector('[data-testid="ai-chat-panel"]');
    expect(chatNodeBack).toBe(chatNodeOnChat);
    expect(isHidden(chatNodeBack?.closest('[role="tabpanel"]') ?? null)).toBe(false);
  });

  // Same node-identity technique, across the Event Feed <-> Assistant
  // switch: the spec requires the chat turn survive switching to Event Feed
  // and back, not just switching among the other tabs.
  it('keeps the same Chat DOM node mounted across the Event Feed <-> Assistant switch', () => {
    const { container } = renderStrict(<SessionWorkspace sessionId="sess-1" />);
    clickTab('Assistant');
    const chatNode = container.querySelector('[data-testid="ai-chat-panel"]');
    expect(chatNode).not.toBeNull();

    clickTab('Event Feed');
    expect(container.querySelector('[data-testid="ai-chat-panel"]')).toBe(chatNode);
    expect(isHidden(screen.getByTestId('event-log-sheet-stub').closest('[role="tabpanel"]'))).toBe(
      false,
    );

    clickTab('Assistant');
    const chatNodeReturned = container.querySelector('[data-testid="ai-chat-panel"]');
    expect(chatNodeReturned).toBe(chatNode);
    expect(isHidden(chatNodeReturned?.closest('[role="tabpanel"]') ?? null)).toBe(false);
  });
});

// --- Dashboards tab (ai-v2-dashboards, task 4.1; spec "AI v2 tab in the
// session workspace" — the tab label is "Dashboards" since ui-refresh, D5)
// ---
//
// Same mounted-hidden discipline as the tabs above, extended to this
// top-level tab. AiV2Panel/AiV2Design are exercised for real here (not
// mocked), same rationale as AiChat/AiPanel: proving genuine no-unmount and
// no-abort requires the real DOM node and a real (mocked-at-the-fetch-
// boundary) in-flight stream.

// --- Deferred transcript-words fetch (perf plan B4) ---
//
// The word list is the biggest payload the workspace pulls, and the
// mounted-hidden tab discipline above is exactly what used to make it
// unconditional: four always-mounted consumers called `useTranscriptWords`
// from the first render. The gate defers it to first activation of a
// words-dependent tab. Panels are untouched — these tests assert only the
// `enabled` flag consumers receive, and the mount-discipline tests above still
// pass unchanged.

describe('SessionWorkspace deferred transcript-words gate', () => {
  const gateOnStub = () =>
    screen.getByTestId('transcribe-feed-stub').getAttribute('data-words-gate');

  it('starts shut on the default (Events) tab, opens on Transcript, and stays open on the way back', () => {
    transcriptWordsSpy.mockClear();
    renderStrict(<SessionWorkspace sessionId="sess-1" />);

    // Nothing words-dependent has been opened yet.
    expect(gateOnStub()).toBe('false');
    // End-to-end through a real consumer: AiV2Panel's widget-data hook holds
    // an empty config here, so the gate is its only trigger.
    expect(transcriptWordsSpy).toHaveBeenCalled();
    expect(transcriptWordsSpy.mock.calls.every(([, opts]) => opts?.enabled === false)).toBe(true);

    clickTab('Transcript');
    expect(gateOnStub()).toBe('true');
    expect(transcriptWordsSpy).toHaveBeenCalledWith('sess-1', { enabled: true });

    // Sticky: leaving the tab must not cancel/re-issue the fetch.
    clickTab('Event Feed');
    expect(gateOnStub()).toBe('true');

    // Topics and Export are words-dependent too; Assistant/Dashboards are not,
    // but the latch is one-way so they cannot shut it either.
    clickTab('Assistant');
    expect(gateOnStub()).toBe('true');
  });

  it.each([['Topics'], ['Export']])('opens on first activation of the %s tab', (tabName) => {
    renderStrict(<SessionWorkspace sessionId="sess-1" />);
    expect(gateOnStub()).toBe('false');
    clickTab(tabName);
    expect(gateOnStub()).toBe('true');
  });

  // The latch lives in a ref, and this component does NOT remount per session
  // (SessionRoute renders WorkspaceStatic with no `key`; `useSession`'s
  // `staleTime: Infinity` lets a nav between two cached sessions merely update
  // the prop — the same fact the AiV2Panel `key={sessionId}` test below turns
  // on). Without the render-time `prevSessionIdRef` compare, session B would
  // inherit session A's activation and eagerly pull B's multi-MB word list.
  // Same `StrictWrapper` re-wrap as that test, for the same reason: a changed
  // root element TYPE would remount SessionWorkspace and make this pass
  // regardless of the reset.
  it('resets the latch when the session changes without a remount', () => {
    const { rerender } = renderStrict(<SessionWorkspace sessionId="sess-a" />);
    clickTab('Transcript');
    clickTab('Event Feed');
    expect(gateOnStub()).toBe('true');

    rerender(
      <StrictWrapper>
        <SessionWorkspace sessionId="sess-b" />
      </StrictWrapper>,
    );

    expect(gateOnStub()).toBe('false');
  });

  // Reset-then-relatch ordering: landing on session B while a words-dependent
  // tab is still selected must re-open B's gate in the same render — the tab
  // is active, so the words really are needed.
  it('re-opens immediately for the next session when a words tab is still selected', () => {
    const { rerender } = renderStrict(<SessionWorkspace sessionId="sess-a" />);
    clickTab('Transcript');
    expect(gateOnStub()).toBe('true');

    rerender(
      <StrictWrapper>
        <SessionWorkspace sessionId="sess-b" />
      </StrictWrapper>,
    );

    expect(gateOnStub()).toBe('true');
  });

  // --- The dashboards-side trigger is gated on the tab, too (review fix) ---
  //
  // AiV2Panel is one of the six always-mounted panels and loads its persisted
  // dashboard in a MOUNT effect, so `useAiV2WidgetData`'s config check saw a
  // saved words widget on every session mount — which armed the multi-MB fetch
  // for a user sitting on the Events tab, defeating the deferral entirely.
  // These two run the REAL AiV2Panel against a REAL persisted config (global
  // `fetch` stubbed at the persistence boundary, the pattern the Dashboards
  // describe below uses) and read the `enabled` option the REAL words hook was
  // called with.
  const savedDashboard = (type: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      config: {
        widgets: [{ id: 'w1', type, title: 'W', x: 0, y: 0, w: 4, h: 3 }],
        interactions: [],
      },
    }),
  });
  const stubDashboardFetch = (type: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/ai/v2/dashboard')) {
          return Promise.resolve(savedDashboard(type) as unknown as Response);
        }
        return Promise.reject(new Error(`unexpected fetch: ${url}`));
      }),
    );
  /** Every `enabled` the real words hook has been asked for since the last clear. */
  const wordsEverEnabled = () =>
    transcriptWordsSpy.mock.calls.some(([, opts]) => opts?.enabled === true);

  it('keeps the gate shut for a saved words-widget dashboard until the Dashboards tab is shown', async () => {
    stubDashboardFetch('session_duration');
    try {
      transcriptWordsSpy.mockClear();
      const { rerender } = renderStrict(<SessionWorkspace sessionId="sess-a" />);

      // The persisted config has LANDED (the grid renders it, hidden) while the
      // Events tab is still the active one — so the negative assertion below is
      // a real absence, not a not-yet-loaded one.
      await waitFor(() => expect(screen.getByTestId('aiv2-dashboard-grid')).toBeTruthy());
      expect(gateOnStub()).toBe('false');
      expect(wordsEverEnabled()).toBe(false);

      // Showing the tab is what needs the payload.
      clickTab('Dashboards');
      expect(wordsEverEnabled()).toBe(true);

      // Sticky: leaving the tab must not cancel/re-issue the fetch. (The tab
      // latch itself stays shut — Dashboards is not a words-dependent TAB.)
      transcriptWordsSpy.mockClear();
      clickTab('Event Feed');
      expect(gateOnStub()).toBe('false');
      expect(transcriptWordsSpy.mock.calls.every(([, opts]) => opts?.enabled === true)).toBe(true);

      // Per-session reset: AiV2Panel remounts on `key={sessionId}`, so session
      // B starts from a shut latch rather than inheriting A's activation.
      transcriptWordsSpy.mockClear();
      rerender(
        <StrictWrapper>
          <SessionWorkspace sessionId="sess-b" />
        </StrictWrapper>,
      );
      await waitFor(() => expect(screen.getByTestId('aiv2-dashboard-grid')).toBeTruthy());
      expect(wordsEverEnabled()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the gate shut on a shown Dashboards tab whose config has no words widget', async () => {
    stubDashboardFetch('topic_timeline');
    try {
      transcriptWordsSpy.mockClear();
      renderStrict(<SessionWorkspace sessionId="sess-a" />);
      await waitFor(() => expect(screen.getByTestId('aiv2-dashboard-grid')).toBeTruthy());

      clickTab('Dashboards');
      expect(gateOnStub()).toBe('false');
      expect(wordsEverEnabled()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('SessionWorkspace Dashboards (AI v2) tab', () => {
  it('activates the Dashboards tabpanel and deselects it on load (tab count covered above)', () => {
    renderStrict(<SessionWorkspace sessionId="sess-1" />);

    expect(screen.getByRole('tab', { name: 'Dashboards' }).getAttribute('aria-selected')).toBe(
      'false',
    );
    clickTab('Dashboards');
    expect(screen.getByRole('tab', { name: 'Dashboards' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(isHidden(screen.getByTestId('aiv2-panel').closest('[role="tabpanel"]'))).toBe(false);
  });

  // Same node-identity technique as the tab-restructure describe above: a
  // conditional-mount implementation would tear down and rebuild the design
  // rail's DOM node (and its hoisted state) on every switch; querySelector
  // returning the SAME node object across switches only holds for a
  // mounted-hidden implementation.
  it('keeps the same Dashboards design-rail DOM node mounted across tab switches (no unmount)', () => {
    const { container } = renderStrict(<SessionWorkspace sessionId="sess-1" />);
    clickTab('Dashboards');
    const railNode = container.querySelector('[data-testid="aiv2-design-rail"]');
    expect(railNode).not.toBeNull();

    clickTab('Event Feed');
    expect(container.querySelector('[data-testid="aiv2-design-rail"]')).toBe(railNode);
    expect(isHidden(railNode?.closest('[role="tabpanel"]') ?? null)).toBe(true);

    clickTab('Assistant');
    expect(container.querySelector('[data-testid="aiv2-design-rail"]')).toBe(railNode);

    clickTab('Dashboards');
    expect(container.querySelector('[data-testid="aiv2-design-rail"]')).toBe(railNode);
    expect(isHidden(railNode?.closest('[role="tabpanel"]') ?? null)).toBe(false);
  });

  // The gate-intent test the task brief calls for: a design turn streaming
  // when the user switches to another top-level tab and back must (a) never
  // have its fetch aborted by the switch itself, and (b) still show the
  // conversation content afterward — proving the hoisted
  // conversation/streaming/abort state genuinely survives the switch, not
  // just that a DOM node happens to persist. A controllable fetch stand-in
  // (never auto-resolving `read()`) keeps the stream "in flight" across the
  // switch so an abort would be observable on `capturedSignal`.
  it('switching tabs mid-stream neither aborts the design turn nor clears the conversation', async () => {
    // AiV2Panel now defaults its `persistence` prop to the REAL fetch-backed
    // `DashboardPersistencePort` (task 5.2), so mounting it also fires a
    // `GET /ai/v2/dashboard` on mount, before the click-driven design-turn
    // POST this test cares about — dispatch by URL rather than relying on
    // `mockImplementationOnce`'s call-order queue, which the load() call
    // would otherwise consume first.
    let designFetchImpl:
      | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
      | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/ai/v2/dashboard')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ config: null }),
          } as unknown as Response);
        }
        return designFetchImpl?.(input, init);
      }),
    );
    try {
      let capturedSignal: AbortSignal | undefined;
      const encoder = new TextEncoder();
      const pendingChunks: string[] = [];
      let resolveNextRead: (() => void) | null = null;

      function deliverChunk(chunk: string) {
        pendingChunks.push(chunk);
        const fn = resolveNextRead;
        resolveNextRead = null;
        fn?.();
      }

      designFetchImpl = (_url, init) => {
        capturedSignal = init?.signal ?? undefined;
        return Promise.resolve({
          status: 200,
          ok: true,
          body: {
            getReader() {
              return {
                read: () =>
                  new Promise((resolve) => {
                    const tryDeliver = () => {
                      if (pendingChunks.length > 0) {
                        resolve({ done: false, value: encoder.encode(pendingChunks.shift()) });
                      } else {
                        resolveNextRead = tryDeliver;
                      }
                    };
                    tryDeliver();
                  }),
                cancel: async () => {},
              };
            },
          },
          json: async () => ({}),
        } as unknown as Response);
      };

      renderStrict(<SessionWorkspace sessionId="sess-1" />);
      clickTab('Dashboards');

      const textarea = screen.getByPlaceholderText(/ask for a starting dashboard/i);
      fireEvent.change(textarea, { target: { value: 'Give me an overview' } });
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      deliverChunk('event: delta\ndata: {"text":"Built an overview."}\n\n');
      await waitFor(() => expect(screen.getByText('Built an overview.')).toBeTruthy());
      expect(capturedSignal?.aborted).toBe(false);

      // Switch away mid-stream.
      clickTab('Event Feed');
      expect(capturedSignal?.aborted).toBe(false);

      // Switch back: conversation intact, not reset to empty.
      clickTab('Dashboards');
      expect(screen.getByText('Give me an overview')).toBeTruthy();
      expect(screen.getByText('Built an overview.')).toBeTruthy();

      // Proof the stream itself is still genuinely alive (not just that old
      // text survived): a further delta delivered AFTER the round trip still
      // lands in the same, still-hoisted conversation.
      deliverChunk('event: delta\ndata: {"text":" More."}\n\n');
      await waitFor(() => expect(screen.getByText('Built an overview. More.')).toBeTruthy());
      expect(capturedSignal?.aborted).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Whole-branch audit fix wave (Fix 1): `useSession`'s `staleTime: Infinity`
  // means navigating between two already-cached sessions updates this
  // `sessionId` prop WITHOUT unmounting `SessionWorkspace` itself (unlike
  // the placeholder<->grid swap tests above, which cover mount/unmount on
  // session presence, not identity). Before the fix, `<AiV2Panel
  // sessionId={sessionId} />` had no `key`, so AiV2Panel's own hoisted state
  // (messages/editingDashboard/proposedDashboard/proposedDashboardTurnId/
  // pendingQuestion) survived a session-to-session `rerender` untouched — a
  // not-yet-Kept proposal from session A could be Kept onto session B. The
  // fix adds `key={sessionId}` at the mount site so a SESSION change (not a
  // tab change — the test above already proves tab switches never remount)
  // forces a fresh AiV2Panel instance.
  it('navigating from session A (with a pending, un-kept proposal) to session B shows a clean Dashboards panel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/ai/v2/dashboard')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ config: null }),
          } as unknown as Response);
        }
        if (url.includes('/ai/v2/design')) {
          const encoder = new TextEncoder();
          let delivered = false;
          return Promise.resolve({
            status: 200,
            ok: true,
            body: {
              getReader() {
                return {
                  read: async () => {
                    if (delivered) return { done: true, value: undefined };
                    delivered = true;
                    return {
                      done: false,
                      value: encoder.encode(
                        'event: dashboard\ndata: {"config":{"widgets":[{"id":"w1","type":"session_duration","title":"X","x":0,"y":0,"w":4,"h":3}],"interactions":[]},"turnId":"turn-a"}\n\n',
                      ),
                    };
                  },
                  cancel: async () => {},
                };
              },
            },
            json: async () => ({}),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
        } as unknown as Response);
      }),
    );
    try {
      const { rerender } = renderStrict(<SessionWorkspace sessionId="sess-a" />);
      clickTab('Dashboards');

      const textarea = screen.getByPlaceholderText(/ask for a starting dashboard/i);
      fireEvent.change(textarea, { target: { value: 'Give me an overview' } });
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      // Session A: proposal offered, not yet kept; the user's own message is
      // visible in the (hoisted) conversation.
      await screen.findByTestId('aiv2-dashboard-proposal-banner');
      expect(screen.getByText('Give me an overview')).toBeTruthy();

      // Navigate to a different, already-cached session — same top-level
      // `SessionWorkspace` instance (feedTab state survives), only the
      // `sessionId` prop changes, exactly as a real nav-without-remount would.
      // Re-wrapped in the SAME `<StrictWrapper>` the initial `renderStrict`
      // used (rather than a bare `rerender(<SessionWorkspace .../>)`): the
      // root element's TYPE must stay identical across the two `rerender`
      // calls, or React treats it as a full tree replacement and remounts
      // `SessionWorkspace` itself — which would make this test pass
      // regardless of whether `AiV2Panel`'s own `key={sessionId}` fix is
      // present, since everything below it would remount either way.
      rerender(
        <StrictWrapper>
          <SessionWorkspace sessionId="sess-b" />
        </StrictWrapper>,
      );

      // Clean slate for session B: no leaked proposal banner, no leaked
      // conversation message; session B's own (null) saved dashboard loads
      // fresh, showing the empty-state entry points.
      await waitFor(() =>
        expect(screen.queryByTestId('aiv2-dashboard-proposal-banner')).toBeNull(),
      );
      expect(screen.queryByText('Give me an overview')).toBeNull();
      expect(await screen.findByTestId('aiv2-start-blank')).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// web-session-console "Discoverable keyboard-shortcut reference" + web-ui-system "Global
// single-key handlers yield to dialogs" (shadcn-shared-wrappers 1.4): `?` opens the shortcut
// reference, and yields to any open dialog, alert dialog, or menu.
describe('SessionWorkspace "?" shortcut', () => {
  it('opens the keyboard-shortcut reference with no overlay open', () => {
    renderStrict(<SessionWorkspace sessionId="sess-1" />);
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });

  it.each(['dialog', 'alertdialog', 'menu'])('does nothing while a [role="%s"] is open', (role) => {
    renderStrict(<SessionWorkspace sessionId="sess-1" />);
    const overlay = document.createElement('div');
    overlay.setAttribute('role', role);
    document.body.appendChild(overlay);
    try {
      fireEvent.keyDown(document.body, { key: '?' });
      expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    } finally {
      overlay.remove();
    }
  });
});

// --- Shell transport status (redesign-show-ignition D2, task 2.2) ---
//
// The workspace publishes its effective transport to the shell store, mapped
// audio-recording→recording, rolling→rolling, play→playback, stop→stopped,
// with the session id and title, and clears it on unmount.
describe('SessionWorkspace shell transport status', () => {
  afterEach(() => {
    statusBySession.clear();
  });

  it('a lease-alive status publishes recording', () => {
    statusBySession.set('sess-rec', {
      title: 'Ep 12',
      is_rolling: true,
      audio_recording_lease_alive: true,
    });
    renderStrict(<SessionWorkspace sessionId="sess-rec" />);
    expect(getTransportStatus()).toEqual({
      state: 'recording',
      sessionId: 'sess-rec',
      title: 'Ep 12',
    });
  });

  it('is_rolling without a lease publishes rolling', () => {
    statusBySession.set('sess-roll', {
      title: 'Ep 13',
      is_rolling: true,
      audio_recording_lease_alive: false,
    });
    renderStrict(<SessionWorkspace sessionId="sess-roll" />);
    expect(getTransportStatus()).toEqual({
      state: 'rolling',
      sessionId: 'sess-roll',
      title: 'Ep 13',
    });
  });

  it('a session with no live status publishes stopped with its id', () => {
    renderStrict(<SessionWorkspace sessionId="sess-idle" />);
    expect(getTransportStatus()).toEqual({ state: 'stopped', sessionId: 'sess-idle', title: null });
  });

  it('unmount clears', () => {
    statusBySession.set('sess-rec', { title: 'Ep 12', audio_recording_lease_alive: true });
    const { unmount } = renderStrict(<SessionWorkspace sessionId="sess-rec" />);
    expect(getTransportStatus().state).toBe('recording');
    unmount();
    expect(getTransportStatus()).toEqual({ state: 'stopped', sessionId: null, title: null });
  });

  // SessionWorkspace does not remount per session (see the words-gate tests
  // above), so the switch is a prop change under the same instance.
  it("switching session ids while recording leaves the store on the new session's state", () => {
    statusBySession.set('sess-a', { title: 'A', audio_recording_lease_alive: true });
    statusBySession.set('sess-b', { title: 'B', is_rolling: true });
    const { rerender } = renderStrict(<SessionWorkspace sessionId="sess-a" />);
    expect(getTransportStatus()).toEqual({ state: 'recording', sessionId: 'sess-a', title: 'A' });

    rerender(
      <StrictWrapper>
        <SessionWorkspace sessionId="sess-b" />
      </StrictWrapper>,
    );

    expect(getTransportStatus()).toEqual({ state: 'rolling', sessionId: 'sess-b', title: 'B' });
  });
});

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../test/renderStrict';
import { SessionWorkspace } from './SessionWorkspace';

// --- SessionWorkspace visibility-swap tests (session-deep-links, task 3.3;
// spec: web-session-routing "Legacy selection spine retired" — "Workspace
// visibility swap survives the removal") ---
//
// The placeholder ↔ grid swap used to be imperative classList toggling in
// AppShell's syncChrome(); it is now render-driven off the sessionId prop
// (design D9). These tests pin the two observable halves the e2e suite
// asserts on (`#v3-session-placeholder` / `#v3-session-grid`), with every
// data/socket/audio hook and heavy child mocked at the module boundary —
// this is a rendering test, not an integration test.

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
}));

vi.mock('../../../api/hooks/useSessionSocket', () => ({
  useSessionSocket: () => {},
}));

vi.mock('../../../api/hooks/useSessionStatus', () => ({
  useSessionStatus: () => ({ data: undefined }),
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
}));

vi.mock('../../../shared/utils/loadingVideo', () => ({
  AUTOLOGGER_LOADING_VIDEO_SRC: '',
}));

vi.mock('../hooks/useAudioClips', () => ({
  useAudioClips: () => ({ clips: [], totalSec: 0, segments: [] }),
}));

vi.mock('../hooks/useRecoveryStopWarning', () => ({
  useRecoveryStopWarning: () => {},
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
vi.mock('./ExportModal', () => ({ ExportModal: () => null }));
vi.mock('./MarkerNav', () => ({ MarkerNav: () => null }));
vi.mock('./TimecodeDisplay', () => ({ TimecodeDisplay: () => null }));
vi.mock('./Timeline', () => ({ Timeline: () => null }));
// TopicsFeed/TranscribeFeed are imported by AiPanel (not SessionWorkspace
// directly) but resolve to the same module path, so these mocks still apply.
// They render a marker (rather than null) so the "feeds unchanged, still
// present under the AI tab" assertions below have something to find.
vi.mock('./TopicsFeed', () => ({
  TopicsFeed: () => <div data-testid="topics-feed-stub" />,
}));
vi.mock('./TranscribeFeed', () => ({
  TranscribeFeed: () => <div data-testid="transcribe-feed-stub" />,
}));
vi.mock('./TransportControls', () => ({
  getTransportState: () => 'stop',
  TransportControls: () => null,
}));

function regions(container: HTMLElement) {
  const placeholder = container.querySelector('#v3-session-placeholder');
  const grid = container.querySelector('#v3-session-grid');
  expect(placeholder).not.toBeNull();
  expect(grid).not.toBeNull();
  return { placeholder: placeholder as HTMLElement, grid: grid as HTMLElement };
}

describe('SessionWorkspace visibility swap', () => {
  it('shows the placeholder and hides the grid when no session is active', () => {
    const { container } = renderStrict(<SessionWorkspace sessionId="" />);
    const { placeholder, grid } = regions(container);

    expect(placeholder.classList.contains('hidden')).toBe(false);
    expect(grid.classList.contains('hidden')).toBe(true);
  });

  it('reveals the grid and hides the placeholder when a session is active', () => {
    const { container } = renderStrict(<SessionWorkspace sessionId="sess-1" />);
    const { placeholder, grid } = regions(container);

    expect(placeholder.classList.contains('hidden')).toBe(true);
    expect(grid.classList.contains('hidden')).toBe(false);
  });

  it('swaps back when the session id prop is cleared (close path)', () => {
    const { container, rerender } = renderStrict(<SessionWorkspace sessionId="sess-1" />);
    rerender(<SessionWorkspace sessionId="" />);
    const { placeholder, grid } = regions(container);

    expect(placeholder.classList.contains('hidden')).toBe(false);
    expect(grid.classList.contains('hidden')).toBe(true);
  });
});

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
// No `@testing-library/jest-dom` matchers in this workspace (see
// SessionWorkspace visibility swap tests above using `classList.contains`
// directly) — these tests read the `hidden` attribute/`aria-selected` via
// plain DOM APIs for the same reason.

function isHidden(el: Element | null): boolean {
  expect(el).not.toBeNull();
  return (el as HTMLElement).hasAttribute('hidden');
}

describe('SessionWorkspace AI tab restructure', () => {
  it('renders the top-level tabs (Event Feed, AI, AI v2) and defaults to Event Feed', () => {
    renderStrict(<SessionWorkspace sessionId="sess-1" />);

    const tablist = screen.getByRole('tablist', { name: 'Feed tabs' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Event Feed', 'AI', 'AI v2']);
    expect(screen.getByRole('tab', { name: 'Event Feed' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: 'AI' }).getAttribute('aria-selected')).toBe('false');
    expect(isHidden(screen.getByTestId('event-log-sheet-stub').closest('[role="tabpanel"]'))).toBe(
      false,
    );
  });

  it('opening AI defaults its nested subtabs to Chat, with Transcribe/Topics also present', () => {
    renderStrict(<SessionWorkspace sessionId="sess-1" />);

    fireEvent.click(screen.getByRole('tab', { name: 'AI' }));

    const aiTablist = screen.getByRole('tablist', { name: 'AI tabs' });
    const subtabs = within(aiTablist).getAllByRole('tab');
    expect(subtabs.map((t) => t.textContent)).toEqual(['Chat', 'Transcribe', 'Topics']);
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');

    // Feeds unchanged: TranscribeFeed/TopicsFeed still render under the AI
    // tab (mounted-hidden, present in the DOM even though Chat is active).
    expect(isHidden(screen.getByTestId('ai-chat-panel').closest('[role="tabpanel"]'))).toBe(false);
    expect(isHidden(screen.getByTestId('transcribe-feed-stub').closest('[role="tabpanel"]'))).toBe(
      true,
    );
    expect(isHidden(screen.getByTestId('topics-feed-stub').closest('[role="tabpanel"]'))).toBe(
      true,
    );
  });

  it('feed presence: switching to Transcribe/Topics subtabs reveals the unchanged feeds', () => {
    renderStrict(<SessionWorkspace sessionId="sess-1" />);
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }));

    fireEvent.click(screen.getByRole('tab', { name: 'Transcribe' }));
    expect(isHidden(screen.getByTestId('transcribe-feed-stub').closest('[role="tabpanel"]'))).toBe(
      false,
    );
    expect(isHidden(screen.getByTestId('ai-chat-panel').closest('[role="tabpanel"]'))).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Topics' }));
    expect(isHidden(screen.getByTestId('topics-feed-stub').closest('[role="tabpanel"]'))).toBe(
      false,
    );
    expect(isHidden(screen.getByTestId('transcribe-feed-stub').closest('[role="tabpanel"]'))).toBe(
      true,
    );
  });

  // Gate-intent: this asserts DOM *node identity* (`toBe`, i.e. `===`), not
  // just visibility/attribute toggling. A conditional-mount implementation
  // (`{aiTab === 'chat' && <AiChat/>}`) would remove the element from the
  // tree on switch-away and create a brand-new element+DOM node on
  // switch-back — `querySelector` would return a *different* node object (or
  // null while hidden), so this assertion would fail. A mounted-hidden
  // implementation keeps the same element/DOM node across the switch, only
  // toggling the `hidden` attribute — this assertion passes only for that
  // shape, which is the one the spec requires.
  it('keeps the same Chat DOM node mounted across AI subtab switches (no unmount)', () => {
    const { container } = renderStrict(<SessionWorkspace sessionId="sess-1" />);
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }));

    const chatNodeOnChat = container.querySelector('[data-testid="ai-chat-panel"]');
    expect(chatNodeOnChat).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Topics' }));
    const chatNodeOnTopics = container.querySelector('[data-testid="ai-chat-panel"]');
    expect(chatNodeOnTopics).toBe(chatNodeOnChat); // same node object => never unmounted
    expect(isHidden(chatNodeOnTopics?.closest('[role="tabpanel"]') ?? null)).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Transcribe' }));
    expect(container.querySelector('[data-testid="ai-chat-panel"]')).toBe(chatNodeOnChat);

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    const chatNodeBack = container.querySelector('[data-testid="ai-chat-panel"]');
    expect(chatNodeBack).toBe(chatNodeOnChat);
    expect(isHidden(chatNodeBack?.closest('[role="tabpanel"]') ?? null)).toBe(false);
  });

  // Same node-identity technique, across the top-level Event Feed <-> AI
  // switch: the spec requires the chat turn survive switching to Event Feed
  // and back, not just switching among the AI subtabs.
  it('keeps the same Chat DOM node mounted across the Event Feed <-> AI top-tab switch', () => {
    const { container } = renderStrict(<SessionWorkspace sessionId="sess-1" />);
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }));
    const chatNode = container.querySelector('[data-testid="ai-chat-panel"]');
    expect(chatNode).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Event Feed' }));
    expect(container.querySelector('[data-testid="ai-chat-panel"]')).toBe(chatNode);
    expect(isHidden(screen.getByTestId('event-log-sheet-stub').closest('[role="tabpanel"]'))).toBe(
      false,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'AI' }));
    const chatNodeReturned = container.querySelector('[data-testid="ai-chat-panel"]');
    expect(chatNodeReturned).toBe(chatNode);
    expect(isHidden(chatNodeReturned?.closest('[role="tabpanel"]') ?? null)).toBe(false);
  });
});

// --- AI v2 tab (ai-v2-dashboards, task 4.1; spec "AI v2 tab in the session
// workspace") ---
//
// Same mounted-hidden discipline as the AI tab above, extended to a third
// top-level tab. AiV2Panel/AiV2Design are exercised for real here (not
// mocked), same rationale as AiChat/AiPanel: proving genuine no-unmount and
// no-abort requires the real DOM node and a real (mocked-at-the-fetch-
// boundary) in-flight stream.

describe('SessionWorkspace AI v2 tab', () => {
  it('activates the AI v2 tabpanel and deselects it on load (tab count covered above)', () => {
    renderStrict(<SessionWorkspace sessionId="sess-1" />);

    expect(screen.getByRole('tab', { name: 'AI v2' }).getAttribute('aria-selected')).toBe('false');
    fireEvent.click(screen.getByRole('tab', { name: 'AI v2' }));
    expect(screen.getByRole('tab', { name: 'AI v2' }).getAttribute('aria-selected')).toBe('true');
    expect(isHidden(screen.getByTestId('aiv2-panel').closest('[role="tabpanel"]'))).toBe(false);
  });

  // Same node-identity technique as the AI tab's own test above: a
  // conditional-mount implementation would tear down and rebuild the design
  // rail's DOM node (and its hoisted state) on every switch; querySelector
  // returning the SAME node object across switches only holds for a
  // mounted-hidden implementation.
  it('keeps the same AI v2 design-rail DOM node mounted across top-tab switches (no unmount)', () => {
    const { container } = renderStrict(<SessionWorkspace sessionId="sess-1" />);
    fireEvent.click(screen.getByRole('tab', { name: 'AI v2' }));
    const railNode = container.querySelector('[data-testid="aiv2-design-rail"]');
    expect(railNode).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Event Feed' }));
    expect(container.querySelector('[data-testid="aiv2-design-rail"]')).toBe(railNode);
    expect(isHidden(railNode?.closest('[role="tabpanel"]') ?? null)).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'AI' }));
    expect(container.querySelector('[data-testid="aiv2-design-rail"]')).toBe(railNode);

    fireEvent.click(screen.getByRole('tab', { name: 'AI v2' }));
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
      fireEvent.click(screen.getByRole('tab', { name: 'AI v2' }));

      const textarea = screen.getByPlaceholderText(/ask for a starting dashboard/i);
      fireEvent.change(textarea, { target: { value: 'Give me an overview' } });
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      deliverChunk('event: delta\ndata: {"text":"Built an overview."}\n\n');
      await waitFor(() => expect(screen.getByText('Built an overview.')).toBeTruthy());
      expect(capturedSignal?.aborted).toBe(false);

      // Switch away mid-stream.
      fireEvent.click(screen.getByRole('tab', { name: 'Event Feed' }));
      expect(capturedSignal?.aborted).toBe(false);

      // Switch back: conversation intact, not reset to empty.
      fireEvent.click(screen.getByRole('tab', { name: 'AI v2' }));
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
});

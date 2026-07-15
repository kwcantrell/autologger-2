import { fireEvent, screen, within } from '@testing-library/react';
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
  it('renders the two top-level tabs (Event Feed, AI) and defaults to Event Feed', () => {
    renderStrict(<SessionWorkspace sessionId="sess-1" />);

    const tablist = screen.getByRole('tablist', { name: 'Feed tabs' });
    const tabs = within(tablist).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Event Feed', 'AI']);
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

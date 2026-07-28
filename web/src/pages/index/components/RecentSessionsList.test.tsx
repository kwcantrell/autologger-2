import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useArchiveSession,
  useDeleteSession,
  useRestoreSession,
  useUpdateSession,
} from '../../../api/hooks/useSessions';
import type { Session } from '../../../api/types';
import { renderStrict } from '../../../test/renderStrict';
import { showToast } from '../utils/toast';
import { ArchivedSessionsList, RecentSessionsList } from './RecentSessionsList';

// --- Session-card variant behaviors (code-health-tail 4.7, finding 2.9) ---
//
// The delete-confirm flow, meta/runtime derivation, and ⋮-menu/meta-row
// scaffold are extracted into shared pieces consumed by BOTH card variants;
// these tests pin each variant's observable behavior through the extraction:
// mock at the module boundary (the useSessions mutation hooks + toast), keep
// the cards, Popover, and ConfirmDialog real. `overlayscrollbars-react` is
// mocked to a plain div (presentational scroll chrome with no jsdom support),
// same as V6Rail.test.tsx.

vi.mock('../../../api/hooks/useSessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/hooks/useSessions')>();
  return {
    ...actual,
    useUpdateSession: vi.fn(),
    useArchiveSession: vi.fn(),
    useDeleteSession: vi.fn(),
    useRestoreSession: vi.fn(),
  };
});

vi.mock('../utils/toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('overlayscrollbars-react', () => ({
  OverlayScrollbarsComponent: ({
    children,
    id,
    className,
  }: {
    children?: React.ReactNode;
    id?: string;
    className?: string;
  }) => (
    <div id={id} className={className}>
      {children}
    </div>
  ),
}));

// Radix Popover positions via floating-ui, which constructs a ResizeObserver
// jsdom doesn't provide (same local stub idiom as TopicsFeed.test.tsx).
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

const updateMutate = vi.fn();
const archiveMutate = vi.fn();
const deleteMutate = vi.fn();
const restoreMutate = vi.fn();

function sessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    title: 'Session One',
    deck_title: '',
    show_id: 'show-1',
    show_code: 'SH',
    show_name: 'Show One',
    episode: '1',
    notes: '',
    session_status: 'active',
    frame_rate: 30,
    start_offset_frames: 0,
    created_at_utc: '2026-07-14T00:00:00Z',
    episode_date: null,
    event_count: 3,
    is_rolling: false,
    current_take: 0,
    rolling_timecode: null,
    total_runtime_hms: '01:02:03',
    archived: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Success-path mutation stubs: invoke onSuccess synchronously so the tests
  // can assert the per-variant toast wiring survives the extraction.
  vi.mocked(useUpdateSession).mockReturnValue({
    mutate: updateMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.()),
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateSession>);
  vi.mocked(useArchiveSession).mockReturnValue({
    mutate: archiveMutate.mockImplementation((_id, opts) => opts?.onSuccess?.()),
  } as unknown as ReturnType<typeof useArchiveSession>);
  vi.mocked(useDeleteSession).mockReturnValue({
    mutate: deleteMutate.mockImplementation((_id, opts) => opts?.onSuccess?.()),
  } as unknown as ReturnType<typeof useDeleteSession>);
  vi.mocked(useRestoreSession).mockReturnValue({
    mutate: restoreMutate.mockImplementation((_id, opts) => opts?.onSuccess?.()),
  } as unknown as ReturnType<typeof useRestoreSession>);
});

function renderRecent(
  sessions: Session[],
  {
    activeSessionId = '',
    onSelectSession = () => {},
    onCloseSession = () => {},
  }: {
    activeSessionId?: string;
    onSelectSession?: (sid: string) => void;
    onCloseSession?: () => void;
  } = {},
) {
  return renderStrict(
    <RecentSessionsList
      sessions={{ active: sessions, archived: [] }}
      isLoading={false}
      activeSessionId={activeSessionId}
      onSelectSession={onSelectSession}
      onCloseSession={onCloseSession}
    />,
  );
}

function card(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector(`[data-session-id="${id}"]`);
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

function openMenu(cardEl: HTMLElement) {
  fireEvent.click(within(cardEl).getByRole('button', { name: 'Session options' }));
}

describe('SessionCard (active-list variant)', () => {
  it('deletes via ⋮ → Delete → themed confirm, with the success toast', async () => {
    const { container } = renderRecent([sessionFixture()]);
    openMenu(card(container, 'sess-1'));
    fireEvent.click(await screen.findByText('Delete'));

    // Themed ConfirmDialog, not window.confirm; danger copy names the session.
    expect(await screen.findByText(/Permanently delete “Session One”/)).toBeTruthy();
    expect(deleteMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteMutate).toHaveBeenCalledTimes(1));
    expect(deleteMutate.mock.calls[0][0]).toBe('sess-1');
    expect(showToast).toHaveBeenCalledWith('Session permanently deleted.');
  });

  it('cancelling the delete confirm never fires the mutation', async () => {
    const { container } = renderRecent([sessionFixture()]);
    openMenu(card(container, 'sess-1'));
    fireEvent.click(await screen.findByText('Delete'));

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText(/Permanently delete/)).toBeNull());
    expect(deleteMutate).not.toHaveBeenCalled();
  });

  it('archives via ⋮ → Archive → confirm (variant-specific action)', async () => {
    const { container } = renderRecent([sessionFixture()]);
    openMenu(card(container, 'sess-1'));
    fireEvent.click(await screen.findByText('Archive'));

    expect(await screen.findByText(/Archive “Session One”/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(archiveMutate).toHaveBeenCalledTimes(1));
    expect(archiveMutate.mock.calls[0][0]).toBe('sess-1');
    expect(showToast).toHaveBeenCalledWith('Session archived.');
  });

  it('owns the rename modal: ⋮ → Rename → Save fires the update mutation', async () => {
    const { container } = renderRecent([sessionFixture()]);
    openMenu(card(container, 'sess-1'));
    fireEvent.click(await screen.findByText('Rename'));

    const input = (await screen.findByDisplayValue('Session One')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateMutate).toHaveBeenCalledTimes(1));
    expect(updateMutate.mock.calls[0][0]).toEqual({ title: 'Renamed', start_offset_frames: 0 });
    expect(showToast).toHaveBeenCalledWith('Session updated.');
  });

  it('title click selects a non-active session; the active card offers Close session instead', async () => {
    const onSelectSession = vi.fn();
    const onCloseSession = vi.fn();
    const { container } = renderRecent(
      [sessionFixture(), sessionFixture({ id: 'sess-2', title: 'Session Two' })],
      { activeSessionId: 'sess-2', onSelectSession, onCloseSession },
    );

    const inactiveTitle = within(card(container, 'sess-1')).getByText('Session One');
    expect(inactiveTitle.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(inactiveTitle);
    expect(onSelectSession).toHaveBeenCalledWith('sess-1');

    // Active variant: its title is a no-op, marked aria-disabled (4.8), plus
    // the hidden a11y marker and the Close session menu item.
    const activeTitle = within(card(container, 'sess-2')).getByText('Session Two');
    expect(activeTitle.getAttribute('aria-disabled')).toBe('true');
    onSelectSession.mockClear();
    fireEvent.click(activeTitle);
    expect(onSelectSession).not.toHaveBeenCalled();
    expect(within(card(container, 'sess-2')).getByText('ACTIVE SESSION')).toBeTruthy();
    openMenu(card(container, 'sess-2'));
    fireEvent.click(await screen.findByText('Close session'));
    expect(onCloseSession).toHaveBeenCalledTimes(1);
  });

  it('renders the shared meta row: date · event count and the runtime', () => {
    const { container } = renderRecent([sessionFixture()]);
    const el = card(container, 'sess-1');
    expect(within(el).getByText(/· 3 events$/)).toBeTruthy();
    expect(within(el).getByText('01:02:03')).toBeTruthy();
  });
});

describe('ArchivedSessionCard (archived-list variant)', () => {
  function renderArchived(sessions: Session[]) {
    return renderStrict(<ArchivedSessionsList sessions={sessions} />);
  }

  it('deletes via the same shared confirm-then-delete flow', async () => {
    const { container } = renderArchived([
      sessionFixture({ id: 'arch-1', title: 'Old Session', archived: true }),
    ]);
    openMenu(card(container, 'arch-1'));
    fireEvent.click(await screen.findByText('Delete'));

    expect(await screen.findByText(/Permanently delete “Old Session”/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteMutate).toHaveBeenCalledTimes(1));
    expect(deleteMutate.mock.calls[0][0]).toBe('arch-1');
    expect(showToast).toHaveBeenCalledWith('Session permanently deleted.');
  });

  it('restores via ⋮ → Restore → confirm (variant-specific action)', async () => {
    const { container } = renderArchived([
      sessionFixture({ id: 'arch-1', title: 'Old Session', archived: true }),
    ]);
    openMenu(card(container, 'arch-1'));
    fireEvent.click(await screen.findByText('Restore'));

    expect(await screen.findByText(/Restore “Old Session”/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => expect(restoreMutate).toHaveBeenCalledTimes(1));
    expect(restoreMutate.mock.calls[0][0]).toBe('arch-1');
    expect(showToast).toHaveBeenCalledWith('Session restored.');
  });

  it('keeps its non-interactive title (a span, not a button) and the shared meta row', () => {
    const { container } = renderArchived([
      sessionFixture({ id: 'arch-1', title: 'Old Session', archived: true }),
    ]);
    const el = card(container, 'arch-1');
    const title = within(el).getByText('Old Session');
    expect(title.tagName).toBe('SPAN');
    expect(within(el).getByText(/· 3 events$/)).toBeTruthy();
    expect(within(el).getByText('01:02:03')).toBeTruthy();
  });
});

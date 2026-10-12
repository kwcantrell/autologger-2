import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { useSearch } from '../../../../api/hooks/useSearch';
import type { SearchResponse } from '../../../../api/types';
import { renderStrict } from '../../../../test/renderStrict';
import { useSwitchActive } from '../../hooks/useSwitchActive';
import { setNavigationImplForTesting } from '../../navigation';
import { SearchPalette } from './SearchPalette';

// catalog-search task 5.5 (design D9; catalog-search "Command palette and results page"):
// Cmd/Ctrl-K or the top-bar button opens the palette (never while typing in a field or while
// another dialog or sheet is open); it searches 200 ms after typing pauses, shows grouped
// results, and each choice routes: a session to `/sessions/<id>`, a moment to its deep link, a
// show or studio through `useSwitchActive` and then `/`, and "See all results" to `/search?q=`.

vi.mock('../../../../api/hooks/useSearch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/hooks/useSearch')>()),
  useSearch: vi.fn(),
}));
vi.mock('../../hooks/useSwitchActive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useSwitchActive')>()),
  useSwitchActive: vi.fn(),
}));

const useSearchMock = vi.mocked(useSearch);
const useSwitchActiveMock = vi.mocked(useSwitchActive);
const switchActive = vi.fn<(t: { studioId: string; showId?: string }) => Promise<boolean>>();

const OPEN = '';
const CLOSE = '';

const RESULTS: SearchResponse = {
  q: 'budget',
  studios: [{ id: 'st-b', name: 'Budget Studio' }],
  shows: [{ id: 'sh-b', name: 'Budget Hour', studio_id: 'st-other' }],
  sessions: [
    {
      id: 'sess-1',
      title: 'Budget review',
      episode: 'E1',
      show_id: 'sh-1',
      studio_id: 'st-1',
      started_at_utc: '2026-10-01T10:00:00.000Z',
      archived: false,
      match: 'title',
      snippet: null,
    },
  ],
  moments: [
    {
      kind: 'transcript',
      session_id: 'sess-2',
      session_title: 'Town hall',
      show_id: 'sh-1',
      id: '25',
      sec: 754.2,
      speaker: 'Ana',
      snippet: `the ${OPEN}budget${CLOSE} passed`,
    },
    {
      kind: 'topic',
      session_id: 'sess-2',
      session_title: 'Town hall',
      show_id: 'sh-1',
      id: 'topic-9',
      sec: null,
      speaker: '',
      snippet: `${OPEN}Budget${CLOSE} debate`,
    },
    {
      kind: 'event',
      session_id: 'sess-3',
      session_title: 'Council',
      show_id: 'sh-1',
      id: 'ev-4',
      sec: null,
      speaker: '',
      snippet: `${OPEN}budget${CLOSE} vote`,
    },
  ],
  moment_sessions: [
    { session_id: 'sess-2', total: 2 },
    { session_id: 'sess-3', total: 1 },
  ],
};

function searchResult(q: string) {
  const live = q.trim().length >= 2;
  return {
    data: live ? { ...RESULTS, q: q.trim() } : undefined,
    isFetching: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useSearch>;
}

// cmdk scrolls the selected item into view; jsdom has no scrollIntoView or ResizeObserver.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

let memory: ReturnType<typeof memoryLocation>;
const onCloseSession = vi.fn();
const confirmSwitch = vi.fn((): true | Promise<boolean> => true);

function renderPalette(path = '/', extra?: React.ReactNode) {
  memory = memoryLocation({ path, record: true });
  setNavigationImplForTesting((p, o) => memory.navigate(p, o));
  return renderStrict(
    <Router hook={memory.hook}>
      {extra}
      <SearchPalette onCloseSession={onCloseSession} confirmSwitch={confirmSwitch} />
    </Router>,
  );
}

const pressCmdK = (target: Element = document.body, mod: 'metaKey' | 'ctrlKey' = 'metaKey') =>
  fireEvent.keyDown(target, { key: 'k', [mod]: true });

const dialog = () => screen.queryByRole('dialog');
const searchButton = () => screen.getByRole('button', { name: /^search/i });

async function openAndType(q: string) {
  fireEvent.click(searchButton());
  const input = await screen.findByRole('combobox');
  fireEvent.change(input, { target: { value: q } });
  await waitFor(() => expect(screen.getByText('Budget review')).toBeTruthy());
}

beforeEach(() => {
  useSearchMock.mockReset();
  useSearchMock.mockImplementation((p) => searchResult(p.q));
  switchActive.mockReset();
  switchActive.mockResolvedValue(true);
  useSwitchActiveMock.mockReset();
  useSwitchActiveMock.mockImplementation(() => ({
    activeStudioId: 'st-1',
    activeShowId: 'sh-1',
    isPending: false,
    switchActive,
  }));
  onCloseSession.mockReset();
  confirmSwitch.mockClear();
});

afterEach(() => {
  setNavigationImplForTesting(null);
  vi.useRealTimers();
});

describe('SearchPalette: opening', () => {
  it('Cmd-K and Ctrl-K open it', async () => {
    renderPalette();
    expect(dialog()).toBeNull();
    act(() => {
      pressCmdK();
    });
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(within(dialog() as HTMLElement).getByRole('combobox')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    await waitFor(() => expect(dialog()).toBeNull());
    act(() => {
      pressCmdK(document.body, 'ctrlKey');
    });
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('does not open while focus is in a text field', () => {
    renderPalette(
      '/',
      <>
        <input aria-label="note" />
        <textarea aria-label="body" />
      </>,
    );
    pressCmdK(screen.getByLabelText('note'));
    pressCmdK(screen.getByLabelText('body'), 'ctrlKey');
    expect(dialog()).toBeNull();
  });

  it('does not open while another dialog or sheet is open', () => {
    renderPalette('/', <div role="dialog" aria-label="Settings" />);
    pressCmdK();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('a plain K, or K with Alt or Shift, does nothing', () => {
    renderPalette();
    fireEvent.keyDown(document.body, { key: 'k' });
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true, altKey: true });
    fireEvent.keyDown(document.body, { key: 'K', ctrlKey: true, shiftKey: true });
    expect(dialog()).toBeNull();
  });

  it('the top-bar button opens it, and its tooltip names the shortcut', async () => {
    renderPalette();
    const button = searchButton();
    act(() => {
      button.focus();
    });
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toMatch(/search/i);
    expect(tip.textContent).toMatch(/(⌘|Ctrl)\s*\+?\s*K/);
    fireEvent.click(button);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});

describe('SearchPalette: searching', () => {
  it('searches 200 ms after typing pauses, with limit 5', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    renderPalette();
    fireEvent.click(searchButton());
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'bu' } });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.change(input, { target: { value: 'bud' } });
    act(() => {
      vi.advanceTimersByTime(199);
    });
    const qs = () => useSearchMock.mock.calls.map(([p]) => p.q);
    expect(qs()).not.toContain('bu');
    expect(qs()).not.toContain('bud');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(qs()).toContain('bud');
    expect(qs()).not.toContain('bu');
    const last = useSearchMock.mock.calls.at(-1)?.[0];
    expect(last).toMatchObject({ q: 'bud', limit: 5 });
  });

  it('shows results grouped, with highlighted snippets', async () => {
    renderPalette();
    await openAndType('budget');
    for (const name of ['Studios', 'Shows', 'Sessions', 'Moments'])
      expect(screen.getByRole('group', { name })).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'Moments' })).getAllByRole('option'),
    ).toHaveLength(3);
    expect(screen.getByText('Budget Studio')).toBeTruthy();
    expect(screen.getByText('Budget Hour')).toBeTruthy();
    const marks = [...document.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(expect.arrayContaining(['budget', 'Budget']));
  });
});

describe('SearchPalette: choosing a result', () => {
  it('a session goes to /sessions/<id> and closes the palette', async () => {
    renderPalette();
    await openAndType('budget');
    fireEvent.click(screen.getByText('Budget review'));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(memory.history?.at(-1)).toBe('/sessions/sess-1');
  });

  it('the session already open is not pushed again', async () => {
    renderPalette('/sessions/sess-1');
    await openAndType('budget');
    fireEvent.click(screen.getByText('Budget review'));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(memory.history).toEqual(['/sessions/sess-1']);
  });

  it('a transcript moment goes to ?t=, a topic to ?topic=, an event to ?event=', async () => {
    renderPalette();
    await openAndType('budget');
    fireEvent.click(screen.getByText('passed', { exact: false }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(memory.history?.at(-1)).toBe('/sessions/sess-2?t=754.2');

    await openAndType('budget');
    fireEvent.click(screen.getByText('debate', { exact: false }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(memory.history?.at(-1)).toBe('/sessions/sess-2?topic=topic-9');

    await openAndType('budget');
    fireEvent.click(screen.getByText('vote', { exact: false }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(memory.history?.at(-1)).toBe('/sessions/sess-3?event=ev-4');
  });

  it('a show result switches through useSwitchActive with its studio, then goes to /', async () => {
    renderPalette('/search?q=x');
    await openAndType('budget');
    fireEvent.click(screen.getByText('Budget Hour'));
    await waitFor(() => expect(switchActive).toHaveBeenCalledTimes(1));
    expect(switchActive).toHaveBeenCalledWith({ studioId: 'st-other', showId: 'sh-b' });
    const opts = useSwitchActiveMock.mock.calls.at(-1)?.[0];
    expect(opts?.confirmSwitch).toBe(confirmSwitch);
    await waitFor(() => expect(memory.history?.at(-1)).toBe('/'));
  });

  it('a studio result switches through useSwitchActive, then goes to /', async () => {
    renderPalette('/search?q=x');
    await openAndType('budget');
    fireEvent.click(screen.getByText('Budget Studio'));
    await waitFor(() => expect(switchActive).toHaveBeenCalledWith({ studioId: 'st-b' }));
    await waitFor(() => expect(memory.history?.at(-1)).toBe('/'));
  });

  it('a declined or failed switch stays where it is', async () => {
    switchActive.mockResolvedValue(false);
    renderPalette('/search?q=x');
    await openAndType('budget');
    fireEvent.click(screen.getByText('Budget Hour'));
    await waitFor(() => expect(switchActive).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(memory.history).toEqual(['/search?q=x']);
  });

  it('a switch from an open session goes home once (the close-session path navigates)', async () => {
    useSwitchActiveMock.mockImplementation((opts) => ({
      activeStudioId: 'st-1',
      activeShowId: 'sh-1',
      isPending: false,
      switchActive: async (t) => {
        switchActive(t);
        if (t.studioId !== 'st-1') opts.onCloseSession();
        return true;
      },
    }));
    onCloseSession.mockImplementation(() => memory.navigate('/'));
    renderPalette('/sessions/sess-9');
    await openAndType('budget');
    fireEvent.click(screen.getByText('Budget Hour'));
    await waitFor(() => expect(onCloseSession).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(memory.history).toEqual(['/sessions/sess-9', '/']);
  });

  it('"See all results" goes to /search?q=', async () => {
    renderPalette();
    await openAndType('café budget');
    fireEvent.click(screen.getByText(/see all results/i));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(memory.history?.at(-1)).toBe(`/search?q=${encodeURIComponent('café budget')}`);
  });
});

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ApiError } from '../../../../api/client';
import { useProfile } from '../../../../api/hooks/useProfile';
import { useSearch } from '../../../../api/hooks/useSearch';
import type { ProfilePayload, SearchResponse } from '../../../../api/types';
import { renderStrict } from '../../../../test/renderStrict';
import { useSwitchActive } from '../../hooks/useSwitchActive';
import { setNavigationImplForTesting } from '../../navigation';
import { SearchRoute } from './SearchRoute';

// catalog-search task 5.6 (design D9; catalog-search "Command palette and results page"): the
// `/search` page keeps `q` and its studio and show filters in the URL (edits replace the entry),
// asks for groups of 25, and has loading, empty, timeout and busy states.

vi.mock('../../../../api/hooks/useSearch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/hooks/useSearch')>()),
  useSearch: vi.fn(),
}));
vi.mock('../../../../api/hooks/useProfile', () => ({ useProfile: vi.fn() }));
vi.mock('../../hooks/useSwitchActive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useSwitchActive')>()),
  useSwitchActive: vi.fn(),
}));

// Radix Select in jsdom.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}
if (typeof Element !== 'undefined') {
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
}

const useSearchMock = vi.mocked(useSearch);
const switchActive = vi.fn<(t: { studioId: string; showId?: string }) => Promise<boolean>>();
const refetch = vi.fn();

const OPEN = '';
const CLOSE = '';

const PROFILE = {
  active_studio_id: 'st-1',
  active_show_id: 'sh-1',
  studios: [
    { id: 'st-1', name: 'Youtube Studio' },
    { id: 'st-2', name: 'Northlight' },
  ],
  shows: [
    { id: 'sh-1', studio_id: 'st-1', name: 'Autolog Test Show' },
    { id: 'sh-2', studio_id: 'st-2', name: 'Harbour Lights' },
  ],
  auth: {
    logged_in: true,
    user: {
      teams: [
        { id: 'st-1', name: 'Youtube Studio', role: 'owner' },
        { id: 'st-2', name: 'Northlight', role: 'member' },
      ],
    },
  },
} as unknown as ProfilePayload;

const RESULTS: SearchResponse = {
  q: 'budget',
  studios: [],
  shows: [{ id: 'sh-2', name: 'Harbour Lights', studio_id: 'st-2' }],
  sessions: [
    {
      id: 'sess-1',
      title: 'Budget review',
      episode: '',
      show_id: 'sh-1',
      studio_id: 'st-1',
      started_at_utc: '2026-10-01T10:00:00.000Z',
      archived: false,
      match: 'notes',
      snippet: `the ${OPEN}budget${CLOSE} notes`,
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
  ],
  moment_sessions: [{ session_id: 'sess-2', total: 1 }],
};

type SearchState = Partial<{
  data: SearchResponse;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  error: Error | null;
}>;

function mockSearch(state: SearchState) {
  useSearchMock.mockImplementation(
    () =>
      ({
        data: undefined,
        isPending: false,
        isFetching: false,
        isError: false,
        error: null,
        refetch,
        ...state,
      }) as unknown as ReturnType<typeof useSearch>,
  );
}

let memory: ReturnType<typeof memoryLocation>;
const onCloseSession = vi.fn();

function renderRoute(path: string) {
  memory = memoryLocation({ path, record: true });
  setNavigationImplForTesting((p, o) => memory.navigate(p, o));
  return renderStrict(
    <Router hook={memory.hook}>
      <SearchRoute onCloseSession={onCloseSession} confirmSwitch={() => true} />
    </Router>,
  );
}

const lastSearch = () => useSearchMock.mock.calls.at(-1)?.[0];
const urlParams = () => new URLSearchParams((memory.history?.at(-1) ?? '').split('?')[1] ?? '');
const queryBox = () => screen.getByRole('searchbox', { name: /search/i });

beforeEach(() => {
  useSearchMock.mockReset();
  mockSearch({ data: RESULTS });
  refetch.mockReset();
  vi.mocked(useProfile).mockReturnValue({ data: PROFILE } as unknown as ReturnType<
    typeof useProfile
  >);
  switchActive.mockReset();
  switchActive.mockResolvedValue(true);
  vi.mocked(useSwitchActive).mockImplementation(() => ({
    activeStudioId: 'st-1',
    activeShowId: 'sh-1',
    isPending: false,
    switchActive,
  }));
});

afterEach(() => {
  setNavigationImplForTesting(null);
});

describe('SearchRoute: the URL drives the query', () => {
  it('reads q and the filters from the URL and asks for groups of 25', () => {
    renderRoute('/search?q=budget&studio_id=st-1&show_id=sh-1');
    expect((queryBox() as HTMLInputElement).value).toBe('budget');
    expect(lastSearch()).toEqual({ q: 'budget', studioId: 'st-1', showId: 'sh-1', limit: 25 });
    expect(screen.getByRole('combobox', { name: /studio/i }).textContent).toMatch(/Youtube Studio/);
    expect(screen.getByRole('combobox', { name: /show/i }).textContent).toMatch(
      /Autolog Test Show/,
    );
  });

  it('no filters in the URL means none are sent', () => {
    renderRoute('/search?q=budget');
    expect(lastSearch()).toEqual({ q: 'budget', studioId: '', showId: '', limit: 25 });
  });

  it('editing the query replaces the URL entry and searches the new text', async () => {
    renderRoute('/search?q=budget&studio_id=st-1');
    fireEvent.change(queryBox(), { target: { value: 'budget cuts' } });
    expect(memory.history).toHaveLength(1);
    expect(urlParams().get('q')).toBe('budget cuts');
    expect(urlParams().get('studio_id')).toBe('st-1');
    expect((queryBox() as HTMLInputElement).value).toBe('budget cuts');
    await waitFor(() => expect(lastSearch()?.q).toBe('budget cuts'));
  });

  it('choosing a studio replaces the URL, and drops a show from another studio', async () => {
    renderRoute('/search?q=budget&show_id=sh-1');
    const studio = screen.getByRole('combobox', { name: /studio/i });
    fireEvent.keyDown(studio, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'Northlight' }));
    await waitFor(() => expect(urlParams().get('studio_id')).toBe('st-2'));
    expect(urlParams().has('show_id')).toBe(false);
    expect(memory.history).toHaveLength(1);
    await waitFor(() => expect(lastSearch()).toMatchObject({ studioId: 'st-2', showId: '' }));
  });

  it('choosing a show replaces the URL; "All shows" removes the filter', async () => {
    renderRoute('/search?q=budget');
    fireEvent.keyDown(screen.getByRole('combobox', { name: /show/i }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'Harbour Lights' }));
    await waitFor(() => expect(urlParams().get('show_id')).toBe('sh-2'));
    fireEvent.keyDown(screen.getByRole('combobox', { name: /show/i }), { key: 'Enter' });
    fireEvent.click(await screen.findByRole('option', { name: 'All shows' }));
    await waitFor(() => expect(urlParams().has('show_id')).toBe(false));
    expect(memory.history).toHaveLength(1);
  });
});

describe('SearchRoute: states', () => {
  it('a query under 2 characters asks for more', () => {
    mockSearch({});
    renderRoute('/search?q=b');
    expect(screen.getByText(/at least 2 characters/i)).toBeTruthy();
  });

  it('loading', () => {
    mockSearch({ isPending: true, isFetching: true });
    renderRoute('/search?q=budget');
    expect(screen.getByRole('status').textContent).toMatch(/searching/i);
  });

  it('empty', () => {
    mockSearch({
      data: { q: 'zzz', studios: [], shows: [], sessions: [], moments: [], moment_sessions: [] },
    });
    renderRoute('/search?q=zzz');
    expect(screen.getByText(/no results/i)).toBeTruthy();
  });

  it.each([
    ['timeout', 'Search timed out; try a more specific query.'],
    ['busy', 'Search is busy; try again.'],
  ])('%s: shows the server’s message and offers a retry', (_name, detail) => {
    mockSearch({ isError: true, error: new ApiError(503, detail) });
    renderRoute('/search?q=budget');
    expect(screen.getByRole('alert').textContent).toContain(detail);
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('SearchRoute: results', () => {
  it('shows the groups with highlighted snippets', () => {
    renderRoute('/search?q=budget');
    for (const name of ['Shows', 'Sessions', 'Moments'])
      expect(screen.getByRole('region', { name })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Studios' })).toBeNull();
    const moments = screen.getByRole('region', { name: 'Moments' });
    expect(within(moments).getByText('budget').tagName).toBe('MARK');
  });

  it('a session opens /sessions/<id>, a moment its deep link', () => {
    renderRoute('/search?q=budget');
    fireEvent.click(screen.getByRole('button', { name: /budget review/i }));
    expect(memory.history?.at(-1)).toBe('/sessions/sess-1');
    act(() => memory.navigate('/search?q=budget'));
    fireEvent.click(screen.getByRole('button', { name: /town hall/i }));
    expect(memory.history?.at(-1)).toBe('/sessions/sess-2?t=754.2');
  });

  it('a show switches through useSwitchActive with its studio, then opens /', async () => {
    renderRoute('/search?q=budget');
    fireEvent.click(screen.getByRole('button', { name: /harbour lights/i }));
    await waitFor(() =>
      expect(switchActive).toHaveBeenCalledWith({ studioId: 'st-2', showId: 'sh-2' }),
    );
    await waitFor(() => expect(memory.history?.at(-1)).toBe('/'));
  });
});

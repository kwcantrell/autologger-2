import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ApiError } from '../../../../api/client';
import { useProfile } from '../../../../api/hooks/useProfile';
import { useSearch } from '../../../../api/hooks/useSearch';
import type { ProfilePayload, SearchResponse } from '../../../../api/types';
import { renderStrict, StrictWrapper } from '../../../../test/renderStrict';
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
    // Moments sit under their session's title (D11), so the moment is found by its snippet.
    fireEvent.click(screen.getByRole('button', { name: /passed/i }));
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

// catalog-search task 7.3 (design D11.3, D11.4; spec "Grouped moments expand", "Expanding a very
// busy session", "A transcript moment's label"): moments grouped under their session, 3 at first,
// "Show N more in this session" (N = min(total, 25) − shown) fetching that session's moments in
// place, and the 25-cap footer with a link to the session.
describe('SearchRoute: moments grouped by session (D11)', () => {
  type Moment = SearchResponse['moments'][number];
  const tm = (session: string, title: string, n: number, extra: Partial<Moment> = {}): Moment =>
    ({
      kind: 'transcript',
      session_id: session,
      session_title: title,
      show_id: 'sh-1',
      id: String(n),
      sec: 60 * n,
      speaker: '1',
      snippet: `${title} passage ${n}`,
      ...extra,
    }) as Moment;
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);

  const GROUPED: SearchResponse = {
    q: 'divorce',
    studios: [],
    shows: [],
    sessions: [],
    moments: [
      ...range(3).map((i) => tm('sess-a', 'Alpha', i)),
      tm('sess-b', 'Bravo', 0, {
        kind: 'topic',
        id: 'tp-1',
        sec: null,
        speaker: '',
      }),
      ...range(3).map((i) => tm('sess-c', 'Charlie', i)),
    ],
    moment_sessions: [
      { session_id: 'sess-a', total: 12 },
      { session_id: 'sess-b', total: 1 },
      { session_id: 'sess-c', total: 40 },
    ],
  };
  const ONE: Record<string, SearchResponse> = {
    'sess-a': {
      ...GROUPED,
      moments: range(12).map((i) => tm('sess-a', 'Alpha', i)),
      moment_sessions: [{ session_id: 'sess-a', total: 12 }],
    },
    'sess-c': {
      ...GROUPED,
      moments: range(25).map((i) => tm('sess-c', 'Charlie', i)),
      moment_sessions: [{ session_id: 'sess-c', total: 40 }],
    },
  };

  /** The main search answers GROUPED; a session-filtered one answers from ONE (or `session`). */
  function mockGrouped(session: (id: string) => SearchState = (id) => ({ data: ONE[id] })) {
    useSearchMock.mockImplementation(
      (p) =>
        ({
          data: undefined,
          isPending: false,
          isFetching: false,
          isError: false,
          error: null,
          refetch,
          ...(p.sessionId ? session(p.sessionId) : { data: GROUPED }),
        }) as unknown as ReturnType<typeof useSearch>,
    );
  }

  const group = (title: string) =>
    within(screen.getByRole('region', { name: 'Moments' })).getByRole('region', { name: title });
  const items = (title: string) => within(group(title)).getAllByRole('listitem');

  it('groups moments under their session title, 3 at first, with "Show N more" from the totals', () => {
    mockGrouped();
    renderRoute('/search?q=divorce');
    expect(items('Alpha')).toHaveLength(3);
    expect(items('Bravo')).toHaveLength(1);
    expect(items('Charlie')).toHaveLength(3);
    expect(
      within(group('Alpha')).getByRole('button', {
        name: 'Show 9 more in this session',
      }),
    );
    expect(
      within(group('Bravo')).queryByRole('button', {
        name: /more in this session/,
      }),
    ).toBeNull();
    // N counts only what one expansion can show: min(40, 25) − 3.
    expect(
      within(group('Charlie')).getByRole('button', {
        name: 'Show 22 more in this session',
      }),
    );
    expect(useSearchMock.mock.calls.every(([p]) => p.sessionId === undefined)).toBe(true);
  });

  it('Grouped moments expand: fetches session_id with limit 25 and lists them in place; other groups unchanged', () => {
    mockGrouped();
    renderRoute('/search?q=divorce&studio_id=st-1');
    fireEvent.click(
      within(group('Alpha')).getByRole('button', {
        name: 'Show 9 more in this session',
      }),
    );
    expect(useSearchMock).toHaveBeenCalledWith({
      q: 'divorce',
      studioId: 'st-1',
      showId: '',
      sessionId: 'sess-a',
      limit: 25,
    });
    expect(items('Alpha')).toHaveLength(12);
    expect(
      within(group('Alpha')).queryByRole('button', {
        name: /more in this session/,
      }),
    ).toBeNull();
    expect(within(group('Alpha')).queryByText(/matches in this session/)).toBeNull();
    expect(items('Bravo')).toHaveLength(1);
    expect(items('Charlie')).toHaveLength(3);
    expect(
      within(group('Charlie')).getByRole('button', {
        name: 'Show 22 more in this session',
      }),
    );
  });

  it('Expanding a very busy session: 25 listed, "Showing 25 of 40 matches in this session" and a link to it', () => {
    mockGrouped();
    renderRoute('/search?q=divorce');
    fireEvent.click(
      within(group('Charlie')).getByRole('button', {
        name: 'Show 22 more in this session',
      }),
    );
    expect(items('Charlie')).toHaveLength(25);
    expect(
      within(group('Charlie')).getByText('Showing 25 of 40 matches in this session'),
    ).toBeTruthy();
    const link = within(group('Charlie')).getByRole('link', {
      name: /open session/i,
    });
    expect(link.getAttribute('href')).toBe('/sessions/sess-c');
    fireEvent.click(link);
    expect(memory.history?.at(-1)).toBe('/sessions/sess-c');
  });

  it('while the session loads its first moments stay, with a status; an error offers a retry', () => {
    const retry = vi.fn();
    let state: SearchState = { isPending: true, isFetching: true };
    mockGrouped(() => ({ ...state, refetch: retry }));
    const { rerender } = renderRoute('/search?q=divorce');
    fireEvent.click(
      within(group('Alpha')).getByRole('button', {
        name: 'Show 9 more in this session',
      }),
    );
    expect(items('Alpha')).toHaveLength(3);
    expect(within(group('Alpha')).getByRole('status').textContent).toMatch(/loading/i);
    state = {
      isError: true,
      error: new ApiError(503, 'Search is busy; try again.'),
    };
    rerender(
      <StrictWrapper>
        <Router hook={memory.hook}>
          <SearchRoute onCloseSession={onCloseSession} confirmSwitch={() => true} />
        </Router>
      </StrictWrapper>,
    );
    expect(items('Alpha')).toHaveLength(3);
    expect(within(group('Alpha')).getByRole('alert').textContent).toContain('Search is busy');
    fireEvent.click(within(group('Alpha')).getByRole('button', { name: /try again/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('a new query collapses expanded groups', async () => {
    mockGrouped();
    renderRoute('/search?q=divorce');
    fireEvent.click(
      within(group('Alpha')).getByRole('button', {
        name: 'Show 9 more in this session',
      }),
    );
    expect(items('Alpha')).toHaveLength(12);
    fireEvent.change(queryBox(), { target: { value: 'divorced' } });
    await waitFor(() => expect(lastSearch()?.q).toBe('divorced'));
    await waitFor(() => expect(items('Alpha')).toHaveLength(3));
  });

  it('labels: "Speaker n · h:mm:ss", a name as is, empty speaker or null sec left out; topics and events their kind', () => {
    const moments = [
      tm('sess-a', 'Alpha', 0, { speaker: '1', sec: 4323.49 }),
      tm('sess-a', 'Alpha', 1, { speaker: 'Ana', sec: 754.2 }),
      tm('sess-a', 'Alpha', 2, { speaker: '', sec: 5 }),
      tm('sess-b', 'Bravo', 0, { speaker: '2', sec: null }),
      tm('sess-b', 'Bravo', 1, {
        kind: 'topic',
        id: 'tp',
        sec: null,
        speaker: '',
      }),
      tm('sess-b', 'Bravo', 2, {
        kind: 'event',
        id: 'ev',
        sec: null,
        speaker: '',
      }),
    ];
    mockSearch({
      data: {
        ...GROUPED,
        moments,
        moment_sessions: [
          { session_id: 'sess-a', total: 3 },
          { session_id: 'sess-b', total: 3 },
        ],
      },
    });
    renderRoute('/search?q=divorce');
    const labels = [...document.querySelectorAll('[data-slot="moment-label"]')].map(
      (l) => l.textContent,
    );
    expect(labels).toEqual([
      'Speaker 1 · 1:12:03',
      'Ana · 0:12:34',
      '0:00:05',
      'Speaker 2',
      'Topic',
      'Event',
    ]);
  });
});

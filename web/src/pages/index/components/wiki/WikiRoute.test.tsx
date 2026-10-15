import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { ApiError, apiFetch } from '../../../../api/client';
import type {
  ProfilePayload,
  WikiPage,
  WikiPageListItem,
  WikiSuggestion,
} from '../../../../api/types';
import { renderWithQueryClient } from '../../../../test/renderWithQueryClient';
import { setNavigationImplForTesting } from '../../navigation';
import { WikiRoute } from './WikiRoute';

// show-wiki task 5.4 (design D7; show-wiki "Wiki screens"): `/wiki` lists the active show's live
// pages in a tab per kind, filters them by title and alias on the client, has a Deleted view with
// Restore, creates pages through "New page", and asks for a show when none is active. Rendered
// against a real query client seeded with the profile; only the network (`apiFetch`) is mocked.

vi.mock('../../../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/client')>()),
  apiFetch: vi.fn(),
}));

const apiFetchMock = vi.mocked(apiFetch);

const PROFILE = {
  active_studio_id: 'st-1',
  active_show_id: 'sh-1',
  studios: [{ id: 'st-1', name: 'Youtube Studio' }],
  shows: [{ id: 'sh-1', studio_id: 'st-1', name: 'Autolog Test Show', can_access: true }],
  auth: { logged_in: true, user: { teams: [{ id: 'st-1', name: 'Youtube Studio' }] } },
} as unknown as ProfilePayload;

function item(over: Partial<WikiPageListItem> & Pick<WikiPageListItem, 'id' | 'kind' | 'title'>) {
  return {
    aliases: [],
    session_id: null,
    revision: 1,
    updated_at_utc: '2026-10-01T10:00:00.000Z',
    updated_by_name: 'Kai Lee',
    ...over,
  } satisfies WikiPageListItem;
}

const PEOPLE = [
  item({ id: 'p-ana', kind: 'person', title: 'Ana Ruiz', aliases: ['The Mayor'] }),
  item({ id: 'p-bo', kind: 'person', title: 'Bo Chen' }),
];
const TOPICS = [item({ id: 't-budget', kind: 'topic', title: 'Budget' })];
const BITS = [item({ id: 'b-cold', kind: 'bit', title: 'Cold open' })];
const SESSIONS = [item({ id: 's-ep1', kind: 'session', title: 'Episode 1', session_id: 'sess-1' })];
const DELETED = [item({ id: 'p-old', kind: 'person', title: 'Old Guest', revision: 4 })];

function page(over: Partial<WikiPage> & Pick<WikiPage, 'id' | 'kind' | 'title'>): WikiPage {
  return {
    show_id: 'sh-1',
    body_md: '',
    aliases: [],
    session_id: null,
    revision: 1,
    merged_into: null,
    deleted: false,
    created_at_utc: '2026-10-01T10:00:00.000Z',
    created_by_name: 'Kai Lee',
    updated_at_utc: '2026-10-01T10:00:00.000Z',
    updated_by_name: 'Kai Lee',
    ...over,
  };
}

// Pending suggestions the list route answers; empty unless a Suggestions test sets them.
let SUGGESTIONS: WikiSuggestion[] = [];

function suggestion(
  over: Partial<WikiSuggestion> & Pick<WikiSuggestion, 'id' | 'kind' | 'title'>,
): WikiSuggestion {
  return {
    show_id: 'sh-1',
    session_id: 'sess-1',
    status: 'pending',
    page_id: null,
    base_revision: null,
    aliases: [],
    rationale: '',
    page: null,
    stale: false,
    created_at_utc: '2026-10-14T10:00:00.000Z',
    created_by_name: 'Kai Lee',
    resolved_at_utc: null,
    resolved_by_name: null,
    resolved_revision: null,
    ...over,
  };
}

type Handler = (path: string, init?: RequestInit) => unknown;
let onWrite: Handler;

function routeApi() {
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') return onWrite(path, init);
    const url = new URL(path, 'http://x/');
    // show-wiki-ai task 6.4 (D7 category 4): the suggestion reads the Suggestions tab makes.
    if (url.pathname === '/shows/sh-1/wiki/suggestions') {
      return { suggestions: SUGGESTIONS, truncated: false };
    }
    const detail = /^\/wiki\/suggestions\/([^/]+)$/.exec(url.pathname);
    const found = detail && SUGGESTIONS.find((s) => s.id === detail[1]);
    if (found) return { ...found, body_md: 'Suggested body.' };
    if (url.pathname === '/wiki/pages/p-ana') {
      return page({ id: 'p-ana', kind: 'person', title: 'Ana Ruiz', revision: 2 });
    }
    if (url.pathname !== '/shows/sh-1/wiki/pages') throw new Error(`unexpected GET ${path}`);
    if (url.searchParams.get('deleted') === '1') return { pages: DELETED, truncated: false };
    const kind = url.searchParams.get('kind');
    const pages =
      kind === 'person'
        ? PEOPLE
        : kind === 'topic'
          ? TOPICS
          : kind === 'bit'
            ? BITS
            : kind === 'session'
              ? SESSIONS
              : [...PEOPLE, ...TOPICS, ...BITS, ...SESSIONS];
    return { pages, truncated: false };
  });
}

function setup(profile: ProfilePayload = PROFILE, path = '/wiki') {
  const memory = memoryLocation({ path, record: true });
  setNavigationImplForTesting((p, o) => memory.navigate(p, o));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['profile'], profile);
  renderWithQueryClient(
    <Router hook={memory.hook}>
      <WikiRoute />
    </Router>,
    client,
  );
  return { memory, client };
}

function chooseTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
}

function listedTitles(): string[] {
  const list = screen.queryByRole('list', { name: /pages/i });
  if (!list) return [];
  return within(list)
    .queryAllByRole('link')
    .map((a) => a.getAttribute('data-title') ?? '');
}

beforeEach(() => {
  SUGGESTIONS = [];
  apiFetchMock.mockReset();
  onWrite = (path) => {
    throw new Error(`unexpected write ${path}`);
  };
  routeApi();
});

afterEach(() => {
  setNavigationImplForTesting(null);
});

describe('WikiRoute: tabs per kind', () => {
  it('has People, Topics, Running bits and Sessions tabs, plus Deleted; People lists first', async () => {
    setup();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim());
    expect(tabs).toEqual([
      'People',
      'Topics',
      'Running bits',
      'Sessions',
      'Deleted',
      'Suggestions',
    ]);
    await waitFor(() => expect(listedTitles()).toEqual(['Ana Ruiz', 'Bo Chen']));
    expect(apiFetchMock).toHaveBeenCalledWith(
      'shows/sh-1/wiki/pages?kind=person',
      expect.anything(),
    );
  });

  it('each tab lists that kind of page from the active show', async () => {
    setup();
    await waitFor(() => expect(listedTitles()).toEqual(['Ana Ruiz', 'Bo Chen']));
    chooseTab('Topics');
    await waitFor(() => expect(listedTitles()).toEqual(['Budget']));
    chooseTab('Running bits');
    await waitFor(() => expect(listedTitles()).toEqual(['Cold open']));
    chooseTab('Sessions');
    await waitFor(() => expect(listedTitles()).toEqual(['Episode 1']));
  });

  it('a page row links to /wiki/<id> and opens it in place', async () => {
    const { memory } = setup();
    const link = await screen.findByRole('link', { name: /Ana Ruiz/ });
    expect(link.getAttribute('href')).toBe('/wiki/p-ana');
    fireEvent.click(link, { button: 0 });
    expect(memory.history.at(-1)).toBe('/wiki/p-ana');
  });

  it('a tab with no pages says so', async () => {
    TOPICS.length = 0;
    try {
      setup();
      chooseTab('Topics');
      expect(await screen.findByText(/no topics yet/i)).toBeTruthy();
    } finally {
      TOPICS.push(item({ id: 't-budget', kind: 'topic', title: 'Budget' }));
    }
  });
});

describe('WikiRoute: filter', () => {
  it('matches titles and aliases on the client, ignoring case', async () => {
    setup();
    await waitFor(() => expect(listedTitles()).toEqual(['Ana Ruiz', 'Bo Chen']));
    const calls = apiFetchMock.mock.calls.length;
    const filter = screen.getByRole('searchbox', { name: /filter/i });

    fireEvent.change(filter, { target: { value: 'mayor' } });
    expect(listedTitles()).toEqual(['Ana Ruiz']);

    fireEvent.change(filter, { target: { value: 'BO' } });
    expect(listedTitles()).toEqual(['Bo Chen']);

    fireEvent.change(filter, { target: { value: 'nobody' } });
    expect(listedTitles()).toEqual([]);
    expect(screen.getByText(/no pages match/i)).toBeTruthy();

    // Filtering never asks the server again.
    expect(apiFetchMock.mock.calls.length).toBe(calls);
  });
});

describe('WikiRoute: Deleted view', () => {
  it('lists deleted pages with Restore, which restores at the listed revision', async () => {
    setup();
    chooseTab('Deleted');
    await waitFor(() => expect(screen.getByText('Old Guest')).toBeTruthy());
    expect(apiFetchMock).toHaveBeenCalledWith('shows/sh-1/wiki/pages?deleted=1', expect.anything());
    onWrite = vi.fn(async () => page({ id: 'p-old', kind: 'person', title: 'Old Guest' }));
    fireEvent.click(screen.getByRole('button', { name: /restore old guest/i }));
    await waitFor(() =>
      expect(onWrite).toHaveBeenCalledWith(
        'wiki/pages/p-old/restore',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ expected_revision: 4 }),
        }),
      ),
    );
  });

  it('a failed restore names the failure', async () => {
    setup();
    chooseTab('Deleted');
    await screen.findByText('Old Guest');
    onWrite = async () => {
      throw new ApiError(409, 'Title already used.', {
        detail: 'Title already used.',
        page_id: 'p-new',
      });
    };
    fireEvent.click(screen.getByRole('button', { name: /restore old guest/i }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Title already used\./);
  });
});

describe('WikiRoute: New page', () => {
  function openDialog() {
    fireEvent.click(screen.getByRole('button', { name: /new page/i }));
    return screen.getByRole('dialog', { name: /new page/i });
  }

  it('asks for kind and title, creates the page and opens it', async () => {
    const { memory } = setup();
    const dialog = openDialog();
    const kinds = within(dialog).getByRole('radiogroup', { name: /kind/i });
    expect(
      within(kinds)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('aria-label') ?? r.textContent),
    ).toEqual(['Person', 'Topic', 'Running bit']);
    fireEvent.click(within(kinds).getByRole('radio', { name: 'Topic' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: /title/i }), {
      target: { value: '  Parking  ' },
    });
    onWrite = vi.fn(async () => page({ id: 't-parking', kind: 'topic', title: 'Parking' }));
    fireEvent.click(within(dialog).getByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(memory.history.at(-1)).toBe('/wiki/t-parking'));
    expect(onWrite).toHaveBeenCalledWith(
      'shows/sh-1/wiki/pages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ kind: 'topic', title: 'Parking' }),
      }),
    );
  });

  it('starts on the open tab’s kind and needs a title', async () => {
    setup();
    chooseTab('Running bits');
    const dialog = openDialog();
    expect(
      within(dialog).getByRole('radio', { name: 'Running bit' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      within(dialog)
        .getByRole('button', { name: /^create$/i })
        .hasAttribute('disabled'),
    ).toBe(true);
  });

  it('a 409 Title already used names the page that holds the title', async () => {
    const { memory } = setup();
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByRole('textbox', { name: /title/i }), {
      target: { value: 'The Mayor' },
    });
    onWrite = async () => {
      throw new ApiError(409, 'Title already used.', {
        detail: 'Title already used.',
        page_id: 'p-ana',
      });
    };
    fireEvent.click(within(dialog).getByRole('button', { name: /^create$/i }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toMatch(/Title already used\./);
    const open = within(alert).getByRole('link', { name: /open that page/i });
    expect(open.getAttribute('href')).toBe('/wiki/p-ana');
    // The draft stays, and nothing navigated.
    expect(
      (within(dialog).getByRole('textbox', { name: /title/i }) as HTMLInputElement).value,
    ).toBe('The Mayor');
    expect(memory.history).toEqual(['/wiki']);
    act(() => {
      fireEvent.click(open, { button: 0 });
    });
    expect(memory.history.at(-1)).toBe('/wiki/p-ana');
  });
});

describe('WikiRoute: no active show', () => {
  it('asks to choose a show and lists nothing', () => {
    setup({ ...PROFILE, active_show_id: null } as unknown as ProfilePayload);
    expect(screen.getByText(/choose a show/i)).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('button', { name: /new page/i })).toBeNull();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

// show-wiki-ai task 6.4 (design D6; show-wiki "Suggestions inbox"; D7 category 4).
describe('WikiRoute: Suggestions tab', () => {
  const ANA = suggestion({
    id: 'sg-ana',
    kind: 'person',
    title: 'Ana Ruiz',
    page_id: 'p-ana',
    base_revision: 1,
    page: { title: 'Ana Ruiz', revision: 2, state: 'live' },
    stale: true,
    rationale: 'She is the mayor now.',
  });
  const COLD = suggestion({
    id: 'sg-cold',
    kind: 'topic',
    title: 'Cold opens',
    rationale: 'A recurring segment.',
  });

  it('is labelled with the pending count', async () => {
    SUGGESTIONS = [ANA, COLD];
    setup();
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Suggestions/ }).textContent).toMatch(/2/),
    );
    expect(apiFetchMock).toHaveBeenCalledWith('shows/sh-1/wiki/suggestions', expect.anything());
  });

  it('?tab=suggestions opens it on load', async () => {
    SUGGESTIONS = [ANA];
    setup(PROFILE, '/wiki?tab=suggestions');
    const tab = screen.getByRole('tab', { name: /Suggestions/ });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('She is the mayor now.')).toBeTruthy();
  });

  it('scrolls the selected Suggestions tab into view, so a narrow tab row shows it', async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (
      this: Element,
      opts?: boolean | ScrollIntoViewOptions,
    ) {
      expect(opts).toEqual({ block: 'nearest', inline: 'nearest' });
      scrolled.push(this);
    };
    try {
      setup(PROFILE, '/wiki?tab=suggestions');
      const tab = screen.getByRole('tab', { name: /Suggestions/ });
      await waitFor(() => expect(scrolled).toContain(tab));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('groups items by target, names a new page with its kind, and badges a stale one', async () => {
    SUGGESTIONS = [COLD, ANA];
    setup(PROFILE, '/wiki?tab=suggestions');
    const list = await screen.findByRole('list', { name: 'Pending suggestions' });
    const groups = within(list).getAllByRole('region');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual([
      'New page · Topic: Cold opens',
      'Ana Ruiz',
    ]);
    expect(within(groups[1]).getByText('Stale')).toBeTruthy();
    expect(within(groups[0]).queryByText('Stale')).toBeNull();
    expect(within(groups[0]).getByText('A recurring segment.')).toBeTruthy();
    const session = within(groups[0]).getByRole('link', { name: /session/i });
    expect(session.getAttribute('href')).toBe('/sessions/sess-1');
  });

  it('with none pending, says so', async () => {
    setup(PROFILE, '/wiki?tab=suggestions');
    expect(await screen.findByText(/No suggestions waiting/)).toBeTruthy();
  });

  it('choosing an item opens the review sheet', async () => {
    SUGGESTIONS = [ANA];
    setup(PROFILE, '/wiki?tab=suggestions');
    fireEvent.click(await screen.findByRole('button', { name: /Review Ana Ruiz/ }));
    const sheet = await screen.findByRole('dialog');
    expect(await within(sheet).findByText(/changed since this suggestion/)).toBeTruthy();
  });
});

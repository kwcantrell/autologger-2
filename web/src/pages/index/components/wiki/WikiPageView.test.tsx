import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import { useProfile } from '../../../../api/hooks/useProfile';
import type { ProfilePayload, WikiPage } from '../../../../api/types';
import { renderWithQueryClient } from '../../../../test/renderWithQueryClient';
import {
  type FetchCall,
  type Reply,
  stubApi,
  wikiPage,
  writesOf,
} from '../../../../test/wikiFetch';
import { useSwitchActive } from '../../hooks/useSwitchActive';
import { setNavigationImplForTesting } from '../../navigation';
import { WikiPageView } from './WikiPageView';

// show-wiki task 5.5 (design D7; show-wiki "Wiki screens", "Edits are compare-and-set on the
// revision"): the page view renders the body with its aliases and last change, edits through
// Write/Preview tabs with alias chips and a compare-and-set `PUT`, keeps the draft on a
// `409 Version conflict.`, follows a merge with a replace navigation, offers a switch for a page
// of another show, and confirms before a `DELETE` that carries `expected_revision`.

vi.mock('../../../../api/hooks/useProfile', () => ({ useProfile: vi.fn() }));
vi.mock('../../hooks/useSwitchActive', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useSwitchActive')>()),
  useSwitchActive: vi.fn(),
}));

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
} as unknown as ProfilePayload;

const switchActive = vi.fn<(t: { studioId: string; showId?: string }) => Promise<boolean>>();
let memory: ReturnType<typeof memoryLocation>;
let calls: FetchCall[];

/** Serve `page` on GET and answer writes with `onWrite`; a page a write answers is served next. */
function serve(page: WikiPage, onWrite?: (call: FetchCall) => Reply | undefined) {
  let current = page;
  calls = stubApi((call) => {
    if (call.method === 'GET' && call.path === `wiki/pages/${page.id}`) return { json: current };
    const reply = onWrite?.(call);
    if (reply && (reply.status ?? 200) < 300) current = reply.json as WikiPage;
    return reply;
  });
}

function renderView(pageId = 'p1') {
  memory = memoryLocation({ path: `/wiki/${pageId}`, record: true });
  setNavigationImplForTesting((p, o) => memory.navigate(p, o));
  return renderWithQueryClient(
    <Router hook={memory.hook}>
      <WikiPageView pageId={pageId} />
    </Router>,
  );
}

const textBox = () => screen.getByRole('textbox', { name: 'Page text' }) as HTMLTextAreaElement;

async function openEditor() {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  return textBox();
}

beforeEach(() => {
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
  vi.unstubAllGlobals();
});

describe('WikiPageView: reading', () => {
  it('renders the body, the aliases, and who changed the page last and when', async () => {
    serve(wikiPage());
    const { container } = renderView();
    expect(await screen.findByRole('heading', { level: 1, name: 'Christina Ramos' })).toBeTruthy();
    expect(screen.getByText('hosts').tagName).toBe('STRONG');
    expect(screen.getByText('Chris R.')).toBeTruthy();
    expect(screen.getByText(/Ana Ruiz/)).toBeTruthy();
    expect(container.querySelector('time[datetime="2026-10-12T15:30:00.000Z"]')).not.toBeNull();
  });

  it('a deleted page shows as deleted and offers no edit', async () => {
    serve(wikiPage({ deleted: true }));
    renderView();
    expect(await screen.findByText(/This page was deleted/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('a missing page says so', async () => {
    serve(wikiPage({ id: 'other' }));
    renderView('p404');
    expect(await screen.findByText(/Page not found/)).toBeTruthy();
  });
});

describe('WikiPageView: editing', () => {
  it('edit and save sends a PUT with expected_revision, then shows the saved page', async () => {
    serve(wikiPage(), (call) =>
      call.method === 'PUT'
        ? { json: wikiPage({ revision: 4, body_md: 'Christina *produces* now.' }) }
        : undefined,
    );
    renderView();
    const box = await openEditor();
    expect(box.value).toBe('Christina **hosts** the show.');
    fireEvent.change(box, { target: { value: 'Christina *produces* now.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    expect(writesOf(calls)[0]).toEqual({
      method: 'PUT',
      path: 'wiki/pages/p1',
      body: {
        expected_revision: 3,
        title: 'Christina Ramos',
        body_md: 'Christina *produces* now.',
        aliases: ['Chris R.'],
      },
    });
    expect(await screen.findByText('produces')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Page text' })).toBeNull();
  });

  it('Preview renders the draft as Markdown', async () => {
    serve(wikiPage());
    renderView();
    const box = await openEditor();
    fireEvent.change(box, { target: { value: 'A **bold** draft' } });
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Preview' }), { button: 0 });
    expect((await screen.findByText('bold')).tagName).toBe('STRONG');
  });

  it('Edit conflict keeps the draft: a 409 keeps the text and offers the newer page', async () => {
    const theirs = wikiPage({ revision: 4, body_md: 'Their text.', updated_by_name: 'Sam Oh' });
    serve(wikiPage(), (call) =>
      call.method === 'PUT'
        ? call.body && (call.body as { expected_revision: number }).expected_revision === 3
          ? { status: 409, json: { detail: 'Version conflict.', current: theirs } }
          : { json: wikiPage({ revision: 5, body_md: 'Their text.' }) }
        : undefined,
    );
    renderView();
    const box = await openEditor();
    fireEvent.change(box, { target: { value: 'My text.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/Sam Oh/);
    expect(textBox().value).toBe('My text.');

    fireEvent.click(within(banner).getByRole('button', { name: 'Load the newer page' }));
    await waitFor(() => expect(textBox().value).toBe('Their text.'));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(2));
    expect((writesOf(calls)[1].body as { expected_revision: number }).expected_revision).toBe(4);
  });

  it('alias chips add and remove, and the save sends them as aliases', async () => {
    serve(wikiPage(), (call) =>
      call.method === 'PUT' ? { json: wikiPage({ revision: 4, aliases: ['CR'] }) } : undefined,
    );
    renderView();
    await openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Remove alias Chris R.' }));
    const add = screen.getByRole('textbox', { name: 'Add alias' });
    fireEvent.change(add, { target: { value: '  CR ' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Remove alias CR' })).toBeTruthy();
    expect((add as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    expect((writesOf(calls)[0].body as { aliases: string[] }).aliases).toEqual(['CR']);
  });
});

describe('WikiPageView: redirects and other shows', () => {
  it('a merged page replaces the URL with the page it was merged into', async () => {
    serve(wikiPage({ merged_into: 'p2' }));
    renderView();
    await waitFor(() => expect(memory.history).toEqual(['/wiki/p2']));
  });

  it('a page of another show offers to switch to that show', async () => {
    serve(wikiPage({ show_id: 'sh-2' }));
    renderView();
    expect(await screen.findByText(/belongs to Harbour Lights/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Harbour Lights' }));
    await waitFor(() =>
      expect(switchActive).toHaveBeenCalledWith({ studioId: 'st-2', showId: 'sh-2' }),
    );
  });

  it('a page of the active show offers no switch', async () => {
    serve(wikiPage());
    renderView();
    await screen.findByRole('heading', { level: 1, name: 'Christina Ramos' });
    expect(screen.queryByRole('button', { name: /Switch to/ })).toBeNull();
  });
});

describe('WikiPageView: delete', () => {
  it('confirms first, then sends DELETE with expected_revision', async () => {
    serve(wikiPage(), (call) =>
      call.method === 'DELETE' ? { json: wikiPage({ revision: 4, deleted: true }) } : undefined,
    );
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(writesOf(calls)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete page' }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    expect(writesOf(calls)[0]).toMatchObject({
      method: 'DELETE',
      path: 'wiki/pages/p1?expected_revision=3',
    });
    expect(await screen.findByText(/This page was deleted/)).toBeTruthy();
  });

  it('declining the confirmation sends nothing', async () => {
    serve(wikiPage());
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(writesOf(calls)).toHaveLength(0);
  });
});

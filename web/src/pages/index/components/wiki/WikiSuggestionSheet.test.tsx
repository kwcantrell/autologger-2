import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WikiPage, WikiSuggestionDetail } from '../../../../api/types';
import { renderWithQueryClient } from '../../../../test/renderWithQueryClient';
import {
  type FetchCall,
  type Reply,
  stubApi,
  wikiPage,
  writesOf,
} from '../../../../test/wikiFetch';
import { WikiSuggestionSheet } from './WikiSuggestionSheet';

// show-wiki-ai task 6.4 (design D6; show-wiki "Suggestions inbox", scenario "Review a stale
// suggestion"): the review sheet loads the suggestion and its target page, and diffs the
// suggestion against the page's CURRENT revision (a new page against empty), saying so when the
// page changed since the run. Preview renders the body. Accept sends the revision the diff was
// drawn against; "Edit, then accept" opens the page editor prefilled (for a new page, with the
// kind fixed) and accepts with the overrides; Dismiss dismisses. A `409 Version conflict.`
// reloads the page and redraws, keeping edited text. Model-written text renders as text.

function detail(overrides: Partial<WikiSuggestionDetail> = {}): WikiSuggestionDetail {
  return {
    id: 'sg1',
    show_id: 'sh-1',
    session_id: 'sess-a',
    status: 'pending',
    page_id: 'p1',
    base_revision: 3,
    kind: 'person',
    title: 'Christina Ramos',
    aliases: ['Chris R.', 'Tina'],
    rationale: 'She produces the show now.',
    page: { title: 'Christina Ramos', revision: 3, state: 'live' },
    stale: false,
    created_at_utc: '2026-10-14T10:00:00.000Z',
    created_by_name: 'Kai Lee',
    resolved_at_utc: null,
    resolved_by_name: null,
    resolved_revision: null,
    body_md: 'Shared line\nShe **produces** the show.',
    ...overrides,
  };
}

const NEW_PAGE = detail({
  page_id: null,
  base_revision: null,
  page: null,
  kind: 'topic',
  title: 'Cold opens',
  aliases: ['Openers'],
  rationale: 'A recurring segment.',
  body_md: 'Every episode opens cold.\nThen the theme.',
});

let calls: FetchCall[];

/** Serve the suggestion and the page (`pages` in order: each accept 409 moves to the next). */
function serve(
  suggestion: WikiSuggestionDetail,
  pages: WikiPage[] = [wikiPage({ body_md: 'Shared line\nOld line' })],
  onWrite?: (call: FetchCall, page: WikiPage) => Reply | undefined,
) {
  let at = 0;
  calls = stubApi((call) => {
    if (call.method === 'GET' && call.path === `wiki/suggestions/${suggestion.id}`)
      return { json: suggestion };
    if (call.method === 'GET' && call.path === 'wiki/pages/p1') return { json: pages[at] };
    if (call.method === 'POST' && call.path.endsWith('/accept')) {
      const sent = (call.body as { expected_revision?: number }).expected_revision;
      if (suggestion.page_id && sent !== pages[at].revision) {
        return { status: 409, json: { detail: 'Version conflict.', current: pages[at] } };
      }
      const custom = onWrite?.(call, pages[at]);
      if (custom) return custom;
      if (suggestion.page_id && sent === pages[at].revision && at + 1 < pages.length) {
        at += 1;
        return { status: 409, json: { detail: 'Version conflict.', current: pages[at] } };
      }
      return {
        status: suggestion.page_id ? 200 : 201,
        json: {
          page: wikiPage({ revision: (pages[at]?.revision ?? 0) + 1 }),
          suggestion: { ...suggestion, status: 'accepted' },
        },
      };
    }
    if (call.method === 'POST' && call.path.endsWith('/dismiss'))
      return { json: { ...suggestion, status: 'dismissed' } };
    return undefined;
  });
}

const onOpenChange = vi.fn();

function renderSheet(id = 'sg1') {
  return renderWithQueryClient(
    <WikiSuggestionSheet suggestionId={id} open onOpenChange={onOpenChange} />,
  );
}

const diffText = (kind: 'added' | 'removed' | 'same') =>
  // Each line's own text (its last node), without the mark and the screen-reader prefix.
  [...document.querySelectorAll(`[data-diff="${kind}"]`)].map(
    (e) => e.lastChild?.textContent ?? '',
  );

const accepts = () => writesOf(calls).filter((c) => c.path.endsWith('/accept'));

afterEach(() => {
  vi.unstubAllGlobals();
  onOpenChange.mockReset();
});

describe('WikiSuggestionSheet: the diff', () => {
  it('diffs the suggestion against the current revision', async () => {
    serve(detail());
    renderSheet();
    await waitFor(() => expect(diffText('added').length).toBeGreaterThan(0));
    expect(diffText('removed').join('\n')).toContain('Old line');
    expect(diffText('added').join('\n')).toContain('She **produces** the show.');
    expect(diffText('same').join('\n')).toContain('Shared line');
    expect(screen.queryByText(/changed since this suggestion/)).toBeNull();
    // Aliases changed: the page has only "Chris R.".
    expect(screen.getByText(/Aliases now:/)).toBeTruthy();
  });

  it('Review a stale suggestion: says the page changed, diffs against now, and Accept sends that revision', async () => {
    serve(detail({ base_revision: 2, stale: true }));
    renderSheet();
    expect(await screen.findByText(/changed since this suggestion/)).toBeTruthy();
    await waitFor(() => expect(diffText('removed').join('\n')).toContain('Old line'));
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(accepts()).toHaveLength(1));
    expect(accepts()[0]).toEqual({
      method: 'POST',
      path: 'wiki/suggestions/sg1/accept',
      body: { expected_revision: 3 },
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('a new page is diffed against empty: every line is added', async () => {
    serve(NEW_PAGE);
    renderSheet();
    expect(await screen.findByText('New page · Topic')).toBeTruthy();
    await waitFor(() =>
      expect(diffText('added')).toEqual(['Every episode opens cold.', 'Then the theme.']),
    );
    expect(diffText('removed')).toEqual([]);
    expect(calls.some((c) => c.path.startsWith('wiki/pages/'))).toBe(false);
  });

  it('Preview renders the suggested body as Markdown', async () => {
    serve(detail());
    renderSheet();
    const preview = await screen.findByRole('tab', { name: 'Preview' });
    fireEvent.mouseDown(preview, { button: 0 });
    expect((await screen.findByText('produces')).tagName).toBe('STRONG');
  });
});

describe('WikiSuggestionSheet: actions', () => {
  it('Accept on a new page sends no revision', async () => {
    serve(NEW_PAGE);
    renderSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(accepts()).toHaveLength(1));
    expect(accepts()[0].body).toEqual({});
  });

  it('Edit, then accept opens the editor prefilled and accepts with the overrides', async () => {
    serve(detail());
    renderSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit, then accept' }));
    const box = screen.getByRole('textbox', { name: 'Page text' }) as HTMLTextAreaElement;
    expect(box.value).toBe('Shared line\nShe **produces** the show.');
    expect((screen.getByRole('textbox', { name: 'Title' }) as HTMLInputElement).value).toBe(
      'Christina Ramos',
    );
    fireEvent.change(box, { target: { value: 'Shared line\nMy edit.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove alias Tina' }));
    fireEvent.click(screen.getByRole('button', { name: 'Accept with edits' }));
    await waitFor(() => expect(accepts()).toHaveLength(1));
    expect(accepts()[0].body).toEqual({
      expected_revision: 3,
      title: 'Christina Ramos',
      body_md: 'Shared line\nMy edit.',
      aliases: ['Chris R.'],
    });
  });

  it('for a new page, the editor has the kind fixed and the accept sends no revision', async () => {
    serve(NEW_PAGE);
    renderSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit, then accept' }));
    const editor = screen.getByRole('region', { name: 'Edit suggestion' });
    expect(within(editor).getByText('Kind: Topic')).toBeTruthy();
    expect(within(editor).queryByRole('combobox')).toBeNull();
    expect(within(editor).queryByRole('radiogroup')).toBeNull();
    fireEvent.change(within(editor).getByRole('textbox', { name: 'Title' }), {
      target: { value: 'Cold open' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Accept with edits' }));
    await waitFor(() => expect(accepts()).toHaveLength(1));
    expect(accepts()[0].body).toEqual({
      title: 'Cold open',
      body_md: 'Every episode opens cold.\nThen the theme.',
      aliases: ['Openers'],
    });
  });

  it('Dismiss dismisses the suggestion and closes the sheet', async () => {
    serve(detail());
    renderSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() =>
      expect(writesOf(calls)).toEqual([
        { method: 'POST', path: 'wiki/suggestions/sg1/dismiss', body: undefined },
      ]),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe('WikiSuggestionSheet: a 409 on accept', () => {
  const NOW = wikiPage({ body_md: 'Shared line\nOld line' });
  const THEIRS = wikiPage({ revision: 4, body_md: 'Shared line\nTheir line' });

  it('reloads the page and redraws the diff against the newer revision', async () => {
    serve(detail(), [NOW, THEIRS]);
    renderSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText(/changed while you were reviewing/)).toBeTruthy();
    await waitFor(() => expect(diffText('removed').join('\n')).toContain('Their line'));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(accepts()).toHaveLength(2));
    expect(accepts()[1].body).toEqual({ expected_revision: 4 });
  });

  it('keeps the edited text, and the next accept carries it against the newer revision', async () => {
    serve(detail(), [NOW, THEIRS]);
    renderSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit, then accept' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Page text' }), {
      target: { value: 'Shared line\nMy edit.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Accept with edits' }));
    expect(await screen.findByText(/changed while you were reviewing/)).toBeTruthy();
    await waitFor(() => expect(diffText('removed').join('\n')).toContain('Their line'));
    expect((screen.getByRole('textbox', { name: 'Page text' }) as HTMLTextAreaElement).value).toBe(
      'Shared line\nMy edit.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Accept with edits' }));
    await waitFor(() => expect(accepts()).toHaveLength(2));
    expect(accepts()[1].body).toMatchObject({
      expected_revision: 4,
      body_md: 'Shared line\nMy edit.',
    });
  });
});

describe('WikiSuggestionSheet: model-written text renders as text', () => {
  it('a <script> title, rationale and alias show literally', async () => {
    serve(
      detail({
        page_id: null,
        base_revision: null,
        page: null,
        title: '<script>alert(1)</script>',
        rationale: '<img src=x onerror=alert(2)>',
        aliases: ['<b>bold</b>'],
      }),
    );
    renderSheet();
    expect(await screen.findByText('<script>alert(1)</script>')).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=alert(2)>')).toBeTruthy();
    expect(screen.getByText(/<b>bold<\/b>/)).toBeTruthy();
    expect(document.body.querySelector('script, img, b')).toBeNull();
  });
});

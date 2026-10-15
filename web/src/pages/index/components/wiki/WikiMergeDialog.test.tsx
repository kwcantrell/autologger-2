import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';
import type { WikiPageListItem } from '../../../../api/types';
import { renderWithQueryClient } from '../../../../test/renderWithQueryClient';
import { type FetchCall, stubApi, wikiPage, writesOf } from '../../../../test/wikiFetch';
import { setNavigationImplForTesting } from '../../navigation';
import { WikiMergeDialog } from './WikiMergeDialog';

// show-wiki task 5.6 (design D7; show-wiki "Merge and split", "Wiki screens"): "Merge into…"
// picks another live, non-session page of the same show, confirms, then sends the merge with both
// pages' revisions and opens the target in place of the merged page.

beforeAll(() => {
  // cmdk scrolls the active item into view; jsdom has no scrollIntoView.
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

const SOURCE = wikiPage({ id: 'p1', title: 'Chris R.', aliases: [], revision: 3 });

function row(id: string, title: string, kind: WikiPageListItem['kind'], revision = 5) {
  return {
    id,
    kind,
    title,
    aliases: [],
    session_id: kind === 'session' ? 'sess-1' : null,
    revision,
    updated_at_utc: '2026-10-12T15:30:00.000Z',
    updated_by_name: 'Kai Lee',
  } satisfies WikiPageListItem;
}

const LIST = [
  row('p1', 'Chris R.', 'person', 3),
  row('p2', 'Christina Ramos', 'person', 5),
  row('p3', 'Episode 12', 'session'),
  row('p4', 'Budget fights', 'topic'),
];

let calls: FetchCall[];
let memory: ReturnType<typeof memoryLocation>;
const onOpenChange = vi.fn();

function renderDialog() {
  calls = stubApi((call) => {
    if (call.method === 'GET' && call.path === 'shows/sh-1/wiki/pages')
      return { json: { pages: LIST, truncated: false } };
    if (call.method === 'POST' && call.path === 'wiki/pages/p1/merge')
      return { json: { page: wikiPage({ id: 'p2', revision: 6 }) } };
    return undefined;
  });
  memory = memoryLocation({ path: '/wiki/p1', record: true });
  setNavigationImplForTesting((p, o) => memory.navigate(p, o));
  return renderWithQueryClient(
    <Router hook={memory.hook}>
      <WikiMergeDialog page={SOURCE} open onOpenChange={onOpenChange} />
    </Router>,
  );
}

afterEach(() => {
  setNavigationImplForTesting(null);
  vi.unstubAllGlobals();
  onOpenChange.mockReset();
});

describe('WikiMergeDialog', () => {
  it('lists only other live non-session pages of the show', async () => {
    renderDialog();
    expect(calls[0]).toMatchObject({ method: 'GET', path: 'shows/sh-1/wiki/pages' });
    await screen.findByRole('option', { name: /Christina Ramos/ });
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names).toHaveLength(2);
    expect(names.join('|')).toMatch(/Christina Ramos/);
    expect(names.join('|')).toMatch(/Budget fights/);
    expect(names.join('|')).not.toMatch(/Episode 12|Chris R\./);
  });

  it('confirms before sending, then merges with both revisions and opens the target', async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole('option', { name: /Christina Ramos/ }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm.textContent).toMatch(/Chris R\./);
    expect(writesOf(calls)).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    expect(writesOf(calls)[0]).toEqual({
      method: 'POST',
      path: 'wiki/pages/p1/merge',
      body: { into_page_id: 'p2', expected_revision: 3, into_expected_revision: 5 },
    });
    await waitFor(() => expect(memory.history).toEqual(['/wiki/p2']));
  });

  it('declining the confirmation sends nothing', async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole('option', { name: /Budget fights/ }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(writesOf(calls)).toHaveLength(0);
  });

  // Task 5.8 browser check: the confirmation drew over the still-open picker.
  it('the picker steps aside while its confirmation is open, and comes back on Cancel', async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole('option', { name: /Budget fights/ }));
    const confirm = await screen.findByRole('alertdialog');
    // By its text: a picker stacked behind the confirmation is aria-hidden there, not gone.
    await waitFor(() => expect(screen.queryByText(/Choose the page that takes in/)).toBeNull());
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('dialog', { name: 'Merge into…' })).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WikiRevision, WikiRevisionListItem } from '../../../../api/types';
import { renderWithQueryClient } from '../../../../test/renderWithQueryClient';
import { type FetchCall, stubApi, wikiPage, writesOf } from '../../../../test/wikiFetch';
import { WikiHistorySheet } from './WikiHistorySheet';

// show-wiki task 5.6 (design D7; show-wiki "Wiki screens", "Every change appends an immutable
// revision"): History lists revisions newest first and loads older ones from `next_before`, shows
// a line diff of a chosen revision against the current page, and restores it with a compare-and-set
// `PUT` carrying the revision's content and `restored_from`.

const CURRENT = wikiPage({ revision: 3, body_md: 'Shared line\nNew line' });

function item(revision: number, note: string): WikiRevisionListItem {
  return {
    revision,
    title: revision === 1 ? 'Chris Ramos' : 'Christina Ramos',
    kind: 'person',
    author_name: revision === 3 ? 'Ana Ruiz' : 'Kai Lee',
    at_utc: `2026-10-0${revision}T10:00:00.000Z`,
    note,
  };
}

const R1: WikiRevision = {
  ...item(1, 'created'),
  body_md: 'Old line\nShared line',
  aliases: ['Chris'],
};

let calls: FetchCall[];

function serve() {
  calls = stubApi((call) => {
    if (call.method === 'GET' && call.path === 'wiki/pages/p1/revisions')
      return { json: { revisions: [item(3, 'edited'), item(2, 'edited')], next_before: 2 } };
    if (call.method === 'GET' && call.path === 'wiki/pages/p1/revisions?before=2')
      return { json: { revisions: [item(1, 'created')], next_before: null } };
    if (call.method === 'GET' && call.path === 'wiki/pages/p1/revisions/1') return { json: R1 };
    if (call.method === 'PUT')
      return { json: wikiPage({ revision: 4, title: R1.title, body_md: R1.body_md }) };
    return undefined;
  });
}

const onOpenChange = vi.fn();

function renderSheet() {
  return renderWithQueryClient(
    <WikiHistorySheet page={CURRENT} open onOpenChange={onOpenChange} />,
  );
}

const revisionButtons = () =>
  screen
    .getAllByRole('button')
    .map((b) => b.getAttribute('data-revision'))
    .filter((r): r is string => r !== null);

afterEach(() => {
  vi.unstubAllGlobals();
  onOpenChange.mockReset();
});

describe('WikiHistorySheet', () => {
  it('lists revisions newest first, and "Load older" follows next_before', async () => {
    serve();
    renderSheet();
    await screen.findByText('Ana Ruiz');
    expect(revisionButtons()).toEqual(['3', '2']);
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    await waitFor(() => expect(revisionButtons()).toEqual(['3', '2', '1']));
    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
  });

  it('shows a line diff of a chosen revision against the current page', async () => {
    serve();
    const { container } = renderSheet();
    await screen.findByText('Ana Ruiz');
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    fireEvent.click(await screen.findByRole('button', { name: /^r1\b/ }));
    await waitFor(() =>
      expect(container.ownerDocument.querySelector('[data-diff="removed"]')).not.toBeNull(),
    );
    const doc = container.ownerDocument;
    const removed = [...doc.querySelectorAll('[data-diff="removed"]')].map((e) => e.textContent);
    const added = [...doc.querySelectorAll('[data-diff="added"]')].map((e) => e.textContent);
    const same = [...doc.querySelectorAll('[data-diff="same"]')].map((e) => e.textContent);
    expect(removed.join('\n')).toContain('Old line');
    expect(added.join('\n')).toContain('New line');
    expect(same.join('\n')).toContain('Shared line');
  });

  it('restore sends a PUT with the revision content, restored_from and expected_revision', async () => {
    serve();
    renderSheet();
    await screen.findByText('Ana Ruiz');
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    fireEvent.click(await screen.findByRole('button', { name: /^r1\b/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore r1' }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    expect(writesOf(calls)[0]).toEqual({
      method: 'PUT',
      path: 'wiki/pages/p1',
      body: {
        expected_revision: 3,
        title: 'Chris Ramos',
        kind: 'person',
        body_md: 'Old line\nShared line',
        aliases: ['Chris'],
        restored_from: 1,
      },
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('the current revision offers no restore', async () => {
    serve();
    renderSheet();
    fireEvent.click(await screen.findByRole('button', { name: /^r3\b/ }));
    expect(await screen.findByText(/This is the current revision/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull();
  });
});

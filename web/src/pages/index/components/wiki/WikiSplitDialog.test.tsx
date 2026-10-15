import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQueryClient } from '../../../../test/renderWithQueryClient';
import { type FetchCall, stubApi, wikiPage, writesOf } from '../../../../test/wikiFetch';
import { WikiSplitDialog } from './WikiSplitDialog';

// show-wiki task 5.6 (design D7; show-wiki "Merge and split", "Wiki screens"): Split takes the
// text that stays, the text to move, and the new page's kind (person, topic or running bit, never
// session), title and optional aliases, and sends them as `remaining_body_md` and `new_page` with
// the source page's `expected_revision`.

const SOURCE = wikiPage({ kind: 'topic', title: 'Running jokes', body_md: 'Keep\nMove me' });

let calls: FetchCall[];
const onOpenChange = vi.fn();

function renderDialog() {
  calls = stubApi((call) =>
    call.method === 'POST' && call.path === 'wiki/pages/p1/split'
      ? {
          json: {
            page: wikiPage({ revision: 4, body_md: 'Keep' }),
            new_page: wikiPage({ id: 'p9', kind: 'bit', title: 'The kazoo', revision: 1 }),
          },
        }
      : undefined,
  );
  return renderWithQueryClient(<WikiSplitDialog page={SOURCE} open onOpenChange={onOpenChange} />);
}

const box = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;

afterEach(() => {
  vi.unstubAllGlobals();
  onOpenChange.mockReset();
});

describe('WikiSplitDialog', () => {
  it('offers person, topic and running bit as the new kind, never session', () => {
    renderDialog();
    const kinds = screen.getAllByRole('radio').map((r) => r.getAttribute('value'));
    expect(kinds).toEqual(['person', 'topic', 'bit']);
  });

  // Task 5.8 browser check: the kind group was named after its options' labels.
  it('names the kind group "New page kind"', () => {
    renderDialog();
    expect(screen.getByRole('radiogroup', { name: 'New page kind' })).toBeTruthy();
  });

  it('starts with the whole body staying, and needs a title and text to move', () => {
    renderDialog();
    expect(box('Stays on this page').value).toBe('Keep\nMove me');
    expect(box('Moves to the new page').value).toBe('');
    expect((screen.getByRole('button', { name: 'Split' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('sends remaining_body_md and new_page with kind, title, body and aliases', async () => {
    renderDialog();
    fireEvent.change(box('Stays on this page'), { target: { value: 'Keep' } });
    fireEvent.change(box('Moves to the new page'), { target: { value: 'Move me' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Running bit' }));
    fireEvent.change(box('New page title'), { target: { value: '  The kazoo ' } });
    fireEvent.change(box('Aliases'), { target: { value: 'Kazoo bit, , kazoo gag ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split' }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    expect(writesOf(calls)[0]).toEqual({
      method: 'POST',
      path: 'wiki/pages/p1/split',
      body: {
        expected_revision: 3,
        remaining_body_md: 'Keep',
        new_page: {
          kind: 'bit',
          title: 'The kazoo',
          body_md: 'Move me',
          aliases: ['Kazoo bit', 'kazoo gag'],
        },
      },
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('leaves aliases out when none are given, and defaults the kind to the source kind', async () => {
    renderDialog();
    fireEvent.change(box('Moves to the new page'), { target: { value: 'Move me' } });
    fireEvent.change(box('New page title'), { target: { value: 'Another topic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Split' }));
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    const body = writesOf(calls)[0].body as { new_page: Record<string, unknown> };
    expect(body.new_page).toEqual({ kind: 'topic', title: 'Another topic', body_md: 'Move me' });
  });
});

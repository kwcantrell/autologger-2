import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { toast as sonnerToast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WikiSuggestion } from '../../../../api/types';
import { Toast } from '../../../../shared/components/Toast';
import { renderWithQueryClient } from '../../../../test/renderWithQueryClient';
import { stubApi } from '../../../../test/wikiFetch';
import { setNavigationImplForTesting } from '../../navigation';
import { UpdateWikiButton } from './UpdateWikiButton';

// show-wiki-ai task 6.3 (design D6; show-wiki "Suggestions inbox", scenario "Update wiki from the
// session page"): "Update wiki" posts `sessions/:id/wiki/generate`. While the run is in progress
// it reads "Updating wiki…" and can't be pressed again. Success says how many suggestions were
// stored, with a way to the Suggestions tab (`/wiki?tab=suggestions`), or that there were none.
// A 503 explains the language model in Settings → Advanced; other failures show the detail. The
// real toast host renders, so the tests read the toasts the person sees.

function suggestion(id: string): WikiSuggestion {
  return {
    id,
    show_id: 'sh-1',
    session_id: 'sess-a',
    status: 'pending',
    page_id: null,
    base_revision: null,
    kind: 'person',
    title: `Person ${id}`,
    aliases: [],
    rationale: 'Named in the session.',
    page: null,
    stale: false,
    created_at_utc: '2026-10-14T10:00:00.000Z',
    created_by_name: 'Kai Lee',
    resolved_at_utc: null,
    resolved_by_name: null,
    resolved_revision: null,
  };
}

const GENERATE = 'sessions/sess-a/wiki/generate';

function renderButton() {
  return renderWithQueryClient(
    <>
      <UpdateWikiButton sessionId="sess-a" />
      <Toast />
    </>,
  );
}

const button = () => screen.getByRole('button', { name: /Update wiki|Updating wiki…/ });

afterEach(() => {
  act(() => {
    sonnerToast.dismiss();
  });
  vi.unstubAllGlobals();
  setNavigationImplForTesting(null);
});

describe('UpdateWikiButton', () => {
  it('reads "Updating wiki…" and is disabled during the run; a second press sends nothing', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
        await gate;
        return new Response(JSON.stringify({ suggestions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    renderButton();
    expect(button().textContent).toContain('Update wiki');
    fireEvent.click(button());
    await waitFor(() => expect(button().textContent).toContain('Updating wiki…'));
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button());
    expect(calls).toEqual([`POST /api/${GENERATE}`]);
    await act(async () => release());
    await waitFor(() => expect(button().textContent).toContain('Update wiki'));
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });

  it('on success says how many suggestions are ready and links to the Suggestions tab', async () => {
    const calls = stubApi((c) =>
      c.method === 'POST' && c.path === GENERATE
        ? { json: { suggestions: [suggestion('a'), suggestion('b'), suggestion('c')] } }
        : undefined,
    );
    const navigate = vi.fn();
    setNavigationImplForTesting(navigate);
    renderButton();
    fireEvent.click(button());
    expect(await screen.findByText('3 suggestions ready')).toBeTruthy();
    expect(calls).toEqual([{ method: 'POST', path: GENERATE, body: undefined }]);
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(navigate).toHaveBeenCalledWith('/wiki?tab=suggestions', undefined);
  });

  it('one suggestion reads in the singular', async () => {
    stubApi((c) =>
      c.method === 'POST' && c.path === GENERATE
        ? { json: { suggestions: [suggestion('a')] } }
        : undefined,
    );
    renderButton();
    fireEvent.click(button());
    expect(await screen.findByText('1 suggestion ready')).toBeTruthy();
  });

  it('an empty result says so, with no link', async () => {
    stubApi((c) =>
      c.method === 'POST' && c.path === GENERATE ? { json: { suggestions: [] } } : undefined,
    );
    renderButton();
    fireEvent.click(button());
    expect(await screen.findByText('No suggestions this time')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
  });

  it('a 503 explains that a language model is needed in Settings → Advanced', async () => {
    stubApi(() => ({ status: 503, json: { detail: 'Service unavailable' } }));
    renderButton();
    fireEvent.click(button());
    expect(
      await screen.findByText('Add a language model in Settings → Advanced to update the wiki.'),
    ).toBeTruthy();
  });

  it('another failure shows the response detail', async () => {
    stubApi(() => ({ status: 502, json: { detail: 'Wiki update failed.' } }));
    renderButton();
    fireEvent.click(button());
    const shown = await screen.findByText('Wiki update failed.');
    expect(shown.closest('[data-sonner-toast]')?.getAttribute('data-type')).toBe('error');
  });
});

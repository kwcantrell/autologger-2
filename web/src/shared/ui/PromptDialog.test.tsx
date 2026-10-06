import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderStrict } from '../../test/renderStrict';
import { useTextPrompt } from './PromptDialog';

// shadcn-shared-wrappers D3b: themed replacement for `window.prompt`, with
// useConfirm's no-hang guarantee (cancel / Escape / replace / unmount → null).
function Probe({ onResult }: { onResult: (label: string, value: string | null) => void }) {
  const { requestText, promptElement } = useTextPrompt();
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          requestText({ title: 'Import logs', label: 'Sheets URL' }).then((v) =>
            onResult('first', v),
          );
        }}
      >
        open-first
      </button>
      <button
        type="button"
        onClick={() => {
          requestText({ title: 'Second prompt', label: 'Other' }).then((v) =>
            onResult('second', v),
          );
        }}
      >
        open-second
      </button>
      {promptElement}
    </div>
  );
}

function setup() {
  const results: Array<[string, string | null]> = [];
  const utils = renderStrict(<Probe onResult={(label, v) => results.push([label, v])} />);
  return { results, ...utils };
}

describe('useTextPrompt (D3b)', () => {
  it('shows a named dialog with a labelled textbox', () => {
    setup();
    fireEvent.click(screen.getByText('open-first'));
    expect(screen.getByRole('dialog', { name: 'Import logs' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Sheets URL' })).toBeTruthy();
  });

  it('Submit resolves the typed string', async () => {
    const { results } = setup();
    fireEvent.click(screen.getByText('open-first'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Sheets URL' }), {
      target: { value: ' https://x/abc ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(results).toEqual([['first', ' https://x/abc ']]));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Enter in the textbox submits', async () => {
    const { results } = setup();
    fireEvent.click(screen.getByText('open-first'));
    const box = screen.getByRole('textbox', { name: 'Sheets URL' });
    fireEvent.change(box, { target: { value: 'typed' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(results).toEqual([['first', 'typed']]));
  });

  it('Cancel resolves null', async () => {
    const { results } = setup();
    fireEvent.click(screen.getByText('open-first'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(results).toEqual([['first', null]]));
  });

  it('Escape resolves null', async () => {
    const { results } = setup();
    fireEvent.click(screen.getByText('open-first'));
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Import logs' }), { key: 'Escape' });
    await waitFor(() => expect(results).toEqual([['first', null]]));
  });

  it('a replaced pending request resolves null and only the newest dialog stays', async () => {
    const { results } = setup();
    fireEvent.click(screen.getByText('open-first'));
    fireEvent.click(screen.getByText('open-second'));
    await act(async () => {});
    expect(results).toEqual([['first', null]]);
    expect(screen.getByRole('dialog', { name: 'Second prompt' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Import logs' })).toBeNull();
  });

  it('unmounting the owner resolves a pending request null', async () => {
    const { results, unmount } = setup();
    fireEvent.click(screen.getByText('open-first'));
    unmount();
    await act(async () => {});
    expect(results).toEqual([['first', null]]);
  });
});

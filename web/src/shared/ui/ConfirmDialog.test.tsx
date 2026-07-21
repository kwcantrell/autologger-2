import { act, fireEvent, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderStrict } from '../../test/renderStrict';
import { useConfirm } from './ConfirmDialog';

// Dialog (via useIsMobile/breakpoints.ts) reads window.matchMedia, which jsdom
// does not implement. The shared `matchMedia` stub the plan assigns to task
// 3.3 (D12 test infra) doesn't exist yet on this branch, so this test stubs
// it locally rather than reaching ahead into web/src/test/setup.ts — task 3.3
// finding it already present globally later is harmless (this local stub only
// installs when the global is missing).
beforeAll(() => {
  if (typeof window.matchMedia === 'function') return;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

// Probe component exercising the hook's public surface (ui-refresh D2): two
// buttons each fire a confirm() and record its resolved value, so the test can
// assert on resolve-false-on-replace and resolve-false-on-unmount without a
// hand-rolled hook harness.
function Probe({ onResult }: { onResult: (label: string, value: boolean) => void }) {
  const { confirm, confirmElement } = useConfirm();
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          confirm({ title: 'First', message: 'first' }).then((v) => onResult('first', v));
        }}
      >
        open-first
      </button>
      <button
        type="button"
        onClick={() => {
          confirm({ title: 'Second', message: 'second' }).then((v) => onResult('second', v));
        }}
      >
        open-second
      </button>
      {confirmElement}
    </div>
  );
}

describe('useConfirm resolve-false semantics (D2)', () => {
  it('resolves a replaced pending confirmation false, keeping only the newest dialog open', async () => {
    const results: Array<[string, boolean]> = [];
    renderStrict(<Probe onResult={(label, v) => results.push([label, v])} />);

    fireEvent.click(screen.getByText('open-first'));
    fireEvent.click(screen.getByText('open-second'));
    await act(async () => {});

    expect(results).toEqual([['first', false]]);
    expect(screen.getByText('Second')).toBeTruthy();
    expect(screen.queryByText('First')).toBeNull();
  });

  it('resolves a pending confirmation false when the owner unmounts', async () => {
    const results: Array<[string, boolean]> = [];
    const { unmount } = renderStrict(<Probe onResult={(label, v) => results.push([label, v])} />);

    fireEvent.click(screen.getByText('open-first'));
    unmount();
    await act(async () => {});

    expect(results).toEqual([['first', false]]);
  });
});

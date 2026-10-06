import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderStrict } from '../../test/renderStrict';
import { ConfirmDialog, useConfirm } from './ConfirmDialog';

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

// shadcn-shared-wrappers D3: desktop renders an AlertDialog; mobile the shared bottom sheet.
// Every dismissal is a decline.
const baseMatchMedia = () => window.matchMedia;
let savedMatchMedia: typeof window.matchMedia;
function setMobile(matches: boolean) {
  savedMatchMedia ??= baseMatchMedia();
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
afterEach(() => {
  if (savedMatchMedia) window.matchMedia = savedMatchMedia;
});

function DangerProbe({ onResult }: { onResult: (value: boolean) => void }) {
  const { confirm, confirmElement } = useConfirm();
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          confirm({
            title: 'Delete row?',
            message: 'Gone for good.',
            confirmLabel: 'Delete',
            danger: true,
          }).then(onResult);
        }}
      >
        open
      </button>
      {confirmElement}
    </div>
  );
}

describe('ConfirmDialog on desktop (AlertDialog)', () => {
  it('renders an alertdialog named by its title with a destructive confirm action', () => {
    setMobile(false);
    renderStrict(<DangerProbe onResult={() => {}} />);
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByRole('alertdialog', { name: 'Delete row?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' }).getAttribute('data-variant')).toBe(
      'destructive',
    );
  });

  it('Escape declines', async () => {
    setMobile(false);
    const results: boolean[] = [];
    renderStrict(<DangerProbe onResult={(v) => results.push(v)} />);
    fireEvent.click(screen.getByText('open'));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    await waitFor(() => expect(results).toEqual([false]));
  });

  it('an overlay click declines', async () => {
    setMobile(false);
    const results: boolean[] = [];
    renderStrict(<DangerProbe onResult={(v) => results.push(v)} />);
    fireEvent.click(screen.getByText('open'));
    const overlay = document.querySelector('[data-slot="alert-dialog-overlay"]');
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay as Element);
    await waitFor(() => expect(results).toEqual([false]));
  });

  it('the confirm action accepts', async () => {
    setMobile(false);
    const results: boolean[] = [];
    renderStrict(<DangerProbe onResult={(v) => results.push(v)} />);
    fireEvent.click(screen.getByText('open'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(results).toEqual([true]));
  });
});

describe('ConfirmDialog on mobile (bottom sheet)', () => {
  it('renders the sheet dialog, moves focus inside, and Escape declines', async () => {
    setMobile(true);
    const results: boolean[] = [];
    renderStrict(<DangerProbe onResult={(v) => results.push(v)} />);
    fireEvent.click(screen.getByText('open'));
    const sheet = await screen.findByRole('dialog', { name: 'Delete row?' });
    expect(sheet.hasAttribute('data-vaul-drawer')).toBe(true);
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(sheet, { key: 'Escape' });
    await waitFor(() => expect(results).toEqual([false]));
  });
});

describe('ConfirmDialog makes exactly one decision per prompt', () => {
  it.each([
    false,
    true,
  ])('accept calls onConfirm once and never onCancel (mobile=%s)', async (mobile) => {
    setMobile(mobile);
    let confirms = 0;
    let cancels = 0;
    renderStrict(
      <ConfirmDialog
        open
        title="Add synthetic stop?"
        message="m"
        confirmLabel="Add synthetic stop"
        onConfirm={() => {
          confirms += 1;
        }}
        onCancel={() => {
          cancels += 1;
        }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add synthetic stop' }));
    await act(async () => {});
    expect([confirms, cancels]).toEqual([1, 0]);
  });

  it('cancel calls onCancel once (desktop)', async () => {
    setMobile(false);
    let cancels = 0;
    renderStrict(
      <ConfirmDialog
        open
        title="t"
        message="m"
        onConfirm={() => {}}
        onCancel={() => (cancels += 1)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {});
    expect(cancels).toBe(1);
  });
});

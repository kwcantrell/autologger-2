import { act, screen, waitFor } from '@testing-library/react';
import { toast as sonnerToast } from 'sonner';
import { afterEach, describe, expect, it } from 'vitest';
import { renderStrict } from '../../test/renderStrict';
import { hideToast, showToast, Toast, toast } from './Toast';

// shadcn-shared-wrappers D6: the legacy toast API is a facade over sonner. The <Toast/> host
// renders the shared dark Toaster; toasts are sonner's `[data-sonner-toast]` list items.
afterEach(() => {
  act(() => {
    sonnerToast.dismiss();
  });
});

const toastEl = (text: string) =>
  screen.queryByText(text)?.closest('[data-sonner-toast]') as HTMLElement | null;

describe('Toast (sonner facade)', () => {
  it('shows a toast queued before the host mounts', async () => {
    act(() => toast.success('hello from the web vitest tier'));
    renderStrict(<Toast />);
    await waitFor(() => expect(toastEl('hello from the web vitest tier')).not.toBeNull());
  });

  it('error toasts use sonner’s error type', async () => {
    renderStrict(<Toast />);
    act(() => showToast('upload failed', true));
    await waitFor(() => expect(toastEl('upload failed')?.getAttribute('data-type')).toBe('error'));
  });

  it('hideToast dismisses the most recent persistent toast and leaves others', async () => {
    renderStrict(<Toast />);
    act(() => {
      toast.error('unrelated failure A');
      toast.persistent('saving audio A');
    });
    await waitFor(() => expect(toastEl('saving audio A')).not.toBeNull());

    act(() => hideToast());
    await waitFor(() => expect(screen.queryByText('saving audio A')).toBeNull());
    expect(toastEl('unrelated failure A')).not.toBeNull();
  });

  it('hideToast with no persistent toast pending is a no-op', async () => {
    renderStrict(<Toast />);
    act(() => toast.error('unrelated failure B'));
    await waitFor(() => expect(toastEl('unrelated failure B')).not.toBeNull());
    act(() => hideToast());
    expect(toastEl('unrelated failure B')).not.toBeNull();
  });

  it('toast.persistent returns a number that toast.dismiss removes', async () => {
    renderStrict(<Toast />);
    let id = 0;
    act(() => {
      id = toast.persistent('saving audio C');
    });
    expect(typeof id).toBe('number');
    await waitFor(() => expect(toastEl('saving audio C')).not.toBeNull());
    act(() => toast.dismiss(id));
    await waitFor(() => expect(screen.queryByText('saving audio C')).toBeNull());
  });

  it('a persistent toast created after plain toasts is not overwritten (id collision)', async () => {
    renderStrict(<Toast />);
    act(() => {
      showToast('plain one');
      showToast('plain two');
      showToast('Saving Audio...', false, { persistent: true });
      showToast('plain three');
    });
    await waitFor(() => {
      for (const t of ['plain one', 'plain two', 'Saving Audio...', 'plain three']) {
        expect(toastEl(t)).not.toBeNull();
      }
    });
    act(() => hideToast());
    await waitFor(() => expect(screen.queryByText('Saving Audio...')).toBeNull());
    expect(toastEl('plain three')).not.toBeNull();
  });
});

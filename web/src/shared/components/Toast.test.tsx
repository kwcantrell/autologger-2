import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderStrict } from '../../test/renderStrict';
import { hideToast, Toast, toast } from './Toast';

// Trivial proving test for the web vitest tier (design D8, task 2.1): renders a
// real, small existing component through jsdom + the `@/…` path aliases + tsx +
// StrictMode, exercising Toast's effects (listener subscribe/cleanup,
// auto-dismiss timer) under StrictMode's double-invoke. Not a Toast coverage pass.
describe('Toast', () => {
  it('renders a queued message', () => {
    toast.success('hello from the web vitest tier');
    renderStrict(<Toast />);

    const entry = screen.getByText('hello from the web vitest tier');
    expect(entry.textContent).toBe('hello from the web vitest tier');
  });

  // hideToast regression coverage (2026-07-27 review, finding 1.12): it used
  // to clear the ENTIRE queue when no persistent toast existed (wiping
  // unrelated error toasts) and emitted a second time after dismiss.
  it('hideToast dismisses the most recent persistent toast and leaves others', () => {
    toast.error('unrelated failure A');
    toast.persistent('saving audio A');
    renderStrict(<Toast />);
    expect(screen.getByText('saving audio A')).toBeTruthy();

    act(() => hideToast());
    expect(screen.queryByText('saving audio A')).toBeNull();
    expect(screen.getByText('unrelated failure A')).toBeTruthy();
  });

  it('hideToast with no persistent toast pending is a no-op', () => {
    toast.error('unrelated failure B');
    renderStrict(<Toast />);

    act(() => hideToast());
    expect(screen.getByText('unrelated failure B')).toBeTruthy();
  });
});

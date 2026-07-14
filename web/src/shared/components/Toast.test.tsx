import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderStrict } from '../../test/renderStrict';
import { Toast, toast } from './Toast';

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
});

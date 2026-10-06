import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tooltip, TooltipProvider } from './Tooltip';

// shadcn-shared-wrappers D5: Tooltip rides the shadcn Tooltip primitive; opens on keyboard focus
// (web-session-console "Transport tooltips"); `disabled` renders the child bare.
// Radix popper positions via floating-ui, which needs a ResizeObserver jsdom lacks
// (the shared local-stub idiom).
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}

describe('Tooltip', () => {
  it('opens on keyboard focus through the shadcn primitive', async () => {
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip content="Roll timecode">
          <button type="button">Roll</button>
        </Tooltip>
      </TooltipProvider>,
    );
    act(() => {
      screen.getByRole('button', { name: 'Roll' }).focus();
    });
    const tip = await waitFor(() => screen.getByRole('tooltip'));
    expect(tip.textContent).toContain('Roll timecode');
    expect(document.querySelector('[data-slot="tooltip-content"]')).not.toBeNull();
  });

  it('disabled renders the child with no tooltip machinery', () => {
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip content="Hidden" disabled>
          <button type="button">Plain</button>
        </Tooltip>
      </TooltipProvider>,
    );
    act(() => {
      screen.getByRole('button', { name: 'Plain' }).focus();
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.getByRole('button', { name: 'Plain' }).hasAttribute('data-state')).toBe(false);
  });
});

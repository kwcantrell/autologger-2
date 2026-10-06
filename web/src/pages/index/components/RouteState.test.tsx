import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../../../shared/components/ui/button';
import { ROUTE_STATE_PAGE } from './RouteLoadingState';
import { GATE_PAGE, RouteState } from './RouteState';

// shadcn-port-shell D2: the shared panel behind SessionRoute's not-found/error/archived states,
// RootGate's error, and ChunkLoadBoundary's route variant.
describe('RouteState', () => {
  it('renders the given id and role, an <h1> title, the copy, and button actions', () => {
    render(
      <RouteState
        frame="route"
        id="session-route-not-found"
        role="status"
        title="Session not found"
        actions={<Button variant="outline">Back to sessions</Button>}
      >
        There’s no session at this link.
      </RouteState>,
    );
    const panel = screen.getByRole('status');
    expect(panel.id).toBe('session-route-not-found');
    expect(screen.getByRole('heading', { level: 1, name: 'Session not found' })).toBeTruthy();
    expect(panel.textContent).toContain('There’s no session at this link.');
    expect(screen.getByRole('button', { name: 'Back to sessions' })).toBeTruthy();
    // A polite status never also becomes an assertive alert.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('error states are alerts; extra props (test ids) pass through to the panel', () => {
    render(
      <RouteState
        frame="route"
        role="alert"
        title="Couldn't finish loading"
        data-testid="chunk-load-error"
        data-variant="route"
      >
        Reload to try again.
      </RouteState>,
    );
    const panel = screen.getByRole('alert');
    expect(panel.getAttribute('data-testid')).toBe('chunk-load-error');
    expect(panel.getAttribute('data-variant')).toBe('route');
  });

  it('renders an optional badge above the title', () => {
    render(<RouteState frame="route" role="status" title="Archived Ep" badge="Archived session" />);
    expect(screen.getByRole('status').textContent).toMatch(/^Archived session/);
  });

  // The shared page frame is a spec obligation (web-session-routing "Deep-link resolution
  // states": every state renders inside it; it reserves the height, CLS 0.123 → 0.001) that
  // nothing else pins — a deliberate class check.
  it.each([
    ['route', ROUTE_STATE_PAGE],
    ['gate', GATE_PAGE],
  ] as const)('frame="%s" wraps the panel in exactly its page-frame classes', (frame, cls) => {
    render(<RouteState frame={frame} role="alert" title="t" />);
    expect(screen.getByRole('alert').parentElement?.className).toBe(cls);
  });
});

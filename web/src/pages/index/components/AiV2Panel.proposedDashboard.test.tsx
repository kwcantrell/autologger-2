import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithQueryClient } from '../../../test/renderWithQueryClient';
import { AiV2Panel } from './AiV2Panel';
import type { DashboardPersistencePort } from './aiV2/dashboardPersistence';
import type { DashboardConfig } from './aiV2/widgetTypes';

// --- AiV2Panel — the design-turn `dashboard` SSE event (ai-v2-dashboards,
// tasks 5.4/5.5; design D10; spec "Dashboards are edited directly, not only
// by conversation") ---
//
// These tests drive the REAL app wiring: AiV2Panel -> AiV2Design's SSE frame
// loop -> `onDashboardProposed` -> AiV2Panel's canvas, exactly the path a
// live design turn's validated `propose_dashboard` proposal takes (task 5.4
// covers the server-side tool boundary; these cover the client rendering +
// persist-offer named in task 5.5's own test requirement: "a design turn's
// proposal renders end-to-end with no markup path"). The `dashboard` event
// is asserted to reach ONLY this panel's own design-turn stream — there is
// no second WS/client connection anywhere in this file, mirroring how the
// server-side test proves the same property structurally (see
// server/src/routers/aiV2.int.test.ts's propose_dashboard describe block).

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function fakeFetchResponse(chunks: string[]) {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    status: 200,
    ok: true,
    // Task 5.6: AiV2Panel now ALSO fires plain GET requests for its
    // widget-data hooks (transcript-words/topics/events/show-categories),
    // which get this SAME stubbed response (the mock isn't routed by URL) —
    // `apiFetch` reads `res.headers` unconditionally, so a benign
    // content-type header keeps those incidental calls from throwing.
    headers: new Headers({ 'content-type': 'application/json' }),
    body: {
      getReader() {
        return {
          read: async () => {
            if (index >= chunks.length) return { done: true, value: undefined };
            const value = encoder.encode(chunks[index]);
            index += 1;
            return { done: false, value };
          },
          cancel: async () => {},
        };
      },
    },
    json: async () => ({}),
  };
}

function fakePort(initial: DashboardConfig | null = null): DashboardPersistencePort & {
  saves: DashboardConfig[];
} {
  let current = initial;
  const saves: DashboardConfig[] = [];
  return {
    saves,
    async load() {
      return current;
    },
    async save(_sessionId, config) {
      current = config;
      saves.push(config);
    },
  };
}

const PROPOSED_CONFIG: DashboardConfig = {
  widgets: [
    { id: 'w1', type: 'session_duration', title: 'Duration', x: 0, y: 0, w: 4, h: 2 },
    { id: 'w2', type: 'talk_time_by_speaker', title: 'Talk time', x: 4, y: 0, w: 4, h: 2 },
  ],
  interactions: [],
};

function startDesignTurn() {
  const textarea = screen.getByPlaceholderText(/ask for a starting dashboard/i);
  fireEvent.change(textarea, { target: { value: 'Give me an overview' } });
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AiV2Panel — the dashboard SSE event renders a proposal through the real grid', () => {
  it('a valid proposal renders via DashboardGrid (real components) and offers Keep/Discard, without auto-saving', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          fakeFetchResponse([
            sseFrame('dashboard', { config: PROPOSED_CONFIG }),
            sseFrame('done', {}),
          ]) as unknown as Response,
      ),
    );
    const port = fakePort(null);
    renderWithQueryClient(<AiV2Panel sessionId="sess-1" persistence={port} />);

    await screen.findByTestId('aiv2-start-blank'); // initial empty state loaded
    startDesignTurn();

    const banner = await screen.findByTestId('aiv2-dashboard-proposal-banner');
    expect(within(banner).getByTestId('aiv2-dashboard-keep')).toBeTruthy();
    expect(within(banner).getByTestId('aiv2-dashboard-discard')).toBeTruthy();

    // Rendered through the REAL grid component — never a raw-HTML injection
    // of the proposed config. One list item per proposed widget.
    const grid = await screen.findByTestId('aiv2-dashboard-grid');
    expect(within(grid).getAllByRole('listitem')).toHaveLength(PROPOSED_CONFIG.widgets.length);

    // Not auto-saved: the proposal is an offer, not a commit (design D7a).
    expect(port.saves).toHaveLength(0);

    // No edit controls while a proposal is pending — Keep/Discard replace
    // them until the user decides.
    expect(screen.queryByTestId('aiv2-dashboard-edit')).toBeNull();
  });

  it('Keep persists the EXACT validated config and returns to the normal saved-dashboard view', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          fakeFetchResponse([
            sseFrame('dashboard', { config: PROPOSED_CONFIG }),
            sseFrame('done', {}),
          ]) as unknown as Response,
      ),
    );
    const port = fakePort(null);
    renderWithQueryClient(<AiV2Panel sessionId="sess-1" persistence={port} />);

    await screen.findByTestId('aiv2-start-blank');
    startDesignTurn();
    await screen.findByTestId('aiv2-dashboard-proposal-banner');

    fireEvent.click(screen.getByTestId('aiv2-dashboard-keep'));

    await waitFor(() => expect(port.saves).toEqual([PROPOSED_CONFIG]));
    expect(screen.queryByTestId('aiv2-dashboard-proposal-banner')).toBeNull();
    expect(await screen.findByTestId('aiv2-dashboard-edit')).toBeTruthy();
    expect(await screen.findByTestId('aiv2-dashboard-grid')).toBeTruthy();
  });

  it('Discard drops the proposal without ever calling save()', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          fakeFetchResponse([
            sseFrame('dashboard', { config: PROPOSED_CONFIG }),
            sseFrame('done', {}),
          ]) as unknown as Response,
      ),
    );
    const port = fakePort(null);
    renderWithQueryClient(<AiV2Panel sessionId="sess-1" persistence={port} />);

    await screen.findByTestId('aiv2-start-blank');
    startDesignTurn();
    await screen.findByTestId('aiv2-dashboard-proposal-banner');

    fireEvent.click(screen.getByTestId('aiv2-dashboard-discard'));

    expect(screen.queryByTestId('aiv2-dashboard-proposal-banner')).toBeNull();
    expect(screen.queryByTestId('aiv2-dashboard-grid')).toBeNull();
    // No dashboard was ever saved, and a message was already sent (so the
    // canvas shows the "still running" placeholder, not the two entry-point
    // buttons — see AiV2Panel's `hasActivity` branch).
    expect(
      await screen.findByText(/the dashboard renders here once the design turn finishes/i),
    ).toBeTruthy();
    expect(port.saves).toHaveLength(0);
  });

  it('a malformed dashboard frame (no valid widgets) is silently dropped — no proposal appears', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          fakeFetchResponse([
            sseFrame('dashboard', { config: { widgets: [{ type: 'not_a_real_type' }] } }),
            sseFrame('done', {}),
          ]) as unknown as Response,
      ),
    );
    const port = fakePort(null);
    renderWithQueryClient(<AiV2Panel sessionId="sess-1" persistence={port} />);

    await screen.findByTestId('aiv2-start-blank');
    startDesignTurn();

    // Turn completes (done); no dashboard event was usable, so nothing new
    // ever renders and the empty-state placeholder remains — never a
    // fabricated/partial dashboard.
    await waitFor(() => expect(screen.queryByTestId('aiv2-design-messages')).toBeTruthy());
    expect(screen.queryByTestId('aiv2-dashboard-proposal-banner')).toBeNull();
    expect(screen.queryByTestId('aiv2-dashboard-grid')).toBeNull();
    expect(port.saves).toHaveLength(0);
  });
});

import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../test/renderStrict';
import { renderWithQueryClient } from '../../../test/renderWithQueryClient';
import { AiV2Panel } from './AiV2Panel';
import { DashboardGrid } from './aiV2/DashboardGrid';
import { SAMPLE_WIDGET_DATA } from './aiV2/widgetRegistry';

// --- AiV2Panel — preview slot wiring (ai-v2-dashboards, task 4.4) ---
//
// Task 4.1/4.2 left `AiV2Design`'s `renderOptionPreview` prop unfilled (no
// preview rendered at all). This unit fills it with
// `renderCatalogWidgetPreview` (aiV2/widgetRegistry.tsx). These tests drive
// the REAL question round trip (SSE `question` event -> option cards) through
// the actual app wiring (AiV2Panel -> AiV2Design -> QuestionCard), not a
// stand-in, and assert the option preview resolves through the exact same
// `CatalogWidget` component `DashboardGrid` renders — spec "Previews reflect
// the rendered result": preview and rendered widget must agree.

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
    // which fall through this router's `designResponse()` default (below) —
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

// AiV2Panel now defaults its `persistence` prop to the REAL fetch-backed
// `DashboardPersistencePort` (task 5.2) — so mounting it (with no explicit
// `persistence` prop, as these tests deliberately do, to exercise the real
// app wiring) ALSO fires a `GET /ai/v2/dashboard` fetch on mount, before any
// click-driven design-turn fetch. A single `mockResolvedValueOnce` (queued by
// CALL ORDER, not URL) would be consumed by that load call instead of the
// design POST this suite cares about — so this router dispatches by URL
// instead of relying on call order.
function fetchRouter(designResponse: () => Promise<Response>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/ai/v2/dashboard')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ config: null }),
      } as unknown as Response);
    }
    return designResponse();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AiV2Panel — question-option preview resolves through the real CatalogWidget', () => {
  it('renders the talk_time_by_speaker preview via the same component DashboardGrid uses', async () => {
    vi.stubGlobal(
      'fetch',
      fetchRouter(
        async () =>
          fakeFetchResponse([
            sseFrame('question', {
              requestId: 'req-1',
              turnId: 'turn-1',
              questions: [
                {
                  question: 'How should talk time be shown?',
                  header: 'Talk time',
                  multiSelect: false,
                  options: [
                    { label: 'Bars by speaker', widgetType: 'talk_time_by_speaker' },
                    { label: 'Not a catalog type', widgetType: undefined },
                  ],
                },
              ],
            }),
          ]) as unknown as Response,
      ),
    );

    renderWithQueryClient(<AiV2Panel sessionId="sess-1" />);
    const textarea = screen.getByPlaceholderText(/ask for a starting dashboard/i);
    fireEvent.change(textarea, { target: { value: 'Give me an overview' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    const card = await screen.findByTestId('aiv2-question-card');
    // Two option cards each render the (possibly empty) preview-slot
    // wrapper; the first option ("Bars by speaker") is the one with a
    // catalog widgetType.
    const previewSlot = within(card).getAllByTestId('aiv2-option-preview-slot')[0];

    // Resolved through the real CatalogWidget dispatch — same testid the
    // grid's rendering uses for this exact catalog type.
    const previewBody = within(previewSlot).getByTestId('aiv2-widget-talk_time_by_speaker');
    expect(previewBody).toBeTruthy();

    // The option with no catalog widgetType renders an EMPTY preview slot —
    // never a fabricated stand-in (spec: "An option naming no catalog type
    // is rejected rather than resolved by matching its display text").
    const noTypeOption = within(card).getByText('Not a catalog type').closest('button');
    const emptySlot = within(noTypeOption as HTMLElement).getByTestId('aiv2-option-preview-slot');
    expect(emptySlot.childElementCount).toBe(0);

    // Cross-check against DashboardGrid rendering the identical sample data:
    // both must show the same honest speaker labels (never fabricated names).
    renderStrict(
      <DashboardGrid
        widgets={[
          { id: 'w1', type: 'talk_time_by_speaker', title: 'Talk time', x: 0, y: 0, w: 6, h: 2 },
        ]}
        widgetData={{ w1: SAMPLE_WIDGET_DATA.talk_time_by_speaker }}
      />,
    );
    expect(within(previewBody).getByText('Speaker 1')).toBeTruthy();
    expect(screen.getAllByText('Speaker 1').length).toBeGreaterThanOrEqual(2);
  });
});

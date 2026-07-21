import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderStrict } from '../../../../test/renderStrict';
import { DashboardGrid } from './DashboardGrid';
import type { CatalogWidgetData } from './widgetRegistry';
import type { DashboardInteraction, WidgetLayout } from './widgetTypes';

// --- DashboardGrid (ai-v2-dashboards, task 4.3) ---
//
// The grid renderer is driven entirely by the layout DSL (position/size) and
// the named interaction vocabulary from server/src/aiV2/catalog.ts. These
// tests exercise: layout (grid-column/-row derived from x/y/w/h), an unknown
// widget type being skipped rather than crashing, a widget id with no data
// rendering an honest placeholder (never a fabricated widget), and the one
// implemented interaction (`highlight_speaker`) actually driving cross-widget
// behavior — proving the DSL is wired to real behavior, not merely validated
// and ignored.

function talkTimeWidget(id: string, x: number, y: number, w: number, h: number): WidgetLayout {
  return { id, type: 'talk_time_by_speaker', title: 'Talk time', x, y, w, h };
}

function excerptWidget(id: string): WidgetLayout {
  return { id, type: 'transcript_excerpt', title: 'Excerpt', x: 6, y: 0, w: 6, h: 2 };
}

const talkTimeData: CatalogWidgetData = {
  widgetType: 'talk_time_by_speaker',
  talkTimeBySpeaker: {
    available: true,
    reason: null,
    bySpeaker: [
      { speaker: '0', talkTimeSec: 100 },
      { speaker: '1', talkTimeSec: 50 },
    ],
  },
};

const excerptDataFor = (speaker: string): CatalogWidgetData => ({
  widgetType: 'transcript_excerpt',
  transcriptExcerpt: { available: true, reason: null, speaker, text: 'A quote.', timestampSec: 12 },
});

describe('DashboardGrid — layout DSL', () => {
  it('positions a widget via CSS grid-column/-row derived from x/y/w/h', () => {
    const widgets = [talkTimeWidget('w1', 3, 1, 6, 2)];
    renderStrict(<DashboardGrid widgets={widgets} widgetData={{ w1: talkTimeData }} />);
    const card = screen.getByTestId('aiv2-widget-talk_time_by_speaker').closest('li');
    expect(card).not.toBeNull();
    expect((card as HTMLElement).style.gridColumn).toBe('4 / span 6');
    expect((card as HTMLElement).style.gridRow).toBe('2 / span 2');
  });

  it('skips an unrecognized widget type rather than crashing', () => {
    const widgets = [
      {
        id: 'bad',
        type: 'sentiment_series',
        title: 'Bad',
        x: 0,
        y: 0,
        w: 3,
        h: 2,
      } as unknown as WidgetLayout,
      talkTimeWidget('w1', 0, 0, 3, 2),
    ];
    renderStrict(<DashboardGrid widgets={widgets} widgetData={{ w1: talkTimeData }} />);
    expect(screen.getByTestId('aiv2-widget-talk_time_by_speaker')).toBeTruthy();
    expect(screen.queryByText('Bad')).toBeNull();
  });

  it('renders an honest placeholder — never a fabricated widget — when a widget id has no data', () => {
    const widgets = [talkTimeWidget('w1', 0, 0, 3, 2)];
    renderStrict(<DashboardGrid widgets={widgets} widgetData={{}} />);
    expect(screen.getByTestId('aiv2-widget-no-data')).toBeTruthy();
    expect(screen.queryByTestId('aiv2-widget-talk_time_by_speaker')).toBeNull();
  });

  it("renders a placeholder when the supplied data disagrees with the widget's configured type", () => {
    const widgets = [talkTimeWidget('w1', 0, 0, 3, 2)];
    renderStrict(<DashboardGrid widgets={widgets} widgetData={{ w1: excerptDataFor('0') }} />);
    expect(screen.getByTestId('aiv2-widget-no-data')).toBeTruthy();
  });
});

describe('DashboardGrid — highlight_speaker interaction', () => {
  it('dims a non-matching-speaker target when a source speaker is selected', () => {
    const widgets = [talkTimeWidget('source', 0, 0, 6, 3), excerptWidget('target')];
    const interactions: DashboardInteraction[] = [
      { kind: 'highlight_speaker', sourceWidgetId: 'source', targetWidgetId: 'target' },
    ];
    renderStrict(
      <DashboardGrid
        widgets={widgets}
        interactions={interactions}
        widgetData={{ source: talkTimeData, target: excerptDataFor('1') }}
      />,
    );

    const targetBody = screen.getByTestId('aiv2-widget-transcript_excerpt');
    expect(targetBody.className).not.toContain('opacity-40');

    // Select speaker "0" in the source widget — the target (excerpt from
    // speaker "1") should now be visually dimmed.
    const rows = screen.getAllByTestId('aiv2-talk-time-row');
    const speakerZeroRow = rows.find((r) => r.getAttribute('data-speaker') === '0');
    expect(speakerZeroRow).toBeTruthy();
    fireEvent.click(speakerZeroRow as HTMLElement);

    expect(screen.getByTestId('aiv2-widget-transcript_excerpt').className).toContain('opacity-40');
  });

  it('an unconfigured interaction kind (filter_by_topic) never crashes and is inert', () => {
    const widgets = [talkTimeWidget('a', 0, 0, 6, 2), excerptWidget('b')];
    const interactions: DashboardInteraction[] = [
      { kind: 'filter_by_topic', sourceWidgetId: 'a', targetWidgetId: 'b' },
    ];
    renderStrict(
      <DashboardGrid
        widgets={widgets}
        interactions={interactions}
        widgetData={{ a: talkTimeData, b: excerptDataFor('0') }}
      />,
    );
    expect(screen.getByTestId('aiv2-widget-talk_time_by_speaker')).toBeTruthy();
    expect(screen.getByTestId('aiv2-widget-transcript_excerpt')).toBeTruthy();
  });
});

// --- ai-v2-dashboards task 5.3: render-side guard against an absurd stored
// widget count (spec "Dashboard persistence"). The server's write-time
// validation already caps widgets-per-dashboard, but this component has no
// way to know a config it's handed actually passed through that path — this
// proves a maliciously/accidentally oversized `widgets` array does not
// translate into an unbounded number of DOM nodes. ---
describe('DashboardGrid — render-side guard on an absurd widget count (task 5.3)', () => {
  it('caps the number of rendered widgets rather than mapping an unbounded array', () => {
    const ABSURD_COUNT = 5000;
    const widgets = Array.from({ length: ABSURD_COUNT }, (_, i) =>
      talkTimeWidget(`w${i}`, 0, 0, 1, 1),
    );
    const widgetData = Object.fromEntries(widgets.map((w) => [w.id, talkTimeData]));

    const start = Date.now();
    renderStrict(<DashboardGrid widgets={widgets} widgetData={widgetData} />);
    const elapsedMs = Date.now() - start;

    const rendered = screen.getAllByTestId('aiv2-widget-talk_time_by_speaker');
    expect(rendered.length).toBeLessThan(ABSURD_COUNT);
    expect(rendered.length).toBeGreaterThan(0);
    // The gate-intent assertion: this must render in test-suite time, not
    // hang — a genuinely unbounded `.map` over 5000 widgets would be slow
    // enough to make this assertion meaningful, not just decorative.
    expect(elapsedMs).toBeLessThan(5000);

    expect(screen.getByTestId('aiv2-dashboard-truncated').textContent).toContain(
      String(ABSURD_COUNT),
    );
  });

  it('does not show the truncation notice for a normal, in-bounds widget count', () => {
    const widgets = [talkTimeWidget('w1', 0, 0, 6, 2)];
    renderStrict(<DashboardGrid widgets={widgets} widgetData={{ w1: talkTimeData }} />);
    expect(screen.queryByTestId('aiv2-dashboard-truncated')).toBeNull();
  });
});

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

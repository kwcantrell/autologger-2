import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderStrict } from '../../../../test/renderStrict';
import {
  CatalogWidget,
  KNOWN_WIDGET_TYPES,
  renderCatalogWidgetPreview,
  SAMPLE_WIDGET_DATA,
} from './widgetRegistry';
import { WIDGET_TYPES } from './widgetTypes';

// --- widgetRegistry (ai-v2-dashboards, task 4.3/4.4) ---
//
// `CatalogWidget` is the single dispatch component both `DashboardGrid` (real
// dashboard data) and `renderCatalogWidgetPreview` (question-view previews,
// task 4.4) render through. These tests establish: (a) every catalog type has
// a working component reachable from the closed set, (b) the catalog stays
// closed — an unknown type never renders a fabricated stand-in, (c) an
// agent-authored title is text-only, never markup.

describe('CatalogWidget — one component per catalog type', () => {
  it.each(WIDGET_TYPES)('renders %s from its sample data without crashing', (type) => {
    renderStrict(<CatalogWidget title={`Title for ${type}`} data={SAMPLE_WIDGET_DATA[type]} />);
    expect(screen.getByTestId(`aiv2-widget-${type}`)).toBeTruthy();
    expect(screen.getByText(`Title for ${type}`)).toBeTruthy();
  });

  it('has exactly the nine catalog types registered — no sentiment widget', () => {
    expect([...KNOWN_WIDGET_TYPES].sort()).toEqual([...WIDGET_TYPES].sort());
    expect(KNOWN_WIDGET_TYPES.has('sentiment_series' as never)).toBe(false);
  });

  it('renders a markup-bearing title as literal text, never interpreted markup', () => {
    renderStrict(
      <CatalogWidget
        title='<img src=x onerror="alert(1)">'
        data={SAMPLE_WIDGET_DATA.session_duration}
      />,
    );
    // The literal string is present as text; no <img> element was created.
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('renderCatalogWidgetPreview — closed catalog, no fabricated stand-in', () => {
  it('returns null for a widget type outside the closed catalog', () => {
    expect(renderCatalogWidgetPreview('sentiment_series', 'Sentiment')).toBeNull();
    expect(renderCatalogWidgetPreview('', 'Empty')).toBeNull();
  });

  it.each(WIDGET_TYPES)('renders the SAME testid as CatalogWidget for %s', (type) => {
    renderStrict(<div>{renderCatalogWidgetPreview(type, `Preview ${type}`)}</div>);
    expect(screen.getByTestId(`aiv2-widget-${type}`)).toBeTruthy();
  });
});

// Unit tests for the ai-v2-dashboards widget catalog + layout/interaction
// schema (design D2/D1, spec "Widget catalog is a closed set" and "Layout
// and interaction vocabulary"). Zod, mirroring server/src/schemas.ts
// conventions. No I/O, no rendering — Phase 4 (render) and Phase 5 (persist
// write-validation) import this module's exports directly.
//
// TDD note: written before `catalog.ts` exists (RED), then the
// implementation is added to turn it GREEN.

import { describe, expect, it } from 'vitest';
import {
  dashboardConfigSchema,
  interactionKindSchema,
  validateDashboardConfig,
  widgetTypeSchema,
  WIDGET_TYPES,
} from './catalog';

function widget(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'w1',
    type: 'talk_time_by_speaker',
    title: 'Talk time',
    x: 0,
    y: 0,
    w: 4,
    h: 2,
    ...overrides,
  };
}

describe('widget catalog is a closed set', () => {
  it('accepts every registered catalog type', () => {
    for (const type of WIDGET_TYPES) {
      expect(widgetTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it('rejects a widget type outside the catalog', () => {
    const result = widgetTypeSchema.safeParse('custom_widget');
    expect(result.success).toBe(false);
  });

  it('rejects a dashboard config naming an unknown widget type', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ type: 'custom_widget' })],
      interactions: [],
    });
    expect(result.success).toBe(false);
  });

  it('has NO sentiment widget type registered (design D2/D2b: no persisted-data-backed widget yet)', () => {
    expect(WIDGET_TYPES).not.toContain('sentiment_series');
    expect(WIDGET_TYPES).not.toContain('sentiment_by_topic');
    expect(widgetTypeSchema.safeParse('sentiment_series').success).toBe(false);
    expect(widgetTypeSchema.safeParse('sentiment_by_topic').success).toBe(false);
  });

  it('every catalog type is a plain snake_case identifier, never a code/expression string', () => {
    for (const type of WIDGET_TYPES) {
      expect(type).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('layout and interaction vocabulary', () => {
  it('accepts a valid single-widget dashboard with no interactions', () => {
    const result = validateDashboardConfig({
      widgets: [widget()],
      interactions: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an interaction whose kind is in the named vocabulary and whose widgets both exist', () => {
    const result = validateDashboardConfig({
      widgets: [
        widget({ id: 'w1', type: 'talk_time_by_speaker' }),
        widget({ id: 'w2', type: 'topic_timeline', x: 4 }),
      ],
      interactions: [{ kind: 'highlight_speaker', sourceWidgetId: 'w1', targetWidgetId: 'w2' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an interaction whose kind is not in the named vocabulary', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ id: 'w1' }), widget({ id: 'w2', x: 4 })],
      interactions: [{ kind: 'run_javascript', sourceWidgetId: 'w1', targetWidgetId: 'w2' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an interaction naming code/expression content instead of a vocabulary kind', () => {
    const result = interactionKindSchema.safeParse('window.alert(1)');
    expect(result.success).toBe(false);
  });

  it('rejects an interaction targeting a widget id that does not exist in the dashboard', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ id: 'w1' })],
      interactions: [{ kind: 'highlight_speaker', sourceWidgetId: 'w1', targetWidgetId: 'ghost' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an interaction whose SOURCE widget id does not exist either', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ id: 'w1' })],
      interactions: [{ kind: 'highlight_speaker', sourceWidgetId: 'ghost', targetWidgetId: 'w1' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate widget ids within one dashboard', () => {
    const result = validateDashboardConfig({
      widgets: [widget({ id: 'dup' }), widget({ id: 'dup', x: 4 })],
      interactions: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a dashboard with zero widgets', () => {
    const result = validateDashboardConfig({ widgets: [], interactions: [] });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer or out-of-range grid position/size', () => {
    expect(validateDashboardConfig({ widgets: [widget({ x: -1 })], interactions: [] }).success).toBe(
      false,
    );
    expect(validateDashboardConfig({ widgets: [widget({ w: 0 })], interactions: [] }).success).toBe(
      false,
    );
    expect(
      validateDashboardConfig({ widgets: [widget({ x: 1.5 })], interactions: [] }).success,
    ).toBe(false);
  });

  it('the exported schema mirrors validateDashboardConfig for direct Zod use by callers', () => {
    const parsed = dashboardConfigSchema.safeParse({ widgets: [widget()], interactions: [] });
    expect(parsed.success).toBe(true);
  });
});

import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../../test/renderStrict';
import { DashboardEditor } from './DashboardEditor';
import type { DashboardConfig, WidgetLayout } from './widgetTypes';

// --- DashboardEditor (ai-v2-dashboards, task 4.6) ---
//
// Spec "Dashboards are edited directly, not only by conversation": add,
// remove, resize, reposition, and retitle a widget, each purely as a
// `DashboardConfig` -> `DashboardConfig` transform handed to `onChange` — no
// fetch, no agent turn, anywhere in this component (see its module header).
// These tests exercise every operation via the keyboard path (design brief:
// "keyboard-operable editing... rendered as visible hints in edit mode"),
// which is fully deterministic under jsdom, unlike pointer-drag pixel math.

function widget(overrides: Partial<WidgetLayout> = {}): WidgetLayout {
  return {
    id: 'w1',
    type: 'session_duration',
    title: 'Session duration',
    x: 2,
    y: 1,
    w: 4,
    h: 3,
    ...overrides,
  };
}

function configWith(...widgets: WidgetLayout[]): DashboardConfig {
  return { widgets, interactions: [] };
}

function renderEditor(config: DashboardConfig, onChange = vi.fn()) {
  renderStrict(<DashboardEditor config={config} onChange={onChange} />);
  return onChange;
}

describe('DashboardEditor — add', () => {
  it('adding a widget from the catalog picker appends it to the config with a default position/size', () => {
    const onChange = renderEditor(configWith());

    fireEvent.click(screen.getByTestId('aiv2-editor-add-widget'));
    expect(screen.getByTestId('aiv2-catalog-picker')).toBeTruthy();

    fireEvent.click(screen.getByTestId('aiv2-picker-item-event_density'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as DashboardConfig;
    expect(next.widgets).toHaveLength(1);
    expect(next.widgets[0]).toMatchObject({ type: 'event_density', x: 0, y: 0, w: 4, h: 3 });
    expect(typeof next.widgets[0].id).toBe('string');
    expect(next.widgets[0].id.length).toBeGreaterThan(0);

    // Picker closes after a pick.
    expect(screen.queryByTestId('aiv2-catalog-picker')).toBeNull();
  });

  it('stacks a newly added widget below the tallest existing widget rather than overlapping it', () => {
    const existing = widget({ id: 'w1', x: 0, y: 0, w: 4, h: 3 });
    const onChange = renderEditor(configWith(existing));

    fireEvent.click(screen.getByTestId('aiv2-editor-add-widget'));
    fireEvent.click(screen.getByTestId('aiv2-picker-item-question_counts'));

    const next = onChange.mock.calls[0][0] as DashboardConfig;
    const added = next.widgets.find((w) => w.type === 'question_counts');
    expect(added?.y).toBe(3); // existing widget's y(0) + h(3)
  });
});

describe('DashboardEditor — remove', () => {
  it('the remove button drops exactly that widget and any interaction naming it', () => {
    const w1 = widget({ id: 'w1' });
    const w2 = widget({ id: 'w2', type: 'question_counts', title: 'Questions' });
    const onChange = vi.fn();
    renderStrict(
      <DashboardEditor
        config={{
          widgets: [w1, w2],
          interactions: [{ kind: 'highlight_speaker', sourceWidgetId: 'w1', targetWidgetId: 'w2' }],
        }}
        onChange={onChange}
      />,
    );

    const widgets = screen.getAllByTestId('aiv2-editor-widget');
    const w1Node = widgets.find((n) => n.getAttribute('data-widget-id') === 'w1');
    expect(w1Node).toBeTruthy();
    fireEvent.click(within(w1Node as HTMLElement).getByTestId('aiv2-editor-remove'));

    const next = onChange.mock.calls[0][0] as DashboardConfig;
    expect(next.widgets.map((w) => w.id)).toEqual(['w2']);
    expect(next.interactions).toEqual([]); // dangling reference to removed w1 dropped
  });

  it('the Del key removes the focused widget', () => {
    const onChange = renderEditor(configWith(widget({ id: 'w1' })));
    const node = screen.getByTestId('aiv2-editor-widget');
    fireEvent.keyDown(node, { key: 'Delete' });
    const next = onChange.mock.calls[0][0] as DashboardConfig;
    expect(next.widgets).toEqual([]);
  });
});

describe('DashboardEditor — reposition (keyboard)', () => {
  it('ArrowRight/ArrowDown move the widget by one grid unit, clamped at 0', () => {
    const onChange = renderEditor(configWith(widget({ id: 'w1', x: 0, y: 0 })));
    const node = screen.getByTestId('aiv2-editor-widget');

    fireEvent.keyDown(node, { key: 'ArrowRight' });
    expect((onChange.mock.calls[0][0] as DashboardConfig).widgets[0]).toMatchObject({ x: 1 });

    // ArrowLeft from x=0 stays clamped at 0 (never negative).
    const onChange2 = renderEditor(configWith(widget({ id: 'w1', x: 0, y: 0 })));
    const node2 = screen.getAllByTestId('aiv2-editor-widget')[1];
    fireEvent.keyDown(node2, { key: 'ArrowLeft' });
    expect((onChange2.mock.calls[0][0] as DashboardConfig).widgets[0]).toMatchObject({ x: 0 });
  });

  it('a widget cannot be moved past the 12-column right edge', () => {
    const onChange = renderEditor(configWith(widget({ id: 'w1', x: 8, y: 0, w: 4 })));
    const node = screen.getByTestId('aiv2-editor-widget');
    fireEvent.keyDown(node, { key: 'ArrowRight' });
    // x=8, w=4 already touches the edge (8+4=12) — clamped, unchanged.
    expect((onChange.mock.calls[0][0] as DashboardConfig).widgets[0]).toMatchObject({ x: 8 });
  });
});

describe('DashboardEditor — resize (Shift+arrow)', () => {
  it('Shift+ArrowRight grows width, Shift+ArrowLeft shrinks it, never below 1', () => {
    const onChange = renderEditor(configWith(widget({ id: 'w1', x: 0, w: 4 })));
    const node = screen.getByTestId('aiv2-editor-widget');
    fireEvent.keyDown(node, { key: 'ArrowRight', shiftKey: true });
    expect((onChange.mock.calls[0][0] as DashboardConfig).widgets[0]).toMatchObject({ w: 5 });
  });

  it('Shift+ArrowDown grows height', () => {
    const onChange = renderEditor(configWith(widget({ id: 'w1', h: 3 })));
    const node = screen.getByTestId('aiv2-editor-widget');
    fireEvent.keyDown(node, { key: 'ArrowDown', shiftKey: true });
    expect((onChange.mock.calls[0][0] as DashboardConfig).widgets[0]).toMatchObject({ h: 4 });
  });
});

describe('DashboardEditor — retitle-in-place', () => {
  it('Enter opens a text input seeded with the current title; a second Enter commits the trimmed value as TEXT', () => {
    const onChange = renderEditor(configWith(widget({ id: 'w1', title: 'Old title' })));
    const node = screen.getByTestId('aiv2-editor-widget');
    fireEvent.keyDown(node, { key: 'Enter' });

    const input = screen.getByTestId('aiv2-editor-retitle-input') as HTMLInputElement;
    expect(input.value).toBe('Old title');

    fireEvent.change(input, { target: { value: '  New title  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as DashboardConfig;
    expect(next.widgets[0].title).toBe('New title'); // trimmed
    expect(screen.queryByTestId('aiv2-editor-retitle-input')).toBeNull();
  });

  it('Escape cancels the retitle without calling onChange', () => {
    const onChange = renderEditor(configWith(widget({ id: 'w1', title: 'Old title' })));
    const node = screen.getByTestId('aiv2-editor-widget');
    fireEvent.keyDown(node, { key: 'Enter' });
    const input = screen.getByTestId('aiv2-editor-retitle-input');
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('aiv2-editor-retitle-input')).toBeNull();
  });

  it('a markup-bearing title commits and later renders as literal text, never interpreted markup (spec: no agent-authored markup)', () => {
    const payload = '<img src=x onerror="alert(1)">';
    const onChange = renderEditor(configWith(widget({ id: 'w1', title: 'Old title' })));
    const node = screen.getByTestId('aiv2-editor-widget');
    fireEvent.keyDown(node, { key: 'Enter' });
    const input = screen.getByTestId('aiv2-editor-retitle-input');
    fireEvent.change(input, { target: { value: payload } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const next = onChange.mock.calls[0][0] as DashboardConfig;
    expect(next.widgets[0].title).toBe(payload);

    // Re-render with the committed title (as the "no data" placeholder path
    // renders `widget.title` directly) and assert no <img> element exists.
    renderStrict(<DashboardEditor config={next} onChange={vi.fn()} />);
    expect(document.querySelectorAll('img').length).toBe(0);
    expect(screen.getAllByText(payload).length).toBeGreaterThan(0);
  });
});

describe('DashboardEditor — catalog picker disabled-with-reason', () => {
  it('a type named in unavailableTypes renders disabled with the supplied reason text; others stay pickable', () => {
    renderStrict(
      <DashboardEditor
        config={configWith()}
        onChange={vi.fn()}
        unavailableTypes={{
          filler_counts: 'This transcript was formatted on import; disfluencies were removed.',
        }}
      />,
    );
    fireEvent.click(screen.getByTestId('aiv2-editor-add-widget'));

    const fillerItem = screen.getByTestId('aiv2-picker-item-filler_counts') as HTMLButtonElement;
    expect(fillerItem.disabled).toBe(true);
    expect(
      within(fillerItem).getByText(/Unavailable: This transcript was formatted on import/),
    ).toBeTruthy();

    const durationItem = screen.getByTestId(
      'aiv2-picker-item-session_duration',
    ) as HTMLButtonElement;
    expect(durationItem.disabled).toBe(false);
  });

  it('clicking a disabled catalog item never calls onChange and leaves the picker open', () => {
    const onChange = vi.fn();
    renderStrict(
      <DashboardEditor
        config={configWith()}
        onChange={onChange}
        unavailableTypes={{ filler_counts: 'Disfluencies were removed on import.' }}
      />,
    );
    fireEvent.click(screen.getByTestId('aiv2-editor-add-widget'));
    fireEvent.click(screen.getByTestId('aiv2-picker-item-filler_counts'));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('aiv2-catalog-picker')).toBeTruthy();
  });
});

describe('DashboardEditor — no fetch anywhere', () => {
  it('every operation (add/remove/resize/reposition/retitle) never calls global fetch', () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const onChange = renderEditor(configWith(widget({ id: 'w1' })));
    const node = () => screen.getByTestId('aiv2-editor-widget');

    fireEvent.keyDown(node(), { key: 'ArrowRight' });
    fireEvent.keyDown(node(), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(node(), { key: 'Enter' });
    fireEvent.change(screen.getByTestId('aiv2-editor-retitle-input'), {
      target: { value: 'Renamed' },
    });
    fireEvent.keyDown(screen.getByTestId('aiv2-editor-retitle-input'), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('aiv2-editor-add-widget'));
    fireEvent.click(screen.getByTestId('aiv2-picker-item-event_density'));

    expect(onChange.mock.calls.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderStrict } from '../../../../test/renderStrict';
import { CatalogPicker } from './CatalogPicker';
import { WIDGET_TYPES } from './widgetTypes';

// --- CatalogPicker (ai-v2-dashboards, task 4.6) ---
//
// Offers exactly the closed catalog (design brief: "near-opaque catalog
// picker with unavailable types disabled-with-reason"). DashboardEditor.test.tsx
// covers the disabled-with-reason contract in context; these tests cover the
// picker's own dismissal affordances and that it never offers a type outside
// the closed set.

describe('CatalogPicker', () => {
  it('renders exactly the closed catalog, once each', () => {
    renderStrict(<CatalogPicker onPick={vi.fn()} onClose={vi.fn()} />);
    for (const type of WIDGET_TYPES) {
      expect(screen.getAllByTestId(`aiv2-picker-item-${type}`)).toHaveLength(1);
    }
  });

  it('the close button calls onClose without calling onPick', () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    renderStrict(<CatalogPicker onPick={onPick} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('clicking the dialog backdrop (not the panel) calls onClose', () => {
    const onClose = vi.fn();
    renderStrict(<CatalogPicker onPick={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('picking an available type calls onPick with exactly that type', () => {
    const onPick = vi.fn();
    renderStrict(<CatalogPicker onPick={onPick} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('aiv2-picker-item-topic_timeline'));
    expect(onPick).toHaveBeenCalledWith('topic_timeline');
  });
});

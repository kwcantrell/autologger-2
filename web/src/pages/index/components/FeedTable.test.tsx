import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type ColumnDef, FeedTable } from './FeedTable';

// shadcn-port-workspace D3: FeedTable scrolls in the shadcn ScrollArea and renders through the
// Table parts. The virtualizers' contract is the element published through `scrollRef`.
const COLUMNS: ColumnDef[] = [
  { key: 'time', label: 'Time', sortKey: 'time' },
  { key: 'text', label: 'Text' },
];

describe('FeedTable (shadcn-port-workspace D3)', () => {
  it('publishes the scroll viewport element through a callback scrollRef', () => {
    let el: HTMLDivElement | null = null;
    render(
      <FeedTable
        columns={COLUMNS}
        scrollRef={(node) => {
          el = node;
        }}
      >
        <tr>
          <td>row</td>
        </tr>
      </FeedTable>,
    );
    expect(el).not.toBeNull();
    expect((el as unknown as HTMLElement).getAttribute('data-slot')).toBe('scroll-area-viewport');
    // The table lives inside the published scroll element.
    expect((el as unknown as HTMLElement).contains(screen.getByRole('table'))).toBe(true);
  });

  it('scrolls on both axes, like OverlayScrollbars did (a wide table is reachable on phones)', () => {
    render(
      <FeedTable columns={COLUMNS}>
        <tr>
          <td>row</td>
        </tr>
      </FeedTable>,
    );
    const vp = document.querySelector('[data-slot=scroll-area-viewport]') as HTMLElement;
    expect(vp.style.overflowX).toBe('scroll');
    expect(vp.style.overflowY).toBe('scroll');
  });

  it('keeps sortable headers: aria-sort on the sorted column, its button calls onSort', () => {
    const onSort = vi.fn();
    render(
      <FeedTable columns={COLUMNS} sortKey="time" sortDir="desc" onSort={onSort}>
        <tr>
          <td>row</td>
        </tr>
      </FeedTable>,
    );
    const th = screen.getByRole('columnheader', { name: 'Time' });
    expect(th.getAttribute('aria-sort')).toBe('descending');
    expect(th.getAttribute('data-slot')).toBe('table-head');
    fireEvent.click(screen.getByRole('button', { name: 'Time' }));
    expect(onSort).toHaveBeenCalledWith('time');
  });

  it('renders the loading row, then the empty row, never both', () => {
    const { rerender } = render(
      <FeedTable columns={COLUMNS} isLoading isEmpty emptyMessage="Nothing yet">
        {null}
      </FeedTable>,
    );
    expect(screen.getByRole('cell', { name: 'Loading…' }).getAttribute('colspan')).toBe('2');
    expect(screen.queryByText('Nothing yet')).toBeNull();
    rerender(
      <FeedTable columns={COLUMNS} isEmpty emptyMessage="Nothing yet">
        {null}
      </FeedTable>,
    );
    expect(screen.getByRole('cell', { name: 'Nothing yet' })).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});

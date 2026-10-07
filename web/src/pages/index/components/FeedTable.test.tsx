import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { feedCountLabel } from './FeedShell';
import {
  type ColumnDef,
  FEED_CELL,
  FEED_CELL_LABEL,
  FEED_CELL_TEXT,
  FEED_CELL_TIME,
  FEED_INLINE_INPUT,
  FEED_INLINE_INPUT_LABEL,
  FEED_INLINE_INPUT_TC,
  FEED_TC,
  FeedTable,
} from './FeedTable';

describe('feedCountLabel (the Event feed heading pattern, shared)', () => {
  it('reads sentence case with the bare count, singular at 1', () => {
    expect(feedCountLabel(10, 'event')).toBe('10 events');
    expect(feedCountLabel(1, 'event')).toBe('1 event');
    expect(feedCountLabel(0, 'topic')).toBe('0 topics');
    expect(feedCountLabel(1, 'topic')).toBe('1 topic');
    expect(feedCountLabel(2279, 'word')).toBe('2279 words');
  });

  it('marks a capped count with + and keeps it plural', () => {
    expect(feedCountLabel(500, 'event', { capped: true })).toBe('500+ events');
    expect(feedCountLabel(1, 'event', { capped: true })).toBe('1+ events');
  });
});

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

// redesign-show-ignition 11.3 (owner feedback): the Transcript and Topics feeds share these
// strings and must sit on the Show Ignition type system, matching the Event feed rows.
describe('Transcript/Topics row chrome on the Show Ignition type system', () => {
  const classes = (s: string) => s.split(/\s+/);

  // Item e follow-up: the timecode cell IS the Event feed's (one shared string), and the input
  // inherits it rather than restyling itself, so the two feeds cannot drift apart again.
  it('the timecode cell is the Event feed timecode cell: accent, timecode face, tabular figures', () => {
    expect(FEED_CELL_TIME).toBe(FEED_TC);
    expect(classes(FEED_TC)).toEqual(
      expect.arrayContaining([
        'font-[family-name:var(--font-mono)]',
        'text-legacy-accent',
        'whitespace-nowrap',
        'tabular-nums',
      ]),
    );
  });

  it('timecode inputs inherit the cell face and reserve a full HH:MM:SS:FF', () => {
    expect(FEED_INLINE_INPUT_TC).not.toMatch(/font-tc|monospace|text-/);
    expect(classes(FEED_INLINE_INPUT_TC)).toEqual(
      expect.arrayContaining(['tabular-nums', 'min-w-[calc(11ch+0.6rem+2px)]']),
    );
  });

  it('the speaker input reserves a full "Person 10" so the phone column never clips it', () => {
    expect(classes(FEED_INLINE_INPUT_LABEL)).toContain('min-w-[calc(9ch+0.6rem+2px)]');
  });

  it('cells carry no colour of their own (the muted grey lost to the accent), body text is the Event feed message colour', () => {
    expect(FEED_CELL).not.toMatch(/text-legacy-muted/);
    expect(classes(FEED_CELL)).toContain('text-[0.78rem]');
    expect(classes(FEED_CELL_TEXT)).toContain('text-(--color-text)');
    expect(classes(FEED_CELL_LABEL)).toEqual(
      expect.arrayContaining(['text-(--color-text)', 'font-semibold']),
    );
  });

  it('inputs take the Event feed size and the accent, with no V5 cyan', () => {
    expect(FEED_INLINE_INPUT).not.toMatch(/56,189,248/);
    expect(FEED_INLINE_INPUT).not.toMatch(/text-\[0\.8rem\]/);
  });
});

// Finish review fix round 3: at 390 the Transcript and Topics sheets were capped at 70dvh AND
// their scroll viewports were capped at 70dvh, so the viewport ran the feed header's height
// (~62px) past the card's bottom edge (the sheet's overflow is visible). The Event feed's
// pattern is the bound for all three: the sheet sizes to header + viewport, and only the
// viewport carries the phone cap, so every row stays inside the card.
describe('phone feed bounds (fix round 3)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = (f: string) => fs.readFileSync(path.join(here, f), 'utf8');

  it.each([
    'TranscribeFeed.tsx',
    'TopicsFeed.tsx',
  ])('%s does not cap its sheet on phones (the viewport carries the cap)', (file) => {
    const modifier = src(file).match(/modifier="([^"]*)"/)?.[1] ?? '';
    expect(modifier).toMatch(/min-h-0/);
    expect(modifier).not.toMatch(/max-md:max-h-/);
  });

  it('the shared scroll viewport carries the 70dvh phone cap', () => {
    expect(src('FeedTable.tsx')).toMatch(/viewportClassName="[^"]*max-md:max-h-\[70dvh\]/);
  });
});

import clsx from 'clsx';
import type { ReactNode, Ref } from 'react';
import { ScrollArea } from '../../../shared/components/ui/scroll-area';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../shared/components/ui/table';

// The sticky feed header chrome and the sort-button reset are the shadcn `TableHead` base
// (shadcn-port-workspace D1). Text-align is NOT set there — the standalone feeds pass
// `text-left` per column; the Event Feed passes `text-center` — so only one alignment utility
// lands on each <th> (no order collision).
// Sort glyphs: the sorted header's button gets a ' ↑'/' ↓' `::after` (leading space
// preserved via Tailwind's `_`→space conversion in the arbitrary content value).
const FEED_TH_SORT_ASC = "[&_button]:after:content-['_↑'] [&_button]:after:text-v5-primary";
const FEED_TH_SORT_DESC = "[&_button]:after:content-['_↓'] [&_button]:after:text-v5-primary";
// Empty-state cell. Anchored via table specificity in legacy; as a utility it wins by layer.
const FEED_EMPTY =
  'px-4 py-[1.35rem] text-center text-[0.85rem] not-italic text-v5-muted border border-solid border-v5-border rounded-v5-md bg-[rgba(0,0,0,0.22)]';

// Shared row/cell/input chrome for Transcribe + Topics feeds (was FeedTable.module.css).

/** Feed body row — unguarded hover tint. */
export const FEED_ROW = 'hover-always:bg-[rgba(255,255,255,0.03)]';
/** Feed body cell. `vertical-align` is intentionally NOT set here — callers add
 *  `align-middle` (Transcribe) or `align-top` (Topics tall-summary rows) so the two
 *  don't collide on one element (generated-order, not class-order, decides). No colour here:
 *  each cell takes exactly one of FEED_TC / FEED_CELL_TEXT / FEED_CELL_LABEL (11.3 item e: a
 *  muted default here beat the timecode cell's accent in generated order, greying the timecodes
 *  and the body text alike). */
export const FEED_CELL =
  'px-[0.4rem] py-[0.1rem] text-[0.78rem] [border-bottom:1px_solid_rgba(255,255,255,0.04)]';
/** The timecode cell face, shared with the Event feed's timecode cell (EventLogRow `CELL_TC`):
 *  accent, the timecode face, tabular figures, never wrapping. */
export const FEED_TC =
  'font-[family-name:var(--font-mono)] text-legacy-accent whitespace-nowrap tabular-nums';
/** Time column (Transcript/Topics) — the Event feed's timecode cell. */
export const FEED_CELL_TIME = FEED_TC;
/** Body text (word, summary, numbers): the Event feed message cell's colour and regular weight. */
export const FEED_CELL_TEXT = 'text-(--color-text)';
/** Label column (speaker): the Event feed's Event-column weight, in the foreground. */
export const FEED_CELL_LABEL = 'text-(--color-text) font-semibold';
/** Inline editable input: inherits the cell's face, size, weight and colour (the Event feed's
 *  0.78rem), so the cell class alone decides the typography. */
export const FEED_INLINE_INPUT =
  'w-full px-[0.3rem] py-[0.18rem] bg-transparent border border-solid border-transparent rounded-[3px] text-inherit [font-family:inherit] [font-size:inherit] [font-weight:inherit] [font-style:inherit] [line-height:inherit] focus:border-[color-mix(in_oklab,var(--si-accent)_55%,transparent)] focus:bg-[color-mix(in_oklab,var(--si-accent)_8%,transparent)] [&[type=number]]:[-moz-appearance:textfield] [&[type=number]::-webkit-inner-spin-button]:appearance-none [&[type=number]::-webkit-inner-spin-button]:m-0 [&[type=number]::-webkit-outer-spin-button]:appearance-none [&[type=number]::-webkit-outer-spin-button]:m-0';
/** Timecode input (composes with FEED_INLINE_INPUT inside a FEED_TC cell): the face comes from
 *  the cell; the minimum width is a full HH:MM:SS:FF (11ch of the inherited timecode face) plus
 *  the input's padding and border, so the auto-layout column can never clip the frames. */
export const FEED_INLINE_INPUT_TC = 'tabular-nums min-w-[calc(11ch+0.6rem+2px)]';
/** Speaker input (composes with FEED_INLINE_INPUT inside a FEED_CELL_LABEL cell): a minimum of
 *  "Person 10" in the inherited semibold face plus padding and border, so the phone layout's
 *  auto-sized column never clips the label. */
export const FEED_INLINE_INPUT_LABEL = 'min-w-[calc(9ch+0.6rem+2px)]';
/** Numeric inputs (Topics duration/level): body text with tabular figures. */
export const FEED_INLINE_INPUT_NUM = 'tabular-nums';
/** Auto-growing wrapping summary textarea (Topics). Composes with FEED_INLINE_INPUT. */
export const FEED_SUMMARY_TEXTAREA =
  'block box-border min-h-[1.6rem] resize-none overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere] leading-[1.35]';

export interface ColumnDef {
  key: string;
  /** Visible header text. Ignored when ariaLabel is set. */
  label: string;
  /** When set, the <th> renders a sort button that calls onSort(sortKey). */
  sortKey?: string;
  /** Utility class string for the per-column <th> width, supplied by the parent. */
  thClassName?: string;
  /** Replaces label for screen readers; use for visually hidden columns (e.g. actions). */
  ariaLabel?: string;
}

interface Props {
  columns: ColumnDef[];
  isLoading?: boolean;
  isEmpty?: boolean;
  emptyMessage?: ReactNode;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  onSort?: (sortKey: string) => void;
  children: ReactNode;
  /** Extra classes added to <table> (e.g. "sheet sheet-dense" for EventLogSheet compat). */
  tableClassName?: string;
  /** Optional <colgroup> for column width constraints. */
  colgroup?: ReactNode;
  /** Receives the scroll viewport element (the virtualizers' scroll element). */
  scrollRef?: Ref<HTMLDivElement>;
}

export function FeedTable({
  columns,
  isLoading,
  isEmpty,
  emptyMessage,
  sortKey,
  sortDir,
  onSort,
  children,
  tableClassName,
  colgroup,
  scrollRef,
}: Props) {
  const colSpan = columns.length;

  return (
    // shadcn ScrollArea (shadcn-port-workspace D3). The viewport is the scroll element the
    // virtualizers read (`scrollRef` -> `viewportRef`: a callback ref fires on mount, a ref object
    // is filled). Box sizing: flex-basis 0 so the feed scrolls internally; on phones the root
    // sizes to content and the 70dvh cap sits on the VIEWPORT (a percentage height would not
    // resolve against a max-height-capped auto root — the viewport would never scroll). The
    // `.v5-transcribe-feed`/`.v5-topics-feed` panel wrappers carry the matching flex-column
    // layout via ancestor variants in TranscribeFeed/TopicsFeed.
    <ScrollArea
      className="min-h-0 flex-[1_1_0] max-md:flex-[0_0_auto]"
      viewportClassName="max-md:h-auto max-md:max-h-[70dvh]"
      viewportRef={scrollRef}
      // Both axes, as OverlayScrollbars had: on phones the table is wider than the viewport.
      scrollbars="both"
    >
      <Table className={tableClassName}>
        {colgroup}
        <TableHeader>
          <TableRow>
            {columns.map((col) => {
              const isSorted = col.sortKey && sortKey === col.sortKey;
              return (
                <TableHead
                  key={col.key}
                  className={clsx(
                    col.thClassName,
                    isSorted && (sortDir === 'asc' ? FEED_TH_SORT_ASC : FEED_TH_SORT_DESC),
                  )}
                  aria-label={col.ariaLabel}
                  aria-sort={
                    isSorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined
                  }
                >
                  {col.sortKey ? (
                    <button type="button" onClick={() => onSort?.(col.sortKey ?? '')}>
                      {col.ariaLabel ? null : col.label}
                    </button>
                  ) : col.ariaLabel ? null : (
                    col.label
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={colSpan} className={FEED_EMPTY}>
                Loading…
              </TableCell>
            </TableRow>
          )}
          {!isLoading && isEmpty && (
            <TableRow>
              <TableCell colSpan={colSpan} className={FEED_EMPTY}>
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
          {!isLoading && !isEmpty && children}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

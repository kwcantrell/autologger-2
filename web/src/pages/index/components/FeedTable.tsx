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
 *  don't collide on one element (generated-order, not class-order, decides). Default
 *  grey mirrors Event Feed's internal-row `color: var(--color-legacy-muted)`. */
export const FEED_CELL =
  'px-[0.4rem] py-[0.1rem] [border-bottom:1px_solid_rgba(255,255,255,0.04)] text-legacy-muted';
/** Time column — blue monospaced, mirrors `.sheet .tc`. */
export const FEED_CELL_TIME =
  'font-[family-name:var(--font-mono)] text-legacy-accent whitespace-nowrap';
/** Inline editable input. `mono` variant swaps the family to `monospace` (was
 *  `.feedInlineInput:global(.mono)` → `var(--mono-font, monospace)`, undefined var →
 *  `monospace`); pass `FEED_INLINE_INPUT_MONO` alongside for those cells. */
export const FEED_INLINE_INPUT =
  'w-full px-[0.3rem] py-[0.18rem] bg-transparent border border-solid border-transparent rounded-[3px] text-inherit [font-family:inherit] [font-weight:inherit] [font-style:inherit] [line-height:inherit] text-[0.8rem] focus:border-[rgba(56,189,248,0.5)] focus:bg-[rgba(56,189,248,0.06)] [&[type=number]]:[-moz-appearance:textfield] [&[type=number]::-webkit-inner-spin-button]:appearance-none [&[type=number]::-webkit-inner-spin-button]:m-0 [&[type=number]::-webkit-outer-spin-button]:appearance-none [&[type=number]::-webkit-outer-spin-button]:m-0';
export const FEED_INLINE_INPUT_MONO = '[font-family:monospace]';
/** Auto-growing wrapping summary textarea (Topics). Composes with FEED_INLINE_INPUT. */
export const FEED_SUMMARY_TEXTAREA =
  'block box-border min-h-[1.6rem] resize-none overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere] leading-[1.35]';

// Glass toolbar buttons (Edit / Save / Cancel / dropdown triggers / Auto Generate /
// Insert), rendered by EventLogSheet, TranscribeFeed, TopicsFeed.
/** Base glass button. Hover is exclusive of :disabled (was `:hover:not(:disabled)`). */
// max-md:px-4 (ui-refresh): with five top-level tabs the toolbar trio
// (Edit / Time Display / Filter) was clipping at the right edge on phones.
export const FEED_GLASS_BTN =
  'box-border inline-flex items-center justify-center px-6 py-[0.55rem] font-[family-name:"Inter",var(--font-poppins),ui-sans-serif,system-ui,sans-serif] text-[0.72rem] font-semibold tracking-[0.1em] uppercase rounded-v5-sm border border-solid border-v5-border [background:linear-gradient(165deg,rgba(255,255,255,0.08),rgba(15,23,42,0.45))] text-[rgba(248,250,252,0.92)] cursor-pointer [box-shadow:inset_0_1px_0_rgba(255,255,255,0.06)] [transition:border-color_0.15s_ease,background_0.15s_ease,box-shadow_0.15s_ease,opacity_0.15s_ease] not-disabled:hover-always:border-[color-mix(in_srgb,var(--v5-primary)_45%,var(--v5-border))] not-disabled:hover-always:[background:linear-gradient(165deg,rgba(255,255,255,0.1),rgba(15,23,42,0.5))] disabled:opacity-45 disabled:cursor-not-allowed max-md:min-h-[2.55rem] max-md:min-w-[2.55rem] max-md:px-2.5 max-md:tracking-normal';
/** Primary glass button — sky accent border/bg/text + exclusive hover. Layer it after
 *  FEED_GLASS_BTN; the accent utilities replace the base border/bg/text. */
export const FEED_GLASS_BTN_PRIMARY =
  'border-[rgba(56,189,248,0.35)] [background:linear-gradient(165deg,rgba(56,189,248,0.16),rgba(15,23,42,0.5))] text-v5-primary not-disabled:hover-always:[background:linear-gradient(165deg,rgba(56,189,248,0.24),rgba(15,23,42,0.52))]';

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

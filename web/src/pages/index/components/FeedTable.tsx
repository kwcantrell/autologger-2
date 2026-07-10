import clsx from 'clsx';
import type { OverlayScrollbars } from 'overlayscrollbars';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import type { MutableRefObject, ReactNode, Ref } from 'react';
import { useCallback } from 'react';

// Sticky feed header cell. Matches Transcribe/Topics' legacy `.feedTh`. Text-align is
// NOT set here — the standalone feeds pass `text-left` per column; the Event Feed passes
// `text-center` (its legacy `.sheet th` centered headers, still in @layer legacy through
// this slice) so only one alignment utility lands on each <th> (no order collision).
const FEED_TH =
  'sticky top-0 z-[1] px-[0.55rem] py-[0.38rem] text-[0.84rem] font-semibold tracking-[0.05em] uppercase whitespace-nowrap bg-surface-raised [border-bottom:1px_solid_var(--border)] text-muted';
// Sort glyphs: the sorted header's button gets a ' ↑'/' ↓' `::after` (leading space
// preserved via Tailwind's `_`→space conversion in the arbitrary content value).
const FEED_TH_SORT_ASC = "[&_button]:after:content-['_↑'] [&_button]:after:text-v5-primary";
const FEED_TH_SORT_DESC = "[&_button]:after:content-['_↓'] [&_button]:after:text-v5-primary";
// Header sort button reset + hover. `font: inherit` doesn't cover letter-spacing (not part
// of the font shorthand) and native buttons reset it to `normal`, so restore the inherited
// tracking explicitly (was `letter-spacing: inherit` in the legacy `.feedTh button` reset).
const FEED_TH_BUTTON =
  '[&_button]:appearance-none [&_button]:bg-transparent [&_button]:border-none [&_button]:text-inherit [&_button]:[font:inherit] [&_button]:[letter-spacing:inherit] [&_button]:cursor-pointer [&_button]:p-0 [&_button]:text-left [&_button]:w-full [&_button]:hover-always:text-v5-primary';
// Empty-state cell. Anchored via table specificity in legacy; as a utility it wins by layer.
const FEED_EMPTY =
  'px-4 py-[1.35rem] text-center text-[0.85rem] not-italic text-v5-muted border border-solid border-v5-border rounded-v5-md bg-[rgba(0,0,0,0.22)]';

// Shared row/cell/input chrome for Transcribe + Topics feeds (was FeedTable.module.css).

/** Feed body row — unguarded hover tint. */
export const FEED_ROW = 'hover-always:bg-[rgba(255,255,255,0.03)]';
/** Feed body cell. `vertical-align` is intentionally NOT set here — callers add
 *  `align-middle` (Transcribe) or `align-top` (Topics tall-summary rows) so the two
 *  don't collide on one element (generated-order, not class-order, decides). Default
 *  grey mirrors Event Feed's internal-row `color: var(--muted)`. */
export const FEED_CELL =
  'px-[0.4rem] py-[0.1rem] [border-bottom:1px_solid_rgba(255,255,255,0.04)] text-muted';
/** Time column — blue monospaced, mirrors `.sheet .tc`. */
export const FEED_CELL_TIME = 'font-[family-name:var(--mono)] text-accent whitespace-nowrap';
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
export const FEED_GLASS_BTN =
  'box-border px-6 py-[0.55rem] font-[family-name:"Inter",var(--font-poppins),ui-sans-serif,system-ui,sans-serif] text-[0.72rem] font-semibold tracking-[0.1em] uppercase rounded-v5-sm border border-solid border-v5-border [background:linear-gradient(165deg,rgba(255,255,255,0.08),rgba(15,23,42,0.45))] text-[rgba(248,250,252,0.92)] cursor-pointer [box-shadow:inset_0_1px_0_rgba(255,255,255,0.06)] [transition:border-color_0.15s_ease,background_0.15s_ease,box-shadow_0.15s_ease,opacity_0.15s_ease] not-disabled:hover-always:border-[color-mix(in_srgb,var(--v5-primary)_45%,var(--v5-border))] not-disabled:hover-always:[background:linear-gradient(165deg,rgba(255,255,255,0.1),rgba(15,23,42,0.5))] disabled:opacity-45 disabled:cursor-not-allowed';
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
  /** Ref forwarded to the scrollable wrapper div (used by virtualizers). */
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

  /* OverlayScrollbars creates its own scroll viewport inside the host element;
   * publish that viewport to scrollRef so TranscribeFeed's react-virtual call
   * (getScrollElement: () => scrollRef.current) continues to work. */
  const handleOsInit = useCallback(
    (instance: OverlayScrollbars) => {
      if (!scrollRef) return;
      const viewport = instance.elements().viewport as HTMLDivElement;
      if (typeof scrollRef === 'function') scrollRef(viewport);
      else (scrollRef as MutableRefObject<HTMLDivElement | null>).current = viewport;
    },
    [scrollRef],
  );

  return (
    // OverlayScrollbars host element. Native overflow/scrollbar styling is owned by
    // the library — we only set box sizing (flex-basis:0 so the feed scrolls
    // internally; phone-first max-height cap so a long feed scrolls rather than
    // burying the end of the stacked page). The `.v5-transcribe-feed`/`.v5-topics-feed`
    // panel wrappers carry the matching flex-column layout via ancestor variants in
    // TranscribeFeed/TopicsFeed.
    <OverlayScrollbarsComponent
      className="min-h-0 flex-[1_1_0] max-md:flex-[0_0_auto] max-md:max-h-[70dvh]"
      defer
      options={{
        scrollbars: {
          theme: 'os-theme-light',
          autoHide: 'leave',
          autoHideDelay: 250,
        },
      }}
      events={{ initialized: handleOsInit }}
    >
      <table className={clsx('w-full border-collapse text-[0.84rem]', tableClassName)}>
        {colgroup}
        <thead>
          <tr>
            {columns.map((col) => {
              const isSorted = col.sortKey && sortKey === col.sortKey;
              const thCls = clsx(
                FEED_TH,
                FEED_TH_BUTTON,
                col.thClassName,
                isSorted && (sortDir === 'asc' ? FEED_TH_SORT_ASC : FEED_TH_SORT_DESC),
              );
              return (
                <th
                  key={col.key}
                  className={thCls}
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
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {isLoading && (
            <tr>
              <td colSpan={colSpan} className={FEED_EMPTY}>
                Loading…
              </td>
            </tr>
          )}
          {!isLoading && isEmpty && (
            <tr>
              <td colSpan={colSpan} className={FEED_EMPTY}>
                {emptyMessage}
              </td>
            </tr>
          )}
          {!isLoading && !isEmpty && children}
        </tbody>
      </table>
    </OverlayScrollbarsComponent>
  );
}

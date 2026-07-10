import clsx from 'clsx';
import type { OverlayScrollbars } from 'overlayscrollbars';
import { OverlayScrollbarsComponent } from 'overlayscrollbars-react';
import type { MutableRefObject, ReactNode, Ref } from 'react';
import { useCallback } from 'react';
import styles from './FeedTable.module.css';

export interface ColumnDef {
  key: string;
  /** Visible header text. Ignored when ariaLabel is set. */
  label: string;
  /** When set, the <th> renders a sort button that calls onSort(sortKey). */
  sortKey?: string;
  /** Camel-case key into FeedTable.module.css for the per-column TH width
   *  (e.g. `"Time"` → `styles.feedThTime`). */
  thModifier?: keyof typeof styles;
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
    <OverlayScrollbarsComponent
      className={styles.feedTableWrap}
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
      <table className={clsx(styles.feedTable, tableClassName)}>
        {colgroup}
        <thead>
          <tr>
            {columns.map((col) => {
              const isSorted = col.sortKey && sortKey === col.sortKey;
              const thCls = clsx(
                styles.feedTh,
                col.thModifier && styles[col.thModifier],
                isSorted && (sortDir === 'asc' ? styles.sortAsc : styles.sortDesc),
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
              <td colSpan={colSpan} className={styles.feedEmpty}>
                Loading…
              </td>
            </tr>
          )}
          {!isLoading && isEmpty && (
            <tr>
              <td colSpan={colSpan} className={styles.feedEmpty}>
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

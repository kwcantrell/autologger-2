import type { ReactNode } from 'react';

interface Props {
  countLabel: string;
  headerId?: string;
  feedAriaLabel?: string;
  toolbar: ReactNode;
  toolbarAriaLabel?: string;
  /** Extra modifier class appended to `.v4-log-sheet` (e.g. `"v5-transcribe-feed"`). */
  modifier?: string;
  /** When set, wraps the sheet in a `div.v4-log-bottom` with this id. */
  logBottomId?: string;
  sheetId?: string;
  /** Rendered after `children`, inside the sheet div (e.g. hidden CSS-compat inputs). */
  after?: ReactNode;
  children: ReactNode;
}

export function FeedShell({
  countLabel,
  headerId,
  feedAriaLabel,
  toolbar,
  toolbarAriaLabel,
  modifier,
  logBottomId,
  sheetId,
  after,
  children,
}: Props) {
  const sheetCls = ['v4-log-sheet', 'v5-event-feed', modifier].filter(Boolean).join(' ');

  const sheet = (
    <div className={sheetCls} id={sheetId}>
      <div className="v5-event-feed-top">
        <div className="v5-event-feed-top__titles">
          <header className="v5-event-feed-head v5-panel-head__main">
            <h2
              className="v5-panel-main-title v5-panel-main-title--numeric"
              id={headerId}
              role="status"
              aria-label={feedAriaLabel}
            >
              {countLabel}
            </h2>
          </header>
        </div>
        <div className="v5-event-feed-toolbar" role="toolbar" aria-label={toolbarAriaLabel}>
          {toolbar}
        </div>
      </div>
      {children}
      {after}
    </div>
  );

  if (logBottomId) {
    return (
      <div className="v4-log-bottom" id={logBottomId}>
        {sheet}
      </div>
    );
  }

  return sheet;
}

import clsx from 'clsx';
import type { ReactNode } from 'react';

// FeedShell chrome (was `:global(...)` rules in EventLogSheet.module.css + the feed-targeting
// `:global(...)` overrides extracted from SessionWorkspace.module.css). The global class
// strings (`v4-log-sheet`, `v5-event-feed*`, `v4-log-bottom`, `v5-panel-main-title*`) STAY —
// they remain hooks for SessionWorkspace's non-feed rules and perfDebug. The utilities are
// added alongside. `#v4-log-session`-scoped rules become `[#v4-log-session_&]:` ancestor
// variants (the id keeps being emitted by SessionWorkspace).

// `.v4-log-bottom` — the wrapper (Event Feed only, via logBottomId).
const LOG_BOTTOM = 'w-full gap-5 overflow-x-visible items-stretch';

// Shared feed-sheet chrome (hooks + open glass). Exported so Assistant /
// Dashboards can wear the same surface as Event Feed / Transcript / Topics —
// including the `.v5FeedTabsPanel` tab-join rules that target these classes.
export const FEED_SHEET_CLASS = clsx(
  'v4-log-sheet v5-event-feed',
  // Feed-only open glass (more transparent than panel strong/regular glass).
  'flex-[1_1_auto] min-w-0 flex flex-col glass-face-feed border border-solid border-v5-border rounded-v5-lg [box-shadow:var(--v5-panel-elevate)]',
  // #v4-log-session .v4-log-sheet.v5-event-feed (panel box) + extracted SW 183 min-h-0.
  '[#v4-log-session_&]:min-h-0 [#v4-log-session_&]:items-stretch [#v4-log-session_&]:mx-4 [#v4-log-session_&]:box-border [#v4-log-session_&]:relative',
  // overflow: extracted SessionWorkspace 183 (x-clip/y-visible) + EventLogSheet event-feed
  // (visible). y stays visible so panel eyebrows/toolbar escape; x clips.
  '[#v4-log-session_&]:overflow-x-clip [#v4-log-session_&]:overflow-y-visible',
);

// FeedShell content inset — top half of the former `p-6` so the header sits
// closer to the sheet edge; horizontal/bottom stay 1.5rem.
const SHEET_PAD = '[#v4-log-session_&]:px-6 [#v4-log-session_&]:pt-3 [#v4-log-session_&]:pb-6';

const SHEET = clsx(FEED_SHEET_CLASS, SHEET_PAD);

// `#v4-log-session .v4-log-sheet.v5-event-feed > .v5-event-feed-top` (EventLogSheet) +
// extracted SessionWorkspace 192 (flex-shrink-0) + 196 (overflow-visible) + the phone-first
// wrap (SessionWorkspace 421 / EventLogSheet 420).
const FEED_TOP =
  'flex flex-row items-start justify-between gap-x-5 gap-y-4 flex-[0_0_auto] shrink-0 w-full min-w-0 mb-2 pb-0 box-border overflow-visible max-md:flex-wrap';

// `#v4-log-session .v5-event-feed-top__titles` (EventLogSheet) + extracted SW 197 (overflow-visible).
const FEED_TITLES = 'flex-[1_1_auto] min-w-0 flex items-start overflow-visible';

// `#v4-log-session .v5-event-feed-top .v5-event-feed-head` (EventLogSheet) + extracted SW 198.
const FEED_HEAD =
  'flex flex-col items-start gap-[var(--v5-panel-head-main-gap)] m-0 p-0 border-none overflow-visible';

// `#v4-log-session .v5-event-feed-toolbar` (EventLogSheet).
const FEED_TOOLBAR = 'flex-[0_0_auto] flex flex-row flex-wrap justify-start self-start gap-2';

// `#v4-log-session .v5-panel-main-title--numeric` (extracted SessionWorkspace 741) — the
// FeedShell-only numeric size delta over the shared `.v5-panel-main-title` base (which stays
// legacy in SessionWorkspace, still targeting this h2). Ancestor variant so the id is retained.
const FEED_TITLE_NUMERIC =
  '[#v4-log-session_&]:text-[1.75rem] [#v4-log-session_&]:font-semibold [#v4-log-session_&]:[font-variant-numeric:tabular-nums] [#v4-log-session_&]:tracking-[-0.03em]';

interface Props {
  countLabel: string;
  headerId?: string;
  feedAriaLabel?: string;
  toolbar: ReactNode;
  toolbarAriaLabel?: string;
  /** Extra class(es) appended to the toolbar div alongside `FEED_TOOLBAR`
   * (which is shared and unchanged). The Event feed passes `max-w-full`
   * (auto-generate-event-logs fix wave): its toolbar gained the AUTO GENERATE
   * button, and `FEED_TOOLBAR`'s `flex-[0_0_auto]` sizes the row to
   * max-content — without a max-width clamp its internal `flex-wrap` never
   * engages, so on narrow viewports the row overflowed and pushed FILTER
   * off-viewport. Clamping lets the row wrap instead. */
  toolbarClassName?: string;
  /** Extra class(es) on the title + toolbar row (`.v5-event-feed-top`). */
  topClassName?: string;
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
  toolbarClassName,
  topClassName,
  modifier,
  logBottomId,
  sheetId,
  after,
  children,
}: Props) {
  const sheetCls = clsx(SHEET, modifier);

  const sheet = (
    <div className={sheetCls} id={sheetId}>
      <div className={clsx('v5-event-feed-top', FEED_TOP, topClassName)}>
        <div className={clsx('v5-event-feed-top__titles', FEED_TITLES)}>
          <header className={clsx('v5-event-feed-head v5-panel-head__main', FEED_HEAD)}>
            <h2
              className={clsx(
                'v5-panel-main-title v5-panel-main-title--numeric',
                FEED_TITLE_NUMERIC,
              )}
              id={headerId}
              role="status"
              aria-label={feedAriaLabel}
            >
              {countLabel}
            </h2>
          </header>
        </div>
        <div
          className={clsx('v5-event-feed-toolbar', FEED_TOOLBAR, toolbarClassName)}
          role="toolbar"
          aria-label={toolbarAriaLabel}
        >
          {toolbar}
        </div>
      </div>
      {children}
      {after}
    </div>
  );

  if (logBottomId) {
    return (
      <div className={clsx('v4-log-bottom', LOG_BOTTOM)} id={logBottomId}>
        {sheet}
      </div>
    );
  }

  return sheet;
}

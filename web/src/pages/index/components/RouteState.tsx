import type { HTMLAttributes, ReactNode } from 'react';
import { Empty } from '../../../shared/components/ui/empty';
import { cn } from '../../../shared/lib/utils';
import { ROUTE_STATE_PAGE } from './RouteLoadingState';

/**
 * RootGate's full-viewport frame (the gate renders before the shell exists, so it centres in
 * the whole viewport rather than the route area).
 */
export const GATE_PAGE =
  'relative z-[1] flex min-h-screen min-h-[100dvh] w-full items-center justify-center px-5 py-10';

// The V5 state panel: glass card, League Gothic page heading, muted copy (formerly copied as
// STATE_PANEL/TITLE/COPY/BADGE into SessionRoute, RootGate and ChunkLoadBoundary).
const PANEL =
  'glass-panel relative box-border w-full max-w-[25rem] gap-0 rounded-v5-lg px-7 py-9 text-center';
const TITLE =
  'm-0 font-league-gothic font-bold text-[2.25rem] leading-none tracking-[0.02em] uppercase text-v5-text';
const COPY = 'mx-auto mb-0 mt-3 max-w-[19rem] text-[0.9rem] leading-[1.5] text-v5-muted';
const BADGE = 'm-0 text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-v5-muted';

interface RouteStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'role'> {
  /** `route`: the shared, height-mirrored route frame (web-session-routing "Deep-link
   * resolution states" — every state renders inside it). `gate`: RootGate's viewport frame. */
  frame: 'route' | 'gate';
  /** `status` for polite states (not-found, archived), `alert` for failures. Never shadcn
   * `Alert`: not-found must stay semantically distinct from error. */
  role: 'status' | 'alert';
  title: ReactNode;
  /** Small eyebrow above the title (e.g. "Archived session"). */
  badge?: ReactNode;
  /** The explanatory copy. */
  children?: ReactNode;
  /** Buttons, stacked full-width under the copy. */
  actions?: ReactNode;
}

/**
 * Shared full-page state panel (shadcn-port-shell D2) on the shadcn `Empty` primitive. The
 * title is a real `<h1>` (EmptyTitle is a div; these are page headings). Extra props (ids,
 * test ids, data attributes) land on the panel.
 */
export function RouteState({
  frame,
  role,
  title,
  badge,
  children,
  actions,
  className,
  ...rest
}: RouteStateProps) {
  return (
    <div className={frame === 'route' ? ROUTE_STATE_PAGE : GATE_PAGE}>
      <Empty role={role} className={cn(PANEL, className)} {...rest}>
        {badge !== undefined && <p className={BADGE}>{badge}</p>}
        <h1 data-slot="empty-title" className={cn(TITLE, badge !== undefined && 'mt-2')}>
          {title}
        </h1>
        {children !== undefined && <p className={COPY}>{children}</p>}
        {actions !== undefined && <div className="mt-6 flex w-full flex-col gap-3">{actions}</div>}
      </Empty>
    </div>
  );
}

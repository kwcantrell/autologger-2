import { ArrowRight, Plus } from 'lucide-react';
import { useSessions } from '../../../api/hooks/useSessions';
import { useShowAccess } from '../../../api/hooks/useShowAccess';
import { Button } from '../../../shared/components/ui/button';
import { fmtDateOnly } from '../../../shared/utils/fmtDateOnly';
import { navigate } from '../navigation';

// --- HomeRoute (ui-refresh, task 5.1; design D10, GATE-OVERRIDDEN) ---
//
// The dedicated home route component: `SessionRoute` renders this for the
// empty session id, in `WorkspaceStatic`'s place (spec: web-home-launch
// "Branded home launch surface"; web-session-routing "Legacy selection spine
// retired"). This retires `SessionWorkspace`'s old empty-id placeholder
// branch and its `#v3-session-placeholder` element/copy — `#home-launch` is
// the new stable, e2e-observable region for the no-session view.
//
// Visuals (wordmark/tagline/resume-card/New Session markup) are quarried
// from the ui-refresh-spike's `HomeLaunch.tsx`, which rendered the same
// markup *inside* the retired placeholder's centering flex container. That
// container doesn't exist anymore, so this component supplies its own
// route-level center-layout instead of relying on it.
//
// The no-active-sessions copy is corrected vs the spike here (spec: "a
// primary create-session action whose copy is correct whether or not
// archived sessions exist") — the spike's "Create your first session" is
// wrong for an archived-only user, who has already created sessions.

const HOME_ROUTE =
  'relative z-[1] flex min-h-[calc(100dvh-var(--topbar-h)-4rem)] w-full flex-col items-center justify-center px-6 py-16 text-center';

const RESUME_CARD =
  'group glass-panel box-border flex w-full max-w-[24rem] cursor-pointer flex-col items-stretch gap-[0.35rem] rounded-v5-lg border border-v5-border px-6 py-5 text-left [transition:border-color_0.15s_ease,background_0.15s_ease] hover-always:border-[color-mix(in_srgb,var(--v5-primary)_35%,var(--v5-border))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(56,189,248,0.55)]';

interface Props {
  onNewSession: () => void;
}

export function HomeRoute({ onNewSession }: Props) {
  const { data: sessions } = useSessions();
  const access = useShowAccess();
  // Resume card = first entry of the active list (server order, newest
  // created) — spec "Branded home launch surface" / "Home with existing
  // sessions" — and only when the user can open it (show-grants D13).
  const first = sessions?.active?.[0];
  const recent = first && access.canAccessShow(first.show_id) ? first : undefined;
  // New Session only when the active team has a show the user can access.
  const canCreate = access.accessibleShows(access.activeStudioId).length > 0;

  return (
    <div className={HOME_ROUTE} id="home-launch">
      <div className="flex w-full max-w-[26rem] flex-col items-center gap-7">
        <header className="flex flex-col items-center gap-2">
          <h1 className="m-0 font-league-gothic font-bold text-[3.4rem] leading-none tracking-[0.03em] uppercase text-v5-text">
            AutoLogger
          </h1>
          <p className="m-0 max-w-[20rem] text-[0.9rem] leading-[1.5] text-v5-muted">
            Every session becomes a searchable, visual record — events, transcripts, topics.
          </p>
        </header>

        <div className="flex w-full flex-col items-center gap-3">
          {recent && (
            <button
              type="button"
              className={RESUME_CARD}
              id="home-resume-session"
              onClick={() => navigate(`/sessions/${encodeURIComponent(recent.id)}`)}
            >
              <span className="text-[0.65rem] font-semibold tracking-[0.16em] uppercase text-v5-muted">
                Jump back in
              </span>
              <span className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 overflow-hidden text-[1.05rem] font-semibold text-ellipsis whitespace-nowrap text-v5-text">
                  {recent.title}
                </span>
                <span
                  aria-hidden="true"
                  className="shrink-0 text-v5-muted [transition:transform_0.15s_ease,color_0.15s_ease] group-hover-always:translate-x-[2px] group-hover-always:text-v5-primary"
                >
                  <ArrowRight className="size-4" strokeWidth={1.8} aria-hidden="true" />
                </span>
              </span>
              <span className="text-[0.72rem] leading-[1.35] text-v5-muted">
                {fmtDateOnly(recent.episode_date ?? recent.created_at_utc)} ·{' '}
                {Number.isFinite(Number(recent.event_count)) ? Number(recent.event_count) : 0}{' '}
                events
              </span>
            </button>
          )}

          {canCreate && (
            <Button
              variant={recent ? 'outline' : 'default'}
              id="home-new-session"
              onClick={onNewSession}
            >
              <Plus strokeWidth={2} aria-hidden="true" />
              {recent ? 'New session' : 'Start a session'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

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

// The resume card (finish review fix round 1: no eyebrow). The session name is the card's heading
// and its one control names the action; the control's `::after` covers the card, so the whole
// card stays one click target (web-home-launch "Resuming from the card").
const RESUME_CARD =
  'group glass-panel relative box-border flex w-full max-w-[24rem] flex-col items-stretch gap-[0.35rem] rounded-v5-lg border border-v5-border px-6 py-5 text-left [transition:border-color_0.15s_ease,background_0.15s_ease] hover-always:border-[color-mix(in_srgb,var(--v5-primary)_35%,var(--v5-border))] has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-(--si-accent)';
const RESUME_ACTION =
  "mt-1.5 inline-flex cursor-pointer items-center gap-1.5 self-start rounded-ctl text-sm font-medium text-(--si-accent-text) outline-none after:absolute after:inset-0 after:rounded-v5-lg after:content-['']";

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
            <section className={RESUME_CARD} aria-labelledby="home-resume-title">
              <h2
                id="home-resume-title"
                className="m-0 truncate text-[1.05rem] leading-snug font-semibold text-v5-text"
              >
                {recent.title}
              </h2>
              <p className="m-0 text-[0.72rem] leading-[1.35] text-v5-muted">
                {fmtDateOnly(recent.episode_date ?? recent.created_at_utc)} ·{' '}
                {Number.isFinite(Number(recent.event_count)) ? Number(recent.event_count) : 0}{' '}
                events
              </p>
              <button
                type="button"
                className={RESUME_ACTION}
                id="home-resume-session"
                aria-label={`Jump back in to ${recent.title}`}
                onClick={() => navigate(`/sessions/${encodeURIComponent(recent.id)}`)}
              >
                Jump back in
                <ArrowRight
                  className="size-4 [transition:transform_0.15s_ease] group-hover-always:translate-x-[2px] motion-reduce:transition-none"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              </button>
            </section>
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

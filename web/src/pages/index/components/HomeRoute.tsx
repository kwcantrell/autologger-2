import { useSessions } from '../../../api/hooks/useSessions';
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
  'relative z-[1] flex min-h-[calc(100vh-4rem)] w-full flex-col items-center justify-center px-6 py-16 text-center';

const RESUME_CARD =
  'group glass-panel box-border flex w-full max-w-[24rem] cursor-pointer flex-col items-stretch gap-[0.35rem] rounded-v5-lg border border-v5-border px-6 py-5 text-left [transition:border-color_0.15s_ease,background_0.15s_ease] hover-always:border-[color-mix(in_srgb,var(--v5-primary)_35%,var(--v5-border))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(56,189,248,0.55)]';

function fmtDateOnly(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

interface Props {
  onNewSession: () => void;
}

export function HomeRoute({ onNewSession }: Props) {
  const { data: sessions } = useSessions();
  // Resume card = first entry of the active list (server order, newest
  // created) — spec "Branded home launch surface" / "Home with existing
  // sessions".
  const recent = sessions?.active?.[0];

  return (
    <div className={HOME_ROUTE} id="home-launch">
      <div className="flex w-full max-w-[26rem] flex-col items-center gap-7">
        <header className="flex flex-col items-center gap-2">
          <h1 className="m-0 font-league-gothic text-[3.4rem] leading-none tracking-[0.03em] uppercase text-v5-text">
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
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M5 12H19M19 12L13 6M19 12L13 18"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </span>
              <span className="text-[0.72rem] leading-[1.35] text-v5-muted">
                {fmtDateOnly(recent.episode_date ?? recent.created_at_utc)} ·{' '}
                {Number.isFinite(Number(recent.event_count)) ? Number(recent.event_count) : 0}{' '}
                events
              </span>
            </button>
          )}

          <button
            type="button"
            className={recent ? 'btn' : 'btn primary'}
            id="home-new-session"
            onClick={onNewSession}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 5V19M5 12H19"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            {recent ? 'New session' : 'Start a session'}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useProfile } from '../../../api/hooks/useProfile';
import type { TeamMembershipBrief } from '../../../api/types';
import { navigate } from '../navigation';
// CreateTeamForm moved to its own module (bundle route-splitting, plan C5.3):
// it is shared with the eagerly-loaded OnboardingPanel, and while it lived in
// THIS file that shared import pinned all of TeamsRoute + TeamCard + the teams
// mutation surface into the homepage graph, zeroing out TeamsRoute's lazy edge.
import { CreateTeamForm } from './CreateTeamForm';
import { TeamCard } from './TeamCard';

// --- TeamsRoute (teams-self-serve, task 6.2; design D7) ---
//
// Renders from `profile.auth.user.teams[]` for the list + role badges — the
// per-team detail (members/invites/enabled_admin_count) is fetched on demand
// by TeamCard only once a team is expanded, so opening this page issues at
// most one request (`GET /api/profile`, already in cache by the time AppShell
// mounts this route — see RootGate/AppShell). RootGate renders the login view
// whenever `auth.logged_in` is false, so `profile.auth.user` is never null
// here in practice; the type allows it, and that case renders only the back
// affordance and mounts nothing that could issue an `/api/teams/*` request.
//
// There are no built-in teams (owner-bootstrap D9): every team, `test-studios` and
// `test-studio-2` included, renders as a TeamCard by the caller's role.

const PAGE_WRAP = 'relative z-[1] mx-auto w-full max-w-[48rem] px-5 py-10';
const PAGE_TITLE =
  'm-0 mb-6 font-league-gothic font-bold text-[2rem] leading-none tracking-[0.02em] uppercase text-v5-text';

// Same STATE_BUTTON idiom as SessionRoute's not-found/error "Back to
// sessions" control (design D2) — one shared control, present regardless of
// which state above it rendered.
const STATE_BUTTON =
  'box-border flex h-11 w-full cursor-pointer items-center justify-center rounded-v5-sm border border-v5-border-strong bg-[rgba(255,255,255,0.03)] px-4 text-[0.8125rem] font-semibold tracking-[0.04em] text-v5-muted [transition:border-color_0.15s_ease,background_0.15s_ease,color_0.15s_ease] hover-always:bg-[rgba(255,255,255,0.05)] hover-always:text-v5-text';
const BACK_WRAP = 'relative z-[1] mx-auto w-full max-w-[25rem] px-5 pb-10';

function TeamsList({ teams }: { teams: TeamMembershipBrief[] }) {
  if (teams.length === 0) {
    return <p className="modal-hint">You&apos;re not on any teams yet.</p>;
  }
  return (
    <ul className="space-y-3" data-testid="teams-list">
      {teams.map((team) => (
        <TeamCard key={team.id} team={team} />
      ))}
    </ul>
  );
}

export function TeamsRoute() {
  const { data: profile } = useProfile();

  // Stable outer container regardless of state (AppShell's route-mount check
  // asserts on this testid alone) — the still-loading gap between AppShell mounting and `useProfile` resolving
  // (in practice never observed in production: RootGate only mounts AppShell
  // once the profile query has data) both render inside it.
  return (
    <div id="teams-route-placeholder" data-testid="teams-route">
      {!profile ? null : (
        <>
          {profile.auth.user === null ? null : (
            <div className={PAGE_WRAP}>
              <h1 className={PAGE_TITLE}>Teams</h1>
              <div className="mb-6">
                <CreateTeamForm />
              </div>
              <TeamsList teams={profile.auth.user.teams} />
            </div>
          )}
          {/* One shared back-to-sessions affordance (design D2; spec: "Teams
              page offers a way back in every state") — present whichever
              state above rendered, not duplicated per branch. */}
          <div className={BACK_WRAP}>
            <button type="button" className={STATE_BUTTON} onClick={() => navigate('/')}>
              Back to sessions
            </button>
          </div>
        </>
      )}
    </div>
  );
}

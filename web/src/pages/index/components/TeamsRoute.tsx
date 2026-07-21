import { useState } from 'react';
import { ApiError } from '../../../api/client';
import { useProfile } from '../../../api/hooks/useProfile';
import { useCreateTeam } from '../../../api/hooks/useTeams';
import type { TeamMembershipBrief } from '../../../api/types';
import { navigate } from '../navigation';
import { TeamCard } from './TeamCard';

// --- TeamsRoute (teams-self-serve, task 6.2; design D7) ---
//
// Renders from `profile.auth.user.teams[]` for the list + role badges — the
// per-team detail (members/invites/enabled_admin_count) is fetched on demand
// by TeamCard only once a team is expanded, so opening this page issues at
// most one request (`GET /api/profile`, already in cache by the time AppShell
// mounts this route — see RootGate/AppShell). Dev-anonymous
// (`profile.auth.user === null`) renders a signed-in-required notice and
// mounts nothing that could issue an `/api/teams/*` request.
//
// Built-in team ids (`test-studios`, `test-studio-2`) are excluded from the
// ENTIRE self-serve management surface server-side (team-management spec,
// "Built-ins rejected on every management route") — rendering them as
// expandable TeamCards would 400/404 on first expand, so they get their own
// static, non-expandable row instead. Mirrors `BUILTIN_STUDIO_ORDER` in
// `server/src/studio.ts` — extend both if a third built-in lands.
const BUILTIN_TEAM_IDS = ['test-studios', 'test-studio-2'];

const STATE_PAGE = 'relative z-[1] flex w-full items-center justify-center px-5 py-16';
const STATE_PANEL =
  'glass-panel relative box-border w-full max-w-[25rem] rounded-v5-lg px-7 py-9 text-center';
const STATE_TITLE =
  'm-0 font-league-gothic text-[2.25rem] leading-none tracking-[0.02em] uppercase text-v5-text';
const STATE_COPY = 'mx-auto mb-0 mt-3 max-w-[19rem] text-[0.9rem] leading-[1.5] text-v5-muted';

const PAGE_WRAP = 'relative z-[1] mx-auto w-full max-w-[48rem] px-5 py-10';
const PAGE_TITLE =
  'm-0 mb-6 font-league-gothic text-[2rem] leading-none tracking-[0.02em] uppercase text-v5-text';

// Same STATE_BUTTON idiom as SessionRoute's not-found/error "Back to
// sessions" control (design D2) — one shared control, present regardless of
// which state above it rendered.
const STATE_BUTTON =
  'box-border flex h-11 w-full cursor-pointer items-center justify-center rounded-v5-sm border border-v5-border-strong bg-[rgba(255,255,255,0.03)] px-4 text-[0.8125rem] font-semibold tracking-[0.04em] text-v5-muted [transition:border-color_0.15s_ease,background_0.15s_ease,color_0.15s_ease] hover-always:bg-[rgba(255,255,255,0.05)] hover-always:text-v5-text';
const BACK_WRAP = 'relative z-[1] mx-auto w-full max-w-[25rem] px-5 pb-10';

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : fallback;
}

function SignedInRequiredNotice() {
  // Reachable only in anonymous mode (the production serve path gates AppShell behind the
  // login page — RootGate — so a logged-out user never lands here). ui-refresh: say WHY
  // there is no sign-in button instead of dead-ending on "sign in required" with nothing to
  // click.
  return (
    <div className={STATE_PAGE}>
      <div className={STATE_PANEL} id="teams-signed-in-required" role="status">
        <h1 className={STATE_TITLE}>Sign in required</h1>
        <p className={STATE_COPY}>
          Teams need a signed-in account, and this server is running in anonymous mode — there is no
          sign-in here. Run the server with Google OAuth configured (<code>REQUIRE_LOGIN=1</code>)
          to manage teams.
        </p>
      </div>
    </div>
  );
}

function BuiltinTeamRow({ team }: { team: TeamMembershipBrief }) {
  return (
    <li
      data-testid={`team-row-${team.id}`}
      className="glass-panel rounded-v5-lg px-4 py-3 text-v5-text"
    >
      <span>{team.name}</span>
      <span className="ml-2 rounded-v5-sm border border-v5-border-strong bg-white/5 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-v5-muted">
        {team.role}
      </span>
      <span className="ml-2 text-[0.75rem] text-v5-muted">Legacy team — managed by support.</span>
    </li>
  );
}

/** Create-team form (task 6.1's `useCreateTeam` mutation). Reused verbatim by
 * the zero-membership onboarding panel (task 6.3, design D8). */
export function CreateTeamForm({ onCreated }: { onCreated?: () => void }) {
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useCreateTeam();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    create.mutate(
      { id: slug.trim(), display_name: displayName.trim() },
      {
        onSuccess: () => {
          setSlug('');
          setDisplayName('');
          onCreated?.();
        },
        onError: (err) => setError(errorMessage(err, 'Could not create team.')),
      },
    );
  }

  return (
    <form
      className="glass-panel rounded-v5-lg px-4 py-4"
      data-testid="team-create-form"
      onSubmit={handleSubmit}
    >
      {error && (
        <p role="alert" className="modal-hint text-[#ff8a8a]">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="field">
          <span>Team id (slug)</span>
          <input
            type="text"
            id="team-create-slug"
            className="profile-select"
            placeholder="my-crew"
            maxLength={63}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Display name</span>
          <input
            type="text"
            id="team-create-name"
            className="profile-select"
            placeholder="My Crew"
            maxLength={200}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <button
          type="submit"
          className="btn primary"
          disabled={create.isPending || slug.trim() === '' || displayName.trim() === ''}
        >
          {create.isPending ? 'Creating…' : 'Create team'}
        </button>
      </div>
      <p className="modal-hint mt-2">
        Lowercase, starts with a letter, letters/digits/hyphens only, 2–63 characters. The id
        can&apos;t be changed later.
      </p>
    </form>
  );
}

function TeamsList({ teams }: { teams: TeamMembershipBrief[] }) {
  if (teams.length === 0) {
    return <p className="modal-hint">You&apos;re not on any teams yet.</p>;
  }
  return (
    <ul className="space-y-3" data-testid="teams-list">
      {teams.map((team) =>
        BUILTIN_TEAM_IDS.includes(team.id) ? (
          <BuiltinTeamRow key={team.id} team={team} />
        ) : (
          <TeamCard key={team.id} team={team} />
        ),
      )}
    </ul>
  );
}

export function TeamsRoute() {
  const { data: profile } = useProfile();

  // Stable outer container regardless of state (AppShell's route-mount check
  // asserts on this testid alone) — the signed-in-required notice and the
  // still-loading gap between AppShell mounting and `useProfile` resolving
  // (in practice never observed in production: RootGate only mounts AppShell
  // once the profile query has data) both render inside it.
  return (
    <div id="teams-route-placeholder" data-testid="teams-route">
      {!profile ? null : (
        <>
          {profile.auth.user === null ? (
            <SignedInRequiredNotice />
          ) : (
            <div className={PAGE_WRAP}>
              <h1 className={PAGE_TITLE}>Teams</h1>
              <div className="mb-6">
                <CreateTeamForm />
              </div>
              <TeamsList teams={profile.auth.user.teams} />
            </div>
          )}
          {/* One shared back-to-sessions affordance (design D2; spec: "Teams
              page offers a way back in every state") — present whichever of
              the two states above rendered, not duplicated per branch. */}
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

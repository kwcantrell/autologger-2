import { useProfile } from '../../../../api/hooks/useProfile';
import type { TeamMembershipBrief } from '../../../../api/types';
import { Empty, EmptyDescription } from '../../../../shared/components/ui/empty';
import { CreateTeamForm } from '../CreateTeamForm';
import { TeamCard } from '../TeamCard';

// --- LegacyTeamsPanel (interim, redesign-show-ignition 6.2) ---
//
// The body of the retired `/teams` page (`TeamsRoute`), moved unchanged into Settings › Members so
// team management stays reachable while the route opens Settings instead. Groups 8.1 and 7.3
// replace it with the Members list and panels and the Team details section; task 10.1 deletes it
// with `TeamCard`.
//
// Renders from `profile.auth.user.teams[]`; each `TeamCard` fetches its team's detail only when
// expanded, so mounting this issues no `/api/teams/*` request. A null user (unreachable: RootGate
// renders the login view signed out) renders nothing that could issue one.

function TeamsList({ teams }: { teams: TeamMembershipBrief[] }) {
  if (teams.length === 0) {
    return (
      <Empty className="items-start">
        <EmptyDescription>You&apos;re not on any teams yet.</EmptyDescription>
      </Empty>
    );
  }
  return (
    <ul className="flex flex-col gap-3" data-testid="teams-list">
      {teams.map((team) => (
        <TeamCard key={team.id} team={team} />
      ))}
    </ul>
  );
}

export function LegacyTeamsPanel() {
  const { data: profile } = useProfile();
  const user = profile?.auth.user;
  return (
    <div data-testid="legacy-teams-panel" className="flex flex-col gap-6">
      {user ? (
        <>
          <CreateTeamForm />
          <TeamsList teams={user.teams} />
        </>
      ) : null}
    </div>
  );
}

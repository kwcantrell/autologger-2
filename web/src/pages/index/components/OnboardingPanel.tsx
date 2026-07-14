import { CreateTeamForm } from './TeamsRoute';

// --- OnboardingPanel (teams-self-serve, task 6.3; design D8) ---
//
// Renders in place of the rail+workspace at `/` when the profile reports a
// logged-in user with zero team memberships — a team-less user can't do
// anything else useful (no active studio, no shows, no sessions), so this
// replaces the shell entirely rather than degrading some part of it (design
// D8's rejected alternative: navigating to `/teams` races profile loading).
//
// Reuses task 6.1's `useCreateTeam` mutation via TeamsRoute's `CreateTeamForm`
// verbatim — no separate onboarding-specific mutation. Success needs no
// explicit navigation or callback: `useCreateTeam` invalidates `['profile']`
// (task 6.1), the refetched profile now carries the new team in
// `auth.user.teams[]`, AppShell's onboarding condition flips to false on the
// next render, and the normal shell takes over showing the new team as
// active (server sets creator prefs when unset, mirroring
// `authSeedPrefsFromGlobals`'s spirit — design D8).

const PAGE =
  'relative z-[1] flex min-h-screen min-h-[100dvh] w-full items-center justify-center px-5 py-10';
const PANEL =
  'glass-panel relative box-border w-full max-w-[32rem] rounded-v5-lg px-7 py-9 text-center';
const TITLE =
  'm-0 font-league-gothic text-[2rem] leading-none tracking-[0.02em] uppercase text-v5-text';
const COPY = 'mx-auto mb-6 mt-3 max-w-[24rem] text-[0.9rem] leading-[1.5] text-v5-muted';

export function OnboardingPanel() {
  return (
    <div className={PAGE} id="onboarding-panel" data-testid="onboarding-panel">
      <div className={PANEL}>
        <h1 className={TITLE}>Create your first team</h1>
        <p className={COPY}>
          You&apos;re not on any teams yet. Create one to get started — you&apos;ll be its admin.
        </p>
        <CreateTeamForm />
      </div>
    </div>
  );
}

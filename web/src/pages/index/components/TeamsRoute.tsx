// --- TeamsRoute (teams-self-serve, task 5.2; design D6/D7) ---
//
// Placeholder mount target for the `/teams` route. AppShell renders this in
// place of SessionRoute (which is what actually renders the no-session home
// view via WorkspaceStatic) whenever the URL is `/teams` — so mounting this
// component IS what hides the home/session workspace at that route; there is
// no separate visibility toggle to wire.
//
// Phase 6 (design D7) replaces this body with the real team list + detail
// page (profile-driven list with roles, `useTeam(id)` on demand, management
// mutations). This stub exists only to prove the routing/navigation/
// departure-watcher wiring (spec: web-session-routing "Teams route is a
// first-class app route"; "Originator-scoped transport stop on route
// departure" — the /teams departure scenario).

const STATE_PAGE = 'relative z-[1] flex w-full items-center justify-center px-5 py-16';
const STATE_PANEL =
  'glass-panel relative box-border w-full max-w-[25rem] rounded-v5-lg px-7 py-9 text-center';
const STATE_TITLE =
  'm-0 font-league-gothic text-[2.25rem] leading-none tracking-[0.02em] uppercase text-v5-text';
const STATE_COPY = 'mx-auto mb-0 mt-3 max-w-[19rem] text-[0.9rem] leading-[1.5] text-v5-muted';

export function TeamsRoute() {
  return (
    <div className={STATE_PAGE}>
      <div
        className={STATE_PANEL}
        id="teams-route-placeholder"
        role="status"
        data-testid="teams-route"
      >
        <h1 className={STATE_TITLE}>Teams</h1>
        <p className={STATE_COPY}>Team management is coming soon.</p>
      </div>
    </div>
  );
}

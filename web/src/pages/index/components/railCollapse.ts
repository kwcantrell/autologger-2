// The desktop rail's collapse toggle (interim; redesign-show-ignition 3.1).
//
// `V6Rail` collapses through the body class `v6-app--rail-collapsed` (its class strings react to
// it as an ancestor variant). Both the rail's own menu button and the top bar's sidebar control
// call this, so the two stay in step. Group 4 rebuilds the rail on shadcn `Sidebar` inside a
// `SidebarProvider`; the top bar then renders `SidebarTrigger` (`toggleSidebar()`) and this module,
// the body class and the `#v6-rail-toggle` button go away.

export const RAIL_COLLAPSED_CLASS = 'v6-app--rail-collapsed';

export function isDesktopRailCollapsed(): boolean {
  return document.body.classList.contains(RAIL_COLLAPSED_CLASS);
}

export function toggleDesktopRailCollapsed(): void {
  document.body.classList.toggle(RAIL_COLLAPSED_CLASS);
  // aria-expanded lives on the rail's toggle button (the element with the handler), not the
  // aside — assistive tech reads the announced state off the control.
  const collapsed = isDesktopRailCollapsed();
  document.getElementById('v6-rail-toggle')?.setAttribute('aria-expanded', String(!collapsed));
  document.getElementById('v3-main')?.classList.toggle('v6-workspace--rail-collapsed', collapsed);
}

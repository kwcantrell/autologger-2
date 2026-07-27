import type { ReactNode } from 'react';

/**
 * Renders the V5 ambient background glow as two DOM nodes (formerly
 * `body.v5-ui::before` / `::after` pseudo-elements).
 *
 * The legacy body classes (`has-v4-topbar`, `v6-app-layout`, `v4-scratch`,
 * `v5-ui`) were dissolved in v1.15.0; component CSS no longer scopes on them.
 *
 * The `.v5-bg-glow*` rules live in `@layer base` in tailwind.css (Task 11);
 * bgGlow.css was retired when baseline.css was folded into the theme layers.
 *
 * The former ThemeContext/useTheme/variant machinery was deleted 2026-07-27
 * (never consumed — this component only ever contributed the glow divs).
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="v5-bg-glow v5-bg-glow--grid" aria-hidden="true" />
      <div className="v5-bg-glow v5-bg-glow--corners" aria-hidden="true" />
      {children}
    </>
  );
}

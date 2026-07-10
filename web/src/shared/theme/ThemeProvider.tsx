import { createContext, type ReactNode, useContext } from 'react';
import glass from './glass.module.css';

export type ThemeVariant = 'v5';

type ThemeContextValue = {
  variant: ThemeVariant;
  glass: string;
  glassStrong: string;
  shadowGlow: string;
};

const ThemeContext = createContext<ThemeContextValue>({
  variant: 'v5',
  glass: glass.glass,
  glassStrong: glass.glassStrong,
  shadowGlow: glass.shadowGlow,
});

/**
 * Renders the V5 ambient background glow as two DOM nodes (formerly
 * `body.v5-ui::before` / `::after` pseudo-elements) and exposes the
 * `glass` / `glassStrong` / `shadowGlow` class names via context.
 *
 * The legacy body classes (`has-v4-topbar`, `v6-app-layout`, `v4-scratch`,
 * `v5-ui`) were dissolved in v1.15.0; component CSS no longer scopes on them.
 *
 * `bgGlow.css` is imported from `AppShell.tsx`, not here, because Vite
 * tree-shakes side-effect imports that sit next to a CSS-Module import in the
 * same file.
 */
export function ThemeProvider({
  children,
  variant = 'v5',
}: {
  children: ReactNode;
  variant?: ThemeVariant;
}) {
  return (
    <ThemeContext.Provider
      value={{
        variant,
        glass: glass.glass,
        glassStrong: glass.glassStrong,
        shadowGlow: glass.shadowGlow,
      }}
    >
      <div className="v5-bg-glow v5-bg-glow--grid" aria-hidden="true" />
      <div className="v5-bg-glow v5-bg-glow--corners" aria-hidden="true" />
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

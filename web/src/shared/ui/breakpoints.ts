import { useEffect, useState } from 'react';

export const BP = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

export type Breakpoint = keyof typeof BP;

/**
 * Reactive `window.matchMedia` hook. Safe to call during SSR (returns `false`
 * until the first effect runs, at which point it syncs to the live MediaQueryList).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent | MediaQueryList) => setMatches(e.matches);
    handler(mql);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

/**
 * `true` below the `md` breakpoint (≤767px) — the phone-first cutover used by
 * the Dialog bottom-sheet branch and the V6Rail off-canvas drawer.
 */
export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${BP.md - 1}px)`);
}

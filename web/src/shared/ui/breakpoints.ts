import { useEffect, useRef, useState } from 'react';

const BP = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

/**
 * Reactive `window.matchMedia` hook. Safe to call during SSR (returns `false`
 * until the first effect runs, at which point it syncs to the live MediaQueryList).
 */
function useMediaQuery(query: string): boolean {
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
const MOBILE_QUERY = `(max-width: ${BP.md - 1}px)`;

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/** Synchronous read of the mobile breakpoint (client only; `false` without a window). */
function isMobileNow(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(MOBILE_QUERY).matches
  );
}

/**
 * Card-vs-sheet mode for a dialog (shadcn-shared-wrappers D2): read synchronously when the dialog
 * opens and held until it closes, so crossing the md breakpoint while open (window resize,
 * tablet rotation) never swaps the dialog's component tree — a swap would remount its content and
 * drop child state (e.g. Settings' nested Event options dialog). While closed it follows the live
 * breakpoint. Safe here because the app's islands are client-only (`ssr: false`).
 */
export function useDialogMode(open: boolean): boolean {
  const live = useIsMobile();
  const latched = useRef<boolean | null>(null);
  if (!open) {
    latched.current = null;
    return live;
  }
  if (latched.current === null) latched.current = isMobileNow();
  return latched.current;
}

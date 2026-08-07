// Runtime atlas loading (spec "web-docs is a static workspace" — "the SPA
// fetches ./atlas.json at runtime"; SEAM, orchestrator directive: the SPA
// renders ONLY fields present in atlas.json). `AtlasContext` is exported
// (not just the provider) so tests can supply a fixture `Atlas` — typically
// one built with the real `buildAtlas` (model/atlas.ts) — directly, without
// mocking `fetch`.
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import type { Atlas } from '../../model/atlas';

export type AtlasState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; atlas: Atlas };

export const AtlasContext = createContext<AtlasState>({ status: 'loading' });

/**
 * Fetches `./atlas.json` (relative to the served document — dev server and
 * built `dist/` both serve it at that path; see vite.config.ts's
 * `copyAtlasJsonPlugin` for how it lands in `dist/`) exactly once on mount.
 */
export function AtlasProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AtlasState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetch('./atlas.json')
      .then((response) => {
        if (!response.ok) {
          throw new Error(`atlas.json request failed: HTTP ${response.status}`);
        }
        return response.json() as Promise<Atlas>;
      })
      .then((atlas) => {
        if (!cancelled) setState({ status: 'ready', atlas });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <AtlasContext.Provider value={state}>{children}</AtlasContext.Provider>;
}

export function useAtlasState(): AtlasState {
  return useContext(AtlasContext);
}

/** Convenience hook for pages that can only render once the atlas is ready — callers must already be inside an `AtlasState.status === 'ready'` guard (see App.tsx), so this throws if used prematurely rather than returning `undefined` silently. */
export function useAtlas(): Atlas {
  const state = useAtlasState();
  if (state.status !== 'ready') {
    throw new Error('useAtlas() called before the atlas finished loading');
  }
  return state.atlas;
}

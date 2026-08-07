// React binding for route.ts's pure `parseHash` (kept in its own file so
// route.ts itself stays framework-free and trivially unit-testable).
import { useEffect, useState } from 'react';
import { parseHash, type Route } from './route';

function currentHash(): string {
  return typeof window === 'undefined' ? '' : window.location.hash;
}

/** Re-renders on every `hashchange`, always returning the parsed current route. */
export function useHashRoute(): Route {
  const [hash, setHash] = useState(currentHash);

  useEffect(() => {
    const onHashChange = () => setHash(currentHash());
    window.addEventListener('hashchange', onHashChange);
    // The hash may have changed between the initial useState() read and this
    // effect's subscription (e.g. a navigation during the first render) —
    // resync once on mount so that race can't strand the route one step
    // behind.
    setHash(currentHash());
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return parseHash(hash);
}

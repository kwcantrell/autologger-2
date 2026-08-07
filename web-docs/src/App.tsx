// Top-level route switch (task 7.1-7.3; design.md D1 — "a Vite + React SPA
// renders pages from `atlas.json`"). Waits for the atlas to finish loading
// (AtlasProvider, wrapped around <App/> in main.tsx) before rendering any
// page — every page component below assumes a ready `Atlas` is available,
// never fetches or re-derives anything itself (SEAM: the SPA renders ONLY
// fields present in atlas.json).
import { Layout } from './components/Layout';
import { useAtlasState } from './lib/AtlasProvider';
import { useHashRoute } from './lib/useHashRoute';
import { AboutPage } from './pages/AboutPage';
import { CapabilityPage } from './pages/CapabilityPage';
import { ComponentPage } from './pages/ComponentPage';
import { DiagramPage } from './pages/DiagramPage';
import { ErPage } from './pages/ErPage';
import { L0Page } from './pages/L0Page';
import { NotFoundPage } from './pages/NotFoundPage';

export function App() {
  const atlasState = useAtlasState();
  const route = useHashRoute();

  if (atlasState.status === 'loading') {
    return (
      <main className="site-main">
        <p>Loading atlas.json…</p>
      </main>
    );
  }

  if (atlasState.status === 'error') {
    return (
      <main className="site-main">
        <h1>Failed to load atlas.json</h1>
        <p role="alert">{atlasState.message}</p>
        <p>
          Run <code>npm run dev -w web-docs</code> (or <code>npm run build -w web-docs</code>) to
          regenerate it.
        </p>
      </main>
    );
  }

  const { atlas } = atlasState;

  return (
    <Layout atlas={atlas}>
      {route.kind === 'l0' && <L0Page atlas={atlas} />}
      {route.kind === 'about' && <AboutPage atlas={atlas} />}
      {route.kind === 'component' && <ComponentPage atlas={atlas} name={route.name} />}
      {route.kind === 'capability' && <CapabilityPage atlas={atlas} name={route.name} />}
      {route.kind === 'er' && <ErPage atlas={atlas} schema={route.schema} />}
      {route.kind === 'diagram' && <DiagramPage atlas={atlas} path={route.path} />}
      {route.kind === 'not-found' && <NotFoundPage hash={route.hash} />}
    </Layout>
  );
}

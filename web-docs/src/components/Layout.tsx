// Shared page chrome: header nav (top-level pages + a quick-jump to any
// component, since L0's own diagram only surfaces `runtime`/`datastore`/
// `external` nodes by default) and the main content slot.
import type { ReactNode } from 'react';
import type { Atlas } from '../../model/atlas';
import { ABOUT_HASH, componentHash, erHash, L0_HASH } from '../lib/route';

export interface LayoutProps {
  atlas: Atlas;
  children: ReactNode;
}

export function Layout({ atlas, children }: LayoutProps) {
  return (
    <div className="layout">
      <header className="site-header">
        <a className="site-title" href={L0_HASH}>
          AutoLogger — Architecture Docs
        </a>
        <nav aria-label="Primary">
          <a href={L0_HASH}>Architecture</a>
          <a href={erHash('catalog')}>Catalog ER</a>
          <a href={erHash('session')}>Session ER</a>
          <a href={ABOUT_HASH}>About</a>
        </nav>
        <label className="quick-jump">
          Jump to component
          <select
            defaultValue=""
            onChange={(event) => {
              const route = event.currentTarget.value;
              if (route) window.location.hash = route;
              event.currentTarget.value = '';
            }}
          >
            <option value="" disabled>
              Choose a component…
            </option>
            {[...atlas.navigation]
              .sort((a, b) => a.componentName.localeCompare(b.componentName))
              .map((entry) => (
                <option key={entry.id} value={componentHash(entry.componentName)}>
                  {entry.componentName}
                </option>
              ))}
          </select>
        </label>
      </header>
      <main className="site-main">{children}</main>
    </div>
  );
}

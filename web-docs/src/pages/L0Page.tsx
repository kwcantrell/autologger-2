// L0: system architecture (spec "Three-level drill-down site" — L0 clauses;
// design.md D1/D9). Renders the atlas-carried mermaid source for the
// current `{showTest, showTooling}` toggle combination — one of the four
// variants `model/atlas.ts` already generated at build time (never
// re-generated client-side; SEAM: this SPA only renders atlas fields).
import { useState } from 'react';
import type { Atlas } from '../../model/atlas';
import { MermaidDiagram } from '../components/MermaidDiagram';
import { componentHash } from '../lib/route';

// Presentation-only legend swatches matching the `classDef` colors
// model/generateL0.ts's CLASS_DEFS embeds directly into the generated
// mermaid source (so the rendered diagram already carries these colors on
// its own) — duplicated here only to explain them, not as a new fact this
// page introduces beyond what the atlas already renders.
const KIND_LEGEND: { kind: string; color: string; label: string }[] = [
  { kind: 'runtime', color: '#4C6EF5', label: 'runtime' },
  { kind: 'datastore', color: '#12B886', label: 'datastore' },
  { kind: 'external', color: '#FA5252', label: 'external (config-gated)' },
  { kind: 'tooling', color: '#868E96', label: 'tooling' },
  { kind: 'test-harness', color: '#ADB5BD', label: 'test-harness' },
];

function variantFor(atlas: Atlas, showTest: boolean, showTooling: boolean) {
  if (showTest && showTooling) return atlas.l0.full;
  if (showTest) return atlas.l0.withTest;
  if (showTooling) return atlas.l0.withTooling;
  return atlas.l0.default;
}

export function L0Page({ atlas }: { atlas: Atlas }) {
  const [showTest, setShowTest] = useState(false);
  const [showTooling, setShowTooling] = useState(false);
  const variant = variantFor(atlas, showTest, showTooling);
  const tintedComponents = new Set(
    atlas.overlay.changes.flatMap((change) => change.tintedComponents),
  );

  return (
    <div className="l0-page">
      <div className="l0-main">
        <h1>System architecture</h1>
        <p className="lede">
          Every component in the tracked tree, grouped by kind. Click a node to open its component
          page. Thick arrows are declared, non-import relationships — their verification is{' '}
          <strong>call-site-level (not per-endpoint)</strong> against the README endpoint table; see
          the model's evidence rules.
        </p>

        <fieldset className="toggles">
          <legend>Toggles</legend>
          <label>
            <input
              type="checkbox"
              checked={showTooling}
              onChange={(event) => setShowTooling(event.currentTarget.checked)}
            />
            Show tooling / test-harness components
          </label>
          <label>
            <input
              type="checkbox"
              checked={showTest}
              onChange={(event) => setShowTest(event.currentTarget.checked)}
            />
            Show test-only edges
          </label>
        </fieldset>

        <MermaidDiagram
          id="l0"
          source={variant.source}
          config={atlas.mermaidConfig}
          navIds={variant.navIds}
        />

        <section className="legend" aria-label="Diagram legend">
          <h2>Legend</h2>
          <ul className="kind-legend">
            {KIND_LEGEND.map((entry) => (
              <li key={entry.kind}>
                <span className="swatch" style={{ background: entry.color }} aria-hidden="true" />
                {entry.label}
              </li>
            ))}
            <li>
              <span
                className="swatch tinted-swatch"
                style={{ borderColor: '#F59F00' }}
                aria-hidden="true"
              />
              tinted — touched by an active change
            </li>
          </ul>
        </section>
      </div>

      <aside className="l0-sidebar" aria-label="Active changes">
        <h2>Active changes</h2>
        {atlas.overlay.changes.length === 0 ? (
          <p>No active OpenSpec changes.</p>
        ) : (
          <ul className="change-list">
            {atlas.overlay.changes.map((change) => (
              <li key={change.name}>
                <p className="change-name">{change.name}</p>
                <p className="change-proposal-path">{change.proposalPath}</p>
                <ul className="change-capabilities">
                  {change.capabilities.map((capability) => (
                    <li key={capability.capability}>
                      {capability.status === 'component-scoped' ? (
                        <>
                          {capability.capability} →{' '}
                          {capability.components.map((name, index) => (
                            <span key={name}>
                              {index > 0 ? ', ' : ''}
                              <a href={componentHash(name)}>{name}</a>
                            </span>
                          ))}
                        </>
                      ) : (
                        <>
                          {capability.capability}{' '}
                          <span className={`badge badge-${capability.status}`}>
                            {capability.status === 'pending' ? 'pending' : 'cross-cutting'}
                          </span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}

        <h2>Pending capabilities</h2>
        {atlas.capabilities.pending.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul>
            {atlas.capabilities.pending.map((capability) => (
              <li key={capability}>
                {capability} <span className="badge badge-pending">pending</span>
              </li>
            ))}
          </ul>
        )}

        {tintedComponents.size > 0 && (
          <p className="tinted-summary">
            {tintedComponents.size} component(s) currently tinted by an active change.
          </p>
        )}

        {(atlas.warnings.overlay.length > 0 || atlas.warnings.dynamicImports.length > 0) && (
          <details className="warnings">
            <summary>Build warnings</summary>
            <ul>
              {atlas.warnings.overlay.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
              {atlas.warnings.dynamicImports.map((warning) => (
                <li key={`${warning.file}:${warning.line}:${warning.column}`}>
                  {warning.file}:{warning.line}:{warning.column} — non-literal dynamic import
                </li>
              ))}
            </ul>
          </details>
        )}
      </aside>
    </div>
  );
}

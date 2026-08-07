// L1: per-component module graph (spec "Three-level drill-down site" — L1
// clauses; "L1 accounts for every mapped file"). `atlas.l1[name]` is absent
// for `datastore`/`external` components (no globs, nothing to graph) — this
// page renders a fallback note rather than assuming it exists everywhere.
import { useState } from 'react';
import type { Atlas } from '../../model/atlas';
import { MermaidDiagram } from '../components/MermaidDiagram';
import { capabilityHash, componentHash, diagramHash, erHash } from '../lib/route';

const ER_LINK_FOR_DATASTORE: Record<string, 'catalog' | 'session'> = {
  'catalog-database': 'catalog',
  'session-databases': 'session',
};

export function ComponentPage({ atlas, name }: { atlas: Atlas; name: string }) {
  const [showTestFiles, setShowTestFiles] = useState(false);
  const component = atlas.model.components.find((c) => c.name === name);

  if (!component) {
    return (
      <div>
        <h1>Unknown component</h1>
        <p>
          No component named "{name}" exists in the current atlas.{' '}
          <a href="#/">Back to architecture</a>
        </p>
      </div>
    );
  }

  const l1 = atlas.l1[name];
  const variant = l1 ? (showTestFiles ? l1.withTests : l1.default) : undefined;
  const requirementCount = (capability: string): number =>
    atlas.specTree.find((tree) => tree.capability === capability)?.requirements.length ?? 0;
  const authoredDiagrams = atlas.authoredDiagrams.filter((d) => d.componentName === name);
  const touchingChanges = atlas.overlay.changes.filter((change) =>
    change.tintedComponents.includes(name),
  );
  const relationships = atlas.model.relationships.filter(
    (rel) => rel.from === name || rel.to === name,
  );
  const erLink = ER_LINK_FOR_DATASTORE[name];

  return (
    <div className="component-page">
      <p>
        <a href="#/">← Architecture</a>
      </p>
      <h1>
        {component.name}{' '}
        <span className={`badge badge-kind-${component.kind}`}>{component.kind}</span>
      </h1>
      <p className="lede">{component.description}</p>

      {erLink && (
        <p>
          <a href={erHash(erLink)}>View {erLink} schema (ER, mechanical) →</a>
        </p>
      )}

      <section aria-label="Module graph">
        <h2>Module graph</h2>
        {variant ? (
          <>
            <fieldset className="toggles">
              <legend>Toggles</legend>
              <label>
                <input
                  type="checkbox"
                  checked={showTestFiles}
                  onChange={(event) => setShowTestFiles(event.currentTarget.checked)}
                />
                Show test files
              </label>
            </fieldset>
            <p className="elided-note">
              {showTestFiles
                ? 'Test files shown.'
                : `${variant.elidedTestCount} test file(s) elided (toggle above to show them).`}{' '}
              {variant.groupedFileCount > 0 &&
                `${variant.groupedFileCount} file(s) grouped into subdirectory nodes.`}
            </p>
            <MermaidDiagram
              id={`component-${component.name}`}
              source={variant.source}
              config={atlas.mermaidConfig}
            />
          </>
        ) : (
          <p>
            This is a {component.kind} component — it has no TypeScript modules of its own to graph.
          </p>
        )}
      </section>

      <section aria-label="Capabilities">
        <h2>Capabilities</h2>
        {component.capabilities.length === 0 ? (
          <p>No capabilities attached.</p>
        ) : (
          <ul>
            {component.capabilities.map((capability) => (
              <li key={capability}>
                <a href={capabilityHash(capability)}>{capability}</a> —{' '}
                {requirementCount(capability)} requirement(s)
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Authored diagrams">
        <h2>Authored diagrams</h2>
        {authoredDiagrams.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul>
            {authoredDiagrams.map((diagram) => (
              <li key={diagram.path}>
                <a href={diagramHash(diagram.path)}>{diagram.path}</a>{' '}
                <span className="badge badge-authored">{diagram.label}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {relationships.length > 0 && (
        <section aria-label="Declared relationships">
          <h2>Declared relationships</h2>
          <p className="lede">
            Verified call-site-level (not per-endpoint) against the evidence rule named below.
          </p>
          <ul>
            {relationships.map((rel) => {
              const otherName = rel.from === name ? rel.to : rel.from;
              const direction = rel.from === name ? '→' : '←';
              return (
                <li key={rel.id}>
                  {direction} <a href={componentHash(otherName)}>{otherName}</a>: {rel.label}
                  {rel.gated && <span className="badge badge-gated">gated: {rel.gated}</span>}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-label="In-flight changes">
        <h2>In-flight changes touching this component</h2>
        {touchingChanges.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul>
            {touchingChanges.map((change) => (
              <li key={change.name}>
                {change.name} <span className="change-proposal-path">({change.proposalPath})</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

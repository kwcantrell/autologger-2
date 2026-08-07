// L2: requirement/scenario browser (spec "Requirement browser is parsed
// from spec markdown with a count gate" — "the site SHALL render it
// navigably... as text"). Requirement/scenario bodies are raw markdown
// snippets straight from `openspec/specs/*/spec.md` — rendered as React
// text children (`white-space: pre-wrap` in CSS preserves their line
// breaks), never parsed into HTML, per spec "requirement/spec text SHALL be
// rendered as text nodes, never as HTML".
import type { Atlas } from '../../model/atlas';
import { componentHash } from '../lib/route';

export function CapabilityPage({ atlas, name }: { atlas: Atlas; name: string }) {
  const tree = atlas.specTree.find((t) => t.capability === name);
  const scope = atlas.model.capabilityScopes.find((s) => s.capability === name);
  const isPending = atlas.capabilities.pending.includes(name);

  return (
    <div className="capability-page">
      <p>
        <a href="#/">← Architecture</a>
      </p>
      <h1>
        {name} {isPending && <span className="badge badge-pending">pending</span>}
        {scope && !isPending && (
          <span className={`badge badge-scope-${scope.type}`}>{scope.type}</span>
        )}
      </h1>

      {scope && scope.type !== 'process' && scope.components.length > 0 && (
        <p className="lede">
          Attached to:{' '}
          {scope.components.map((componentName, index) => (
            <span key={componentName}>
              {index > 0 ? ', ' : ''}
              <a href={componentHash(componentName)}>{componentName}</a>
            </span>
          ))}
        </p>
      )}

      {!tree ? (
        <p>
          {isPending
            ? 'This capability is named only by an active change’s delta specs — it has not ' +
              'yet joined the openspec/specs/ baseline, so there is no requirement text to show ' +
              'yet.'
            : 'Unknown capability — not found in the current atlas.'}
        </p>
      ) : (
        <>
          <p className="lede">{tree.requirements.length} requirement(s).</p>
          {tree.requirements.map((requirement) => (
            <article key={requirement.name} className="requirement">
              <h2>{requirement.name}</h2>
              <p className="spec-text">{requirement.body}</p>
              {requirement.scenarios.map((scenario) => (
                <div key={scenario.name} className="scenario">
                  <h3>{scenario.name}</h3>
                  <p className="spec-text">{scenario.body}</p>
                </div>
              ))}
            </article>
          ))}
        </>
      )}
    </div>
  );
}

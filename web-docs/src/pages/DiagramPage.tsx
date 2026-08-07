// L2: authored state diagrams (spec "Authored state diagrams are attached,
// structurally validated, and labeled" — "labeled 'authored' in the UI
// (distinct from mechanical diagrams)").
import type { Atlas } from '../../model/atlas';
import { MermaidDiagram } from '../components/MermaidDiagram';
import { componentHash } from '../lib/route';

function titleFor(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.mmd$/, '').replace(/-/g, ' ');
}

export function DiagramPage({ atlas, path }: { atlas: Atlas; path: string }) {
  const diagram = atlas.authoredDiagrams.find((d) => d.path === path);

  if (!diagram) {
    return (
      <div>
        <h1>Unknown diagram</h1>
        <p>
          No authored diagram at "{path}" exists in the current atlas.{' '}
          <a href="#/">Back to architecture</a>
        </p>
      </div>
    );
  }

  return (
    <div className="diagram-page">
      <p>
        <a href={componentHash(diagram.componentName)}>← {diagram.componentName}</a>
      </p>
      <h1>
        {titleFor(diagram.path)} <span className="badge badge-authored">{diagram.label}</span>
      </h1>
      <p className="lede">
        Authored by a human from a direct read of the code (never generated from imports) — see{' '}
        <code>{diagram.path}</code>. Structurally gate-checked (mermaid parse validity, ≥1 state, ≥1
        transition) but its semantic truth rests on code review, not mechanics.
      </p>
      <MermaidDiagram
        id={`diagram-${diagram.path}`}
        source={diagram.source}
        config={atlas.mermaidConfig}
      />
    </div>
  );
}

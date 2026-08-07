// L2: catalog/session ER diagrams (spec "ER diagrams are produced by
// schema introspection" — design.md D5's honest-expectation note: the
// current schema declares few foreign keys, so these read as table-detail
// diagrams more than relationship webs).
import type { Atlas } from '../../model/atlas';
import { MermaidDiagram } from '../components/MermaidDiagram';
import { erHash } from '../lib/route';

const TITLES: Record<'catalog' | 'session', string> = {
  catalog: 'Catalog database schema',
  session: 'Session database schema',
};

export function ErPage({ atlas, schema }: { atlas: Atlas; schema: 'catalog' | 'session' }) {
  const other = schema === 'catalog' ? 'session' : 'catalog';
  return (
    <div className="er-page">
      <p>
        <a href="#/">← Architecture</a> · <a href={erHash(other)}>{TITLES[other]} →</a>
      </p>
      <h1>
        {TITLES[schema]} <span className="badge badge-mechanical">mechanical</span>
      </h1>
      <p className="lede">
        Derived by schema introspection against a bare in-memory database — running the real
        migrations (catalog) or <code>SessionCore.initSchema()</code> (session), then reading
        `sqlite_master`/`pragma table_info`/`pragma foreign_key_list`. Never parsed from DDL text.{' '}
        <strong>Sparse by design</strong>: the live schema declares few foreign keys (3 in catalog,
        0 in session), so this reads as a table-detail diagram more than a relationship web — no
        relationship is inferred or drawn beyond what the schema itself declares.
      </p>
      <MermaidDiagram id={`er-${schema}`} source={atlas.er[schema]} config={atlas.mermaidConfig} />
    </div>
  );
}

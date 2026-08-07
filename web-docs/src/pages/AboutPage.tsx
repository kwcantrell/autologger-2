// About page (spec "Exclusions are visible, not silent" — "every excluded
// file is listed with the model's stated reason"; the process-capability
// half of "Baseline capabilities map to components..." — process-scoped
// capabilities attach to no component, so they are listed here instead).
import type { Atlas } from '../../model/atlas';

export function AboutPage({ atlas }: { atlas: Atlas }) {
  const processCapabilities = atlas.model.capabilityScopes.filter((s) => s.type === 'process');

  return (
    <div className="about-page">
      <p>
        <a href="#/">← Architecture</a>
      </p>
      <h1>About this site</h1>
      <p className="lede">
        A generated map of the AutoLogger repo: every tracked source file belongs to exactly one
        component; every cross-component edge is derived from real imports and checked against a
        committed, reviewed snapshot; every non-import relationship (thick arrows on the
        architecture diagram) carries a mechanically-checked evidence rule, verified{' '}
        <strong>call-site-level (not per-endpoint)</strong> against the frozen HTTP/WS contract.
        Nothing here is hand-drawn except the two authored state-lifecycle diagrams, which are
        labeled "authored" and derived from a direct code read, not from imports.
      </p>

      <section aria-label="Excluded files">
        <h2>Excluded files</h2>
        <p className="lede">
          Tracked files that are genuinely tooling/config, not application code — excluded from
          component coverage by name, with a reason, rather than silently dropped.
        </p>
        {atlas.model.exclusions.length === 0 ? (
          <p>None.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {atlas.model.exclusions.map((exclusion) => (
                <tr key={exclusion.file}>
                  <td>
                    <code>{exclusion.file}</code>
                  </td>
                  <td>{exclusion.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-label="Process-scoped capabilities">
        <h2>Process-scoped capabilities</h2>
        <p className="lede">
          Attached to no component — they govern how the repo works (the SDLC itself), not a runtime
          module.
        </p>
        {processCapabilities.length === 0 ? (
          <p>None.</p>
        ) : (
          <ul>
            {processCapabilities.map((scope) => (
              <li key={scope.capability}>{scope.capability}</li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Baseline and pending capabilities">
        <h2>Capabilities</h2>
        <p>
          {atlas.capabilities.baseline.length} baseline, {atlas.capabilities.pending.length} pending
          (named only by an active change's delta specs, not yet archived to openspec/specs/).
        </p>
      </section>
    </div>
  );
}

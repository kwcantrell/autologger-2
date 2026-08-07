// Capability accounting gate (design.md D3/D4/D6; spec "Baseline
// capabilities map to components; new capabilities get pending-grace"). Pure
// logic over the model's `capabilityScopes` plus the live-enumerated
// baseline/active-delta capability name lists — the live-repo enumeration
// (src/lib/openspec.ts) and file reading live in scripts/check.ts, mirroring
// model/coverage.ts and model/edges.ts's pure-logic/live-wiring split.

import type { CapabilityScope, ComponentModel } from './components';

export interface CapabilityIssue {
  kind: 'unaccounted' | 'dangling-capability' | 'dangling-component' | 'duplicate';
  message: string;
}

function scopeComponents(scope: CapabilityScope): string[] {
  return scope.type === 'process' ? [] : scope.components;
}

/**
 * Checks the model's `capabilityScopes` against the live set of baseline
 * OpenSpec capabilities (`openspec/specs/*`) and the live set of capabilities
 * named by active changes' delta specs (not yet archived to baseline).
 *
 * - Every baseline capability SHALL appear in `capabilityScopes` exactly
 *   once (component / cross-cutting / process) — else "unaccounted".
 * - Every `capabilityScopes` entry SHALL name a capability that exists in
 *   baseline OR in an active change's delta specs — else "dangling-capability"
 *   (a capability named only by an active delta is NOT an error —
 *   pending-grace; see `pendingCapabilities` below for the inverse view).
 * - Every component named by a `component`/`cross-cutting` scope SHALL exist
 *   in the model — else "dangling-component".
 * - A capability declared more than once in `capabilityScopes` is a
 *   "duplicate".
 */
export function checkCapabilityAccounting(
  model: ComponentModel,
  baselineCapabilities: string[],
  activeChangeDeltaCapabilities: string[],
): CapabilityIssue[] {
  const issues: CapabilityIssue[] = [];
  const baselineSet = new Set(baselineCapabilities);
  const deltaSet = new Set(activeChangeDeltaCapabilities);
  const componentNames = new Set(model.components.map((component) => component.name));

  const seen = new Set<string>();
  for (const scope of model.capabilityScopes) {
    if (seen.has(scope.capability)) {
      issues.push({
        kind: 'duplicate',
        message: `Capability "${scope.capability}" is declared more than once in capabilityScopes.`,
      });
    }
    seen.add(scope.capability);

    if (!baselineSet.has(scope.capability) && !deltaSet.has(scope.capability)) {
      issues.push({
        kind: 'dangling-capability',
        message:
          `Model declares capability "${scope.capability}" (${scope.type}), which exists ` +
          "neither under openspec/specs/ nor as an active change's delta capability. Remedy: " +
          'remove the stale capabilityScopes entry, or correct the name.',
      });
    }

    for (const componentName of scopeComponents(scope)) {
      if (!componentNames.has(componentName)) {
        issues.push({
          kind: 'dangling-component',
          message:
            `Capability "${scope.capability}" (${scope.type}) names component ` +
            `"${componentName}", which does not exist in the model.`,
        });
      }
    }
  }

  for (const capability of baselineCapabilities) {
    if (!seen.has(capability)) {
      issues.push({
        kind: 'unaccounted',
        message:
          `Baseline capability "${capability}" (openspec/specs/${capability}/) is not ` +
          'accounted for in the model: attach it to a component, declare it cross-cutting with ' +
          'an explicit component set, or declare it process. Remedy: add a capabilityScopes ' +
          'entry in web-docs/model/components.ts.',
      });
    }
  }

  return issues.sort((a, b) => a.message.localeCompare(b.message));
}

/**
 * Capabilities named only by an active change's delta specs (not yet in the
 * openspec/specs/ baseline) — rendered as visible "pending" rather than
 * failing the gate (spec: "New capability from an active change is pending,
 * not fatal"). Sorted, deduplicated.
 */
export function pendingCapabilities(
  baselineCapabilities: string[],
  activeChangeDeltaCapabilities: string[],
): string[] {
  const baselineSet = new Set(baselineCapabilities);
  return [...new Set(activeChangeDeltaCapabilities)]
    .filter((capability) => !baselineSet.has(capability))
    .sort();
}

// Active-changes overlay extraction (design.md D6; spec "Active changes
// overlay from tracked artifacts"). Pure logic over already-enumerated
// change/capability name lists — the live-repo wiring (src/lib/openspec.ts's
// git- and filesystem-backed enumeration) lives in scripts/check.ts,
// mirroring model/coverage.ts, model/edges.ts, model/relationships.ts, and
// model/capabilities.ts's pure-logic/live-wiring split.
//
// Partitioning rule (design.md D6 / spec, verbatim): a change's delta
// capabilities are component-scoped (tint their components), cross-cutting
// (listed on the change without tinting), or pending — named only by an
// active change's delta, not yet in the openspec/specs/ baseline (D4's
// pending-grace). A capability that IS in the baseline but is declared
// `process`-scoped in the model (attached to no component, e.g.
// `sdlc-process`) folds into the same "listed without tinting" treatment as
// cross-cutting — no delta in this repo currently touches a process-scoped
// capability, but process scopes never tint by construction, so this is the
// only coherent fallback rather than a fourth bucket the spec doesn't name.

import type { CapabilityScope, ComponentModel } from './components';

export type OverlayCapabilityStatus = 'component-scoped' | 'cross-cutting' | 'pending';

export interface OverlayCapability {
  capability: string;
  status: OverlayCapabilityStatus;
  /** Non-empty only when status is 'component-scoped'. */
  components: string[];
}

export interface ChangeOverlay {
  name: string;
  proposalPath: string;
  capabilities: OverlayCapability[];
  /** Sorted, deduplicated union of components tinted by this change's component-scoped capabilities. */
  tintedComponents: string[];
}

export interface OverlayResult {
  changes: ChangeOverlay[];
  /** One message per on-disk openspec/changes/ directory with no tracked proposal.md — non-fatal. */
  warnings: string[];
}

function scopeFor(model: ComponentModel, capability: string): CapabilityScope | undefined {
  return model.capabilityScopes.find((scope) => scope.capability === capability);
}

function classifyDeltaCapability(
  model: ComponentModel,
  capability: string,
  baselineCapabilities: Set<string>,
): OverlayCapability {
  if (!baselineCapabilities.has(capability)) {
    return { capability, status: 'pending', components: [] };
  }
  const scope = scopeFor(model, capability);
  if (scope?.type === 'component') {
    return { capability, status: 'component-scoped', components: [...scope.components].sort() };
  }
  // cross-cutting, process, or (defensively) a baseline capability with no
  // capabilityScopes entry at all — that last case is a hard failure of the
  // capability-accounting gate (model/capabilities.ts) elsewhere in
  // docs:check, so this branch only has to avoid crashing on it, never
  // paper over it.
  return { capability, status: 'cross-cutting', components: [] };
}

function proposalPathFor(changeName: string): string {
  return `openspec/changes/${changeName}/proposal.md`;
}

/**
 * Builds the active-changes overlay: one ChangeOverlay per tracked-proposal
 * change (sorted by name), plus a warning per on-disk change directory that
 * has no tracked proposal.md (skipped from the overlay, never fatal — spec
 * "Untracked or partial change directories are inert").
 */
export function buildOverlay(params: {
  model: ComponentModel;
  /** Every directory name that physically exists under openspec/changes/ (archive excluded) — see src/lib/openspec.ts's listChangeDirectoriesOnDisk. */
  changeDirectoriesOnDisk: string[];
  /** Change directory names with a git-tracked proposal.md — see src/lib/openspec.ts's listActiveChangeNames. */
  activeChangeNames: string[];
  baselineCapabilities: string[];
  /** Delta capability names for a given active change name — see src/lib/openspec.ts's listChangeDeltaCapabilities. */
  deltaCapabilitiesFor: (changeName: string) => string[];
}): OverlayResult {
  const {
    model,
    changeDirectoriesOnDisk,
    activeChangeNames,
    baselineCapabilities,
    deltaCapabilitiesFor,
  } = params;

  const baselineSet = new Set(baselineCapabilities);
  const activeSet = new Set(activeChangeNames);

  const warnings = [...changeDirectoriesOnDisk]
    .filter((name) => !activeSet.has(name))
    .sort()
    .map(
      (name) =>
        `openspec/changes/${name}/ has no tracked proposal.md — skipped from the active-changes overlay.`,
    );

  const changes: ChangeOverlay[] = [...activeChangeNames].sort().map((name) => {
    const capabilities = [...deltaCapabilitiesFor(name)]
      .sort()
      .map((capability) => classifyDeltaCapability(model, capability, baselineSet));

    const tintedComponents = [
      ...new Set(
        capabilities
          .filter((capability) => capability.status === 'component-scoped')
          .flatMap((capability) => capability.components),
      ),
    ].sort();

    return { name, proposalPath: proposalPathFor(name), capabilities, tintedComponents };
  });

  return { changes, warnings };
}

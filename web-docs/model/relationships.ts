// Relationship evidence gate (design.md D3/D4; spec "Declared non-import
// relationships carry mechanical evidence"). Pure logic over the model's
// declared `relationships` plus an injected file reader — the live-repo
// wiring (real `readFileSync` rooted at the repo root) lives in
// scripts/check.ts, mirroring model/coverage.ts and model/edges.ts's split
// (spec "Live-repo drift gates run at build and via docs:check").

import type { ComponentModel, Relationship } from './components';

export interface RelationshipIssue {
  kind: 'missing-file' | 'unmatched-literal' | 'dangling-component';
  message: string;
}

function relationshipRef(relationship: Relationship): string {
  return `"${relationship.id}" (${relationship.from} → ${relationship.to})`;
}

/**
 * Checks every declared relationship's evidence rules against `readFile` (a
 * repo-relative-path → file-contents lookup, undefined when the file doesn't
 * exist). Each evidence entry must exist and contain every literal in
 * `mustContain`; a failing entry names the relationship AND that entry's
 * rule (spec: "Unevidenced relationship fails ... naming the relationship
 * and its evidence rule"). Also fails a relationship whose `from`/`to` names
 * a component absent from the model — a dangling reference the evidence
 * check alone wouldn't catch.
 */
export function checkRelationshipEvidence(
  model: ComponentModel,
  readFile: (repoRelativePath: string) => string | undefined,
): RelationshipIssue[] {
  const issues: RelationshipIssue[] = [];
  const componentNames = new Set(model.components.map((component) => component.name));

  for (const relationship of model.relationships) {
    for (const endpoint of ['from', 'to'] as const) {
      const name = relationship[endpoint];
      if (!componentNames.has(name)) {
        issues.push({
          kind: 'dangling-component',
          message:
            `Relationship ${relationshipRef(relationship)} names ${endpoint} component ` +
            `"${name}", which does not exist in the model.`,
        });
      }
    }

    for (const evidence of relationship.evidence) {
      const contents = readFile(evidence.file);
      if (contents === undefined) {
        issues.push({
          kind: 'missing-file',
          message:
            `Relationship ${relationshipRef(relationship)}: evidence file "${evidence.file}" ` +
            'does not exist.',
        });
        continue;
      }
      for (const literal of evidence.mustContain) {
        if (!contents.includes(literal)) {
          issues.push({
            kind: 'unmatched-literal',
            message:
              `Relationship ${relationshipRef(relationship)}: evidence file "${evidence.file}" ` +
              `does not contain the required literal "${literal}".`,
          });
        }
      }
    }
  }

  return issues.sort((a, b) => a.message.localeCompare(b.message));
}

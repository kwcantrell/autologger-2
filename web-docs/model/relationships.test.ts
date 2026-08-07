import { describe, expect, it } from 'vitest';
import type { ComponentModel, Relationship } from './components';
import { checkRelationshipEvidence } from './relationships';

const defaultComponents: ComponentModel['components'] = [
  {
    name: 'alpha',
    kind: 'runtime',
    description: '',
    globs: [],
    capabilities: [],
    authoredDiagrams: [],
  },
  {
    name: 'beta',
    kind: 'runtime',
    description: '',
    globs: [],
    capabilities: [],
    authoredDiagrams: [],
  },
];

function baseModel(overrides: Partial<ComponentModel> = {}): ComponentModel {
  return {
    components: defaultComponents,
    relationships: [],
    capabilityScopes: [],
    exclusions: [],
    ...overrides,
  };
}

function relationship(
  overrides: Partial<Relationship> & Pick<Relationship, 'id' | 'evidence'>,
): Relationship {
  return { from: 'alpha', to: 'beta', label: 'a relationship', ...overrides };
}

const files: Record<string, string> = {
  'alpha/client.ts': "export function go() { return fetch('/x'); }",
  'alpha/socket.ts': "const ws = new WebSocket('ws://x');",
};

function readFile(file: string): string | undefined {
  return files[file];
}

describe('checkRelationshipEvidence — pure evidence checks (synthetic fixtures)', () => {
  it('is clean when every evidence file exists and contains every mustContain literal', () => {
    const model = baseModel({
      relationships: [
        relationship({
          id: 'alpha-to-beta',
          evidence: [{ file: 'alpha/client.ts', mustContain: ['fetch('] }],
        }),
      ],
    });
    expect(checkRelationshipEvidence(model, readFile)).toEqual([]);
  });

  it('passes a multi-file relationship only when EVERY evidence entry passes', () => {
    const model = baseModel({
      relationships: [
        relationship({
          id: 'alpha-to-beta',
          evidence: [
            { file: 'alpha/client.ts', mustContain: ['fetch('] },
            { file: 'alpha/socket.ts', mustContain: ['new WebSocket('] },
          ],
        }),
      ],
    });
    expect(checkRelationshipEvidence(model, readFile)).toEqual([]);
  });

  it('fails naming the relationship and the missing-file evidence rule', () => {
    const model = baseModel({
      relationships: [
        relationship({
          id: 'alpha-to-beta',
          evidence: [{ file: 'alpha/does-not-exist.ts', mustContain: ['fetch('] }],
        }),
      ],
    });
    const issues = checkRelationshipEvidence(model, readFile);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('alpha-to-beta');
    expect(issues[0]?.message).toContain('alpha/does-not-exist.ts');
    expect(issues[0]?.message).toContain('does not exist');
  });

  it('fails naming the relationship and the unmatched literal when the file exists but lacks the pattern', () => {
    const model = baseModel({
      relationships: [
        relationship({
          id: 'alpha-to-beta',
          evidence: [{ file: 'alpha/client.ts', mustContain: ['XMLHttpRequest('] }],
        }),
      ],
    });
    const issues = checkRelationshipEvidence(model, readFile);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('alpha-to-beta');
    expect(issues[0]?.message).toContain('alpha/client.ts');
    expect(issues[0]?.message).toContain('XMLHttpRequest(');
  });

  it('reports one issue per failing evidence entry when a multi-file relationship partially fails', () => {
    const model = baseModel({
      relationships: [
        relationship({
          id: 'alpha-to-beta',
          evidence: [
            { file: 'alpha/client.ts', mustContain: ['fetch(', 'XMLHttpRequest('] },
            { file: 'alpha/socket.ts', mustContain: ['new WebSocket('] },
          ],
        }),
      ],
    });
    const issues = checkRelationshipEvidence(model, readFile);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('XMLHttpRequest(');
  });
});

describe('checkRelationshipEvidence — dangling component references', () => {
  it('fails naming a relationship whose "from" component does not exist in the model', () => {
    const model = baseModel({
      components: [
        {
          name: 'beta',
          kind: 'runtime',
          description: '',
          globs: [],
          capabilities: [],
          authoredDiagrams: [],
        },
      ],
      relationships: [
        relationship({
          id: 'ghost-to-beta',
          from: 'ghost',
          to: 'beta',
          evidence: [{ file: 'alpha/client.ts', mustContain: ['fetch('] }],
        }),
      ],
    });
    const issues = checkRelationshipEvidence(model, readFile);
    expect(issues.some((issue) => issue.message.includes('ghost'))).toBe(true);
  });

  it('fails naming a relationship whose "to" component does not exist in the model', () => {
    const model = baseModel({
      components: [
        {
          name: 'alpha',
          kind: 'runtime',
          description: '',
          globs: [],
          capabilities: [],
          authoredDiagrams: [],
        },
      ],
      relationships: [
        relationship({
          id: 'alpha-to-ghost',
          to: 'ghost',
          evidence: [{ file: 'alpha/client.ts', mustContain: ['fetch('] }],
        }),
      ],
    });
    const issues = checkRelationshipEvidence(model, readFile);
    expect(issues.some((issue) => issue.message.includes('ghost'))).toBe(true);
  });
});

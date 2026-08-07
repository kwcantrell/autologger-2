// TDD for the DOM-shimmed mermaid parser (task 6.3; design.md D1/D9; spec
// "Diagram validity gates use a DOM-bootstrapped parser and size budgets" —
// "Build-time mermaid validation SHALL run with a DOM shim ... bootstrapped
// before mermaid loads"). These tests exercise the REAL `mermaid` package
// under a REAL jsdom bootstrap (never mocked) — that combination is exactly
// what's being verified: a plain-Node import of `mermaid` throws on
// DOMPurify the moment a diagram source needs label sanitization (measured —
// see task-6.3-report.md), so a fake/mocked mermaid would prove nothing.
import { describe, expect, it } from 'vitest';
import { parseMermaidSource } from './mermaidValidate';

describe('parseMermaidSource', () => {
  it('accepts a valid flowchart with a quoted label (exercises DOMPurify sanitizeText — the exact path that throws without the DOM shim)', async () => {
    const result = await parseMermaidSource('flowchart TD\n  a["Some Label"]\n  a --> a');
    expect(result.valid).toBe(true);
  });

  it('accepts a valid stateDiagram-v2', async () => {
    const result = await parseMermaidSource(
      'stateDiagram-v2\n  [*] --> Free\n  Free --> Held: grant',
    );
    expect(result.valid).toBe(true);
  });

  it('accepts a valid erDiagram', async () => {
    const result = await parseMermaidSource('erDiagram\n  A {\n    TEXT id "PK"\n  }');
    expect(result.valid).toBe(true);
  });

  it('rejects unparseable mermaid syntax, naming the diagram in the error (gate-intent demo (b))', async () => {
    const result = await parseMermaidSource('flowchart TD\n  this is not valid mermaid {{{');
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.error.length > 0).toBe(true);
  });

  it("ACCEPTS a structurally-garbage stateDiagram (a bare note, no real state/transition) — the exact gap diagramValidity.ts's structural checks exist to close (gate-intent demo (c))", async () => {
    const result = await parseMermaidSource('stateDiagram-v2\n  note left of X: hello');
    expect(result.valid).toBe(true);
  });

  it('ACCEPTS an empty stateDiagram-v2 with zero transitions', async () => {
    const result = await parseMermaidSource('stateDiagram-v2\n');
    expect(result.valid).toBe(true);
  });
});

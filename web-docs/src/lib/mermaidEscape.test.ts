import { describe, expect, it } from 'vitest';
import { escapeMermaidLabel } from './mermaidEscape';

describe('escapeMermaidLabel', () => {
  it('leaves ordinary text untouched', () => {
    expect(escapeMermaidLabel('session-databases')).toBe('session-databases');
  });

  it('escapes a literal double quote so it cannot terminate the label early', () => {
    const result = escapeMermaidLabel('the "recording lease" store');
    expect(result).not.toContain('"');
    expect(result).toContain('#quot;recording lease#quot;');
  });

  it('escapes literal # so a hostile string cannot construct its own mermaid entity', () => {
    // Without escaping # first, a hostile "#quot;" substring would survive
    // verbatim and could be re-interpreted as this function's own escape
    // output by a downstream consumer that naively string-replaces once.
    const hostile = '#quot;><script>alert(1)</script>';
    const result = escapeMermaidLabel(hostile);
    // Every literal '#' in the input became '#35;' — the entity that
    // renders back to a literal '#', not the raw injected quote-entity.
    expect(result).toBe('#35;quot;><script>alert(1)</script>');
    expect(result.match(/#35;/g)).toHaveLength(1);
  });

  it('escapes a literal pipe so it cannot break a |label| edge delimiter', () => {
    const result = escapeMermaidLabel('a | b');
    expect(result).not.toContain('|');
    expect(result).toBe('a #124; b');
  });

  it('collapses embedded newlines (CRLF, LF, CR) into a single space', () => {
    expect(escapeMermaidLabel('line one\nline two')).toBe('line one line two');
    expect(escapeMermaidLabel('line one\r\nline two')).toBe('line one line two');
    expect(escapeMermaidLabel('line one\rline two')).toBe('line one line two');
  });

  it('trims leading/trailing whitespace after newline collapsing', () => {
    expect(escapeMermaidLabel('  padded  ')).toBe('padded');
  });

  it('handles a string combining every hostile character at once', () => {
    const hostile = 'name "with" a | pipe #and a\nnewline';
    const result = escapeMermaidLabel(hostile);
    expect(result).not.toMatch(/["|]/);
    expect(result).not.toContain('\n');
    expect(result).toBe('name #quot;with#quot; a #124; pipe #35;and a newline');
  });

  it("does not escape angle brackets — htmlLabels:false + strict mode is that layer's job", () => {
    expect(escapeMermaidLabel('<b>bold</b>')).toBe('<b>bold</b>');
  });
});

import { describe, expect, it } from 'vitest';
import { MERMAID_CLIENT_CONFIG } from './mermaidConfig';

describe('MERMAID_CLIENT_CONFIG', () => {
  it('locks securityLevel to strict and htmlLabels off — the XSS mitigation design.md D1 requires', () => {
    expect(MERMAID_CLIENT_CONFIG.securityLevel).toBe('strict');
    expect(MERMAID_CLIENT_CONFIG.htmlLabels).toBe(false);
  });

  it('never auto-starts (the site renders explicitly from atlas data, not DOM auto-scan)', () => {
    expect(MERMAID_CLIENT_CONFIG.startOnLoad).toBe(false);
  });
});

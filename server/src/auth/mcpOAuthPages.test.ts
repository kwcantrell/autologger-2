// The MCP OAuth pages (custom dashboards J3; design sections 4.2 and 4.4): the CSP names the one
// inline style by its hash, and client-supplied text is escaped.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { consentPage, errorPage, MCP_PAGE_CSP, MCP_PAGE_STYLE, returnPage } from './mcpOAuthPages';

const styleHash = createHash('sha256').update(MCP_PAGE_STYLE).digest('base64');

describe('MCP OAuth pages', () => {
  it('the CSP is the design 4.2 policy with the inline style hash', () => {
    expect(MCP_PAGE_CSP).toBe(
      `default-src 'none'; style-src 'sha256-${styleHash}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    );
  });

  it('every page holds exactly the hashed style and loads nothing', async () => {
    const pages = [
      await consentPage({
        email: 'a@b.com',
        clientName: 'Claude',
        redirectHost: 'claude.ai',
        requestId: 'r',
        csrf: 'c',
      }),
      await returnPage('https://claude.ai/cb?code=x&state=y', 'claude.ai'),
      await errorPage('Oops', 'Start again.'),
    ];
    for (const p of pages) {
      expect(p).toContain(`<style>${MCP_PAGE_STYLE}</style>`);
      expect(p.match(/<style/g)?.length).toBe(1);
      expect(p).not.toMatch(/<script|<link|<img|<iframe|src=/);
    }
  });

  it('escapes the client name, email and host', async () => {
    const p = await consentPage({
      email: '"><script>alert(1)</script>',
      clientName: '<img src=x onerror=alert(1)>',
      redirectHost: 'evil"host',
      requestId: '"r',
      csrf: "'c",
    });
    expect(p).not.toContain('<script>alert');
    expect(p).not.toContain('<img src=x');
    expect(p).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(p).toContain('evil&quot;host');
    expect(p).toContain('value="&quot;r"');
  });

  it('the returning page has a meta refresh and a link to the same escaped URL', async () => {
    const p = await returnPage('https://claude.ai/cb?code=a&state=b"c', 'claude.ai');
    expect(p).toContain(
      '<meta http-equiv="refresh" content="0; url=https://claude.ai/cb?code=a&amp;state=b&quot;c">',
    );
    expect(p).toContain(
      '<a href="https://claude.ai/cb?code=a&amp;state=b&quot;c">Continue to claude.ai</a>',
    );
  });
});

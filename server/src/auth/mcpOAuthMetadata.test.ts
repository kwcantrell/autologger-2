// The MCP OAuth identifiers (design section 4.1).
import type { Config } from '@autologger/ports';
import { describe, expect, it } from 'vitest';
import { mcpIssuer, mcpResource } from './mcpOAuthMetadata';

const cfg = (url: string) => ({ PUBLIC_BASE_URL: url }) as unknown as Config;

describe('issuer and resource (design 4.1)', () => {
  it('are the public origin without a trailing slash, and it plus /mcp', () => {
    expect(mcpIssuer(cfg('https://app.example.com/'))).toBe('https://app.example.com');
    expect(mcpResource(cfg('https://app.example.com'))).toBe('https://app.example.com/mcp');
  });
});

// Task 7.3 — the membership-bootstrap template's config parser. Pure, so it runs in the unit tier
// (moved from bootstrapMemberships.int.test.ts, which drives the template against the real app).
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../scripts/bootstrapMemberships.example';

describe('bootstrapMemberships parseConfig', () => {
  it('parseConfig rejects malformed input', () => {
    expect(() => parseConfig({})).toThrow();
    expect(() =>
      parseConfig({ memberships: [{ email: 'a@b.c', team: 'x', role: 'root' }] }),
    ).toThrow();
  });
});

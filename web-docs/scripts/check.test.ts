import { describe, expect, it } from 'vitest';
import { gatesNotYetImplementedMessage } from './check';

describe('gatesNotYetImplementedMessage', () => {
  it('names the gates as not yet implemented, never silently passing as if checked', () => {
    expect(gatesNotYetImplementedMessage()).toContain('gates not yet implemented');
  });
});

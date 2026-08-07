import { describe, expect, it } from 'vitest';
import * as ports from './index';

// @autologger/ports ships types/interfaces only (design D2/D3; spec
// "Ports package is interface-only and closed") — no runtime
// implementations. This is the package's own falsifiable guard: import the
// barrel and assert it has no runtime exports (type-only exports vanish
// under verbatimModuleSyntax, so any surviving key would be a real value).
describe('@autologger/ports', () => {
  it('the package barrel exports no runtime values', () => {
    expect(Object.keys(ports)).toEqual([]);
  });
});

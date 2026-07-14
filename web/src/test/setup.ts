import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// `@testing-library/react`'s automatic afterEach cleanup only self-registers
// when it detects a global `afterEach` (jest-style globals); this workspace's
// vitest config does not set `test.globals: true` (tests import `afterEach`
// etc. explicitly from 'vitest' instead), so cleanup must be wired up here.
// Without it, DOM nodes from one test's render() leak into the next test in
// the same file — any multi-test/multi-render file in the tier hits this.
afterEach(() => {
  cleanup();
});

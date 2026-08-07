import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom has no matchMedia; the shared `useIsMobile` breakpoint hook (Dialog,
// AppShell, ShortcutsDialog) calls it on mount. A minimal never-matches stub
// keeps components-under-test on the desktop branch.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// Node >= 22 defines an experimental `localStorage` accessor on globalThis that
// yields undefined unless `--localstorage-file` is passed; under vitest's jsdom
// environment (where `window` IS globalThis) it shadows jsdom's Storage, so
// `window.localStorage` comes back undefined. Install a minimal in-memory
// Storage so browser-truthful localStorage code (e.g. dashboardPersistence's
// default backend, AiChat) behaves as it does in real browsers.
if (typeof window !== 'undefined' && !window.localStorage) {
  const store = new Map<string, string>();
  const storageStub: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(String(key), String(value));
    },
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storageStub,
  });
}

// `@testing-library/react`'s automatic afterEach cleanup only self-registers
// when it detects a global `afterEach` (jest-style globals); this workspace's
// vitest config does not set `test.globals: true` (tests import `afterEach`
// etc. explicitly from 'vitest' instead), so cleanup must be wired up here.
// Without it, DOM nodes from one test's render() leak into the next test in
// the same file — any multi-test/multi-render file in the tier hits this.
afterEach(() => {
  cleanup();
});

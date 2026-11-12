// The one way test code builds server bindings. `createBindings` resolves
// `AI_V2_CREDENTIAL_SOURCE_PATH` and `AI_CHAT_CLI_HOME` from `homedir()` (which reads
// `process.env.HOME` on Linux) once, at construction, so for that one call `HOME` points at a fresh
// empty temp dir, removed straight after: no test can read the operator's real
// `~/.claude/.credentials.json`. A guard test (bindings.test.ts) keeps every other test file off
// `createBindings` itself.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBindings } from '../node/config';

export type TestBindings = ReturnType<typeof createBindings> & {
  /** The (already removed) stand-in home the bindings were built under. */
  home: string;
};

export function testBindings(...args: Parameters<typeof createBindings>): TestBindings {
  const home = mkdtempSync(join(tmpdir(), 'autologger-test-home-'));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return { ...createBindings(...args), home };
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  }
}

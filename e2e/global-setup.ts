import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Wipe the e2e server state before the webServer boots — a crashed prior run
 * (SIGKILL teardown) must not leak DBs/WAL files into this run. */
export default function globalSetup(): void {
  rmSync(join(dirname(fileURLToPath(import.meta.url)), '.data'), {
    recursive: true,
    force: true,
  });
}

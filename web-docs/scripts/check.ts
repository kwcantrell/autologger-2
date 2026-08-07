// Placeholder `docs:check` entry point (tasks 1.1/1.2). Root `npm run docs:check`
// invokes `npm run check -w web-docs`, which runs this file under `tsx`. The real
// extraction pipeline + gate battery (component coverage, edge snapshot,
// relationship evidence, capability accounting, diagram validity — see
// design.md D4) lands in later phases; this stub keeps the root `docs:check`
// wiring green until then, and exits 0 so it never falsely reports drift.
import { fileURLToPath } from 'node:url';

export function gatesNotYetImplementedMessage(): string {
  return 'web-docs: gates not yet implemented — extraction pipeline lands in later phases.';
}

function isDirectRun(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  console.log(gatesNotYetImplementedMessage());
  process.exit(0);
}

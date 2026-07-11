// Fail the build if @companion-module/base resolves outside Companion 4.3.4's
// accepted module-API range (~0.6 || 1 - 1.14.x || 2 - 2.0.x).
//
// Workspace-hoisting hazard: this script's require.resolve() runs from
// companion/scripts/, so in an npm workspace it can resolve a *different*
// copy of @companion-module/base than other tools do. Notably,
// `companion-module-build` (invoked by `npm run package -w companion`, from
// @companion-module/tools) resolves the framework package from ITS OWN
// location (node_modules/@companion-module/tools/scripts/lib/), which climbs
// to the workspace ROOT node_modules — not companion/node_modules. Without
// the root-level npm `overrides` entry in the top-level package.json pinning
// @companion-module/base to ~1.14.0, root node_modules can end up hoisting a
// *different major* of @companion-module/base (pulled in transitively by
// @companion-module/tools' own deps), so `companion-module-build` bakes the
// wrong runtime.apiVersion into the packaged manifest even though this
// script (and `companion/`'s own compiled code) sees the correct pinned
// version. If this check ever starts passing while `npm run package -w
// companion`'s output manifest disagrees, suspect that override having been
// dropped or a dependency bump reintroducing a second hoisted copy.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('@companion-module/base/package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [major, minor] = version.split('.').map(Number);

const ok =
  (major === 0 && minor === 6) ||
  (major === 1 && minor <= 14) ||
  (major === 2 && minor === 0);

if (!ok) {
  console.error(
    `@companion-module/base ${version} is outside Companion 4.3.4's accepted range ` +
      `(~0.6 || 1 - 1.14.x || 2 - 2.0.x). Pin to ~1.14.0 (stable 1.x).`,
  );
  process.exit(1);
}
console.log(`@companion-module/base ${version} OK for Companion 4.3.4.`);

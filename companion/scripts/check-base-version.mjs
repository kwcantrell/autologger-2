// Fail the build if @companion-module/base resolves outside Companion 4.3.4's
// accepted module-API range (~0.6 || 1 - 1.14.x || 2 - 2.0.x).
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
      `(~0.6 || 1 - 1.14.x || 2 - 2.0.x). Pin to ~2.0.0.`,
  );
  process.exit(1);
}
console.log(`@companion-module/base ${version} OK for Companion 4.3.4.`);

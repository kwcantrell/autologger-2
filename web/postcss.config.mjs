import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// `base` pins Tailwind v4's automatic source detection (the scan that decides
// which utility classes get emitted) to THIS directory — the web app root —
// instead of the plugin's default of `process.cwd()` (verified against the
// installed @tailwindcss/postcss dist: `e.base ?? process.cwd()`;
// dev-layout-fix, nextjs-frontend-migration).
//
// Why cwd is wrong here: `next build` runs with cwd `web/` (npm -w web), but
// the DEV server embeds next({ dev: true }) inside the backend process, whose
// cwd is `server/` (`npm run dev -w server`). With the default, dev scanned
// `server/` for class candidates, found none of the app's utility classes,
// and emitted a utilities layer missing everything `web/src/**` uses —
// rendering every utility-styled component unstyled in dev while prod stayed
// pixel-perfect. For prod builds `base` equals what cwd already was, so prod
// output is byte-unchanged (visual suites stay zero-diff).
const config = {
  plugins: {
    '@tailwindcss/postcss': {
      base: dirname(fileURLToPath(import.meta.url)),
    },
  },
};

export default config;

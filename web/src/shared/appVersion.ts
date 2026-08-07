// Named JSON import — Vite tree-shakes this to just the `version` field, so
// the rest of package.json (dependency names, scripts) stays out of the bundle.
import { version } from '../../package.json';

/** App version from `web/package.json` (kept aligned with the root package). */
export const APP_VERSION: string = version;

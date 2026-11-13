// Tailwind v4's class-candidate scan root is declared in the stylesheet, not here:
// `@import 'tailwindcss/utilities.css' ... source('../../..')` in
// src/shared/theme/tailwind.css (job 014), which explains why. This config used to pass the
// plugin a `base` derived from `import.meta.url`. Under Next 16, Turbopack evaluates this file with
// an `import.meta.url` of `web/web/postcss.config.mjs`, so that `base` named a missing directory
// and no utility class was emitted. With a `source()` root in the stylesheet, the plugin uses
// `base` only as a cache key, so the option is gone.
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;

# Changelog

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.7.0] — 2026-07-10

### Added
- Bitfocus Companion module (`companion/` workspace): log events by category, roll/stop
  takes, record/play the active session, with live feedbacks (rolling/recording/playing/
  session-active) and variables (timecode, take, deck title, command delivery, …). Pure
  client of the existing `/api/companion/*` endpoints; polls state with post-action
  refresh. Includes a headless-Companion Playwright e2e harness.

### Fixed
- Root `package.json` `overrides` pins `@companion-module/base` to `~1.14.0` across the
  workspace so `npm run package` bakes the correct `runtime.apiVersion` into the Companion
  module bundle (previously a hoisted transitive `2.0.4` from `@companion-module/tools`
  produced an unloadable package).

## [0.6.0] — 2026-07-10

### Changed

- Frontend styling system migrated from CSS Modules + plain shared CSS to **Tailwind
  v4**: 23 `*.module.css` files (7,329 lines) plus the four-file plain-CSS theme layer
  (`tokens.css`, `baseline.css`, `chrome.css`, `bgGlow.css`) collapsed into a single
  `web/src/shared/theme/tailwind.css` entry (theme tokens, base, components, utilities
  layers). Zero `.module.css` files remain under `web/src/`.
- Visual parity verified against 44 frozen two-viewport (desktop 1280×720, mobile
  390×844) baselines captured before conversion began; all 44 pass on the post-migration
  build.
- The screenshot regression harness (`e2e/visual.spec.ts`) is kept permanently as the
  opt-in `npm run e2e:visual` Playwright project, excluded from default `npm run e2e`
  (gate decision E-1). Its campaign-only constraints are lifted: the frozen-baseline
  re-capture policy now allows re-baselining any affected shot with a reviewed
  before/after diff, and `@playwright/test` is back to a caret range (`^1.61.1`) instead
  of the exact pin used during the migration.
- Fonts (Inter, Oswald, Roboto, Poppins, League Gothic, Chivo Mono) and `animate.css` are
  vendored locally — no CDN requests at runtime.

### Fixed

- Purged dead CSS discovered during the migration's stage-0a dead-rule audit and an
  unrealized `glass` `ThemeContext` indirection (581 deleted lines across 15 files),
  including 12 unreachable `#modal-app-settings`-prefixed rules with no remaining
  renderer. Confirmed no-op against the frozen visual baselines.
- Fixed a marquee overflow toggle that collided with Tailwind's own core `inline`
  utility (a bare `.inline` class conversion had silently picked up Tailwind's
  `display: inline` instead of the intended legacy rule) — resolved with an explicit
  `[display:inline]` arbitrary value, verified against a computed-style check.
- Restored a `pointer-events: none` declaration on the transport control icon
  (`TransportControls.tsx`'s `CTRL_ICON`) that had been silently dropped during its
  initial conversion.

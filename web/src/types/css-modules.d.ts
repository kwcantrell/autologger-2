// Plain side-effect CSS imports (tailwind.css entry, vendor css). TS 6 (TS2882)
// requires an ambient declaration even for import-for-side-effect.
//
// The former `*.module.css` declaration was removed in Task 11: with chrome/
// baseline/tokens/bgGlow/perfDebug all converted, zero CSS-Modules files remain
// (`find web/src -name '*.module.css'` is empty), and `css.modules` was dropped
// from vite.config.ts.
declare module '*.css';

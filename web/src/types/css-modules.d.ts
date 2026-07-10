declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}

// Plain side-effect CSS imports (theme/baseline/chrome, vendor css). TS 6
// (TS2882) requires an ambient declaration even for import-for-side-effect.
// The more specific '*.module.css' pattern above still wins for CSS Modules.
declare module '*.css';

// The ONLY reference to './thing' in this file is a `typeof import(...)`
// type position — no value-level ImportDeclaration exists. This is the
// case a plain ImportDeclaration/ExportDeclaration/dynamic-import() walk
// misses entirely.
export type ThingModule = typeof import('./thing');

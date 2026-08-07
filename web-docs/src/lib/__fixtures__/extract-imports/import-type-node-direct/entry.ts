// The ONLY reference to './thing' in this file is a direct (non-`typeof`)
// `import('...').Member` type position.
export type ThingRef = import('./thing').Thing;

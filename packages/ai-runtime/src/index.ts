// @autologger/ai-runtime package entry (openspec/changes/ai-runtime-package
// task 3.1). The 13 production modules formerly split across
// `server/src/ai-runtime/` and `server/src/aiV2/` now live beside this file,
// moved in one dispatch unit spanning both directories (design D1/D8).
// Depends on `@autologger/domain`, `@autologger/contract`,
// `@autologger/session-core`, and `@autologger/ports` — `ports` is not
// optional here: design D3 threads a required, leading `Clock` through six
// in-package signatures, giving five moved modules a type-only import of
// `Clock` from `@autologger/ports` that the pre-change edge inventory (this
// package does not exist on `main`) does not show.
//
// DELIBERATELY NOT A GOD-BARREL, unlike @autologger/transcription's and
// @autologger/media-import's entries: this package's production modules are
// consumed through the `"./*"` SUBPATH export
// (`@autologger/ai-runtime/<module>`), never re-exported from here. Gate
// ruling E4 chose subpath over barrel because four server integration suites
// `vi.spyOn` a MODULE NAMESPACE (`aiV2.int.test.ts` alone carries three such
// spies on `aiV2SdkSpawn`), which intercepts a router's call only when both
// sides resolve to the SAME module record — so every router and its
// integration test import the identical `@autologger/ai-runtime/<module>`
// specifier, and a re-export barrel that offered a second route to the same
// symbols would make that fragile. What this barrel exports is exactly the
// one thing with no module-identity stake: the fixtures-directory constant,
// which app-side integration tests import from `@autologger/ai-runtime`
// (matching the transcription/media-import precedent) while in-package tests
// import it from `./fixturesDir` directly.
export * from './fixturesDir';

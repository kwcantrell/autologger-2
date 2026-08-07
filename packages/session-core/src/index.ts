// @autologger/session-core package entry (persistence-package-extraction
// task 4.3). The per-session live spine — SessionHub + registry, SessionCore
// + the SessionRuntime seam, the seven domain stores (audio/dashboard/event/
// lease/topic/transcript/transport), eventAnchors, audioSeamParts, and
// storeHelpers — moved verbatim from server/src/session/. Depends on
// @autologger/domain, @autologger/contract, @autologger/ports;
// better-sqlite3 as a peerDependency (design D1/D5) — the server workspace
// remains the installing dependency, so there is exactly one resolved copy
// in the tree (load-bearing for the `DashboardValidationError`/
// `DashboardBoundsError` → 422 `instanceof` mapping).
//
// `SessionHub.ts`'s own re-exports (`AudioSegmentMeta`, `StoredDashboard`,
// `DashboardBoundsError`/`DashboardValidationError`, `SessionProjection`/
// `TransportState`, `Topic`, `TranscriptWord`) coexist with this barrel's
// separate `export *` from each of those same modules — both point at the
// identical underlying bindings, so there is no `export *` ambiguity
// (verified: `tsc --noEmit -p packages/session-core` is clean; same
// coexistence `@autologger/catalog`'s barrel already relies on).

export * from './audioSeamParts';
export * from './audioStore';
export * from './dashboardStore';
export * from './eventAnchors';
export * from './eventStore';
export * from './leaseStore';
export * from './SessionHub';
export * from './sessionCore';
export * from './storeHelpers';
export * from './topicStore';
export * from './transcriptStore';
export * from './transportStore';

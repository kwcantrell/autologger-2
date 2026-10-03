// @autologger/session-core package entry (persistence-package-extraction
// task 4.3). The per-session live spine — SessionHub + registry, SessionCore
// + the SessionRuntime seam, the seven domain stores (audio/dashboard/event/
// lease/topic/transcript/transport), eventAnchors, audioSeamParts, and
// storeHelpers — moved verbatim from server/src/session/. Depends on
// @autologger/domain, @autologger/contract, @autologger/ports, and on no
// database driver: its storage (the Postgres session adapter) is supplied by
// the composition root (session-tables design D9).
//
// `SessionHub.ts`'s own re-exports (`AudioSegmentMeta`, `StoredDashboard`,
// `DashboardBoundsError`/`DashboardValidationError`, `SessionProjection`/
// `TransportState`, `Topic`, `TranscriptWord`) coexist with this barrel's
// separate `export *` from each of those same modules — both point at the
// identical underlying bindings, so there is no `export *` ambiguity
// (verified: `tsc --noEmit -p packages/session-core` is clean; same
// coexistence `@autologger/catalog`'s barrel already relies on).

export * from './asyncSessionSql';
export * from './audioSeamParts';
export * from './audioStore';
export * from './dashboardStore';
export * from './eventAnchors';
export * from './eventStore';
export * from './fifoLock';
export * from './leaseStore';
export * from './SessionHub';
export * from './sessionCore';
export * from './storeHelpers';
export * from './topicStore';
export * from './transcriptStore';
export * from './transportStore';

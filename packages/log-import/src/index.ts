// @autologger/log-import package entry (feature-service-packages task 5.3).
// Google Sheets batch log-import domain logic — categoryMatch.ts (fuzzy
// category-name matching), jobStore.ts (the in-memory job-status store,
// Clock-parameterized since task 5.2), runSessionLogImport.ts (sync scoring
// + event creation against one matched session), sheetsFetch.ts (public
// workbook fetch + row parse, via exceljs), sheetTimecode.ts (SMPTE timecode
// parsing for sheet rows), syncScore.ts (log-row-to-transcript-seam sync
// scoring) — moved verbatim from server/src/logImport/. The router-level
// coordinator (`ensureTimedTranscript`) stays in `routers/logImport.ts`
// (task 5.1 — a Hono-importing module can't live in this package). Depends
// on @autologger/domain, @autologger/ports, and @autologger/session-core
// (design D1); exceljs is declared here AND by server/package.json (gate
// ruling E1 — routers/logImport.int.test.ts imports it directly to build a
// workbook fixture and stays in the app).

export * from './categoryMatch';
export * from './jobStore';
export * from './runSessionLogImport';
export * from './sheetsFetch';
export * from './sheetTimecode';
export * from './syncScore';

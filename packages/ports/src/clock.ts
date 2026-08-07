// The single Clock port (spec: core-ports-architecture). Every decision-making
// time read — lease staleness/expiry, alarm scheduling, live timecode, KV TTL,
// presence freshness, JWKS cache TTL — goes through an injected Clock so tests
// can advance time without waiting. One coherent time source app-wide.
//
// Interface only (package-split-foundation design D2/D3): the real adapter
// (`systemClock`) lives at the composition side, `server/src/node/systemClock.ts`
// — this package ships no runtime implementations.

export interface Clock {
  now(): number;
}

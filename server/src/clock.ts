// The single Clock port (spec: core-ports-architecture). Every decision-making
// time read — lease staleness/expiry, alarm scheduling, live timecode, KV TTL,
// presence freshness, JWKS cache TTL — goes through an injected Clock so tests
// can advance time without waiting. One coherent time source app-wide.

export interface Clock {
  now(): number;
}

/** The real adapter. */
export const systemClock: Clock = { now: () => Date.now() };

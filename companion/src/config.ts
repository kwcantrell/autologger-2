// Stub — replaced by Task 2, which adds getConfigFields(), normalizeBaseUrl(),
// and clampPollMs() via TDD. Exists here only so Task 1's upgrades.ts import
// resolves and `npm run typecheck -w companion` passes in isolation.
export interface ModuleConfig {
  url: string;
  token: string;
  pollMs: number;
}

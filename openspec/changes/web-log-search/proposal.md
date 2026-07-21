# Proposal: web-log-search (DRAFT — queued by the ui-refresh gate, 2026-07-21)

> Status: draft proposal only — not fact-checked, not paneled, not gated. Queued by the
> `ui-refresh` gate's D3 ruling. Sequencing: after `ui-refresh` (and after
> `ai-session-analyst` is re-planned). Remaining artifacts (specs/design/tasks) are
> deliberately not drafted until this is picked up.

## Why

The `ui-refresh` change scoped the rail search honestly to a client-side session-title filter
because content search needs server support and the HTTP contract is frozen. Operators' actual
recall need — "which session had the lav rustle?" — is content search across events and
transcript words. The ui-refresh gate ruled to pursue this as its own contract-delta change.

## What Changes

- A new server search route (contract delta — e.g. `GET /api/search?q=…` over event messages
  and transcript words across the caller's visible sessions), with result shape, limits, and
  throttling/indexing decided in design (per-session SQLite fan-out is the core design
  problem).
- The rail search grows a results section: session-title matches (existing behavior) plus
  content hits deep-linking to `/sessions/:id` (and, if cheap, a seek target).

## Capabilities

### New Capabilities

- `log-search`: cross-session content search — route contract, scope/authorization (sessions
  visible to the caller only), result shape, and the client results UI.

### Modified Capabilities

- `api-contract-freeze` interaction: the freeze requires this change's delta spec to authorize
  the new route (that is the point of doing it as its own change).
- `web-home-launch`: the rail-search requirement gains the results section.

## Impact

Server (new route + tests) + web (rail search results UI). Authorization posture must match
the existing session-visibility rules; spend/perf review needed for search fan-out across
per-session DBs.

## Non-Goals

- No full-text index infrastructure decisions in this proposal (design question).
- No search inside AI chat transcripts or dashboards.

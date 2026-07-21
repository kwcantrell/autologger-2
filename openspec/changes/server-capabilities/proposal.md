# Proposal: server-capabilities (DRAFT — queued by the ui-refresh gate, 2026-07-21)

> Status: draft proposal only — not fact-checked, not paneled, not gated. Queued by the
> `ui-refresh` gate's D9 ruling. Sequencing: after `ui-refresh`. Remaining artifacts
> (specs/design/tasks) are deliberately not drafted until this is picked up.

## Why

`ui-refresh` gates transcript/topic generation honestly but can only learn unavailability by
letting the first request 503 (client-side latch, reload to clear) — the frozen contract
forbade adding a capability endpoint inside that change. The gate ruled to pursue the endpoint
as its own contract-delta change so the UI is honest at first render and updates without a
reload after the operator configures the server.

## What Changes

- A new read-only capabilities route (contract delta — e.g. `GET /api/capabilities` →
  `{ transcription: boolean, topics_generate: boolean, youtube_import: boolean, … }`),
  reporting deployment-level feature availability the server already knows
  (`deepgramConfigured`, the intentionally-503 routes).
- The web client renders generation affordances from the capability payload at first paint and
  replaces `ui-refresh`'s 503 latch (the latch remains the fallback for servers predating the
  route).

## Capabilities

### New Capabilities

- `server-capabilities`: the capabilities route contract (shape, additive-evolution rule so
  new flags never break old clients) and the client's render-from-capabilities behavior.

### Modified Capabilities

- `api-contract-freeze` interaction: this change's delta spec authorizes the new route.
- `web-session-console`: the honest-gating requirement's learn-by-503 latch is superseded by
  capability-driven rendering (latch kept as fallback).

## Impact

Server (one read-only route + tests; no auth beyond the existing session posture — it leaks
only configuration booleans, but that leak is itself a design-review question) + web
(TranscribeFeed/TopicsFeed gating source swap).

## Non-Goals

- No per-user/per-team capability differences (deployment-level only).
- No live push of capability changes (poll/refetch semantics decided in design).

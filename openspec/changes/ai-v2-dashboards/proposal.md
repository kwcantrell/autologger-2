# ai-v2-dashboards — Proposal

## Why

`ai-topics-chat` (shipped 2026-07-15) turns a session's transcript into topics through a chat
panel. That is one fixed output from one fixed workflow. Operators also want to *see* a session —
who spoke and for how long, where the questions clustered, how topics laid out against the event
log — and the shape of that view differs per session and per person.

This change adds an **"AI v2"** tab where the user **designs a dashboard** conversationally.
Claude proposes design decisions as questions with rendered previews; the user picks; the result
is a saved dashboard rendered from the session's own data.

The interaction is modelled on the operator's `ask-user-question-previews` Agent SDK demo, whose
mechanic is that **`canUseTool` is an interaction channel, not just a gate**: the callback blocks,
the question reaches the browser, the user answers, and the agent continues. The reference target
for the *output* is the operator's `autologgers-demo.html` ("Autologgers — Meeting Intelligence
Demo") — read for structure only; see Non-Goals.

This change **supersedes `ai-session-analyst`** (gated 2026-07-20, never implemented). Dashboard
design is a build-an-artifact workflow, not the question-answering one that change specified.

## What Changes

- **Web — a new "AI v2" tab.** Follows the two patterns `AiPanel` already proves: panels stay
  **mounted-hidden** rather than conditionally rendered, and stream/abort state is **hoisted**
  above the panel — so switching tabs never kills an in-flight design turn. Web-only layout
  change; not contract-bearing.
- **Web — design conversation.** Question cards with option previews and a free-text fallback,
  modelled on the demo's `QuestionView`. **Catalog previews render through the same React
  components as the real dashboard**, with sample data — so a preview cannot drift from what it
  previews. This is a deliberate divergence from the demo, whose previews are model-authored HTML.
- **Web — dashboard renderer.** A grid driven by the layout DSL, one component per catalog widget
  type.
- **Server — design-turn endpoint.** `POST /api/sessions/:sessionId/ai/v2/design`, streaming as
  SSE, reusing the `ai-topics-chat` event vocabulary and its **additive-open** posture.
- **Server — answer endpoint.** `POST /api/sessions/:sessionId/ai/v2/answer` carrying
  `(turn, request, answer)`, which resolves the blocked `canUseTool` callback. **Not WebSocket:**
  the per-session WS fan-out broadcasts to every attached client including Companion
  (`ai-topics-chat` D2), and one user's design answers must not reach every viewer.
- **Server — dashboard persistence.** A saved dashboard is validated JSON config. Read and write
  endpoints; storage location decided at the gate (see design D5).
- **Server — aggregate toolset.** In-process MCP tools (`createSdkMcpServer` + `tool()`) exposing
  **computed aggregates** — speaker stats, topic timeline, event stats — rather than raw rows, so
  the agent designs against summaries instead of pulling a whole transcript into context.
- **Widget catalog + layout DSL (normative).** Claude selects widget types from a **fixed
  catalog** and emits a structured layout: grid position, size, and cross-widget interactions
  drawn from a **named vocabulary**, never free-form callbacks. Unknown types are rejected.
- **Sandboxed custom widget (normative).** The one escape hatch for genuinely custom output:
  rendered in an **`<iframe sandbox>` without `allow-same-origin`**. Model-authored markup never
  touches the authenticated DOM. This is the only path by which such markup renders at all.
- **Security lockdown (normative).** Carries forward the corrected option set from the superseded
  change: `tools: []` as the built-in denial (**not** the auto-approve `allowedTools`),
  `settingSources: []`, `strictMcpConfig: true`, a fail-closed permission mode, `cwd` pinned
  outside the repo and `DATA_DIR`, `maxBudgetUsd`, isolated `CLAUDE_CONFIG_DIR`, and
  `AskUserQuestion` plus the named SDK-infrastructure tools allowed through `canUseTool`.
- **Auth.** A configured workspace-scoped key is preferred; the operator's `claude login` is used
  when no key is configured **and** the bind is loopback, logged loudly at startup.
- **Spend bounds.** Reuses the existing turn registry (per-session single-flight + process-wide
  ceiling) plus a per-turn USD ceiling.
- **Configuration gating.** `503` unless configured, plus the open-network refusal, so a paid
  endpoint is never served anonymously on a reachable network.

## Contract impact

**Additive only.** New routes under `/api/sessions/:sessionId/ai/v2/…` authorized by this delta.
No existing endpoint, JSON shape, status code, export body, header/range semantic, or WS
message/emission semantic changes. Dashboards are read over HTTP; nothing is added to the frozen
WS fan-out.

## Non-Goals

- **No sentiment widgets in v1.** DeepGram sentiment is *requested* (`deepgram.ts`, commit
  `7f47b31`) but **never persisted** — no column, nothing under `server/src/session/`. Verified.
  Persisting it is a separate change; shipping a widget with no backing data would be a dead tile.
- **No copying from the reference dashboard.** `autologgers-demo.html` contains a **real private
  conversation** including personal and financial detail. It is a structural reference only: its
  content must never reach specs, tests, fixtures, seed data, or commits.
- **No change to the topics chat**, its CLI transport, its loopback MCP listener, or its argv
  lockdown.
- **No cross-session dashboards.** One session's data per dashboard in v1; the turn→`sessionId`
  binding stays intact.
- **No model-authored markup in the authenticated DOM.** Custom widgets render only in the
  sandboxed iframe; there is no `dangerouslySetInnerHTML` path outside it.
- **No dashboard sharing, export, or scheduled refresh** in v1.

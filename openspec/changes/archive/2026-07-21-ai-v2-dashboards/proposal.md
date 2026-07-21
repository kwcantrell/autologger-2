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
- **No agent-authored markup, anywhere (normative).** The sandboxed custom-widget iframe was
  **cut from v1 at the gate** — it was the most complex part of the change, justified only by a
  hypothesis about a feature with zero users, and it carried the whole XSS/CSP/exfiltration
  surface (this application has **no CSP at all**). Every widget renders through our components;
  agent-authored strings render as **text only**. A repo-wide assertion enforces that no
  `dangerouslySetInnerHTML` exists.
- **Agent proposes, user adjusts (normative).** A design turn produces a *starting* dashboard;
  every subsequent edit is direct manipulation with no turn. This makes the edit path a core
  requirement rather than the omission the panel found.
- **Degraded state is first-class (normative).** A widget whose backing data is absent renders an
  explicit unavailable state naming the reason — **never zeros as data**. Manual transcripts have
  no word timings and unanchored ones have zeroed timings, so this is the common case, not an edge.
- **Security lockdown (normative).** Carries the corrected option set forward, with one
  gate-accepted weakening: **the built-in set is exactly the interactive question tool** —
  `tools: []` would strip it, since it is a built-in, making the whole design conversation
  impossible. Plus `disallowedTools` naming the write/exec built-ins, `settingSources: []`,
  `strictMcpConfig: true`, a permission mode under which the question callback actually runs,
  `cwd` pinned outside the repo and `DATA_DIR`, `maxBudgetUsd`, isolated `CLAUDE_CONFIG_DIR`, and
  a bound on MCP tool-call duration.
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

- **No custom widgets / no agent-authored markup in v1.** Cut at the gate; adding it later is
  purely additive, and would first require an exact sandbox token set, a CSP with
  `connect-src 'none'`, and a `postMessage` data channel — the three things the draft lacked.
- **The data work is sequenced ahead of this change, not bundled into it.** Persisting DeepGram
  `paragraphs` and `sentiment` (both requested and currently discarded), populating word timings on
  the manual-entry path, and resolving speaker **names** rather than diarization indices are
  schema/ingest concerns with their own gates. Until they land, the affected widgets render their
  unavailable state rather than being offered as working tiles.
- **No copying from the reference dashboard.** `autologgers-demo.html` contains a **real private
  conversation** including personal and financial detail. It is a structural reference only: its
  content must never reach specs, tests, fixtures, seed data, or commits.
- **No change to the topics chat**, its CLI transport, its loopback MCP listener, or its argv
  lockdown.
- **No cross-session dashboards.** One session's data per dashboard in v1; the turn→`sessionId`
  binding stays intact.
- **No model-authored markup rendered anywhere.** There is no `dangerouslySetInnerHTML` path in
  this feature at all — enforced by a repo-wide assertion, with no sandboxed exception, because
  the custom-widget iframe was cut from v1.
- **No dashboard sharing, export, or scheduled refresh** in v1.

# ai-v2-dashboards — Delta Spec

## ADDED Requirements

### Requirement: Configuration-gated AI v2 endpoints
The AI v2 endpoints SHALL be gated on explicit configuration naming the agent executable and
enabling the feature. When the feature is unconfigured or disabled, every AI v2 route SHALL
respond `503` with an actionable JSON `{ detail }`, spawning nothing, and unconfigured deployments
SHALL be otherwise unchanged. Enabling or disabling AI v2 SHALL NOT affect the existing AI chat.
These routes are new frozen API surface authorized by this delta; no existing route, shape, status
code, or WS emission changes.

#### Scenario: Unconfigured deployment returns 503
- **WHEN** AI v2 is not configured and a client posts a design turn
- **THEN** the response is `503 { detail }` and no subprocess is spawned

#### Scenario: AI v2 disabled independently of the AI chat
- **WHEN** AI v2 is disabled but the AI chat is configured
- **THEN** AI v2 routes respond `503` and the AI chat continues to serve normally

### Requirement: Open-network refusal
Because a design turn spends the operator's credentials, AI v2 SHALL refuse to serve turns when
authentication is disabled on a reachable network: when login is disabled AND the server is bound
to a non-loopback address with no IP allowlist, AI v2 routes SHALL respond `503` with an
actionable detail, independent of the general auth gate. Loopback-bound anonymous development is
unaffected.

#### Scenario: Anonymous LAN deployment refuses design turns
- **WHEN** login is disabled and the bind is non-loopback with no allowlist
- **THEN** AI v2 routes respond `503` and no subprocess is spawned

### Requirement: Agent credentials
A configured workspace-scoped API key SHALL be used in preference to the operator's interactive
login, and the login SHALL NOT be used while a key is configured. When no key is configured, the
interactive-login fallback SHALL be permitted **only** on a loopback bind, and the server SHALL
log that it is spending the operator's personal subscription. A non-loopback deployment with no
configured key SHALL refuse to serve design turns.

#### Scenario: A configured key is preferred over the login
- **WHEN** a key is configured and a design turn runs
- **THEN** the turn authenticates with that key, not the operator's interactive login

#### Scenario: Login fallback is announced, not silent
- **WHEN** no key is configured and the server is loopback-bound
- **THEN** turns are served via the operator's login and the server logs that personal
  subscription credentials are being spent

### Requirement: Design turn contract
`POST /api/sessions/:sessionId/ai/v2/design` SHALL accept a JSON body carrying the user's message
and, optionally, an identifier resuming a previous design conversation. Checks SHALL be evaluated
in this order, matching existing session sub-routes: authentication → session resolution/scoping
(`404` for nonexistent, deleted, or out-of-studio sessions) → configuration gate and open-network
refusal (`503`) → body validation (`422` schema, `400` malformed JSON) → turn slot (`409`). No
guard path SHALL spawn a subprocess. All error bodies SHALL use the repo's `{ detail }` shape.

#### Scenario: Invalid body rejected without side effects
- **WHEN** a client posts an empty message or a body missing required fields
- **THEN** the response is `422 { detail }` and no subprocess is spawned

#### Scenario: Unauthorized session is masked as 404
- **WHEN** a caller without studio access to `:sessionId` posts a design turn, whether or not the
  feature is configured or a turn is in flight
- **THEN** the response is `404`, leaking neither configuration nor in-flight state

### Requirement: Design question round trip
During a design turn the agent MAY ask the requesting user a question. A question SHALL be
delivered only to the client that initiated that turn and SHALL NOT be broadcast to other clients
attached to the session.

Answers SHALL be submitted to a dedicated endpoint which SHALL evaluate the same guard chain as
the design endpoint, masking an inaccessible session as `404`. An answer SHALL be accepted only
when its identifiers belong to a question currently pending for that session and that turn **and
the answering principal is the same principal that initiated the turn** — access to the session
alone SHALL NOT authorize answering another user's question, because an answer determines what is
built and stored. Turn and request identifiers SHALL be generated with at least 128 bits of
entropy, so that guessing is not the operative defense. Authentication mechanisms that do not
identify an individual principal SHALL NOT be accepted on these routes.

An answer for a turn that is no longer in flight SHALL be rejected without effect, and a pending
entry SHALL be deleted when its turn ends by any path, so it cannot be resolved late.

An unanswered question SHALL NOT hold a turn open indefinitely. When the requesting client
disconnects or the turn times out, the pending question SHALL be abandoned, the turn SHALL end,
its child process SHALL be terminated, and its concurrency slot SHALL be released.

#### Scenario: A question reaches only the asking client
- **WHEN** a design turn asks a question and other clients are attached to the session
- **THEN** only the client that initiated the turn receives it

#### Scenario: A foreign answer is rejected
- **WHEN** an answer carries a turn or request identifier belonging to a different session or turn
- **THEN** it is rejected and the pending question remains unanswered

#### Scenario: A co-member cannot answer another user's question
- **WHEN** a different authenticated user with access to the same session submits an otherwise
  valid answer to a question pending for another user's turn
- **THEN** it is rejected and the question remains pending

#### Scenario: A late answer is rejected
- **WHEN** an answer arrives for a turn that has already ended
- **THEN** it is rejected without effect

#### Scenario: An abandoned question does not wedge the session
- **WHEN** a question is pending and the requesting client disconnects
- **THEN** the turn ends, its child is terminated, and its concurrency slot is released

### Requirement: Widget catalog is a closed set
Dashboards SHALL be composed from a fixed catalog of widget types. A dashboard naming a type
outside the catalog SHALL be rejected on validation and SHALL NOT be stored or rendered. A widget
type SHALL NOT be registered in the catalog unless the data it displays is derivable from stored
session data — in particular, sentiment-based widgets SHALL NOT be offered while sentiment is not
persisted, so that no offered widget can render permanently empty.

#### Scenario: An unknown widget type is rejected
- **WHEN** a dashboard configuration names a widget type not in the catalog
- **THEN** validation rejects it and nothing is stored

#### Scenario: Every offered widget can render
- **WHEN** the agent is offered the catalog
- **THEN** every type in it is backed by data derivable from stored session data

### Requirement: Data unavailability is a rendered state, never a zero
Backing data may be absent for a given session even when a widget's type is valid — transcripts
entered by hand carry no word timings, transcripts that could not be anchored to a recording carry
zeroed timings, and diarized speakers may have no resolved names. A widget whose backing data is
absent or degenerate SHALL render an **explicit unavailable state naming the reason**, and SHALL
NOT render zeros, empty series, or placeholder values as though they were measurements.

#### Scenario: A transcript without timings does not render zeros
- **WHEN** a widget depending on word timings renders for a session whose transcript has none
- **THEN** it states that timing data is unavailable for that session rather than showing zeros

#### Scenario: Unavailability names its reason
- **WHEN** any widget cannot render real data
- **THEN** the rendered state identifies which data is missing

### Requirement: Dashboards are edited directly, not only by conversation
A design turn produces a **starting** dashboard. Every subsequent modification — adding, removing,
resizing, repositioning, or retitling a widget — SHALL be possible through direct manipulation
without running another design turn, so that changing one widget does not require repeating a
conversation or spending another turn.

#### Scenario: A widget is changed without a design turn
- **WHEN** a user modifies a saved dashboard's widgets or layout
- **THEN** the change is applied and persisted with no agent turn run

#### Scenario: A design turn seeds rather than replaces
- **WHEN** a design turn completes
- **THEN** its output is a dashboard the user can then edit directly

### Requirement: Layout and interaction vocabulary
A dashboard configuration SHALL describe widget placement (position and size) and any cross-widget
interactions using a **named vocabulary** defined by this capability. Interactions SHALL NOT be
expressed as executable code or free-form expressions. A configuration referencing an undefined
interaction, or a widget that does not exist in the same dashboard, SHALL be rejected.

#### Scenario: A dangling interaction reference is rejected
- **WHEN** a configuration declares an interaction targeting a widget id not present
- **THEN** validation rejects it

### Requirement: No agent-authored markup is ever rendered
Every widget SHALL render through this application's own components. No agent-authored content
SHALL be interpreted as markup, anywhere, by any path. Agent-authored strings that appear in a
dashboard — titles, captions, labels — SHALL be rendered as **text only**, and SHALL NOT be
interpolated into HTML, a URL, a style declaration, an attribute that accepts a URL or code, or
any component option documented to accept markup.

#### Scenario: A widget title containing markup renders as inert text
- **WHEN** a stored dashboard carries a widget title containing HTML tags
- **THEN** the title renders as literal text and no markup is interpreted

#### Scenario: Catalog widgets render only from application components
- **WHEN** any widget renders
- **THEN** it renders through the application's own components, never from agent-authored markup

### Requirement: Previews reflect the rendered result
Every preview SHALL be produced by the same component that renders the widget in a dashboard, so a
preview cannot diverge from the result it previews.

An option offered to the user SHALL carry a **catalog widget-type identifier**, validated against
the closed catalog on receipt, so that resolving an option to its component is an exact lookup and
never an inference from agent-authored display text. Preview content supplied by the agent SHALL
NOT be used.

#### Scenario: Preview and rendered widget agree
- **WHEN** a user is shown a preview for a widget and later renders that widget
- **THEN** both are produced by the same component

#### Scenario: An option naming no catalog type is rejected
- **WHEN** an option arrives without a valid catalog widget-type identifier
- **THEN** it is rejected rather than resolved by matching its display text

### Requirement: Session-scoped aggregate toolset
The agent SHALL read session data only through tools scoped to the one session the turn was
started for. The session SHALL be bound by the turn and SHALL NOT be accepted as a tool parameter.
Tools SHALL expose computed aggregates rather than unbounded raw rows; any tool returning a list
SHALL be bounded, and a truncated result SHALL state its truncation so the agent can report
partial coverage rather than treating it as complete.

#### Scenario: The agent cannot address another session
- **WHEN** a design turn is registered for `:sessionId`
- **THEN** every tool call resolves against that session only, and no tool accepts a session
  identifier as an argument

#### Scenario: Concurrent turns on different sessions do not cross
- **WHEN** two design turns run concurrently for different sessions
- **THEN** each turn's tools resolve only its own session's data

#### Scenario: A bounded result states truncation
- **WHEN** a tool result would exceed its documented bound
- **THEN** the result is truncated and the truncation is stated in the tool output

### Requirement: Subprocess security lockdown
A design turn's built-in tool set SHALL be **exactly the one interactive question tool** — a
closed set of one, established by the base-tool-set option and **not** by an auto-approve
allowlist, which does not restrict availability. No filesystem, shell, or network built-in SHALL
be reachable, and the write/execute built-ins SHALL additionally be named in an explicit denial
list, that being the only mechanism documented to override an allow.

The turn SHALL additionally run with: filesystem settings tiers disabled; only the MCP servers
this capability passes programmatically; a permission mode under which the interactive question
tool's permission callback **actually executes** rather than being short-circuited by an auto-deny
or auto-allow path; a configuration directory separate from the operator's personal one;
account-level cloud connectors disabled; a working directory **outside the repository checkout and
outside `DATA_DIR`**; an explicit pinned system prompt; a per-turn spend ceiling; a bound on MCP
tool-call duration; and a minimal environment. Session forking SHALL be disabled explicitly rather
than left to a default.

The question tool SHALL NOT be configured to emit HTML previews, and any preview content supplied
by the agent on a question option SHALL be discarded before the question is relayed to a client —
previews are produced by this application's own components, so agent-authored preview content is
both unnecessary and a markup path this capability does not permit.

Configuration-directory isolation SHALL NOT be relied upon to contain settings reached through the
working directory: agent sessions run non-interactively and therefore skip workspace trust
verification, so a settings file in the working directory can execute hook commands, merge
permission grants, and inject environment variables with no prompt. The pinned working directory
is what addresses that path, and it SHALL be a directory the deployment controls.

A **closed-world** characterization test SHALL pin the resolved option set: it SHALL assert the
enumerated keys and values, **and** assert that options capable of widening the child — programmatic
hooks, plugins, agent definitions, extra process arguments, additional directories, and any
permission-bypass switch — are **absent**. Pinning values alone detects a change; only a
closed-world assertion detects an addition.

#### Scenario: Built-in tools are not reachable
- **WHEN** the agent attempts to invoke a built-in shell or filesystem tool
- **THEN** the tool is not available and no command executes

#### Scenario: The interactive question tool is available and its callback runs
- **WHEN** a design turn asks the user a question
- **THEN** the question tool is available to the agent, its permission callback executes, and the
  turn blocks until an answer or an abandonment condition resolves it

#### Scenario: Agent-supplied preview content is not relayed
- **WHEN** the agent supplies preview content on a question option
- **THEN** that content is discarded server-side and never reaches a client

#### Scenario: A planted project settings file does not execute
- **WHEN** a settings file defining a lifecycle hook is present in a directory the deployment does
  not control
- **THEN** no design turn uses that directory as its working directory, and the hook does not run

#### Scenario: Account connectors are not inherited
- **WHEN** the authenticating account has cloud connectors enabled and a design turn runs
- **THEN** those connectors are not available to the turn

### Requirement: Subprocess and turn lifecycle
Every design turn SHALL terminate its child process on every path — completion, failure, timeout,
and client disconnect — leaving no surviving process, because an orphan continues to spend the
operator's credentials and this deployment does not support restart. The turn timeout SHALL be
independent of the agent iterator, so a turn that never yields still ends, releases its slot, and
terminates its child.

#### Scenario: No orphaned process survives an abort
- **WHEN** an in-flight design turn is aborted and its child does not exit on the first signal
- **THEN** no agent process from that turn survives, and its concurrency slot is released

#### Scenario: A turn that never yields still ends
- **WHEN** a design turn's agent iterator produces no messages and does not terminate
- **THEN** the turn timeout fires regardless, the child is terminated, and the slot is released

### Requirement: Spend and concurrency bounds
A design turn SHALL acquire a slot from the same registry the AI chat uses, before any subprocess
is spawned, so per-session single-flight and the process-wide ceiling bound both features together
rather than doubling the operator's exposure. When a slot cannot be acquired the endpoint SHALL
respond `409` with an actionable `{ detail }` naming which feature holds the slot, and spawn
nothing. The slot SHALL be released when the turn ends by any path, including paths where the
agent iterator never terminates. Each turn SHALL additionally carry a per-turn spend ceiling.

#### Scenario: A second turn on a busy session is rejected
- **WHEN** a turn is already in flight for `:sessionId` — either feature — and a client posts a
  design turn for that session
- **THEN** the response is `409 { detail }` naming the holder, and no subprocess is spawned

### Requirement: Dashboard persistence
A dashboard SHALL be stored as a validated configuration and SHALL be re-renderable after the
design turn that produced it has ended.

Validation on write SHALL cover the **whole configuration**, not only its widget types and
interactions: every string field SHALL be length-bounded and schema-constrained, and a
configuration carrying a field that would be interpreted as markup, a URL, or code SHALL be
rejected. A stored dashboard is a durable artifact that re-renders unattended for other users, so
its content is treated as untrusted regardless of which agent or user produced it.

Writing a dashboard SHALL be scoped at least as tightly as reading the session it belongs to, and
stored configurations SHALL record the principal that created them and the turn they originated
from. Reading SHALL be scoped exactly as the session, so a caller who cannot read the session
cannot read its dashboards.

The number of dashboards per session, widgets per dashboard, and the serialized size of a
configuration SHALL each be bounded, with writes exceeding a bound rejected. A stored dashboard
SHALL be removable and replaceable through the interface, so a bad configuration does not require
filesystem access to remove.

#### Scenario: A dashboard survives its design turn
- **WHEN** a design turn completes and the client reloads
- **THEN** the saved dashboard renders from stored configuration and session data

#### Scenario: An invalid configuration is rejected on write
- **WHEN** a configuration naming an unknown widget type is submitted for storage
- **THEN** it is rejected and nothing is stored

#### Scenario: Dashboard access follows session access
- **WHEN** a caller without access to a session requests its dashboards
- **THEN** the response is `404`, exactly as for the session itself

### Requirement: AI v2 tab in the session workspace
The session workspace SHALL present an AI v2 surface alongside the existing tabs. All tab panels
SHALL remain mounted and be hidden rather than unmounted when inactive, and the design
conversation, streaming, and abort state SHALL be held above the panel component, so switching
tabs neither aborts an in-flight design turn nor clears the conversation.

#### Scenario: Switching tabs preserves an in-flight design turn
- **WHEN** a design turn is streaming and the user switches to another tab and back
- **THEN** the turn is still streaming and the conversation is intact

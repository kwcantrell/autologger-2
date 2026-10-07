# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Production companies: one AutoLogger install serves several studios or clients, and producers
oversee many shows and sessions across teams. Within each team:

- **Owners and admins** run the team. They create teams, invite members, assign roles, and grant
  per-show access.
- **Members** do the session work: they log events live against timecode, then come back to
  review transcripts, topics, exports, and AI dashboards.

The people and devices vary. Desktops, tablets, and phones are all in use, in rooms that range
from dim studios to bright offices, and sometimes remotely. The Companion hardware module also
connects as a client of the live session.

## Product Purpose

AutoLogger is a session-logging workspace. Operators log events against running timecode during
a live session. They record or import audio and generate transcripts and topics from it. Then
they analyze the session afterward. Success means a producer can find any event, word, or theme
in any session they have access to, and understand it, without re-listening to the recording.

## Positioning

- **One searchable record per session.** Events, audio, transcript, topics, and dashboards live
  together in the session, so nothing has to be reassembled from separate tools.
- **Agentic analysis grounded in the session's own data.** An agent reads the session's computed
  aggregates and proposes a dashboard, and the operator then edits it directly. The agent runs
  under a closed-world lockdown, and its markup is never rendered.

## Operating Context

- **Session workspace tabs:** Event Feed, Transcript, Topics, Assistant, Dashboards, and Export.
- **Live logging:** the 1–9 hotkeys, transport controls, and recording status, with Companion
  hardware driving the same live session over WebSocket.
- **Team administration:** the `/teams` page, which covers roles, invites, and show grants.
  Members reach a show's sessions only through a grant, and losing access closes their live
  sockets.
- **Sign-in:** login is always required, via Google OAuth.

## Capabilities and Constraints

- **Contract:** the HTTP/WS contract is frozen (`api-contract-freeze`). Any UI change that
  alters routes, JSON shapes, status codes, or WebSocket messages needs its own approved change.
- **Server-side integrations:** DeepGram, `yt-dlp`, and the Claude CLI or Agent SDK run only on
  the server. Each returns 503 until it is configured, and the UI must gate those features
  honestly.
- **Roles:** `owner`, `admin`, and `member`. Each team has at most one owner, and the owner
  can't leave without transferring ownership.
- **Deployment:** a portable Node server, now migrating to self-hosted Supabase Postgres.
- **Open decisions:**
  - Device priority: which device class gets the primary layout.
  - Multi-tenant presentation: how studios and clients are distinguished in the UI.

## Brand Commitments

- **Name:** AutoLogger.
- **Voice:** precise, calm, technical.
- **Visual identity: open for redesign.** The current V5 dark-glass system is the incumbent, not
  a commitment. No palette, typography, or aesthetic is binding yet.

## Evidence on Hand

- **Logos:** `web/public/static/logo-autologger-app.png`,
  `web/public/static/logo-autologger-transparent.png`, and
  `web/src/assets/logos/logo-autologger-transparent.png`.
- **Brand video:** `web/src/assets/video/AutoLogger_Small.webm`.
- **API fixtures:** `fixtures/api-responses/` holds real response shapes.
- **What's missing:** there are no testimonials, customer names, case studies, benchmarks, or
  pricing. Future work must not invent them.

## Product Principles

- **Many shows, one place.** Producers move across teams, shows, and sessions without losing
  orientation, and access boundaries are always visible.
- **Exact about time and state.** Timecode, transport, recording status, and access state are
  always truthful.
- **Absence is information.** When data is missing, unconfigured, or access is denied, the UI
  says so and names the reason. It never shows blanks or zeros as if they were data.
- **AI as an instrument.** Agentic analysis works from the session's own data and stays editable
  by the operator.

## Accessibility & Inclusion

- **Standard:** WCAG AA, measured on the rendered surfaces. That means ≥4.5:1 contrast for body
  text and ≥3:1 for large text.
- **Lighting and devices:** contrast must hold in both dim and bright rooms, on every supported
  device class.
- **State:** color is never the only channel.
- **Motion:** every animation has a `prefers-reduced-motion` alternative.
- **Keyboard:** every direct-manipulation interaction has a keyboard equivalent.

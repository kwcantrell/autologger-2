# 0035: Custom session dashboards are agent-written TSX, run only in a no-network sandbox, behind an in-app OAuth server and an opt-in flag

- Date: 2026-11-13
- Status: Proposed
- Rule: none yet. The build jobs listed in [the design](../design/custom-session-dashboards.md#13-job-breakdown) add the specs (`mcp-authorization`, `mcp-session-data`, `custom-dashboards`) and change `ai-v2-dashboards` "No agent-authored markup is ever rendered", api-contract-freeze "OAuth callback failure redirect" and "Companion device tokens authenticate only the Companion surface", and the boot and router specs, each in the job that changes the behavior.

## Context

Studio (team) owners and admins want to ask Claude, in claude.ai or Claude Desktop, to design a
custom dashboard for a session. Claude would read the whole session (events, transcript, topics
and its wiki pages) through an MCP server and write the dashboard as React TSX with shadcn
components, including components of its own design. The dashboard renders inside Claude as an MCP
App and in the session's Dashboards tab in autologger web.

Four facts make this a design decision, not a feature job:

- **It reverses a spec rule.** `ai-v2-dashboards` "No agent-authored markup is ever rendered"
  says no agent-authored content is interpreted as markup "anywhere, by any path". Custom
  dashboards *execute* agent-authored code.
- **It touches auth.** Claude connectors authenticate with OAuth 2.1 (the MCP authorization
  spec). autologger has only a cookie login (Google through Supabase Auth) and Companion device
  tokens. AGENTS.md makes auth design human-led.
- **The input is untrusted.** Transcripts, topics, event notes and wiki pages are written by
  many people and by other AI runs. Claude reads them while writing code that other people's
  browsers then run.
- **A first attempt was reset.** Jobs 001–005, 016, 020 and 021 were deferred. 001's contract
  assumed `PUBLIC_BASE_URL` was new (it exists and is required at boot, `server/src/bootGuard.ts`),
  and the later rework asked for a real opt-in flag, an exact `/mcp` path, IPv6-aware rate limits
  and cleanup of expired rows. 016 found that the split topology's router sends every GET outside
  `/api` and `/auth` to the web container, so new GET routes need router rules.

The human made fourteen decisions at intake (2026-11-13), and three more (15–17) the same day,
answering open questions 7, 2 and 12 of the design. This ADR records them and the reasoning behind
each. The design doc gives the mechanism.

## Decision

Build custom session dashboards as an opt-in feature with these properties. Each item is a
human decision; the reasoning follows it.

1. **Start fresh.** Jobs 001–005, 016, 020 and 021 are context, not commitments. *Why:* their
   contracts carried wrong assumptions. A design written first can fix them once instead of job by
   job.
2. **Everything of the session is reachable, in pages.** Every event, transcript segment, topic
   and associated wiki page can be read, through cursor-paged tools with a per-call item and
   character limit. *Why:* a dashboard designer needs the real data, not a summary chosen in
   advance. Paging keeps any single call bounded, so a long session can't blow the client's
   context or the server's memory.
3. **Owners and admins create and edit; members don't.** Any owner or admin of the studio may
   edit or delete any of its dashboards. *Why:* a dashboard runs code in other people's browsers,
   so the people who already manage the studio's shows and grants (team-management "Team roles,
   owner anchor and show access") decide what runs. Shared editing within that group avoids
   orphaned dashboards when an author leaves.
4. **Anyone who can read the session can view.** Viewing works in the Claude client (MCP App)
   and in autologger web's Dashboards tab. A session's own dashboards and the studio templates
   that apply to it are visible, and their data is always fetched under the *viewer's*
   permissions. *Why:* a dashboard is a view of session data. The viewer's own access rule
   (team-management "Member content access") is the right bound. A dashboard stores code, never
   data, so it can't carry an author's access to a viewer.
5. **An in-app OAuth 2.1 authorization server.** It implements the MCP authorization spec:
   protected-resource metadata, dynamic client registration and PKCE. Its login step is the
   existing Google sign-in. Access tokens last 1 h and refresh tokens 30 days. Refresh tokens
   rotate, and reusing a spent one revokes its whole chain. Settings gets a "Connected apps" list
   where users revoke a client. Studio roles are checked on every call. *Why:*
   - Claude connectors speak exactly this protocol.
   - Reusing Google sign-in adds no second identity.
   - Short access tokens, plus rotation with reuse detection, bound the damage of a stolen token.
   - Checking roles per call, rather than baking them into tokens, means a demotion or removal
     takes effect on the next call.
6. **Two scopes.** A dashboard is either attached to one session, or saved as a studio template
   (optionally limited to some shows) that renders against any applicable session. *Why:* the
   same layout is usually wanted for every episode of a show. A template avoids copying it, and
   the show limit keeps a template where it makes sense.
7. **React TSX with shadcn.** *Why:* Claude writes React fluently and can design new components.
   Using the app's own shadcn set keeps the look consistent. A fixed widget catalog, as in v2,
   can't express new components.
8. **Live, not realtime.** Data is fetched when the dashboard is viewed. There is no WebSocket
   subscription in v1. *Why:* fetch-on-view is enough for post-session review. It keeps the
   frozen WebSocket contract untouched, and keeps the sandbox free of long-lived channels.
9. **A data-only sandbox inside the MCP App.** The agent's TSX runs in a nested sandboxed iframe
   with no network and an opaque origin. Its only capability is a typed query API, answered by
   the View, for the one session the View was opened for. It can't call tools, write anything or
   reach other sessions. *Why:* the code is untrusted, possibly steered by prompt injection in
   session content. The boundary is the browser's iframe sandbox **together with** the embedding
   page's `frame-src` policy, pinned to the exact frame URL; neither alone is enough, and
   together they don't rely on reviewing the code.
   - The sandbox (no `allow-same-origin`, no network) stops cookies and storage, network
     fetches, the user's tools and other sessions.
   - The sandbox doesn't stop the frame navigating itself (`location`, an anchor click, a meta
     refresh) and carrying session data out in the URL. The embedder's `frame-src` stops that:
     the browser checks it on every navigation of the child frame, so the frame can't leave the
     frame URL.

   The mechanism is in the design: the View's meta CSP (§8.1), the app's `frame-src` header on
   the web (§9.2), and threats T1 and T2 (§11). The narrow API means a hostile dashboard can at
   worst show wrong data about a session the viewer can already read.
10. **A separate origin for the web runtime, plus an import allowlist enforced at save.** The
    web viewer loads the same sandbox runtime from its own origin. The server refuses to save TSX
    that imports anything but React, the shadcn set and the data hooks. *Why:*
    - The separate origin is defense in depth: even a mistake in the iframe's `sandbox` attribute
      can't put agent code on the app origin, where the session cookie and the API live.
    - The allowlist keeps dashboards small and reviewable, and refuses obvious attempts to pull
      in network or DOM-escaping libraries, at the cheapest point.
11. **Writes are dashboards only.** The only writes are create, update, delete and restore a
    revision. Session data stays read-only through MCP. *Why:* the connector exists to design
    views. Letting a remote client edit events or transcripts would widen what a stolen token or
    an injected instruction could damage, for no benefit to this feature.
12. **History.** The last 20 revisions of each dashboard are kept, each with its author and
    time. Any kept revision can be restored, and delete is permanent. *Why:* an agent edit can
    be bad, so one-step recovery matters. A cap keeps storage bounded. Permanent delete is what
    an owner expects when removing code that runs in others' browsers.
13. **Opt-in, off by default.** The flag needs a public HTTPS base URL. Off, the `/mcp` and
    OAuth routes don't exist and the deployment is unchanged. *Why:*
    - An authorization server and remote code are new exposure. An operator should choose them.
    - Claude connectors require HTTPS.
    - "Off means unchanged" keeps the frozen contract intact for every deployment that doesn't
      opt in.
14. **Design and ADR first, then a sequence of factory jobs.** *Why:* the feature crosses auth,
    the contract and the router. Small, ordered, independently mergeable jobs each get their own
    proof and review.
15. **Environment variable names are confirmed as designed:** `CUSTOM_DASHBOARDS_ENABLED`,
    `DASHBOARD_RUNTIME_ORIGIN`, `MCP_SIGNING_SECRET`, `MCP_ALLOWED_ORIGINS`,
    `ROUTER_CUSTOM_DASHBOARDS` and `ROUTER_DASHBOARD_RUNTIME_HOST` (decided 2026-11-13, design
    open question 7). *Why:* the names follow the repo's existing patterns (`AI_V2_ENABLED` for
    the flag, `FRAME_BUS_SECRET` for a server-only secret, the `ROUTER_` prefix of
    `ROUTER_PORT` for router settings), and fixing them now lets J1 and the router job build
    against stable names instead of renaming operator settings after they ship.
16. **Grants have a 90-day hard cap.** A grant expires 90 days after its creation, whatever
    refreshes happen. The user then reconnects. Refresh tokens still rotate, with 30 days from
    each issue, but never past the grant's cap (decided 2026-11-13, design open question 2).
    *Why:* with only per-token expiry, an active connection never expires, so a connector that
    is never reconnected lives forever. That sits badly with least privilege as applied
    elsewhere. A fixed cap bounds how long any one consent, and any undetected stolen chain,
    can last, at the cost of one reconnect every 90 days.
17. **Refresh reuse has a 30-second grace window.** A reuse of a rotated refresh token within
    30 seconds of its rotation is not treated as theft: it returns the successor token already
    issued, and mints nothing new. This applies only when the same client presents the same
    refresh token. Any reuse after 30 seconds still revokes the whole grant chain. The window is
    configurable, defaulting to 30 seconds (decided 2026-11-13, design open question 12).
    *Why:*
    - Strict detection logs a user out of the connector whenever a refresh response is lost in
      transit, or two refreshes race (Claude retrying, or two tabs).
    - Okta (refresh-token rotation "grace period", 30 s by default) and Auth0 (rotation "reuse
      interval") offer the same mitigation for the same reason.
    - Inside the window, a racing replay only receives the token already issued. It doesn't
      fork the chain or get anything new, and once the window closes, a reuse by either party
      still revokes the chain.

**The `ai-v2-dashboards` rule reversed, for this new dashboard kind only.** `ai-v2-dashboards`
"No agent-authored markup is ever rendered" stays in force for v2 dashboards. Their widgets still
render only through the application's own components, and the rule still holds on the app origin
everywhere. Custom dashboards are a separate kind with their own tables, routes and spec
(`custom-dashboards`). Their agent-authored code is executed only inside the sandbox runtime
described in the design, never on the app origin. The build job that ships the runtime narrows
that requirement's "anywhere, by any path" wording to exclude the sandbox runtime, and it keeps
the repo-wide `dangerouslySetInnerHTML` guard (`web/src/noAgentAuthoredMarkup.repo.test.ts`).
**v2 dashboards are unchanged.** Their routes (`…/ai/v2/*`), their `catalog.session_dashboards`
table, their widget catalog and their editor are untouched. Both kinds coexist in the session's
Dashboards tab.

*Alternatives considered.*
- **Extend the v2 widget catalog instead of running code.** Safer, but it can't express
  components Claude designs, which is the point of the request (decision 7).
- **Render agent TSX on the app origin after review or linting.** Rejected: static checks can't
  prove untrusted JavaScript harmless. The sandbox, together with the embedder's `frame-src`
  pinned to the frame URL, has to be the boundary (decision 9), and the allowlist is only an
  early refusal.
- **Let the sandbox fetch data itself with a scoped token.** Rejected: it gives agent code a
  credential and a network path. Answering typed queries from the trusted parent keeps both out
  of the sandbox (decisions 9 and 10).
- **Use an external identity provider (Supabase Auth's OAuth server, or a hosted AS).** Not
  chosen. The human wants the login step to be the existing Google sign-in and the per-call
  checks to be autologger's own. An external AS would also need its own token mapping to studio
  roles.
- **Client ID Metadata Documents (CIMD) instead of DCR.** The MCP authorization revision
  2026-07-28 prefers CIMD and marks DCR deprecated (still allowed). Claude supports both. The
  human chose DCR, and the design keeps DCR and lists CIMD as a later addition (see Consequences).

## Evidence

- **Code it builds on:** listed with paths in the design's [grounding section](../design/custom-session-dashboards.md#2-what-exists-today).
  - Studio role checks: `requireTeamRole` in `server/src/routers/teams.ts`.
  - Session access: `requireSession` in `server/src/routers/_helpers.ts`, and `authCanAccessShow`
    in `packages/catalog/src/authStore.ts`.
  - The loopback-only MCP listener: `packages/ai-runtime/src/aiMcpServer.ts`.
  - The Hono app and frontend bridge: `server/src/app.ts` and `server/src/node/nextFrontend.ts`.
  - Google sign-in: `server/src/routers/auth.ts`.
  - The hashed bearer-token precedent: `server/src/auth/companionDeviceToken.ts` and
    `supabase/migrations/20261015000000_companion_devices.sql`.
  - The router: `docker/Caddyfile`.
- **`PUBLIC_BASE_URL` already exists.** It is read by `publicBaseUrl()` in `server/src/env.ts`,
  and its absence is refused at boot by `SIGN_IN_VARS` in `server/src/bootGuard.ts`
  (web-frontend-platform). The dev stack pins it to `http://localhost:${DEV_PORT}`
  (local-container-environments). The flag adds a check that it is `https:`; it adds no new
  base-URL setting.
- **External specs, checked 2026-11-12:**
  - The MCP Apps extension (`io.modelcontextprotocol/ui`), stable revision 2026-01-26, at
    <https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx>.
  - The MCP authorization spec, revision 2025-11-25 (the revision the pinned
    `@modelcontextprotocol/sdk` 1.32 and Claude's connector docs target), with the changes in
    revision 2026-07-28 noted, at
    <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>.
  - Claude's connector authentication requirements, at
    <https://claude.com/docs/connectors/building/authentication>.
- **Incidents from the first attempt:** jobs 001 (reset over `PUBLIC_BASE_URL`) and 016 (router
  rules), in `factory/jobs/`.

This ADR stays Proposed until the human approves the design. It becomes Accepted when the first
build job merges.

## Consequences

- **New exposure on opted-in deployments:** a public token endpoint, dynamic client registration
  open to anyone, and agent code running in viewers' browsers. The threat model in the design
  lists each threat with its mitigation and residuals. `docs/security.md` gains an entry in the
  job that ships each piece.
- **More moving parts to run:**
  - A second public hostname for the runtime origin, and router rules for the new GET paths.
  - Anthropic's connector egress range has to be allowed when `IP_ALLOWLIST` is set.
- **Reuse detection can still log a user out of the connector.** A refresh response lost in
  transit makes the client retry with a spent token. Within the 30 s grace window (decision 17)
  the retry gets the successor already issued. A retry after the window revokes the chain and
  the user reconnects. This is accepted to keep detection strict outside the window.
- **Every connection ends after 90 days** (decision 16). The user reconnects, however active the
  connection was.
- **The MCP spec is moving.** The design targets protocol revision 2025-11-25, through the SDK
  already pinned. Revision 2026-07-28 drops transport sessions and prefers CIMD. A later job can
  add CIMD (advertised beside DCR) and the new transport once Claude and the SDK use them.
- **Drop or revisit if:**
  - the boundary is shown to leak: a network request, a cookie or a tool call from dashboard
    code, or a self-navigation by dashboard code that carries data out of the frame URL;
  - Claude stops supporting MCP Apps or DCR;
  - owners don't use templates or the Claude path;
  - the reuse-detection logouts outside the grace window are still frequent, or the window is
    seen being exploited, either of which would be a new human decision about its length.

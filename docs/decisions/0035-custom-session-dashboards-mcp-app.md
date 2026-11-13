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

The human made fourteen decisions at intake (2026-11-13). This ADR records them and the reasoning
behind each. The design doc gives the mechanism.

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
   session content. The boundary is the browser's sandbox, so it doesn't rely on reviewing the
   code. The narrow API means a hostile dashboard can at worst show wrong data about a session
   the viewer can already read.
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
  prove untrusted JavaScript harmless. The sandbox has to be the boundary, and the allowlist is
  only an early refusal.
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
- **Reuse detection can log a user out of the connector.** A refresh response lost in transit
  makes the client retry with a spent token, which revokes the chain. The user reconnects. This
  is accepted to keep detection strict.
- **The MCP spec is moving.** The design targets protocol revision 2025-11-25, through the SDK
  already pinned. Revision 2026-07-28 drops transport sessions and prefers CIMD. A later job can
  add CIMD (advertised beside DCR) and the new transport once Claude and the SDK use them.
- **Drop or revisit if:**
  - the sandbox is shown to leak (a network request, a cookie or a tool call from dashboard
    code);
  - Claude stops supporting MCP Apps or DCR;
  - owners don't use templates or the Claude path;
  - the reuse-detection logouts are frequent enough to need a grace window, which would be a new
    human decision.

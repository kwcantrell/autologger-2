## MODIFIED Requirements

### Requirement: Split-container serving topology
The Next build SHALL also emit standalone server output (`output: 'standalone'`, traced from
the repository root). That output SHALL be able to serve the frontend with no Hono process
present, and SHALL serve the same routes, page components, and closed path-family set as the
bridge. Enabling standalone output SHALL NOT change how the single-process topology behaves.

In the split-container topology, the standalone server SHALL sit behind the internal router
specified by the `container-deployment` capability. The router SHALL send to the server
(running API-only) every request that the bridge would have answered with the server's own
`404`:
- all `/api*` and `/auth*` paths;
- all non-GET/HEAD methods;
- trailing-slash paths other than `/`.

The router SHALL close stray non-`/api` `Upgrade` requests with no response written. Its path
matching SHALL use the raw, case-sensitive request path, exactly as the bridge's checks do.

As a result, the following dispositions SHALL hold unchanged at the public origin:
- "API routes never reach the frontend bridge"
- "Non-GET unmatched requests keep the server's 404"
- "Trailing slash stays 404"
- "Non-API upgrade in production"

**Carve-out:** in this topology, shell and asset requests do not reach the server, so the
"Page requests pass through server middleware" guarantee is **not guaranteed** for them.
Access control for shell and asset requests is the upstream proxy's responsibility, and the
deployment documentation SHALL say so.

#### Scenario: Standalone output leaves single-process serving unchanged
- **WHEN** `npm run build && npm run start` runs after standalone output is enabled
- **THEN** the single-process server serves the shell, assets, and API exactly as before

#### Scenario: Same shell from both topologies
- **WHEN** `GET /sessions/abc` is requested from the single-process server and, for the
  same build, through the split topology's router
- **THEN** both respond `200` with the index shell from the same page component and no
  `Set-Cookie`

#### Scenario: Server middleware coverage of shell requests is not guaranteed in split topology
- **WHEN** the split topology is running with `IP_ALLOWLIST` set on the server and a
  non-allowlisted client requests `/` through the router
- **THEN** no requirement guarantees the request is rejected, while that client's `/api/*`
  requests are still rejected by the server

# Auth model & API map — retired

**This document was retired as stale on 2026-07-27** (2026-07-27 full-repo review,
finding 4.1): it predated teams/invites, the AI chat / AI v2 / dashboard routes, and
described the now configuration-gated features (`youtube-import`,
`transcript-words/generate`, `topics/generate`) as flat 503s.

The normative references are:

- **`README.md`** — the endpoint table there is the normative route inventory
  (capability spec `api-contract-freeze`), and covers the auth model.
- **Code** — `server/src/middleware/auth.ts`, `server/src/middleware/ipAllowlist.ts`,
  and the per-router guards under `server/src/routers/`.

No regenerated copy is planned; the endpoint inventory is deliberately maintained in
one place (the README) rather than mirrored here.

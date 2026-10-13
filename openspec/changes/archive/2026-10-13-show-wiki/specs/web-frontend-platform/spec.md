# Spec Delta

## MODIFIED Requirements

### Requirement: Shell routing from the shared route definition
Next SHALL serve the index shell for exactly the router-known paths — `/`,
`/sessions/:id` (one non-empty raw segment), `/teams`, `/search`, `/wiki` and
`/wiki/:pageId` (one non-empty raw segment) — via a catch-all that validates
the segment list the framework provides, treating each raw path segment as exactly one
entry regardless of any percent-encoded separators it carries — the validator SHALL NOT
decode-and-re-split segment values. Any other path, including the retired `/admin/users`,
SHALL fall through to the not-found page. The accepted segment shapes SHALL derive
from the shared route-definition module (`web/src/shared/utils/loginReturnPath.ts`) via
a segment-shape helper added alongside `isRouterKnownPathname`. The module holds two
predicates with deliberately different domains — the deep-link predicate (excludes `/`)
consumed by the stash write and return-path validator, and the shell segment-shape
helper (includes `/`) consumed by the catch-all — and they SHALL NOT be merged. Any
other path SHALL yield `404`; trailing-slash variants of router-known paths (e.g.
`/teams/`) SHALL NOT be redirected to their canonical form and SHALL yield `404`,
matching pre-change behavior (enforced at the serving layer in front of the framework:
paths ending in `/`, other than `/` itself, are answered `404` by the server and never
reach the framework). Shell responses SHALL set no cookies and read no cookies;
for a fixed deployment and fixed request headers, the response SHALL NOT vary with
session/team existence, deletion state, or requester authorization, and SHALL embed no
session-derived or catalog-derived data. Shell routes SHALL be dynamically rendered
with no per-request persistence into the build directory (`web/.next` stays read-only
at runtime).

#### Scenario: Nested session path stays 404
- **WHEN** `GET /sessions/a/b` is requested
- **THEN** the response is `404` (three raw segments — not a router-known shape)

#### Scenario: Nested wiki path stays 404
- **WHEN** `GET /wiki/a/b` is requested
- **THEN** the response is `404` (three raw segments — not a router-known shape)

#### Scenario: Percent-encoded slash stays a single segment
- **WHEN** `GET /sessions/a%2Fb` is requested
- **THEN** the shell is served with `200` (one raw id segment whose decoded value
  contains `/`, matching pre-change behavior)

#### Scenario: Trailing slash stays 404
- **WHEN** `GET /teams/` or `GET /sessions/abc/` is requested
- **THEN** the response is `404` with no redirect, matching pre-change behavior

#### Scenario: No runtime writes to the build directory
- **WHEN** shell routes are requested repeatedly (including many distinct session ids)
  against a production server
- **THEN** no new files appear under `web/.next`

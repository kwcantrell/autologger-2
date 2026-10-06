# Spec Delta

## MODIFIED Requirements

### Requirement: Shell routing from the shared route definition
Next SHALL serve the index shell for exactly the router-known paths — `/`,
`/sessions/:id` (one non-empty raw segment), `/teams` — via a catch-all that validates
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

### Requirement: Client-island rendering
The index application tree SHALL render as a client-only island (`ssr: false` dynamic
import from a client wrapper component): no server-side rendering or hydration of the
application tree. React StrictMode SHALL remain disabled for the index tree, preserving
today's semantics. (The admin tree and its separate island were retired with the
`/admin/users` page.) In-app navigation SHALL continue through the wouter-based
navigation funnel (`web/src/pages/index/navigation.ts`) with its synchronous
pre-render departure semantics unchanged; the Next layer SHALL NOT remount the island
across in-app navigations between router-known paths.

#### Scenario: In-app navigation does not remount the island
- **WHEN** a user navigates in-app from `/` to `/sessions/<id>` and back
- **THEN** the island component instance persists (departure-watcher and transport
  semantics fire exactly as before this change) and no full document load occurs

### Requirement: Server-rendered shell
The documents served for the router-known paths SHALL contain server-rendered layout chrome (document structure,
theme/body attributes, stylesheet and font references, and a static loading skeleton)
rather than an empty mount node, and the not-found page SHALL be statically rendered.
The skeleton SHALL contain no user- or session-derived data.

The document for the **router-known paths** SHALL additionally emit `<link rel="preload"
as="font" type="font/woff2" crossorigin>` for the two font faces on the critical path — the
deduplicated Inter latin subset and the League Gothic latin subset the loading skeleton itself
renders in. Because that layout has no `<head>` element and Next's
`metadata` export has no preload API, the links are rendered in the body and hoisted to the
document head by React 19 — the supported route.

Two properties of those preloads are load-bearing:

- **The preload `href` and the CSS `src:` MUST resolve to the same URL.** A preload names an
  exact request; if the stylesheet then asks for a different URL, the preloaded bytes are dead
  weight and the font is fetched twice. Satisfying this is what forces those two faces onto
  stable, build-invariant paths; where those files live and what that costs is owned by
  `Self-hosted font faces are deduplicated and scoped to what renders`, and is not restated
  here.
- **`crossorigin` is mandatory**, even same-origin. Fonts are always fetched in CORS mode, so a
  preload without it is a cache-key mismatch and the file downloads twice — the opposite of the
  intended effect.

#### Scenario: First paint is not an empty root
- **WHEN** `GET /` is fetched without executing JavaScript
- **THEN** the response HTML contains the layout chrome and loading skeleton markup, not
  an empty root element

#### Scenario: Critical fonts are preloaded with matching URLs
- **WHEN** `GET /` is fetched without executing JavaScript
- **THEN** the document contains two `<link rel="preload" as="font" type="font/woff2"
  crossorigin>` elements whose `href`s are the same stable `/static/fonts/` URLs the
  stylesheet's `@font-face` `src:` declarations request

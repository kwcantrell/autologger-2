---
name: generate-docs
description: Regenerate the end-user documentation site in docs-site/ by running the docs-writer agent, then verify it with scripts/check-docs-site.mjs. Use when asked to generate, refresh or update the user docs or help site, or after user-facing features change.
---

# Generate docs

`docs-site/` is AutoLogger's end-user help site: static HTML and CSS, one how-to page per
user-facing feature. It is generated, so refresh it with the agent instead of hand-editing.

## Steps

1. Run the `docs-writer` subagent (`.claude/agents/docs-writer.md`) with the task
   "Regenerate docs-site/ from the current repository." Pass along anything the user asked to
   focus on. Wait for it to finish.
2. Run the checker from the repo root:

   ```sh
   node scripts/check-docs-site.mjs
   ```

   It must print `docs-site check passed`. If it fails, send the problems back to the
   `docs-writer` agent to fix (or fix them directly if they are trivial) and run it again.
3. Run the checker's tests: `node --test scripts/check-docs-site.test.mjs`.
4. Show the user `git status docs-site/` and the agent's report: pages added, changed or
   removed, specs excluded and why, and anything the agent could not document confidently.
   Commit only if the user asks.

## Rules

- The site is for end users. Reject output that shows source paths, routes, environment
  variables, secrets or real email addresses, even if the checker misses it.
- No JavaScript, no external stylesheets, fonts, scripts or images, no build step.
- Do not edit product code, `openspec/specs/` or the README to make the docs easier to write.

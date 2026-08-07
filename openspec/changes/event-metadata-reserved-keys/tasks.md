# event-metadata-reserved-keys — tasks

> PROVISIONAL until panel + gate.

## 1. Server strip + tests

- [ ] 1.1 `AUTO_GENERATION_RESERVED_METADATA_KEYS` constant beside the JS
      predicate in server/src/routers/events.ts; POST handler deletes those
      top-level keys from parsed metadata **unconditionally, immediately after
      zod parse (both the internal and non-internal category paths)**, before
      the UI-snapshot merge. Size cap stays pre-strip (D2).
- [ ] 1.2 Int tests (events int suite): stamping POST → stored/echoed metadata
      lacks both keys, keeps others, 200 unchanged; **value-independent** strip
      (`auto_generated: "yes"`, numeric `auto_generate_run_id` → both gone);
      **internal-category stamping POST also stripped**; ordinary-metadata POST
      byte-identical; `has_auto_generated` stays false after a stamping POST
      (the delta scenario); PUT edit of a generation-created row keeps the
      predicate matching; regenerate sweep still removes a PRE-EXISTING
      predicate-matching row (no retro-clean regression). Unit tripwire: the
      constant contains the key the JS/SQL predicates read.
- [ ] 1.3 README events row: one clause noting reserved-key stripping.

## 2. Final gates

- [ ] 2.1 `npm run typecheck`, `npm test`, `npm run lint`; e2e/visual NOT
      expected to change (server-only) — run `npm run e2e` as the smoke gate;
      skip visual with rationale recorded (no UI surface touched).

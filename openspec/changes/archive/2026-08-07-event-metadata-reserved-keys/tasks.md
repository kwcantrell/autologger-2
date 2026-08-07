# event-metadata-reserved-keys — tasks

> PROVISIONAL until panel + gate.

## 1. Server strip + tests

- [x] 1.1 `AUTO_GENERATION_RESERVED_METADATA_KEYS` constant beside the JS
      predicate in server/src/routers/events.ts; POST handler deletes those
      top-level keys from parsed metadata **unconditionally, immediately after
      zod parse (both the internal and non-internal category paths)**, before
      the UI-snapshot merge. Size cap stays pre-strip (D2).
- [x] 1.2 Int tests (events int suite): stamping POST → stored/echoed metadata
      lacks both keys, keeps others, 200 unchanged; **value-independent** strip
      (`auto_generated: "yes"`, numeric `auto_generate_run_id` → both gone);
      **internal-category stamping POST also stripped**; ordinary-metadata POST
      byte-identical; `has_auto_generated` stays false after a stamping POST
      (the delta scenario); PUT edit of a generation-created row keeps the
      predicate matching; regenerate sweep still removes a PRE-EXISTING
      predicate-matching row (no retro-clean regression). Unit tripwire: the
      constant contains the key the JS/SQL predicates read.
      Done in `server/src/routers/events.metadataStrip.int.test.ts` (8
      scenarios) + `events.metadataStrip.test.ts` (2-case unit tripwire). The
      grandfathered pre-existing-row sweep is already pinned by
      `events.generate.int.test.ts`'s `seedAutoSlateEvent` fixture (seeds a
      predicate-matching row directly at the hub, bypassing this route — the
      same shape as any row written before this change) and is unaffected by
      this change, so not re-proven with a duplicate CLI-fixture-driven test.
- [x] 1.3 README events row: one clause noting reserved-key stripping.

## 2. Final gates

- [x] 2.1 `npm run typecheck`, `npm test`, `npm run lint`; e2e/visual NOT
      expected to change (server-only) — run `npm run e2e` as the smoke gate;
      skip visual with rationale recorded (no UI surface touched).

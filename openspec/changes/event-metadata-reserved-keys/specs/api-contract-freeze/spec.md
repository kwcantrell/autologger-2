# api-contract-freeze — delta (event-metadata-reserved-keys)

## ADDED Requirements

### Requirement: Events POST strips reserved auto-generation metadata keys

`POST /api/sessions/:sessionId/events` SHALL remove the keys `auto_generated`
and `auto_generate_run_id` from client-supplied `metadata` before the event is
stored — silently, regardless of the values sent (no error, no status-code
change; the ignore/strip precedent), and unconditionally (the internal-category
path included). All other metadata keys SHALL pass through unchanged — except
the existing category-UI-snapshot keys, which the snapshot merge continues to
overwrite exactly as today. The existing serialized-size cap applies to the
`metadata` field as sent (pre-strip). The stripping is
observable: subsequent reads of the created event carry metadata without the
reserved keys. Server-side writers (the generation run's `create_event` tool,
the sheets importer's hub write) are NOT this route and SHALL be unaffected.

#### Scenario: Stamping client is stripped

- **WHEN** a client POSTs an event with
  `metadata: { auto_generated: true, auto_generate_run_id: "x", note: "keep" }`
- **THEN** the response is the normal `200` created event whose metadata
  contains `note` but neither reserved key, and subsequent event reads agree

#### Scenario: Stripping is value-independent

- **WHEN** a client POSTs an event with
  `metadata: { auto_generated: "yes", auto_generate_run_id: 7, note: "keep" }`
- **THEN** the stored/echoed metadata carries `note` and neither reserved key,
  regardless of the values sent

#### Scenario: Ordinary metadata unaffected

- **WHEN** a client POSTs an event with metadata carrying no reserved keys
- **THEN** the stored metadata is byte-equivalent to today's behavior

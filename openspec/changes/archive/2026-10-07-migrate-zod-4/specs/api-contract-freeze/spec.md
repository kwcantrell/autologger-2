## ADDED Requirements

### Requirement: Validation error bodies carry zod 4 issues
A request refused by a request schema SHALL be answered `422 {"detail": [...]}`, where `detail` is
the array of zod 4 issues for that request (the repo's `zod` major is 4). Each issue SHALL carry
`code`, `path` (an array of keys and indexes) and `message`. Clients SHALL rely on nothing else in
an issue. Its other fields, its code for a given failure, and the wording of messages the code does
not set SHALL be those zod 4 produces. A message the code sets (for example
`overwrite requires version`) SHALL be returned unchanged.

The same zod 4 messages SHALL appear where a route builds a string `detail` from issues:
- the team routes' `400` detail, which is the first issue's message;
- the AI v2 dashboard write's `422` detail, which is the issues' messages joined with `; `.

A number field SHALL refuse a non-finite value, for example JSON `1e400`, which parses to
`Infinity`, with this `422`. Apart from that, the status codes, the `{detail}` envelope, and which
requests are refused SHALL NOT change.

#### Scenario: A missing field is a zod 4 issue
- **WHEN** a client creates a session without `show_id`
- **THEN** the response is `422`, `detail` is an array, and one issue has code `invalid_type`, path
  `["show_id"]` and a non-empty message

#### Scenario: A message the code sets is unchanged
- **WHEN** a client sends `PUT` on an event with an otherwise valid body, `overwrite: true` and no
  `version`
- **THEN** the response is `422`, and one issue has path `["overwrite"]` and message
  `overwrite requires version`

#### Scenario: A non-finite number is refused
- **WHEN** a client creates a topic whose body has `"duration_sec": 1e400`
- **THEN** the response is `422`, one issue has path `["duration_sec"]`, and no topic is written

#### Scenario: Defaults and transforms are unchanged
- **WHEN** the DELETE version query schema parses `{version: "12", overwrite: "1"}` and `{}`, and
  every request schema with a default or transform parses the inputs recorded before the migration
- **THEN** the first gives version `12` with overwrite `true`, the second gives an empty object,
  and every other output is the same as before the migration

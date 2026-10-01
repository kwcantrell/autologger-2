## ADDED Requirements

### Requirement: Text containing NUL is refused
The catalog cannot store the character U+0000 (NUL). A request value containing NUL that would
reach a catalog statement, whether from a path segment, a query value or a body field, SHALL be
refused with status `400` and a JSON body `{"detail": "<message>"}`. The statement carrying it
SHALL NOT be sent, and a catalog transaction it belongs to SHALL write nothing.

These cases are handled explicitly:
- `POST /api/companion/presence` with a `session_id` containing NUL SHALL be refused with `400`,
  and SHALL store no presence.
- An OAuth callback whose `state` contains NUL SHALL be treated as an invalid state, with the
  existing `state_invalid` redirect.
- A sign-in whose identity token has a subject or email claim containing NUL SHALL be refused
  with the existing `token_invalid` redirect.
- NUL SHALL be removed from the given-name, family-name and picture claims before they are
  stored.

Values without NUL SHALL behave as before.

#### Scenario: NUL in a show name is a 400
- **WHEN** a client creates a show whose `name` contains `\u0000`
- **THEN** the response is `400` with a JSON `detail`, and no show is created

#### Scenario: NUL in a team display name is a 400
- **WHEN** a team admin creates a team whose `display_name` contains `\u0000`
- **THEN** the response is `400` with a JSON `detail`, as for the family's other validation errors, and no team is created

#### Scenario: NUL in a path segment is a 400
- **WHEN** a client requests a team-scoped route whose team id path segment contains a percent-encoded NUL
- **THEN** the response is `400` with a JSON `detail`, not `500`

#### Scenario: NUL in a presence session id is refused
- **WHEN** a Companion client posts presence with a `session_id` containing NUL
- **THEN** the response is `400`, and a later `GET /api/companion/state` answers as if that presence had never been posted

#### Scenario: NUL in the OAuth state is an invalid state
- **WHEN** the OAuth callback receives a `state` containing a percent-encoded NUL
- **THEN** it redirects with `login_error=state_invalid`

#### Scenario: NUL in the email claim refuses sign-in
- **WHEN** a first Google sign-in carries an `email` containing NUL
- **THEN** it redirects with `login_error=token_invalid` and creates no user

#### Scenario: NUL in a name claim is stripped
- **WHEN** a first Google sign-in carries a `given_name` containing NUL and valid other claims
- **THEN** the user is created, and the stored given name is the claim with NUL removed

### Requirement: Catalog integer fields are bounded
A request integer that the server stores in a 64-bit catalog column (session
`start_offset_frames`, on create and on update) SHALL be at most `9007199254740991`
(`Number.MAX_SAFE_INTEGER`). A larger value SHALL be refused with status `422` and the existing
validation-error body, instead of failing on storage.

#### Scenario: An oversized frame offset is a 422
- **WHEN** a client creates a session with `start_offset_frames` of `1e20`
- **THEN** the response is `422` with a validation-error body, and no session is created

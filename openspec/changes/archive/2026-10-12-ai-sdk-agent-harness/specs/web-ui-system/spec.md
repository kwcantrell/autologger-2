## MODIFIED Requirements

### Requirement: Settings manages the user's AI providers
The Settings view SHALL have an **Advanced** section, in the "You" group after Companion devices,
available to every signed-in user whatever their team role. It SHALL show and change only the
signed-in user's own provider credentials, through api-contract-freeze "Provider credential
routes".

It SHALL be composed from the shared shadcn primitives and the existing Settings parts, with no
one-off markup where a primitive exists.

**Approval note.** When `GET /api/me/providers` reports `run_features_allowed: false`, the
section SHALL show, above the tabs, a status note: "Transcription and AI features are limited to
approved users on this server." The user can still save and test keys.

**Layout.**
- The section SHALL show two tabs, **Language model** and **Speech to text**.
- Both tab panels SHALL stay mounted while the section is mounted, so an unsaved edit in one
  survives switching to the other.
- Each panel SHALL show:
  - a status badge, "Connected" when a credential is saved and "Not set up" otherwise;
  - one-line help naming what the provider powers.

**Fields.**
- **Language model:** Provider (OpenAI-compatible, Anthropic, OpenAI or Google, plus "Claude CLI
  (operator)" as described below), Base URL (shown only for OpenAI-compatible), Model, API key.
- **Speech to text:** Provider (DeepGram, the only choice), Model, API key.

**The Claude CLI option.**
- "Claude CLI (operator)" SHALL be offered in the Language model provider list only when
  `GET /api/me/providers` reports `claude_cli_allowed: true`. It SHALL also be shown, as the
  current choice, when the saved language model's provider is `claude-cli`, so the user can see
  and replace or remove it.
- With it selected, Base URL, Model and API key SHALL be hidden, and the help line SHALL read
  "Runs on this server's Claude CLI login. Available only to operator accounts."
- Saving it SHALL send `{provider: "claude-cli"}` with no key, base URL or model. Save SHALL be
  enabled for it without any typed field.
- When it is saved, the badge reads "Connected", and **Test connection** and **Remove** are
  offered as for any saved credential.
- Switching from a saved Claude CLI to any other provider SHALL require a key, under the rules
  below.

**The API key is write-only.**
- With no saved credential, the key is a password input.
- With one, the row reads "Key set, ending in ••<last4>." and offers **Replace**, which shows the
  password input, and **Remove**, which asks through the themed confirm dialog and then deletes the
  credential.
- A typed key SHALL live only in the panel's component state. It SHALL NOT be written to the query
  cache or any storage, and SHALL be cleared after a save.

**Saving.**
- Each panel SHALL have its own save bar, following "Honest save model in Settings".
- Save SHALL be disabled until the panel's fields are valid:
  - a model is required, except for the Claude CLI;
  - a base URL is required for an OpenAI-compatible language model;
  - a key is required when none is saved, except for the Claude CLI;
  - a key is required when the language model's provider, or its OpenAI-compatible base URL
    host, changes to a provider other than the Claude CLI. The key row then shows the password
    input with the help "A new provider or host needs its key entered again."

**Testing.**
- Each panel with a saved credential SHALL offer **Test connection**. It shows a busy state while
  running, then the response's `detail` as a success or error alert.
- Editing any field SHALL clear the last result.

**Errors.** A failed load, save, remove or test request SHALL show the response's `detail` and
change nothing else.

#### Scenario: Saving a key shows only its last four characters
- **WHEN** a user enters a base URL, a model and the key `sk-test-9f2c` on Language model and saves
- **THEN** the badge reads "Connected", the key row reads "Key set, ending in ••9f2c.", and the
  key appears nowhere else on the page or in the query cache

#### Scenario: A draft survives a tab switch
- **WHEN** the user types a model on Language model, switches to Speech to text, and switches back
- **THEN** the typed model is still there and the Language model save bar still offers Save

#### Scenario: Removing a key asks first
- **WHEN** the user presses Remove, declines, presses it again and confirms
- **THEN** after declining nothing was sent; after confirming the credential is deleted and the
  panel shows "Not set up" with an empty key input

#### Scenario: A failed test shows the server's reason
- **WHEN** the user tests a credential and the response is `{ok: false, detail: "The provider
  rejected the API key."}`
- **THEN** the panel shows that detail in an error alert

#### Scenario: Users who are not approved are told before adding a key
- **WHEN** a user whose providers response has `run_features_allowed: false` opens Advanced
- **THEN** the approval note shows above the tabs, and the fields still work

#### Scenario: Choosing a fixed-host provider hides the base URL
- **WHEN** the user picks Anthropic as the language model provider
- **THEN** the Base URL row is hidden and is not sent on save

#### Scenario: Changing the host asks for the key again
- **WHEN** a user with a saved language model changes its base URL to another host
- **THEN** the key row shows an empty password input with the new provider or host help, and Save stays
  disabled until a key is entered

#### Scenario: A member manages their own providers
- **WHEN** a plain member of a team, with no grants, opens Settings
- **THEN** the Advanced section is enabled and shows only that member's credentials

#### Scenario: A user who is not allowlisted doesn't see the Claude CLI
- **WHEN** a user whose providers response has `claude_cli_allowed: false` and no saved
  `claude-cli` credential opens the Language model provider list
- **THEN** the list offers OpenAI-compatible, Anthropic, OpenAI and Google, and no "Claude CLI
  (operator)"

#### Scenario: Choosing and saving the Claude CLI sends no key
- **WHEN** a user whose providers response has `claude_cli_allowed: true` picks "Claude CLI
  (operator)" and saves
- **THEN** Base URL, Model and API key are hidden, the help line reads "Runs on this server's
  Claude CLI login. Available only to operator accounts.", the request body is
  `{provider: "claude-cli"}` with no key, and after the save the badge reads "Connected" and Test
  connection is offered

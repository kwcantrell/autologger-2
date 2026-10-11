## MODIFIED Requirements

### Requirement: Configuration-gated generation
Transcript generation SHALL be gated on the caller having a usable speech-to-text credential, as
provider-credentials "Work runs on its user's credentials" resolves it. In development mode, a
caller without one SHALL fall back to `DEEPGRAM_API_KEY` when it is set.

When neither applies, `POST /api/sessions/:sessionId/transcript-words/generate` SHALL answer `503`
with the detail `Add a speech-to-text key in Settings → Advanced to generate transcripts.`
(api-contract-freeze "Transcript generation endpoint behavior"). Otherwise the endpoint SHALL run
the generation pipeline:
- with the credential's model;
- for the fallback, with `DEEPGRAM_MODEL`, which defaults to `nova-3`.

The API key MUST NOT appear in any response body, log line, or stored artifact other than its
encrypted credential row. It MUST be sent only in the `Authorization` request header, never in a
URL, so no error path can stringify it.

#### Scenario: Unconfigured deployment keeps the frozen 503
- **WHEN** in production mode a user without a speech-to-text credential calls `POST
  /api/sessions/:id/transcript-words/generate`
- **THEN** the response is `503` with the Settings → Advanced detail and no DeepGram request is
  made

#### Scenario: Configured deployment generates
- **WHEN** a user with a speech-to-text credential calls the endpoint and the session has at least
  one readable audio segment
- **THEN** the DeepGram request carries that user's key and model, and the endpoint responds
  `200 {words}` with the generated transcript words

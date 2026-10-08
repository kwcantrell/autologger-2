# AutoLogger

Control an AutoLogger session from Companion. **A browser must be open on the
AutoLogger session** — the module acts on whichever session that browser reports as active.

## Configuration
- **Server URL** — e.g. `http://127.0.0.1:8787`.
- **Device token** — required. Sign in to AutoLogger, open **Settings → Companion devices**,
  create a device, and paste the token it shows (it starts with `ald_` and is shown once).
  The module acts as the user who created the device and sees only the sessions that user can
  access. Companion keeps the token in its secrets store.
- **Poll interval (ms)** — default 1000.

## Device tokens
- The server's `API_TOKEN` no longer works. After the server deploy that retired it, re-pair
  every Companion install: create a device in Settings and paste its token. A connection upgraded
  from an earlier module version keeps its old `API_TOKEN` value in the token field, but the
  server rejects it.
- A token expires after 90 days without use, and deleting the device in Settings revokes it.
  Either way the connection shows **Device token invalid or revoked**: create a new device and
  paste its token.

## Notes
- **Which session?** Buttons show the session/show (`deck_title`) — always check it before pressing; with multiple browser tabs open the active session can change.
- **Record/Play** are relayed to the browser; the `command_error` variable reports if delivery failed. `Playing` state is best-effort (reported by the browser), unlike `Rolling`/`Recording`.

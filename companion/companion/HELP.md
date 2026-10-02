# AutoLogger

Control an AutoLogger session from Companion. **A browser must be open on the
AutoLogger session** — the module acts on whichever session that browser reports as active.

## Configuration
- **Server URL** — e.g. `http://127.0.0.1:8787`.
- **API token** — required: the server's `API_TOKEN`. Without it every request gets `401`.
- **Poll interval (ms)** — default 1000.

## Notes
- **Which session?** Buttons show the session/show (`deck_title`) — always check it before pressing; with multiple browser tabs open the active session can change.
- **Record/Play** are relayed to the browser; the `command_error` variable reports if delivery failed. `Playing` state is best-effort (reported by the browser), unlike `Rolling`/`Recording`.

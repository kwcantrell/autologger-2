# 0023: Companion can join Supabase Realtime (ADR 0021 slice 2 spike)

- Date: 2026-10-01
- Status: Proposed (the owner picks direct or relay before slice 9)
- Rule: none. This records a spike finding. No code was committed; the spike ran from the
  session scratchpad and was removed.

## Context

ADR 0021 replaces the WebSocket protocol with Supabase Realtime and left one question open: can
Companion join a Realtime channel? The fallback is a Companion-only relay.

Today the Companion module speaks HTTP only:
- `companion/src/api.ts` and `poller.ts` poll `GET /api/companion/state`, call `GET /api/companion/categories`
  and POST `log`, `transport` and `command`, with `Authorization: Bearer API_TOKEN` (the server
  also has `POST /api/companion/presence`, used by browsers, and the retired
  `GET /api/companion/commands/wait`);
- the server relays a command to the browser over the session WebSocket
  (`SessionHub.broadcastCommand`, from `server/src/routers/companion.ts`).

So the choice is:
- **(A) Direct:** the module subscribes to Realtime for live state and sends commands as
  broadcasts.
- **(B) Relay:** the module keeps its HTTP calls to the api, and the api publishes to Realtime.

## What was tested

- **Spike module.** A throwaway module, `autologger-spike` (`@supabase/realtime-js` 2.117.2,
  `@companion-module/base` 1.14), was built with `companion-module-build`.
- **Runtime.** It ran in a throwaway container of the dev Companion image (v4.3.4, module runtime
  Node v22.22.2). The container was on the dev `edge` network and connected to
  `ws://supabase-gw:8000/realtime/v1`.
- **Gateway.** For the spike only, the gateway's Host check also allowed `supabase-gw:8000`,
  through a scratch override.
- **Credentials.** The module used the dev anon key and short-lived HS256 tokens. The tokens were
  minted from the dev JWT secret with role `authenticated` and sub `companion-spike`.
- **Stand-in browser.** A Node client on the host connected through `127.0.0.1:8790`.
- **Scratch database objects.** A `public.spike` table in the `supabase_realtime` publication,
  and two `realtime.messages` policies for the private topic `companion:spike` (subs
  `companion-spike` and `browser-spike` only).
- **Cleanup.** Everything was dropped afterwards, and `docker/supabase/test_gateway.sh dev`
  passed 45/45.

## Results

| # | Question | Result |
|---|---|---|
| 1 | Does the module bundle and load in Companion? | Yes. The bundle is 202 KB including `ws`. Init logged `"node":"v22.22.2","hasWebSocket":"function"` |
| 2 | Does it connect and join through the gateway? | Yes: `spike-cmd`, `spike-db` and `companion:spike` all `SUBSCRIBED` |
| 3 | Command path (broadcast) | Module → browser: 200/200 delivered, p50 1 ms, p95 2 ms. Browser → module → browser round trip: 200/200, p50 3 ms, p95 4 ms |
| 4 | State path | `postgres_changes` INSERT: 50/50 delivered, p50 260 ms, p95 480 ms, max 504 ms. Presence sync reached the module |
| 5 | Private channel and RLS | The allowed subs join and the module received 25/25 messages. A token with another sub got `Unauthorized: You do not have permissions to read from this Channel topic: companion:spike` and received 0 messages |
| 6 | Token expiry | Without a refresh, Realtime closed every channel at `exp`, and the client did not rejoin. With `setAuth(newToken)` 40 s into a 60 s token, the channels stayed up and an insert 27 s past the first token's `exp` was delivered. That is one run, not a reliability result |
| 7 | Reconnect | With the `ws` transport, all three channels re-`SUBSCRIBED` 6-8 s after a Realtime restart (three runs: 8110 ms, 8175 ms, and about 6.2 s in an earlier overlapping run) and about 1.0 s after a gateway restart (one run). Recovery passed through transient `CHANNEL_ERROR`s (1012, 1006) and transport errors first. With Node 22's built-in WebSocket, the client never reconnected; see below |
| 8 | Cost | From `ps` in the same Companion, the spike process used 63440 KiB RSS against 53680 KiB for the current `autologger` module at idle: about 10 MB more. CPU over the test window, which included the 20 msg/s bursts and idle time, was 0.4% median and 0.9% max across 5 samples |

The latencies come from one or two runs on one host over loopback, so they say nothing about LAN
or proxy latency.

## Findings that shape the design

1. **Companion modules can't read files.** Companion 4.3 starts modules with Node's
   `--permission` and only the module directory readable. `readFileSync` failed with "Access to
   this API has been restricted". Credentials must come through the module's config: `secret-text`
   fields, which Companion keeps in its secrets store.
2. **Set the token before the first join.** With only an `accessToken` callback, the first join
   carried the anon key. Realtime logged `iss=supabase` with the anon key's `exp`. The likely cause,
   which the spike didn't trace, is that `realtime-js` joins before the callback resolves. The consequences were:
   - the private channel failed once with `Unauthorized`, then rejoined about 5 s later;
   - `postgres_changes` registered as `anon` (`realtime.subscription.claims_role = anon`) and
     delivered nothing, while still reporting `SUBSCRIBED`. It failed silently.

   `await client.setAuth()` before `subscribe()` fixed both: the subscription registered as
   `authenticated|companion-spike` and 50/50 events arrived. This applies to the web client in
   slice 9 too.
3. **Node 22's built-in WebSocket doesn't reconnect.** After a Realtime restart, on Node v22.22.2
   (both inside Companion and as plain `node` in the same image) the client logged a transport
   `error` with no `close`. It stayed disconnected for the rest of each run: more than 50 s plain,
   and about 6 min in the module until it was replaced. The same client on the host's Node 24.21.0 got `close` events and
   rejoined after about 6 s.

   Passing `ws` (v8.22) as `transport` fixed it on plain Node 22 (about 8 s to rejoin) and inside
   Companion. Even then, recovery passes through several transient errors, so the module's status
   should debounce `CHANNEL_ERROR`. A module on Node 22 must ship `ws`,
   or add a watchdog that rebuilds the client.
4. **Expiry closes channels with no automatic recovery.** A Companion credential has to be
   refreshed before `exp` through `setAuth`, and the module has to rebuild its channels after a
   `CLOSED` it didn't cause.
5. **Public channels are open to any key holder.** An `authenticated` token with an unrelated sub
   joined the public `spike-cmd` channel. Every slice 9 topic must be private, with
   `realtime.messages` policies. Consider the tenant's private-only setting.
6. **`realtime-js` transport logs include the apikey.** The connect log line carries
   `?apikey=<anon key>`. Don't forward transport logs to Companion's log, which the admin UI shows
   and exports. (The spike's own log printed the dev anon key once before redaction was added. The
   anon key is the public client key, but this repo treats it as a secret.)
7. **The gateway has to admit Companion.** Today it allows only Host `localhost|127.0.0.1:<port>`
   on loopback, and it rejects any Origin other than that address (Companion sends none). Direct mode needs a Host or route that Companion can reach: the LAN, or the
   upstream proxy (the stage-behind-proxy follow-up). The browser will need the same, and the Origin rule as well.

## Recommendation

**(A) Direct is feasible.** Commands and live state work, with these conditions:
- private topics with RLS;
- `setAuth` before joining;
- the `ws` transport;
- refresh before expiry.

The recommendation is A for commands and live state in slice 9, provided slice 5 provides a
Companion credential that can be refreshed. Writes Companion makes today (`log`, `transport`)
stay on the api or an RPC, decided in slices 7 and 8. Realtime is not a write path.

B stays the fallback and costs nothing to keep. `/api/companion/*` keeps working until slice 9.
The ADR 0021 trigger "the Companion spike fails and a relay would keep the old WebSocket protocol
alive" did not fire.

## Open decisions (owner)

- **Credential model (slice 5).** Each option needs a module-side refresh that persists the new
  secret through `saveConfig`, which was not tested here:
  - a GoTrue user per Companion device, with a refresh token in Companion's secrets store
    (revocable, normal RLS);
  - a long-lived token minted from the JWT secret (simple, but not revocable short of rotating the
    secret);
  - a dedicated `companion` role with narrow policies.
- **Network path.** How Companion reaches the gateway in prod: the LAN address or the upstream
  proxy, and the Host value the gateway accepts.
- **State derivation.** `/api/companion/state` computes the active session (freshest visible
  presence), timecode, rolling and recording state, and the event count on the server. Under A,
  that moves to Realtime presence plus `postgres_changes` on the session and lease tables (slices
  7 and 8), or to a broadcast the api publishes.

## Consequences

- Slice 9 plans the Companion module change: `ws` dependency, secret fields, refresh, rebuild on
  `CLOSED`, private topics. The `api-contract-freeze` delta for `/api/companion/*` happens there.
- Slice 5's credential decision has to cover a headless device as well as browser users.

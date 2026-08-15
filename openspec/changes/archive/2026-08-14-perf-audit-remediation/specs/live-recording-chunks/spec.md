# live-recording-chunks — delta

## MODIFIED Requirements

### Requirement: Rescue and uploads are bound to their recording's session and survive component lifecycle

Chunk uploads and the rescue queue SHALL bind to the session id captured when the
recording started, and the queue SHALL live outside the recorder component's lifecycle,
so switching the workspace to another session (the recorder is not remounted per session)
or unmounting the recorder mid-drain neither retargets uploads at the wrong session nor
silently discards queued chunks. The page-leave warning SHALL cover, in addition to
active recording, any state with a non-empty rescue queue or an in-flight chunk upload.
(A full page unload after the warning still loses unsent chunks — an accepted, disclosed
limit, per the proposal's Non-Goals.)

That coverage is unchanged. What is now additionally required is the **attachment
discipline** behind it, which is user-observable in a new way. A registered `beforeunload`
listener disqualifies the page from the back/forward cache on its **mere presence** — the
browser never inspects whether the handler would actually warn — so registering one at module
scope, for the lifetime of the tab, cost every route a restored-from-bfcache navigation,
including the overwhelmingly common case where nothing has ever been recorded.

Therefore:

- **The page SHALL remain bfcache-eligible while there is nothing to lose.** No
  `beforeunload` listener SHALL be registered by the chunk machinery while the rescue queue
  is empty and no upload is in flight — including before any recording has ever started, when
  the queue singleton does not yet exist. The leave-warning module SHALL reach the queue
  through a peek/creation seam that never constructs the singleton itself.
- **The listener SHALL be attached synchronously with the enqueue that creates the risk.**
  The module SHALL subscribe to the queue and attach on any snapshot with a non-empty chunk
  list or an in-flight upload; because the queue notifies its subscribers synchronously from
  inside `enqueue()` (and from every other mutation point), the listener is armed in the same
  turn as the chunk landing in the queue. There SHALL be no window in which a chunk exists
  unwarned. The handler SHALL still re-read the live snapshot when it fires, as race defense.
- **The listener SHALL be removed when the queue drains**, restoring bfcache eligibility.
  Attach and detach SHALL both be idempotent, so a repeated non-empty snapshot cannot stack a
  second listener and a repeated drain cannot double-remove.
- **`AudioRecorder`'s own leave guard SHALL be likewise scoped**: its `beforeunload` listener
  is registered only for the span of an actual recording (`phase === 'recording'`), not for the
  component's whole mount. Gating the registration, not merely the handler body, is what keeps
  an idle session page bfcache-eligible.

Multiple `beforeunload` listeners compose — each gets its own chance to `preventDefault()` — so
the recorder's guard and the queue's guard coexist without either needing to know about the
other.

#### Scenario: Session switch mid-recording does not retarget uploads
- **WHEN** the user switches the workspace to a different session while a recording with
  pending chunk uploads is active
- **THEN** every chunk (including later rollovers of that recording) uploads to the
  session where the recording started

#### Scenario: Closing the tab with queued chunks warns first
- **WHEN** the user closes the tab after stopping a recording whose rescue queue is
  non-empty
- **THEN** the browser's leave warning fires (the same guard as leaving mid-recording)

#### Scenario: An idle app registers no leave listener
- **WHEN** the app is loaded on any route and nothing has been recorded — no chunk is queued
  and no upload is in flight
- **THEN** no `beforeunload` listener is registered by the chunk machinery or by the recorder,
  and the page stays eligible for the back/forward cache

#### Scenario: Enqueuing a chunk arms the warning in the same turn
- **WHEN** a chunk is enqueued
- **THEN** the `beforeunload` listener is registered synchronously with that enqueue, with no
  intervening turn in which the chunk is queued but the warning is not armed

#### Scenario: Draining the queue disarms the warning
- **WHEN** the last queued chunk finishes uploading and no upload remains in flight
- **THEN** the `beforeunload` listener is removed and the page is bfcache-eligible again

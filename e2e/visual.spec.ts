import { expect, type Locator, type Page, test } from '@playwright/test';
import { createSession as createSessionShared, openRailIfMobile } from './createSession';

// -----------------------------------------------------------------------------
// Visual-regression harness (spec stage 0b).
//
// Freezes the PRE-Tailwind rendering as committed PNG baselines. Every later
// migration slice diffs against these; re-baselining is forbidden, so all
// nondeterminism must be pinned HERE via `prepareForShot` + masks.
//
// Determinism controls:
//   * `expect.toHaveScreenshot` defaults (playwright.config.ts): animations
//     disabled, caret hidden, maxDiffPixels: 0.
//   * `prepareForShot` pauses/rewinds every <video> (the webm loading logo
//     autoplays) and awaits `document.fonts.ready`.
//   * Wall-clock / random regions are masked in every shot that shows them —
//     see the mask helpers below. Masks are frozen with the baselines, so they
//     must all exist NOW even if a region is empty at capture time.
//
// The visual-desktop / visual-mobile projects run this file at 1280×720 and
// 390×844 respectively; the mobile viewport exercises the Radix bottom-sheet
// and the V6Rail off-canvas drawer automatically.
// -----------------------------------------------------------------------------

/** Kill nondeterminism the `animations: 'disabled'` flag can't reach. */
async function prepareForShot(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const v of document.querySelectorAll('video')) {
      v.pause();
      v.currentTime = 0;
    }
    // Auto-focused inputs (e.g. the rename modal) select their text; whether
    // the ::selection highlight has painted by shot time is a race that
    // `caret: 'hide'` does not cover. Collapse any selection deterministically.
    const ae = document.activeElement;
    if (
      (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement) &&
      typeof ae.setSelectionRange === 'function'
    ) {
      try {
        ae.setSelectionRange(0, 0);
      } catch {
        // number/email inputs throw on setSelectionRange — nothing to collapse.
      }
    }
    // The mobile layout lets the PAGE scroll (html/body overflow-y auto below
    // 768px), so interactions that scroll an element into view (e.g. tapping
    // "Delete row" low in the feed) leave a run-order-dependent scroll offset —
    // observed as a whole-viewport vertical shift. Pin to the top before every
    // shot; desktop's viewport-locked shell makes this a no-op there.
    window.scrollTo(0, 0);
  });
  await page.evaluate(() => document.fonts.ready);
}

// Wall-clock text renders in the timeline deck (`#session-aside-date`, class
// `.v4-session-date` / `.v5-session-date-inline`) and in the recent-sessions
// rail cards (`.sessionCardMeta` inside `#session-list`) — baselines captured
// today would fail tomorrow. Date regions are masked in EVERY shot that shows
// them (loss logged: date typography is verified by the per-slice review
// checklist instead). The random session UUID (`#v4-session-id-display`) is
// masked for the same reason.
const DATE_MASK = (page: Page): Locator[] => [
  page.locator('.v4-session-date'),
  page.locator('.v5-session-date-inline'),
  page.locator('#session-list'), // rail session cards carry dates + runtime
  page.locator('#v4-session-id-display'), // random per-run session UUID
  // ui-refresh home launch surface: the resume card shows the most recent
  // active session (title/date/count from the shared hermetic DB), which
  // varies with whatever other specs in this run created sessions first.
  page.locator('#home-resume-session'),
];
const VIDEO_MASK = (page: Page): Locator[] => [
  page.locator('video'),
  page.locator('.autologger-loading-video'),
];
// Time-driven regions for rolling/playing shots: the timecode aside (live
// clock) + the timeline geometry (playhead/readout are wall-clock-driven).
const LIVE_MASK = (page: Page): Locator[] => [
  ...VIDEO_MASK(page),
  ...DATE_MASK(page),
  page.locator('#timeline-shell'),
  page.locator('#v4-session-aside'),
];
// Stopped-session feed/workspace shots keep the timeline chrome visible (ticks,
// track, readout) but must mask `#timeline-markers`: a seeded event's marker is
// positioned from its timecode, whose frame digits depend on ms-level click
// timing, so the marker glyph + playhead-glow jitter sub-pixel run-to-run. The
// aside (live/last clock) is masked for the same reason. Timeline typography is
// covered by the always-visible ticks/readout and by the per-slice review.
const FEED_MASK = (page: Page): Locator[] => [
  ...VIDEO_MASK(page),
  ...DATE_MASK(page),
  page.locator('#v4-session-aside'),
  page.locator('#timeline-markers'),
];

// -----------------------------------------------------------------------------
// Flows (mirror e2e/smoke.spec.ts).
// -----------------------------------------------------------------------------

// The shared helper (./createSession.ts) with this suite's fixed episode text
// — the title (show code + episode) appears in shots and the default is
// derived from the show's next_episode counter. Pin it so the deck/rail title
// text is identical run to run.
async function createSession(page: Page): Promise<void> {
  await createSessionShared(page, { episode: 'VIS01' });
}

async function rollAndLog(page: Page): Promise<void> {
  await page.locator('#btn-ctl-2').click(); // roll timecode
  const sceneBtn = page
    .locator('#cat-strip-live-slot [data-category-id]')
    .filter({ hasText: 'Scene' });
  await expect(sceneBtn).toBeEnabled();
  await sceneBtn.click();
  await expect(page.locator('#v4-log-sheet tr[data-event-id]').first()).toBeVisible();
}

/** Roll, log a Scene, then stop timecode — leaves a session with seeded events. */
async function seedStoppedSession(page: Page): Promise<void> {
  await createSession(page);
  await rollAndLog(page);
  await page.locator('#btn-ctl-4').click(); // stop timecode (btn-ctl-4, verified vs TransportControls.tsx)
  await expect(page.locator('#v5-controls-status-value')).toHaveText('Stopped');
}

// Quality fix wave, FIX 6d: the transcribe-feed and topics-feed tests each
// seeded rows via an out-of-band POST, then reloaded to force a cold refetch
// (see `seedTranscriptAndTopicsRows`'s comment below for why the reload is
// needed) — the exact same 6-line block, duplicated verbatim in both tests.
// Extracted here, next to `seedStoppedSession`, so a future third
// seeded-feed shot has one place to call, not a third copy to keep in sync.
// (Forward reference to `seedTranscriptAndTopicsRows`, defined below — safe:
// `async function` declarations hoist.)
async function seedRowsAndReload(page: Page): Promise<void> {
  const sessionUrl = page.url();
  const sessionId = new URL(sessionUrl).pathname.split('/').pop() as string;
  await seedTranscriptAndTopicsRows(page, sessionId);
  await page.goto(sessionUrl);
  await expect(page.locator('#v3-session-grid')).not.toHaveClass(/hidden/);
  await expect(page.locator('#v5-controls-status-value')).toHaveText('Stopped');
}

// feed-row-seek, task 11.4: the transcript and topics visual fixtures
// previously screenshot EMPTY feeds ("No transcript yet" / "No topics yet"),
// so the new leading jump column (and any column-width regression around it)
// was invisible to the visual gate — a baseline that never renders a row
// can't move when a row's layout breaks. Seed real rows via the plain
// transcript-words/topics CRUD endpoints (routers/transcribe.ts — ungated,
// unlike …/generate), same `page.evaluate(fetch(...))` idiom smoke.spec.ts
// already uses for out-of-band API calls against the session the UI just
// created (cookie auth rides along automatically; same-origin, no CORS).
//
// The hermetic default show's frame rate is 24fps (server/src/studio.ts
// DEFAULT_STUDIO_BLOB), so a full `HH:MM:SS:FF` timecode's frame field tops
// out at 23 — "01:23:45:12" is a valid, in-range 11-char string, which is
// the exact shape design D2 (JumpToTimeButton.tsx) measured as already over
// the old 104px (`w-[6.5rem]`) time-cell capacity BEFORE the jump column
// existed. Both feeds get one such row so a truncation/overflow regression
// in the new layout has something to truncate.
//
// Transcript words are seeded first (and with non-empty `session_time`) so
// Topics' `transcriptAnchored` gate (TopicsFeed.tsx `transcriptWhollyAnchorless`)
// is open — otherwise every Topics row's jump control would render nothing
// and the very column under test would be invisible in that feed too.
//
// ui-refresh keeps every feed tab mounted (just hidden) rather than
// unmounting the inactive ones, so BOTH panels' rows exist in the DOM
// simultaneously regardless of which tab is active — the transcript and
// topics session-time values below are deliberately kept distinct (never
// sharing a string) so an `aria-label="Jump to <time>"` lookup in one feed's
// test can never strict-mode-collide with a same-valued row sitting hidden
// in the other feed's mounted panel.
async function seedTranscriptAndTopicsRows(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(
    async ({ sid }) => {
      const words = [
        { session_time: '00:00:05:00', speaker: '0', word: 'Welcome' },
        { session_time: '00:00:06:00', speaker: '0', word: 'to' },
        { session_time: '00:00:07:00', speaker: '0', word: 'the' },
        { session_time: '00:00:08:00', speaker: '1', word: 'show.' },
        // Full HH:MM:SS:FF — the over-capacity shape (see comment above).
        { session_time: '01:23:45:12', speaker: '1', word: 'Testing' },
        { session_time: '01:23:46:00', speaker: '1', word: 'timecode overflow at full precision.' },
      ];
      const topics = [
        {
          session_time: '00:10:05:00',
          duration_sec: 12,
          topic_level: 1,
          summary: 'Cold open and introductions.',
        },
        {
          session_time: '00:10:20:00',
          duration_sec: 45,
          topic_level: 2,
          summary:
            'Discussion of the first segment, with a longer summary to exercise wrapping in the summary column and the auto-grow textarea.',
        },
        // Full HH:MM:SS:FF — the same over-capacity shape as above, at a
        // different time than the transcript's row (see comment above).
        {
          session_time: '02:11:33:19',
          duration_sec: 30,
          topic_level: 1,
          summary: 'Full-precision timecode topic (over-capacity check).',
        },
        { session_time: '02:12:10:05', duration_sec: 8, topic_level: 3, summary: 'Wrap-up.' },
      ];
      // Sequential, not Promise.all: each POST's `ordinal` is assigned from a
      // server-side counter, so awaiting in order keeps row order (and hence
      // this fixture) deterministic run to run.
      for (const w of words) {
        const res = await fetch(`/api/sessions/${sid}/transcript-words`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(w),
        });
        if (!res.ok) throw new Error(`POST /transcript-words failed: ${res.status}`);
      }
      for (const t of topics) {
        const res = await fetch(`/api/sessions/${sid}/topics`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(t),
        });
        if (!res.ok) throw new Error(`POST /topics failed: ${res.status}`);
      }
    },
    { sid: sessionId },
  );
}

// =============================================================================
// Page-level shots
// =============================================================================

test('home', async ({ page }) => {
  await page.goto('/');
  // ui-refresh: the home placeholder is now the branded launch surface
  // (HomeRoute.tsx, `#home-launch`).
  await expect(page.getByRole('heading', { name: 'AutoLogger' })).toBeVisible();
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('home.png', {
    mask: [...VIDEO_MASK(page), ...DATE_MASK(page)],
    fullPage: false,
  });
});

test('admin-users', async ({ page }) => {
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Admin Users' })).toBeVisible();
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('admin-users.png');
});

// =============================================================================
// Workspace transport states
// =============================================================================

test('workspace stopped + seeded events', async ({ page }) => {
  await seedStoppedSession(page);
  await prepareForShot(page);
  // Stopped clock still shows the last timecode, whose frame digits depend on
  // ms-level click timing → mask the aside here too.
  await expect(page).toHaveScreenshot('workspace-stop.png', {
    mask: FEED_MASK(page),
  });
});

test('workspace rolling', async ({ page }) => {
  await createSession(page);
  await rollAndLog(page);
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('workspace-rolling.png', { mask: LIVE_MASK(page) });
});

test('workspace play', async ({ page }) => {
  // No audio segments exist, so pressing play (btn-ctl-1) is a no-op that keeps
  // the stopped chrome. The "play" transport state (green pause button) only
  // engages with playable audio, which is unavailable headless. This shot
  // therefore captures the stopped workspace reached via the play control —
  // the play-state chrome delta is covered by the review checklist. Mask LIVE.
  await seedStoppedSession(page);
  await page.locator('#btn-ctl-1').click(); // play/pause audio
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('workspace-play.png', { mask: LIVE_MASK(page) });
});

// =============================================================================
// Modals & overlays
// =============================================================================

test('new-session-modal', async ({ page }) => {
  await page.goto('/');
  await openRailIfMobile(page);
  await page.locator('#v6-btn-new-session').click();
  await expect(page.locator('#new-session-form')).toBeVisible();
  await expect(page.locator('#ns-show')).toBeEnabled();
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('new-session-modal.png', { mask: VIDEO_MASK(page) });
});

test('home-settings-modal', async ({ page }) => {
  await page.goto('/');
  await openRailIfMobile(page);
  await page.locator('#v6-btn-settings').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // The settings modal hosts EventButtonsTable on the event-buttons tab.
  await page.locator('#v6-settings-tab-event-buttons').click();
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('home-settings-modal.png', { mask: VIDEO_MASK(page) });
});

test('event-options-modal', async ({ page }) => {
  // EventOptionsModal is nested inside the settings modal → event-buttons tab →
  // the "options" cell button of a DROPDOWN/ON_OFF button row. Open settings,
  // switch to event buttons, and click the first enabled options button.
  await page.goto('/');
  await openRailIfMobile(page);
  await page.locator('#v6-btn-settings').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('#v6-settings-tab-event-buttons').click();
  // The Options-cell button carries the dropdown/on-off summary and is enabled
  // only for DROPDOWN / ON_OFF rows. The hermetic default show seeds an
  // "Audio issue" DROPDOWN whose options are "Lav, Boom" (server/src/studio.ts),
  // so the summary text is deterministic — target that enabled options button.
  const optsBtn = page
    .locator('table[aria-label="Event buttons"] button:not([disabled])')
    .filter({ hasText: 'Lav, Boom' })
    .first();
  await optsBtn.click();
  // The nested EventOptionsModal opens as a Radix Dialog titled "Dropdown
  // options" (the DROPDOWN variant). The settings modal behind it does not
  // carry role=dialog, so assert on the options modal by its accessible name
  // rather than counting dialogs.
  await expect(page.getByRole('dialog', { name: 'Dropdown options' })).toBeVisible();
  // The modal autofocuses its first Option input; whether the programmatic
  // focus paints a :focus-visible ring is a Chrome heuristic race, and the
  // ring repaint shifts the row's wrapped content ~1px on the mobile
  // bottom-sheet (observed 445px diff > the 0.001 ceiling). Blur for a
  // deterministic unfocused state — same treatment as rename-session-modal.
  await page.evaluate(() => {
    const ae = document.activeElement;
    if (ae instanceof HTMLElement) ae.blur();
  });
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('event-options-modal.png', { mask: VIDEO_MASK(page) });
});

test('export-tab', async ({ page }) => {
  await seedStoppedSession(page);
  await page.getByRole('tab', { name: 'Export' }).click();
  // FeedShell titles use role="status" (accessible name from feedAriaLabel).
  await expect(page.getByRole('status', { name: 'Export feed' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Event feed CSV' })).toBeVisible();
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('export-tab.png', { mask: VIDEO_MASK(page) });
});

test('rename-session-modal', async ({ page }) => {
  await createSession(page);
  // The rail (and its session cards) is an inert drawer on mobile — reopen it.
  await openRailIfMobile(page);
  // Open the active session card's row menu, then Rename.
  await page.locator('#session-list button[aria-label="Session options"]').first().click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await expect(page.getByRole('heading', { name: 'Rename session' })).toBeVisible();
  // The modal select()s the name input on a deferred setTimeout(0)
  // (RecentSessionsList.tsx — "Slight defer so Radix Dialog autoFocus doesn't
  // clobber select()"). If the shot lands before that timer, the selection
  // highlight is absent; after it, present — a race prepareForShot's collapse
  // can itself lose by running too early. Wait for the deferred select to have
  // landed FIRST (query the dialog input directly — on the mobile bottom-sheet
  // it is not reliably document.activeElement), then collapse it explicitly so
  // the collapse is the last selection write.
  await page.waitForFunction(() => {
    const inp = document.querySelector('[role="dialog"] input');
    return inp instanceof HTMLInputElement && (inp.selectionEnd ?? 0) > 0;
  });
  // …then collapse AND blur it: select() focuses the input in Chrome, and
  // whether that programmatic focus paints a :focus-visible ring is itself a
  // browser heuristic race (observed as a ring-only ~1.6k-px diff). Blurring
  // pins a deterministic unfocused end-state; the focused-input treatment is
  // covered by the per-slice review checklist instead.
  await page.evaluate(() => {
    const inp = document.querySelector('[role="dialog"] input');
    if (inp instanceof HTMLInputElement) {
      inp.setSelectionRange(0, 0);
      inp.blur();
    }
  });
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('rename-session-modal.png', {
    mask: [...VIDEO_MASK(page), ...DATE_MASK(page)],
  });
});

// =============================================================================
// Feed states
// =============================================================================

test('feed edit-mode', async ({ page }) => {
  await seedStoppedSession(page); // batch edit requires stopped timecode
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('feed-edit-mode.png', {
    mask: FEED_MASK(page),
  });
});

test('feed pending-delete', async ({ page }) => {
  await seedStoppedSession(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
  // Delete the first editable (non-internal) row → it enters pending-delete.
  await page.getByRole('button', { name: 'Delete row' }).first().click();
  await expect(page.getByRole('button', { name: 'Restore row' }).first()).toBeVisible();
  await prepareForShot(page);
  // The feed tab-strip labels occasionally rasterize with a ~1px vertical text
  // offset in this shot on mobile (observed 635px diff, exceeding the 0.001
  // ceiling, ~1-in-3 full-suite runs; never reproduced in isolation) — a
  // full-suite-only race we could not tolerance-govern. The strip is masked
  // HERE ONLY; tab typography remains pixel-gated by the workspace-stop,
  // edit-mode, transcribe, topics, and hide-internal shots.
  await expect(page).toHaveScreenshot('feed-pending-delete.png', {
    mask: [...FEED_MASK(page), page.getByRole('tablist', { name: 'Feed tabs' })],
  });
});

test('transcribe-feed tab', async ({ page }) => {
  await seedStoppedSession(page);
  // feed-row-seek task 11.4: seed real rows — this fixture previously
  // screenshot the empty "No transcript yet" state, which can't catch a
  // jump-column layout regression. The seed POSTs bypass React Query (raw
  // `fetch`, no mutation hook), and ui-refresh keeps every feed tab mounted
  // from session-load time — so `TranscribeFeed`/`TopicsFeed` already fired
  // their (empty) initial fetch before these POSTs land, and nothing
  // invalidates that cache. A fresh navigation (`page.goto`, mirroring
  // smoke.spec.ts's deep-link reload) re-mounts the workspace and refetches
  // cold, same as a real user reloading after someone else edited the
  // transcript.
  await seedRowsAndReload(page);
  // ui-refresh: Transcript is a top-level tab again (the ai-topics-chat
  // nested "AI tabs" arrangement is gone — see SessionWorkspace.tsx's flat
  // "Feed tabs" tablist).
  await page
    .getByRole('tablist', { name: 'Feed tabs' })
    .getByRole('tab', { name: 'Transcript' })
    .click();
  await expect(
    page.getByRole('tablist', { name: 'Feed tabs' }).getByRole('tab', { name: 'Transcript' }),
  ).toHaveAttribute('aria-selected', 'true');
  // Wait for the seeded rows (and their jump-column buttons) to actually
  // render before shooting — the fixture's whole point is that this feed
  // shows content, not the empty-state card.
  await expect(page.getByRole('button', { name: 'Jump to 01:23:45:12' })).toBeVisible();
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('transcribe-feed.png', {
    mask: FEED_MASK(page),
  });
});

test('topics-feed tab', async ({ page }) => {
  await seedStoppedSession(page);
  // feed-row-seek task 11.4: seed real rows — this fixture previously
  // screenshot the empty "No topics yet" state, which can't catch a
  // jump-column layout regression. Transcript words are seeded too (even
  // though this tab doesn't show them) because Topics' jump column only
  // renders once the session's transcript is anchored (TopicsFeed.tsx
  // `transcriptWhollyAnchorless`). Reload after seeding — see the
  // transcribe-feed test above for why a raw out-of-band POST needs one.
  await seedRowsAndReload(page);
  // ui-refresh: Topics is a top-level tab again (the ai-topics-chat nested
  // "AI tabs" arrangement is gone — see SessionWorkspace.tsx's flat "Feed
  // tabs" tablist).
  await page
    .getByRole('tablist', { name: 'Feed tabs' })
    .getByRole('tab', { name: 'Topics' })
    .click();
  await expect(
    page.getByRole('tablist', { name: 'Feed tabs' }).getByRole('tab', { name: 'Topics' }),
  ).toHaveAttribute('aria-selected', 'true');
  // Wait for the seeded rows (and their jump-column buttons) to actually
  // render before shooting.
  await expect(page.getByRole('button', { name: 'Jump to 02:11:33:19' })).toBeVisible();
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('topics-feed.png', {
    mask: FEED_MASK(page),
  });
});

test('hide-internal toggle', async ({ page }) => {
  await seedStoppedSession(page);
  // Filter popover → uncheck "Show internal events" (default is ON).
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Show internal events' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-hide-internal', '1');
  await prepareForShot(page);
  await expect(page).toHaveScreenshot('hide-internal.png', {
    mask: FEED_MASK(page),
  });
});

// =============================================================================
// Error / toast states
// =============================================================================

test('error-toast variant', async ({ page }) => {
  // Trigger a failing form submit: clear the episode and submit → the
  // NewSessionModal fires showToast('Enter an episode.', true), pinning the
  // isError (border-danger/text) toast branch.
  await page.goto('/');
  await openRailIfMobile(page);
  await page.locator('#v6-btn-new-session').click();
  await expect(page.locator('#ns-show')).toBeEnabled();
  await page.locator('#ns-episode').fill('');
  await page.locator('#ns-submit').click();
  const toast = page.locator('#toast-queue >> text=Enter an episode.');
  await expect(toast).toBeVisible();
  await prepareForShot(page);
  // Clip to the toast queue: the toast is a 3.2s auto-dismiss transient, so
  // shooting only its box avoids racing unrelated chrome and keeps the diff
  // scoped to the error styling under test.
  await expect(page.locator('#toast-queue')).toHaveScreenshot('error-toast.png');
});

// =============================================================================
// Audio recording / audio-save states (fake-media MediaRecorder path)
// =============================================================================
// The fake-media launch args (--use-fake-ui/device-for-media-stream, set on
// both visual projects) let getUserMedia + MediaRecorder run headless. The
// sole `persistent: true` toast call site is AudioSaveOverlay.tsx (fired when
// isUploading flips true), so the persistent-toast and audio-save-overlay
// states share the save flow. Determinism pin: the segment upload
// (POST …/audio/segments…) is STALLED via page.route while the shot is taken,
// holding isUploading true — otherwise the overlay's ~1.35s presentation
// window would race the toHaveScreenshot retry loop.

/** Create a session, roll, and start MediaRecorder audio via the transport. */
async function startRecording(page: Page): Promise<void> {
  await createSession(page);
  // Record immediately after roll — no Scene event first, so the internal
  // recording-start row lands at session time 00:00:00 deterministically.
  await page.locator('#btn-ctl-2').click(); // roll timecode
  const recordBtn = page.getByRole('button', { name: 'Record audio' });
  await expect(recordBtn).toBeEnabled();
  await recordBtn.click();
  // mic_on state = the same slot flips to "Stop recording audio".
  await expect(page.getByRole('button', { name: 'Stop recording audio' })).toBeVisible();
}

/** Stall all audio segment/waveform uploads so isUploading stays true. */
async function stallAudioUploads(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname.includes('/audio/segments'),
    () => {
      /* hold the request forever; the browser context teardown aborts it */
    },
  );
}

test('audio-recording transport state', async ({ page }) => {
  await startRecording(page);
  await prepareForShot(page);
  // LIVE_MASK covers the ticking aside/timeline; the top recording bar's
  // duration counter ticks every second → masked. The "RECORDING AUDIO"
  // label itself is static text and stays visible.
  await expect(page).toHaveScreenshot('audio-recording.png', {
    mask: [...LIVE_MASK(page), page.locator('#top-bar-recording-dur')],
  });
});

test('audio-save overlay', async ({ page }) => {
  await startRecording(page);
  await stallAudioUploads(page);
  await page.getByRole('button', { name: 'Stop recording audio' }).click();
  await expect(page.locator('#autologger-audio-save-overlay')).toBeVisible();
  await prepareForShot(page); // also pauses/rewinds the overlay's loading video
  // Per spec the shot covers the overlay CHROME; the looping video region is
  // masked (VIDEO_MASK matches it), as are the time-driven regions behind the
  // translucent overlay.
  await expect(page).toHaveScreenshot('audio-save-overlay.png', {
    mask: [...LIVE_MASK(page), page.locator('#top-bar-recording-dur')],
  });
});

test('persistent toast (audio-save)', async ({ page }) => {
  await startRecording(page);
  await stallAudioUploads(page);
  await page.getByRole('button', { name: 'Stop recording audio' }).click();
  // The overlay effect fires showToast twice (it re-runs when its own
  // visibility flips 'hidden'→'showing' with isUploading still true), so two
  // identical persistent toasts stack — deterministically. Assert the first;
  // the queue shot freezes both.
  const toast = page.locator('#toast-queue >> text=Saving Audio...').first();
  await expect(toast).toBeVisible();
  await prepareForShot(page);
  // Element shot of the toast queue (same shape as error-toast): pins the
  // non-error persistent-toast styling without racing background chrome.
  await expect(page.locator('#toast-queue')).toHaveScreenshot('persistent-toast.png');
});

// =============================================================================
// Timeline seeked-paused (the unmasked-timeline pixel gate)
// =============================================================================

test('timeline seeked-paused', async ({ page }) => {
  await seedStoppedSession(page);
  const markers = page.locator('#timeline-markers button[data-event-id]');
  // The timeline only renders markers when totalSec > 0 (audio- or event-
  // driven). Without audio segments the track can collapse to zero width and
  // render no markers; if so this state is not deterministically reachable
  // headless — skip rather than freeze an empty/flaky baseline.
  const count = await markers.count();
  test.skip(count === 0, 'timeline has no markers without audio (totalSec === 0)');
  await markers.first().click();
  await expect(markers.first()).toHaveClass(/[Ss]elected/);
  await prepareForShot(page);
  // This is the UNMASKED-timeline pixel gate. The seeded event's timecode
  // varies with ms-level click timing, so the marker glyph, its label, and the
  // seeked playhead all sit at a slightly different x each run:
  //   * Desktop (1280×720): jitter observed ≤ ~390px — within the spec's
  //     per-shot ceiling (0.001 ratio ≡ 921px), so the marker/playhead layers
  //     stay VISIBLE and the shot carries maxDiffPixels: 921. (The config-level
  //     `maxDiffPixels: 0` default merges with per-shot options and the
  //     stricter limit wins, so the override must be maxDiffPixels itself,
  //     not maxDiffPixelRatio alone.)
  //   * Mobile (390×844): jitter observed up to ~578px, EXCEEDING the 0.001
  //     ceiling (329px) — tolerance cannot govern it, so per governance the
  //     time-derived layers (#timeline-markers, #timeline-playhead, the marker
  //     glow) are masked and the shot stays at strict 0. Coverage loss (mobile
  //     selected-marker/playhead styling) is logged in the report; ticks,
  //     track chrome, readout, and zoom rail remain pixel-gated on both.
  const vp = page.viewportSize();
  const isDesktop = (vp?.width ?? 0) >= 768;
  const baseMask = [...VIDEO_MASK(page), ...DATE_MASK(page), page.locator('#v4-session-aside')];
  if (isDesktop) {
    await expect(page).toHaveScreenshot('timeline-seeked-paused.png', {
      mask: baseMask,
      maxDiffPixels: Math.floor((vp?.width ?? 1280) * (vp?.height ?? 720) * 0.001),
    });
  } else {
    await expect(page).toHaveScreenshot('timeline-seeked-paused.png', {
      mask: [
        ...baseMask,
        page.locator('#timeline-markers'),
        page.locator('#timeline-playhead'),
        page.locator('#timeline-marker-playhead-glow'),
      ],
    });
  }
});

// =============================================================================
// Mobile-only: rail drawer open
// =============================================================================

test.describe('mobile drawer', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 768, 'rail drawer is mobile-only');
  test('mobile rail drawer open', async ({ page }) => {
    await page.goto('/');
    // ui-refresh: the home placeholder is now the branded launch surface.
    await expect(page.getByRole('heading', { name: 'AutoLogger' })).toBeVisible();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.locator('#v6-rail')).toBeVisible();
    await prepareForShot(page);
    await expect(page).toHaveScreenshot('mobile-rail-drawer.png', {
      mask: [...VIDEO_MASK(page), ...DATE_MASK(page)],
    });
  });
});

// =============================================================================
// Forced interaction states (desktop only) — hover pseudo-states
// =============================================================================

test.describe('forced interaction states (desktop only)', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 768, 'hover shots are desktop-only');

  /** boundingBox() is null only for detached/invisible elements — fail loudly. */
  async function clipOf(
    l: Locator,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = await l.boundingBox();
    if (!box) throw new Error('hover target has no bounding box');
    return box;
  }

  test('category button hover', async ({ page }) => {
    await createSession(page);
    await rollAndLog(page);
    const btn = page.locator('#cat-strip-live-slot [data-category-id]').first();
    await btn.hover();
    await prepareForShot(page);
    await expect(page).toHaveScreenshot('hover-category.png', { clip: await clipOf(btn) });
  });

  test('transport button hover', async ({ page }) => {
    await createSession(page);
    await rollAndLog(page);
    const btn = page.locator('#btn-ctl-2');
    await btn.hover();
    await prepareForShot(page);
    await expect(page).toHaveScreenshot('hover-transport.png', { clip: await clipOf(btn) });
  });

  test('feed row hover', async ({ page }) => {
    await seedStoppedSession(page);
    const row = page.locator('#v4-log-sheet tr[data-event-id]').first();
    await row.hover();
    await prepareForShot(page);
    await expect(page).toHaveScreenshot('hover-feed-row.png', { clip: await clipOf(row) });
  });
});

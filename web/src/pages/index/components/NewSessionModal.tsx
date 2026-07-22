import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../../api/client';
import { useCreateSession } from '../../../api/hooks/useSessions';
import type { ProfilePayload } from '../../../api/types';
import { BTN_PRIMARY_SKY } from '../../../shared/theme/classnames';
import { Dialog } from '../../../shared/ui/Dialog';
import { showToast } from '../utils/toast';
import { Select } from './Select';

const FPS_PRESETS: [string, string][] = [
  ['23.976', '23.976 (2398/100)'],
  ['24', '24'],
  ['25', '25'],
  ['29.97', '29.97 (30000/1001)'],
  ['30', '30'],
  ['47.952', '47.952 (48000/1001)'],
  ['48', '48'],
  ['50', '50'],
  ['59.94', '59.94 (60000/1001)'],
  ['60', '60'],
  ['100', '100'],
  ['119.88', '119.88 (120000/1001)'],
  ['120', '120'],
];

// Modal-scoped input chrome reach-in (was `.new-session-dialog :global(.profile-select|.num|
// input)`): overrides only bg / border / color / radius over the chrome input base; font /
// padding / width / margin stay from chrome (.profile-select / .num / input[type=text]).
const NS_INPUT_OVERRIDE =
  'bg-[rgba(255,255,255,0.05)] border border-v5-border-strong text-v5-text rounded-[0.5rem]';

// Disclosure toggle (ui-refresh progressive disclosure): quiet text affordance
// with a rotating chevron; aria-expanded carries the state.
const DISCLOSURE_BTN =
  'inline-flex cursor-pointer items-center gap-[0.4rem] self-start border-0 bg-transparent p-0 text-[0.78rem] font-semibold text-v5-muted [transition:color_0.15s_ease] hover-always:text-v5-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(56,189,248,0.55)]';

function fpsFloatMatchesPreset(val: number, presetStr: string): boolean {
  return Math.abs(val - Number.parseFloat(presetStr)) < 0.0001;
}

function fpsToPreset(fps: number): { preset: string; custom: string } {
  for (const [presetVal] of FPS_PRESETS) {
    if (fpsFloatMatchesPreset(fps, presetVal)) return { preset: presetVal, custom: '' };
  }
  return { preset: 'other', custom: String(fps) };
}

interface Props {
  profile: ProfilePayload | undefined;
  onClose: () => void;
  onCreated: (sessionId: string, ytUrl?: string, useYtPublishDate?: boolean) => void;
}

export function NewSessionModal({ profile, onClose, onCreated }: Props) {
  const shows = profile?.shows ?? [];
  const defaultShowId = profile?.active_show_id ?? '';
  const defaultFps = profile?.new_session_defaults?.default_frame_rate ?? 24;
  const { preset: initPreset, custom: initCustom } = fpsToPreset(defaultFps);

  const [showId, setShowId] = useState(defaultShowId || (shows[0]?.id ?? ''));
  const [episode, setEpisode] = useState('');
  const [episodeEdited, setEpisodeEdited] = useState(false);
  const [ytUrl, setYtUrl] = useState('');
  const [useYtPublishDate, setUseYtPublishDate] = useState(false);
  const [notes, setNotes] = useState('');
  const [fpsPreset, setFpsPreset] = useState(initPreset);
  const [fpsCustom, setFpsCustom] = useState(initCustom);
  const [offset, setOffset] = useState('0');
  // Progressive disclosure (ui-refresh): the modal used to present 8 inputs at
  // once. YouTube import and the timecode plumbing (frame rate / start offset)
  // are behind collapsed sections with safe defaults; the core flow is
  // show → episode → notes → create.
  const [showYt, setShowYt] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const episodeRef = useRef<HTMLInputElement>(null);

  const { mutate: createSession, isPending } = useCreateSession();

  // Sync default episode from selected show
  useEffect(() => {
    if (episodeEdited) return;
    const show = shows.find((s) => s.id === showId);
    if (show) setEpisode(String(show.next_episode ?? 1));
  }, [showId, shows, episodeEdited]);

  const handleShowChange = (next: string) => {
    setShowId(next);
    setEpisodeEdited(false);
  };

  // True toggle (ui-refresh): the old button always re-applied the BONUS
  // prefix and its on/off state was unreadable; it now flips the prefix and
  // renders pressed (aria-pressed) while active.
  const isBonus = /^\s*BONUS\b/i.test(episode);
  const handleBonusEpisode = () => {
    const v = episode.trim();
    if (isBonus) {
      setEpisode(v.replace(/^\s*BONUS\s*/i, '').trim());
    } else {
      setEpisode(v ? `BONUS ${v}` : 'BONUS ');
    }
    setEpisodeEdited(true);
    episodeRef.current?.focus();
  };

  const resolvedFps = (): number => {
    if (fpsPreset === 'other') {
      const v = Number.parseFloat(fpsCustom);
      if (!Number.isFinite(v) || v < 1 || v > 120)
        throw new Error('Custom frame rate must be between 1 and 120.');
      return v;
    }
    return Number.parseFloat(fpsPreset);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!showId) {
      showToast('Select a show.', true);
      return;
    }
    if (!episode.trim()) {
      showToast('Enter an episode.', true);
      return;
    }

    let frame_rate: number;
    try {
      frame_rate = resolvedFps();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Invalid frame rate', true);
      return;
    }

    // Update active show if changed
    const prevShow = profile?.active_show_id ?? '';
    const studioId = profile?.active_studio_id ?? '';
    if (studioId && showId && showId !== prevShow) {
      try {
        await apiFetch('profile', {
          method: 'PUT',
          body: JSON.stringify({ active_studio_id: studioId, active_show_id: showId }),
        });
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Failed to update show', true);
        return;
      }
    }

    const start_offset_frames = Number.parseInt(offset, 10) || 0;

    createSession(
      {
        show_id: showId,
        episode: episode.trim(),
        notes: notes.trim() || null,
        frame_rate,
        start_offset_frames,
      },
      {
        onSuccess: (created) => {
          onClose();
          onCreated(created.id, ytUrl.trim() || undefined, useYtPublishDate);
        },
        onError: (err: unknown) =>
          showToast(err instanceof Error ? err.message : 'Failed to create session', true),
      },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      // Desktop rail-offset centering. `md:!` beats Dialog's base translate within the
      // utilities layer; md-scoped so the ≤767px bottom-sheet keeps its own full-width
      // positioning. (The old .new-session-dialog base transform was identical to this and
      // is now gone — this utility is the sole desktop-centering control.)
      className="md:![transform:translate(calc(-50%+8.125rem),-50%)]"
      hideTitle
      title="New Session"
    >
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="flex items-center gap-(--v6-rail-gap)">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            className="shrink-0 text-[rgba(229,238,252,0.72)]"
          >
            <title>New session</title>
            <path d="M12 5V19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M5 12H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          {/* Both `.v6-new-session-modal__title-row h2` and `.v6-new-session-head h2` matched
              this element at equal specificity; the head-h2 rule came LATER in source so it won:
              1rem / 600 / 0.06em / uppercase / v5-text / margin 0. */}
          <h2 className="m-0 text-[1rem] font-semibold tracking-[0.06em] uppercase text-v5-text">
            New Session
          </h2>
        </div>
        <button
          type="button"
          className="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-v5-sm border border-v5-border bg-[rgba(255,255,255,0.04)] text-[1.25rem] leading-none text-v5-muted [transition:background_0.12s_ease,color_0.12s_ease,border-color_0.12s_ease] hover-always:border-v5-border-strong hover-always:text-v5-text"
          aria-label="Close"
          onClick={onClose}
        >
          &times;
        </button>
      </div>

      <form id="new-session-form" className="new-session-form" onSubmit={handleSubmit}>
        <label className="field" htmlFor="ns-show">
          <span>Show</span>
          <Select
            id="ns-show"
            ariaLabel="Show"
            value={showId}
            onChange={handleShowChange}
            options={
              shows.length === 0
                ? [{ value: '', label: 'No shows linked to this team', disabled: true }]
                : shows.map((sh) => ({ value: sh.id, label: `${sh.name} (${sh.show_code})` }))
            }
            disabled={shows.length === 0}
          />
        </label>

        <div
          className="tool-row tool-row-session-opts"
          style={{ flexWrap: 'nowrap', alignItems: 'flex-end' }}
        >
          <label className="field inline" style={{ flex: '1 1 0', minWidth: 0 }}>
            <span>Episode</span>
            <input
              type="text"
              id="ns-episode"
              className={clsx('profile-select', NS_INPUT_OVERRIDE)}
              maxLength={80}
              autoComplete="off"
              ref={episodeRef}
              value={episode}
              onChange={(e) => {
                setEpisode(e.target.value);
                setEpisodeEdited(true);
              }}
            />
          </label>
          <button
            type="button"
            className={clsx(
              'btn mb-4 shrink-0 rounded-v5-sm',
              isBonus
                ? 'border-[rgba(56,189,248,0.5)] bg-[rgba(56,189,248,0.16)] text-[#e0f2fe]'
                : 'border border-v5-border-strong bg-[rgba(255,255,255,0.06)] text-[rgba(255,255,255,0.88)] hover-always:bg-[rgba(255,255,255,0.1)]',
            )}
            id="ns-bonus-episode"
            aria-pressed={isBonus}
            onClick={handleBonusEpisode}
          >
            Bonus
          </button>
        </div>

        <label className="field">
          <span>Notes (optional)</span>
          <input
            type="text"
            id="ns-notes"
            name="notes"
            className={NS_INPUT_OVERRIDE}
            placeholder="Session notes"
            maxLength={2000}
            autoComplete="off"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        {/* Progressive disclosure (ui-refresh): YouTube import + timecode
            plumbing collapse behind toggles with safe defaults; the summaries
            keep the current values readable while closed. */}
        <div className="mt-1 flex flex-col gap-2">
          <button
            type="button"
            className={DISCLOSURE_BTN}
            id="ns-toggle-yt"
            aria-expanded={showYt}
            onClick={() => setShowYt((v) => !v)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              className={clsx('[transition:transform_0.15s_ease]', showYt && 'rotate-90')}
            >
              <path
                d="M9 5L16 12L9 19"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Import audio from YouTube{!showYt && ytUrl.trim() ? ' — link added' : ''}
          </button>
          {showYt && (
            <div className="flex flex-col gap-2 pl-5">
              <label className="field">
                <span>YouTube video link</span>
                <input
                  type="url"
                  id="ns-yt-url"
                  className={clsx('profile-select', NS_INPUT_OVERRIDE)}
                  placeholder="https://www.youtube.com/watch?v=…"
                  autoComplete="off"
                  value={ytUrl}
                  onChange={(e) => setYtUrl(e.target.value)}
                />
              </label>
              <label className="flex flex-row items-center gap-[6px]">
                <input
                  type="checkbox"
                  checked={useYtPublishDate}
                  onChange={(e) => setUseYtPublishDate(e.target.checked)}
                />
                <span className="text-[0.85rem] text-v5-muted">
                  Use the video&apos;s publish date as the session date
                </span>
              </label>
            </div>
          )}

          <button
            type="button"
            className={DISCLOSURE_BTN}
            id="ns-toggle-advanced"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              className={clsx('[transition:transform_0.15s_ease]', showAdvanced && 'rotate-90')}
            >
              <path
                d="M9 5L16 12L9 19"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Timecode settings — {fpsPreset === 'other' ? fpsCustom || '?' : fpsPreset} fps · offset{' '}
            {offset || '0'}
          </button>
          {showAdvanced && (
            <div className="flex flex-col gap-3 pl-5">
              <div className="fps-field">
                {/* Modal reach-in recolored the label var(--color-muted) → var(--v5-muted). */}
                <span className="fps-field-label text-v5-muted">Frame rate</span>
                <Select
                  id="ns-fps-preset"
                  // Keep the fps trigger inside the .fps-field column (legacy #ns-fps-preset width
                  // rule). The old .fps-select bg/radius reach-in already lost to the Select
                  // trigger's own glass utilities, so only the width constraint carries over.
                  // `.fps-select` retained (chrome styles it elsewhere).
                  className="fps-select max-w-[14rem] min-w-0"
                  ariaLabel="Frame rate"
                  value={fpsPreset}
                  onChange={setFpsPreset}
                  options={[
                    ...FPS_PRESETS.map(([value, label]) => ({ value, label })),
                    { value: 'other', label: 'Other…' },
                  ]}
                />
                {fpsPreset === 'other' && (
                  <div id="ns-fps-custom-wrap" className="fps-custom-wrap">
                    <label className="inline fps-custom-label">
                      Custom fps
                      <input
                        type="number"
                        id="ns-fps-custom"
                        min="1"
                        max="120"
                        step="0.001"
                        className={clsx('num fps-custom-input', NS_INPUT_OVERRIDE)}
                        placeholder="1–120"
                        autoFocus
                        value={fpsCustom}
                        onChange={(e) => setFpsCustom(e.target.value)}
                      />
                    </label>
                  </div>
                )}
                <span id="ns-fps-hint" className="fps-hint">
                  NTSC fractional rates use SMPTE-true values.
                </span>
              </div>

              <label className="inline">
                Start offset (frames)
                <input
                  type="number"
                  id="ns-offset"
                  value={offset}
                  min="0"
                  step="1"
                  className={clsx('num wide', NS_INPUT_OVERRIDE)}
                  onChange={(e) => setOffset(e.target.value)}
                />
              </label>
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button
            type="submit"
            // Modal-scoped .btn.primary sky-tint reach-in (shared BTN_PRIMARY_SKY).
            className={clsx('btn primary', BTN_PRIMARY_SKY)}
            id="ns-submit"
            disabled={isPending}
          >
            {isPending ? 'Creating…' : 'Create & open'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../../api/client';
import { useCreateSession } from '../../../api/hooks/useSessions';
import type { ProfilePayload } from '../../../api/types';
import { Dialog } from '../../../shared/ui/Dialog';
import { showToast } from '../utils/toast';
import styles from './NewSessionModal.module.css';
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

  const handleBonusEpisode = () => {
    const v = episode.trim();
    const core = v.toUpperCase().startsWith('BONUS') ? v.replace(/^\s*BONUS\s+/i, '').trim() : v;
    setEpisode(core ? `BONUS ${core}` : 'BONUS ');
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
      // utilities layer (the legacy .newSessionDialog rule would lose to Dialog utilities);
      // md-scoped so the ≤767px bottom-sheet keeps its own full-width positioning.
      className={clsx(
        styles.newSessionDialog,
        'md:![transform:translate(calc(-50%+8.125rem),-50%)]',
      )}
      hideTitle
      title="New Session"
    >
      <div className={styles.v6NewSessionHead}>
        <div className={styles.v6NewSessionModalTitleRow}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <title>New session</title>
            <path d="M12 5V19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M5 12H19" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <h2>New Session</h2>
        </div>
        <button
          type="button"
          className={styles.v6NewSessionClose}
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
          style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}
        >
          <label className="field inline" style={{ flex: '0 0 auto', width: '8rem' }}>
            <span>Episode</span>
            <input
              type="text"
              id="ns-episode"
              className="profile-select"
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
          <label className="field inline" style={{ flex: '1 1 0', minWidth: 0 }}>
            <span>
              YouTube video <span className="field-optional">(optional)</span>
            </span>
            <input
              type="url"
              id="ns-yt-url"
              className="profile-select"
              placeholder="Link to YouTube video"
              autoComplete="off"
              value={ytUrl}
              onChange={(e) => setYtUrl(e.target.value)}
            />
          </label>
        </div>
        <div className="tool-row tool-row-session-opts" style={{ alignItems: 'center' }}>
          <button type="button" className="btn" id="ns-bonus-episode" onClick={handleBonusEpisode}>
            Bonus episode
          </button>
          <label
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: '6px',
              marginLeft: 'auto',
            }}
          >
            <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
              Use YouTube publish date
            </span>
            <input
              type="checkbox"
              checked={useYtPublishDate}
              onChange={(e) => setUseYtPublishDate(e.target.checked)}
            />
          </label>
        </div>

        <label className="field">
          <span>Notes (optional)</span>
          <input
            type="text"
            id="ns-notes"
            name="notes"
            placeholder="Session notes"
            maxLength={2000}
            autoComplete="off"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>

        <div className="tool-row tool-row-session-opts">
          <div className="fps-field">
            <span className="fps-field-label">Frame rate</span>
            <Select
              id="ns-fps-preset"
              className="fps-select"
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
                    className="num fps-custom-input"
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
              className="num wide"
              onChange={(e) => setOffset(e.target.value)}
            />
          </label>

          <button type="submit" className="btn primary" id="ns-submit" disabled={isPending}>
            {isPending ? 'Creating…' : 'Create & open'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

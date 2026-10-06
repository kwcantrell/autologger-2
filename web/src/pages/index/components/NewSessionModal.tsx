import clsx from 'clsx';
import { ChevronRight, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { apiFetch } from '../../../api/client';
import { useCreateSession } from '../../../api/hooks/useSessions';
import { showAccessFrom } from '../../../api/hooks/useShowAccess';
import type { ProfilePayload } from '../../../api/types';
import { Button, TOUCH_TARGET } from '../../../shared/components/ui/button';
import { Checkbox } from '../../../shared/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '../../../shared/components/ui/field';
import { Input } from '../../../shared/components/ui/input';
import { Dialog, DialogActions } from '../../../shared/ui/Dialog';
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
// Disclosure toggles: ghost Buttons reset to the quiet inline-link look (mixed case, no padding).
const DISCLOSURE_BTN =
  'h-auto self-start gap-[0.4rem] border-0 bg-transparent p-0 text-[0.78rem] font-semibold normal-case tracking-normal text-v5-muted hover:bg-transparent hover:text-v5-text';
// `.profile-select`'s bottom margin (form spacing), now on the shadcn Input.
const NS_FIELD_INPUT = clsx('mb-4', NS_INPUT_OVERRIDE);
// The inline label + number input rows (was `.inline` + `.num`).
const NS_INLINE_FIELD = 'items-center gap-[0.35rem]';
const NS_INLINE_LABEL = 'text-[0.85rem] text-legacy-muted';

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
  // show-grants D13: the picker lists the active team's shows the user can access.
  const shows = showAccessFrom(profile).accessibleShows(profile?.active_studio_id);
  const activeShowId = profile?.active_show_id ?? '';
  const defaultShowId = shows.some((s) => s.id === activeShowId) ? activeShowId : '';
  const defaultFps = profile?.new_session_defaults?.default_frame_rate ?? 24;
  const { preset: initPreset, custom: initCustom } = fpsToPreset(defaultFps);

  const [showId, setShowId] = useState(defaultShowId || (shows[0]?.id ?? ''));
  const [episode, setEpisode] = useState('');
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

  const { mutate: createSession, isPending } = useCreateSession();

  const selectedShow = shows.find((s) => s.id === showId);
  // session-title-suffix (design D6/D7): the episode field only makes sense
  // for Episode-suffix shows — Date-suffix shows derive the title server-side
  // from the show code + UTC date, with no operator-facing episode concept.
  const isEpisodeMode = selectedShow?.title_suffix === 'episode';

  const handleShowChange = (next: string) => {
    setShowId(next);
    const nextShow = shows.find((s) => s.id === next);
    // Clear stale episode text when switching to a Date-suffix show — nothing
    // seeds the field from a counter anymore, so any leftover value would be
    // sent (harmlessly ignored) or, worse, look like it means something once
    // the field is hidden again.
    if (nextShow?.title_suffix !== 'episode') {
      setEpisode('');
    }
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
    // Episode is only meaningful (and required) for Episode-suffix shows; Date-suffix
    // shows derive the title server-side and never show this field (design D6).
    if (isEpisodeMode && !episode.trim()) {
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
        // Date mode omits episode entirely — the server derives the title from the show
        // code + UTC date and does not fabricate an episode value client-side (design D6).
        episode: isEpisodeMode ? episode.trim() : undefined,
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
          <Plus className="size-5 shrink-0 text-[rgba(229,238,252,0.72)]" aria-hidden="true" />
          {/* Both `.v6-new-session-modal__title-row h2` and `.v6-new-session-head h2` matched
              this element at equal specificity; the head-h2 rule came LATER in source so it won:
              1rem / 600 / 0.06em / uppercase / v5-text / margin 0. */}
          <h2 className="m-0 text-[1rem] font-semibold tracking-[0.06em] uppercase text-v5-text">
            New Session
          </h2>
        </div>
        <Button
          variant="outline"
          size="icon"
          className={clsx('text-v5-muted hover:text-v5-text', TOUCH_TARGET)}
          aria-label="Close"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <form id="new-session-form" className="flex flex-col gap-3" onSubmit={handleSubmit}>
        <Field>
          <FieldLabel htmlFor="ns-show">Show</FieldLabel>
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
        </Field>

        {/* session-title-suffix (design D6/spec "New Session modal respects suffix"):
            the episode field (and the old Bonus toggle, removed entirely) only applies
            to Episode-suffix shows. Date-suffix shows derive the title server-side. */}
        {isEpisodeMode && (
          <Field>
            <FieldLabel htmlFor="ns-episode">Episode</FieldLabel>
            <Input
              type="text"
              id="ns-episode"
              className={NS_FIELD_INPUT}
              maxLength={80}
              autoComplete="off"
              value={episode}
              onChange={(e) => setEpisode(e.target.value)}
            />
          </Field>
        )}

        <Field>
          <FieldLabel htmlFor="ns-notes">Notes (optional)</FieldLabel>
          <Input
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
        </Field>

        {/* Progressive disclosure (ui-refresh): YouTube import + timecode
            plumbing collapse behind toggles with safe defaults; the summaries
            keep the current values readable while closed. */}
        <div className="mt-1 flex flex-col gap-2">
          <Button
            variant="ghost"
            className={DISCLOSURE_BTN}
            id="ns-toggle-yt"
            aria-expanded={showYt}
            onClick={() => setShowYt((v) => !v)}
          >
            <ChevronRight
              aria-hidden="true"
              className={clsx('size-3 [transition:transform_0.15s_ease]', showYt && 'rotate-90')}
            />
            Import audio from YouTube{!showYt && ytUrl.trim() ? ' — link added' : ''}
          </Button>
          {showYt && (
            <div className="flex flex-col gap-2 pl-5">
              <Field>
                <FieldLabel htmlFor="ns-yt-url">YouTube video link</FieldLabel>
                <Input
                  type="url"
                  id="ns-yt-url"
                  className={NS_FIELD_INPUT}
                  placeholder="https://www.youtube.com/watch?v=…"
                  autoComplete="off"
                  value={ytUrl}
                  onChange={(e) => setYtUrl(e.target.value)}
                />
              </Field>
              <Field orientation="horizontal" className="gap-[6px]">
                <Checkbox
                  id="ns-yt-publish-date"
                  checked={useYtPublishDate}
                  onCheckedChange={(v) => setUseYtPublishDate(v === true)}
                />
                <FieldLabel htmlFor="ns-yt-publish-date" className="text-[0.85rem]">
                  Use the video&apos;s publish date as the session date
                </FieldLabel>
              </Field>
            </div>
          )}

          <Button
            variant="ghost"
            className={DISCLOSURE_BTN}
            id="ns-toggle-advanced"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            <ChevronRight
              aria-hidden="true"
              className={clsx(
                'size-3 [transition:transform_0.15s_ease]',
                showAdvanced && 'rotate-90',
              )}
            />
            Timecode settings — {fpsPreset === 'other' ? fpsCustom || '?' : fpsPreset} fps · offset{' '}
            {offset || '0'}
          </Button>
          {showAdvanced && (
            <div className="flex flex-col gap-3 pl-5">
              <Field className="min-w-[min(100%,14rem)]">
                <FieldLabel htmlFor="ns-fps-preset">Frame rate</FieldLabel>
                <Select
                  id="ns-fps-preset"
                  // Keep the fps trigger compact inside the column.
                  className="max-w-[14rem] min-w-0"
                  ariaLabel="Frame rate"
                  value={fpsPreset}
                  onChange={setFpsPreset}
                  options={[
                    ...FPS_PRESETS.map(([value, label]) => ({ value, label })),
                    { value: 'other', label: 'Other…' },
                  ]}
                />
                {fpsPreset === 'other' && (
                  <Field
                    id="ns-fps-custom-wrap"
                    orientation="horizontal"
                    className={clsx(NS_INLINE_FIELD, 'mt-[0.15rem] flex-wrap')}
                  >
                    <FieldLabel htmlFor="ns-fps-custom" className={NS_INLINE_LABEL}>
                      Custom fps
                    </FieldLabel>
                    <Input
                      type="number"
                      id="ns-fps-custom"
                      min="1"
                      max="120"
                      step="0.001"
                      className={clsx('w-[4.5rem] min-w-24', NS_INPUT_OVERRIDE)}
                      placeholder="1–120"
                      autoFocus
                      value={fpsCustom}
                      onChange={(e) => setFpsCustom(e.target.value)}
                    />
                  </Field>
                )}
                <FieldDescription
                  id="ns-fps-hint"
                  className="max-w-[18rem] text-[0.72rem] leading-[1.3] text-legacy-muted"
                >
                  NTSC fractional rates use SMPTE-true values.
                </FieldDescription>
              </Field>

              <Field orientation="horizontal" className={NS_INLINE_FIELD}>
                <FieldLabel htmlFor="ns-offset" className={NS_INLINE_LABEL}>
                  Start offset (frames)
                </FieldLabel>
                <Input
                  type="number"
                  id="ns-offset"
                  value={offset}
                  min="0"
                  step="1"
                  className={clsx('w-24', NS_INPUT_OVERRIDE)}
                  onChange={(e) => setOffset(e.target.value)}
                />
              </Field>
            </div>
          )}
        </div>

        <DialogActions>
          <Button type="submit" className={TOUCH_TARGET} id="ns-submit" disabled={isPending}>
            {isPending ? 'Creating…' : 'Create & open'}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

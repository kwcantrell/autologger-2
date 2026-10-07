import { useQueryClient } from '@tanstack/react-query';
import { PlusIcon, TvIcon, XIcon } from 'lucide-react';
import { type CSSProperties, Fragment, type ReactNode, useState } from 'react';
import { useProfile, useProfileMutation } from '../../../../api/hooks/useProfile';
import { showAccessFrom } from '../../../../api/hooks/useShowAccess';
import type { ProfilePayload } from '../../../../api/types';
import { Alert, AlertDescription } from '../../../../shared/components/ui/alert';
import { Button } from '../../../../shared/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../../shared/components/ui/card';
import { Checkbox } from '../../../../shared/components/ui/checkbox';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../../../../shared/components/ui/empty';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from '../../../../shared/components/ui/field';
import { Input } from '../../../../shared/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from '../../../../shared/components/ui/item';
import { Kbd } from '../../../../shared/components/ui/kbd';
import { RadioGroup, RadioGroupItem } from '../../../../shared/components/ui/radio-group';
import { Spinner } from '../../../../shared/components/ui/spinner';
import { Textarea } from '../../../../shared/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '../../../../shared/components/ui/toggle-group';
import { cn } from '../../../../shared/lib/utils';
import { useConfirm } from '../../../../shared/ui/ConfirmDialog';
import { normalizePalette9, PALETTE_SLOT_INDICES } from '../../utils/palette9';
import { showToast } from '../../utils/toast';
import { Select } from '../Select';
import {
  applyPalettePreset,
  cleanDropdownOptions,
  copyButtonsFrom,
  EVENT_BUTTON_TYPES,
  type EventButtonDraft,
  type EventButtonType,
  eventButtonSummary,
  INSTRUCTION_MAX,
  isInstructionBearing,
  newEventButton,
  PALETTE_PRESET_IDS,
  type PaletteFields,
  presetLabel,
  setPaletteSlot,
  withButtonType,
} from './eventButtonsModel';
import type { SettingsSectionProps } from './SettingsView';
import { runSaveSteps, SidePanel } from './SidePanel';
import {
  activeShowIdForSave,
  invalidateAfterProfileSave,
  type ShowDraft,
  showDraftToUpdate,
} from './settingsModel';
import {
  RoleLockNotice,
  SectionSaveBar,
  SettingRow,
  SettingsSectionHeader,
  ShowsNotReady,
} from './settingsParts';
import { type SettingsShowsScope, useInlineDraft, useSettingsShows } from './settingsScopes';

// --- Settings › Event buttons (redesign-show-ignition 9.1-9.2; design D6, D10) ---
//
// The active show's logging strip as a list plus a panel:
//   - one "Buttons" card whose first two rows are the Palette (preset ToggleGroup) and its Colours
//     (nine slots; editing one makes the palette Custom), then a row per button (key 1–9 or "–",
//     name, summary, colour, Edit) and Add button. The palette is an INLINE slice with the card's
//     save bar (web-ui-system "Honest save model in Settings");
//   - a "Copy from another show" card, which replaces this show's buttons and colours with a copy
//     of another show's, instructions included, after a confirm;
//   - each button opens in a `SidePanel`: preview, name, type, colour, Dropdown options (label,
//     needs context, per-option instruction), On/Off labels, the whole-button instruction (none
//     for On/Off), Move up / Move down (drag reorder is gone) and Delete with a second-click
//     confirm. Save writes the show's WHOLE category array through `show_updates`.
// Every write carries the active team and echoes the active show, and sends the show's saved
// palette or buttons for whatever it is not changing, so a panel save never commits unsaved
// palette edits. The rules (type switch, instruction-bearing, presets, copy) live in
// `eventButtonsModel.ts`; the wire mapping in `settingsModel.ts`.

const keyLabel = (index: number) => (index < 9 ? String(index + 1) : '–');

export function EventButtonsSection({ onGoToSection }: SettingsSectionProps) {
  const { data: profile } = useProfile();
  const scope = useSettingsShows();
  const showId = scope.activeShowId;
  const saved = showId ? scope.baseline[showId] : undefined;
  const role = showAccessFrom(profile).teamRole(scope.studioId);
  const canEdit = role === 'owner' || role === 'admin';
  const teamName = profile?.studios.find((s) => s.id === scope.studioId)?.name ?? 'this team';

  const showName =
    (saved ? saved.name || 'Untitled show' : undefined) ??
    profile?.shows.find((s) => s.id === profile.active_show_id)?.name;
  const header = (
    <SettingsSectionHeader
      title="Event buttons"
      description={
        showName
          ? `The logging strip for ${showName}. Keys 1–9 log while the console has focus.`
          : 'The logging strip for the active show.'
      }
    />
  );

  if (!profile || !scope.studioId) {
    return (
      <>
        {header}
        <Empty>
          <EmptyDescription>Join or create a team to set up its shows.</EmptyDescription>
        </Empty>
      </>
    );
  }
  if (!scope.ready) {
    return (
      <>
        {header}
        <ShowsNotReady unavailable={scope.unavailable} onRetry={scope.retry} />
      </>
    );
  }
  if (!saved) {
    return (
      <>
        {header}
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TvIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No shows yet</EmptyTitle>
            <EmptyDescription>
              {canEdit
                ? `${teamName} has no shows. Add one in Shows.`
                : `${teamName} has no shows yet.`}
            </EmptyDescription>
          </EmptyHeader>
          {canEdit && (
            <EmptyContent>
              <Button variant="outline" onClick={() => onGoToSection('shows')}>
                Go to Shows
              </Button>
            </EmptyContent>
          )}
        </Empty>
      </>
    );
  }

  return (
    <>
      {header}
      {!canEdit && role && <RoleLockNotice role={role} teamName={teamName} />}
      <EventButtons
        profile={profile}
        scope={scope}
        showId={showId}
        saved={saved}
        canEdit={canEdit}
      />
    </>
  );
}

function EventButtons({
  profile,
  scope,
  showId,
  saved,
  canEdit,
}: {
  profile: ProfilePayload;
  scope: SettingsShowsScope;
  showId: string;
  saved: ShowDraft;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const mutation = useProfileMutation();
  const { confirm, confirmElement } = useConfirm();

  // The palette: an inline slice, re-seeded whenever the show's saved palette changes.
  const slice: PaletteFields = {
    event_palette: saved.event_palette,
    event_palette_preset: saved.event_palette_preset,
    event_palette_custom: saved.event_palette_custom,
  };
  const palette = useInlineDraft<PaletteFields>(
    'event-buttons',
    `${scope.studioId}:${showId}:${JSON.stringify(slice)}`,
    slice,
  );
  const [paletteSaving, setPaletteSaving] = useState(false);
  const [paletteError, setPaletteError] = useState<string | null>(null);

  const others = scope.shows.filter((s) => s.studio_id === scope.studioId && s.id !== showId);
  const [copyFrom, setCopyFrom] = useState('');
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  // `null` index: Add button. Each open is a fresh mount (`n`); closing keeps it mounted so the
  // sheet animates out and hands focus back.
  const [panel, setPanel] = useState<{ index: number | null; open: boolean; n: number } | null>(
    null,
  );
  const openPanel = (index: number | null) =>
    setPanel((p) => ({ index, open: true, n: (p?.n ?? 0) + 1 }));

  /** One profile write of this show, then the saved baseline and the dependent caches. */
  async function writeShow(next: ShowDraft, label: string) {
    await runSaveSteps([
      {
        label,
        run: () =>
          mutation.mutateAsync({
            active_studio_id: scope.studioId,
            active_show_id: activeShowIdForSave(profile, scope.studioId, {
              ready: scope.ready,
              selectedShowId: showId,
            }),
            show_updates: [showDraftToUpdate(showId, next)],
          }),
      },
    ]);
    scope.commitShow(showId, next);
    invalidateAfterProfileSave(queryClient, { showUpdates: true });
  }

  async function savePalette() {
    if (!palette.value) return;
    const fields = palette.value;
    setPaletteError(null);
    setPaletteSaving(true);
    try {
      // The saved buttons go back unchanged; only the palette is this slice's.
      await writeShow({ ...saved, ...fields }, 'save the palette');
      palette.markSaved(fields);
      showToast('Saved.');
    } catch (err) {
      setPaletteError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setPaletteSaving(false);
    }
  }

  async function copyButtons() {
    const src = scope.baseline[copyFrom];
    if (!src) return;
    const srcName = src.name || 'the other show';
    const n = src.categories.length;
    const ok = await confirm({
      title: 'Replace this show’s buttons?',
      message: `${saved.name || 'This show'}’s ${saved.categories.length} buttons and colours will be replaced with a copy of ${srcName}’s ${n} button${n === 1 ? '' : 's'} and colours.`,
      confirmLabel: 'Replace buttons',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    setCopyError(null);
    setCopying(true);
    try {
      await writeShow({ ...saved, ...copyButtonsFrom(src) }, `copy the buttons from ${srcName}`);
      setCopyFrom('');
      showToast(`Copied ${n} button${n === 1 ? '' : 's'} from ${srcName}.`);
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : 'Copy failed.');
    } finally {
      setCopying(false);
    }
  }

  const value = palette.value ?? slice;
  const swatches = normalizePalette9(value.event_palette);
  const buttons = saved.categories;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Buttons</CardTitle>
          <CardDescription>
            {buttons.length === 0
              ? 'No buttons yet.'
              : `${buttons.length} button${buttons.length === 1 ? '' : 's'}, in logging-strip order.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FieldGroup className="gap-4">
            <WideRow
              row="palette"
              title="Palette"
              titleId="event-palette-label"
              description="The colours every button in this show picks from."
              disabled={!canEdit}
            >
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                spacing={1}
                aria-labelledby="event-palette-label"
                className="flex-wrap"
                disabled={!canEdit}
                value={value.event_palette_preset}
                onValueChange={(v) => {
                  // A single toggle group deselects on a second click; a preset is always set.
                  if (v) palette.update(applyPalettePreset(value, v));
                }}
              >
                {PALETTE_PRESET_IDS.map((id) => (
                  <ToggleGroupItem key={id} value={id}>
                    {presetLabel(id)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </WideRow>
            <FieldSeparator />
            <WideRow
              row="colours"
              controlClassName="grid w-full grid-cols-9 gap-2 md:w-88"
              title="Colours"
              description="Change one and the palette becomes Custom."
              disabled={!canEdit}
            >
              {PALETTE_SLOT_INDICES.map((slot) => (
                <input
                  key={slot}
                  type="color"
                  className="pal-slot aspect-square h-auto! w-full!"
                  aria-label={`Colour ${slot + 1}`}
                  title={`Colour ${slot + 1}: ${swatches[slot]}`}
                  disabled={!canEdit}
                  value={swatches[slot]}
                  onChange={(e) => palette.update(setPaletteSlot(value, slot, e.target.value))}
                />
              ))}
            </WideRow>
          </FieldGroup>
          <FieldSeparator />
          <ItemGroup aria-label="Event buttons">
            {buttons.map((btn, i) => (
              <Fragment key={btn.id}>
                {i > 0 && <ItemSeparator />}
                <ButtonRow btn={btn} index={i} canEdit={canEdit} onEdit={() => openPanel(i)} />
              </Fragment>
            ))}
            {buttons.length > 0 && <ItemSeparator />}
            <Item role="listitem" size="sm" data-row="add" className="justify-end">
              <ItemActions>
                <Button variant="outline" disabled={!canEdit} onClick={() => openPanel(null)}>
                  <PlusIcon data-icon="inline-start" aria-hidden="true" />
                  Add button
                </Button>
              </ItemActions>
            </Item>
          </ItemGroup>
        </CardContent>
        <SectionSaveBar
          dirty={palette.dirty}
          saving={paletteSaving}
          valid={canEdit}
          error={paletteError}
          onSave={() => void savePalette()}
        />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Copy from another show</CardTitle>
          <CardDescription>
            Replaces this show’s buttons and colours with a copy of another show’s, generation
            instructions included.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SettingRow label="Copy buttons from" disabled={!canEdit}>
            {others.length ? (
              <>
                <Select
                  className="min-w-0 flex-1"
                  ariaLabel="Show to copy buttons from"
                  placeholder="Choose a show…"
                  disabled={!canEdit || copying}
                  value={copyFrom}
                  onChange={setCopyFrom}
                  options={others.map((s) => ({
                    value: s.id,
                    label: scope.baseline[s.id]?.name || s.name || s.show_code || s.id,
                  }))}
                />
                <Button
                  variant="outline"
                  disabled={!canEdit || !copyFrom || copying}
                  onClick={() => void copyButtons()}
                >
                  {copying && <Spinner data-icon="inline-start" aria-hidden="true" />}
                  Copy
                </Button>
              </>
            ) : (
              <span className="text-sm text-muted-foreground">No other shows on this team</span>
            )}
          </SettingRow>
          {copyError && (
            <Alert variant="destructive">
              <AlertDescription>{copyError}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {canEdit && panel && (
        <EventButtonPanel
          key={panel.n}
          open={panel.open}
          index={panel.index}
          saved={saved}
          onWrite={writeShow}
          onClose={() => setPanel((p) => (p ? { ...p, open: false } : p))}
        />
      )}
      {confirmElement}
    </>
  );
}

/**
 * A setting row whose control side is as wide as its content (five presets, nine slots, two move
 * buttons), where `SettingRow` fixes it at 260px and squeezes the label in a narrow panel.
 * Stacked below `md`.
 */
function WideRow({
  row,
  title,
  titleId,
  description,
  disabled,
  controlClassName,
  children,
}: {
  row?: string;
  /** Layout for the control side (the nine slots lay out as a grid). */
  controlClassName?: string;
  title: string;
  titleId?: string;
  description: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Field
      orientation="horizontal"
      data-row={row}
      data-disabled={disabled || undefined}
      className="justify-between gap-4 max-md:flex-col max-md:items-stretch"
    >
      <FieldContent className="min-w-0">
        <FieldTitle id={titleId}>{title}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <div className={cn('flex min-w-0 shrink-0 flex-wrap items-center gap-2', controlClassName)}>
        {children}
      </div>
    </Field>
  );
}

function ButtonRow({
  btn,
  index,
  canEdit,
  onEdit,
}: {
  btn: EventButtonDraft;
  index: number;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const name = btn.name || 'Untitled button';
  const summary = eventButtonSummary(btn);
  return (
    <Item
      role="listitem"
      size="sm"
      data-row="button"
      data-testid={`event-button-row-${btn.name}`}
      data-instruction-bearing={isInstructionBearing(btn)}
      className="flex-nowrap"
    >
      <ItemMedia>
        <Kbd aria-label={index < 9 ? `Key ${index + 1}` : 'No key'}>{keyLabel(index)}</Kbd>
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="max-w-full min-w-0">
          <span className="min-w-0 truncate">{name}</span>
        </ItemTitle>
        <ItemDescription className="truncate">{summary}</ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0">
        <span
          data-slot="event-button-colour"
          aria-hidden="true"
          className="size-4 rounded-[4px] border border-(--si-line)"
          style={{ backgroundColor: btn.color }}
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={!canEdit}
          aria-label={`Edit ${name}`}
          onClick={onEdit}
        >
          Edit
        </Button>
      </ItemActions>
    </Item>
  );
}

// ── The panel ───────────────────────────────────────────────────────────────

interface ButtonPanelDraft {
  button: EventButtonDraft;
  /** Where the button sits in the strip (its key is position + 1, for the first nine). */
  position: number;
}

/** Every option carries an instruction string in the draft, so `''` and absent compare equal. */
const forPanel = (btn: EventButtonDraft): EventButtonDraft => ({
  ...btn,
  dropdown_options: btn.dropdown_options.map((o) => ({
    label: o.label,
    needs_context: o.needs_context,
    auto_instruction: o.auto_instruction ?? '',
  })),
});

function EventButtonPanel({
  open,
  index,
  saved,
  onWrite,
  onClose,
}: {
  open: boolean;
  /** `null` for Add button. */
  index: number | null;
  saved: ShowDraft;
  onWrite: (next: ShowDraft, label: string) => Promise<void>;
  onClose: () => void;
}) {
  const isNew = index === null;
  const count = saved.categories.length;
  const swatches = normalizePalette9(saved.event_palette);
  const [baseline] = useState<ButtonPanelDraft>(() =>
    isNew
      ? { button: newEventButton(swatches), position: count }
      : { button: forPanel(saved.categories[index]), position: index },
  );
  const [draft, setDraft] = useState<ButtonPanelDraft>(baseline);
  // Stable row keys for the options (the draft's options carry no id).
  const [optKeys, setOptKeys] = useState<string[]>(() =>
    baseline.button.dropdown_options.map(() => crypto.randomUUID()),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const btn = draft.button;
  const setButton = (next: EventButtonDraft) => setDraft((d) => ({ ...d, button: next }));
  const patch = (p: Partial<EventButtonDraft>) => setButton({ ...btn, ...p });
  const patchOption = (i: number, p: Partial<EventButtonDraft['dropdown_options'][number]>) =>
    patch({ dropdown_options: btn.dropdown_options.map((o, k) => (k === i ? { ...o, ...p } : o)) });

  function changeType(type: EventButtonType) {
    const next = withButtonType(btn, type);
    if (next.dropdown_options.length !== optKeys.length) {
      setOptKeys(next.dropdown_options.map(() => crypto.randomUUID()));
    }
    setButton(forPanel(next));
  }

  /** The category array this panel would save: the button cleaned and at its position. */
  function categoriesWith(button: EventButtonDraft): EventButtonDraft[] {
    const rest = isNew ? [...saved.categories] : saved.categories.filter((_, k) => k !== index);
    rest.splice(draft.position, 0, button);
    return rest;
  }

  async function save() {
    const onOff = btn.type === 'ON_OFF';
    const final: EventButtonDraft = {
      ...btn,
      name: btn.name.trim(),
      dropdown_options: cleanDropdownOptions(btn.dropdown_options),
      on_label: onOff ? btn.on_label.trim() : btn.on_label,
      off_label: onOff ? btn.off_label.trim() : btn.off_label,
      auto_instruction: onOff ? '' : btn.auto_instruction,
    };
    await onWrite(
      { ...saved, categories: categoriesWith(final) },
      isNew ? 'add the button' : 'save the button',
    );
  }

  async function handleDelete() {
    if (index === null) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await onWrite(
        { ...saved, categories: saved.categories.filter((_, k) => k !== index) },
        'delete the button',
      );
      onClose();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Delete failed.');
      setDeleting(false);
    }
  }

  const position = draft.position;
  const key = position < 9 ? String(position + 1) : null;
  const typeInfo = EVENT_BUTTON_TYPES.find((t) => t.value === btn.type);
  const previewLabel =
    btn.type === 'ON_OFF' ? btn.off_label.trim() || btn.name.trim() : btn.name.trim();
  const colourIndex = swatches.indexOf(btn.color.toLowerCase());

  return (
    <SidePanel
      open={open}
      onClose={onClose}
      title={isNew ? 'New button' : 'Edit button'}
      description={saved.name || 'Untitled show'}
      media={<Kbd aria-hidden="true">{key ?? '–'}</Kbd>}
      value={draft}
      baseline={baseline}
      valid={btn.name.trim() !== ''}
      onSave={save}
      saveLabel={isNew ? 'Add button' : 'Save'}
    >
      <Field>
        <FieldTitle>Preview</FieldTitle>
        <Button
          asChild
          variant="log"
          size={null}
          className="min-h-16 w-full max-w-56 flex-col items-start justify-between gap-2 p-2.5 text-left"
          style={{ '--cat': btn.color } as CSSProperties}
          data-latched={btn.type === 'ON_OFF' ? 'off' : undefined}
        >
          <div data-testid="event-button-preview" aria-hidden="true">
            <span className="flex items-center gap-2">
              {key && <Kbd>{key}</Kbd>}
              <span className="size-2 shrink-0 rounded-[2px] bg-(--cat)" />
            </span>
            <span className="min-w-0 break-words leading-tight">{previewLabel || 'Untitled'}</span>
          </div>
        </Button>
      </Field>

      <FieldSet>
        <FieldLegend>Button</FieldLegend>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="event-button-name">Name</FieldLabel>
            <Input
              id="event-button-name"
              type="text"
              maxLength={200}
              autoComplete="off"
              placeholder="Event name"
              value={btn.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
            <FieldDescription>Shown on the button and as the event’s category.</FieldDescription>
          </Field>
          <Field>
            <FieldTitle id="event-button-type-label">Type</FieldTitle>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              className="flex-wrap"
              aria-labelledby="event-button-type-label"
              value={btn.type}
              onValueChange={(v) => {
                if (v) changeType(v as EventButtonType);
              }}
            >
              {EVENT_BUTTON_TYPES.map((t) => (
                <ToggleGroupItem key={t.value} value={t.value}>
                  {t.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>{typeInfo?.help}</FieldDescription>
          </Field>
          <Field>
            <FieldTitle id="event-button-colour-label">Colour</FieldTitle>
            <RadioGroup
              aria-labelledby="event-button-colour-label"
              className="grid grid-cols-9 gap-2"
              value={colourIndex >= 0 ? String(colourIndex) : ''}
              onValueChange={(v) => patch({ color: swatches[Number(v)] })}
            >
              {swatches.map((hex, i) => (
                <RadioGroupItem
                  // biome-ignore lint/suspicious/noArrayIndexKey: the nine palette slots are positional and may repeat a colour.
                  key={i}
                  value={String(i)}
                  aria-label={`Colour ${i + 1} ${hex}`}
                  className="size-auto w-full rounded-md"
                  style={{ backgroundColor: hex }}
                />
              ))}
            </RadioGroup>
            <FieldDescription>
              {colourIndex >= 0
                ? `From this show’s ${presetLabel(saved.event_palette_preset)} palette.`
                : `Its colour (${btn.color}) isn’t in this show’s palette. Pick one to change it.`}
            </FieldDescription>
          </Field>
        </FieldGroup>
      </FieldSet>

      {btn.type === 'DROPDOWN' && (
        <FieldSet>
          <FieldLegend>Options</FieldLegend>
          <FieldDescription>
            The chosen option becomes the event message. “Needs context” asks for a note after it is
            picked.
          </FieldDescription>
          <FieldGroup className="gap-4">
            {btn.dropdown_options.map((opt, i) => {
              const id = `event-option-${optKeys[i]}`;
              const n = i + 1;
              return (
                <Fragment key={optKeys[i]}>
                  {i > 0 && <FieldSeparator />}
                  <FieldGroup className="gap-2">
                    <Field orientation="horizontal" className="items-end gap-2">
                      <Field className="min-w-0 flex-1">
                        <FieldLabel htmlFor={`${id}-label`}>{`Option ${n}`}</FieldLabel>
                        <Input
                          id={`${id}-label`}
                          aria-label={`Option ${n} label`}
                          type="text"
                          maxLength={200}
                          value={opt.label}
                          onChange={(e) => patchOption(i, { label: e.target.value })}
                        />
                      </Field>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove option ${n}`}
                        disabled={btn.dropdown_options.length < 2}
                        onClick={() => {
                          patch({
                            dropdown_options: btn.dropdown_options.filter((_, k) => k !== i),
                          });
                          setOptKeys((keys) => keys.filter((_, k) => k !== i));
                        }}
                      >
                        <XIcon aria-hidden="true" />
                      </Button>
                    </Field>
                    <Field orientation="horizontal">
                      <Checkbox
                        id={`${id}-context`}
                        aria-label={`Option ${n} needs context`}
                        checked={opt.needs_context}
                        onCheckedChange={(v) => patchOption(i, { needs_context: v === true })}
                      />
                      <FieldLabel htmlFor={`${id}-context`} className="font-normal">
                        Needs context
                      </FieldLabel>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${id}-instruction`} className="font-normal">
                        Instruction for this option
                      </FieldLabel>
                      <Textarea
                        id={`${id}-instruction`}
                        aria-label={`Option ${n} instruction`}
                        rows={2}
                        maxLength={INSTRUCTION_MAX}
                        placeholder="Optional. When should AUTO GENERATE pick this option?"
                        value={opt.auto_instruction ?? ''}
                        onChange={(e) => patchOption(i, { auto_instruction: e.target.value })}
                      />
                    </Field>
                  </FieldGroup>
                </Fragment>
              );
            })}
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => {
                patch({
                  dropdown_options: [
                    ...btn.dropdown_options,
                    { label: '', needs_context: false, auto_instruction: '' },
                  ],
                });
                setOptKeys((keys) => [...keys, crypto.randomUUID()]);
              }}
            >
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Add option
            </Button>
          </FieldGroup>
        </FieldSet>
      )}

      {btn.type === 'ON_OFF' && (
        <FieldSet>
          <FieldLegend>States</FieldLegend>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="event-button-on">On label</FieldLabel>
              <Input
                id="event-button-on"
                type="text"
                maxLength={200}
                value={btn.on_label}
                onChange={(e) => patch({ on_label: e.target.value })}
              />
              <FieldDescription>Logged when it switches on.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="event-button-off">Off label</FieldLabel>
              <Input
                id="event-button-off"
                type="text"
                maxLength={200}
                value={btn.off_label}
                onChange={(e) => patch({ off_label: e.target.value })}
              />
              <FieldDescription>Logged when it switches off.</FieldDescription>
            </Field>
          </FieldGroup>
        </FieldSet>
      )}

      <FieldSet>
        <FieldLegend>Auto-generate</FieldLegend>
        {btn.type === 'ON_OFF' ? (
          <FieldDescription>On / Off buttons can’t auto-generate events.</FieldDescription>
        ) : (
          <Field>
            <FieldLabel htmlFor="event-button-instruction">Instruction</FieldLabel>
            <Textarea
              id="event-button-instruction"
              aria-label="Auto-generate instruction"
              rows={3}
              maxLength={INSTRUCTION_MAX}
              placeholder="e.g. Log when the host introduces a new segment."
              value={btn.auto_instruction}
              onChange={(e) => patch({ auto_instruction: e.target.value })}
            />
            <FieldDescription>
              When a transcript is generated, AutoLogger can log this event for you. Describe when
              it should, or leave it empty to log it only by hand.
              {btn.type === 'DROPDOWN' && ' Each option can carry its own instruction too.'}
            </FieldDescription>
          </Field>
        )}
      </FieldSet>

      {!isNew && (
        <FieldSet>
          <FieldLegend>Position</FieldLegend>
          <WideRow
            title={key ? `Key ${key}` : 'No key'}
            description={`Position ${position + 1} of ${count} in the logging strip.${key ? '' : ' Only the first nine have a key.'}`}
          >
            <Button
              variant="outline"
              size="sm"
              disabled={position === 0}
              onClick={() => setDraft((d) => ({ ...d, position: d.position - 1 }))}
            >
              Move up
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={position >= count - 1}
              onClick={() => setDraft((d) => ({ ...d, position: d.position + 1 }))}
            >
              Move down
            </Button>
          </WideRow>
        </FieldSet>
      )}

      {!isNew && (
        <FieldSet>
          <FieldLegend className="sr-only">Delete</FieldLegend>
          <WideRow
            title="Delete button"
            description="Events already logged with it stay in their sessions."
          >
            <Button variant="destructive" disabled={deleting} onClick={() => void handleDelete()}>
              {deleting && <Spinner data-icon="inline-start" aria-hidden="true" />}
              {confirmDelete ? 'Click again to delete' : 'Delete'}
            </Button>
          </WideRow>
          {deleteError && (
            <Alert variant="destructive">
              <AlertDescription>{deleteError}</AlertDescription>
            </Alert>
          )}
        </FieldSet>
      )}
    </SidePanel>
  );
}

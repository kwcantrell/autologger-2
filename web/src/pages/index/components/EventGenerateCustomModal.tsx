import { useMemo, useState } from 'react';
import { useShow } from '../../../api/hooks/useShows';
import type { EventGenerateSelection, ShowCategory } from '../../../api/types';
import { Dialog } from '../../../shared/ui/Dialog';

interface Props {
  showId: string | null;
  onSubmit: (selection: EventGenerateSelection[]) => void;
  onClose: () => void;
}

interface Candidate {
  key: string;
  categoryId: string;
  categoryLabel: string;
  optionLabel?: string;
  instruction: string;
}

function selectionCandidates(categories: ShowCategory[]): Candidate[] {
  const flat = categories.flatMap((category) => {
    if (category.type === 'ON_OFF') return [];
    const categoryLabel = category.name || category.label || category.id;
    const buttonInstruction = category.auto_instruction?.trim();
    const button: Candidate[] = buttonInstruction
      ? [
          {
            key: JSON.stringify([category.id, null]),
            categoryId: category.id,
            categoryLabel,
            instruction: buttonInstruction,
          },
        ]
      : [];
    const options =
      category.type === 'DROPDOWN'
        ? category.dropdown_options.flatMap((option): Candidate[] => {
            const instruction = option.auto_instruction?.trim();
            const optionLabel = option.label.trim();
            return instruction && optionLabel
              ? [
                  {
                    key: JSON.stringify([category.id, optionLabel]),
                    categoryId: category.id,
                    categoryLabel,
                    optionLabel,
                    instruction,
                  },
                ]
              : [];
          })
        : [];
    return [...button, ...options];
  });
  // The server matches a selection entry by (category_id, trimmed option
  // label) and dedupes labels into a Set — duplicate option labels within a
  // dropdown are ONE selectable entry on the wire, so present them as one row
  // here too (first wins). Also keeps React keys unique: rendering duplicates
  // would share one checkbox state across visually distinct rows.
  const byKey = new Map<string, Candidate>();
  for (const candidate of flat) {
    if (!byKey.has(candidate.key)) byKey.set(candidate.key, candidate);
  }
  return [...byKey.values()];
}

export function EventGenerateCustomModal({ showId, onSubmit, onClose }: Props) {
  // profile-shows-slimming: the per-button/per-option `auto_instruction`s this
  // modal lists live on the show's `categories`, which `/api/profile` no
  // longer carries. This component is mounted only while the modal is open
  // (its caller renders it behind the open flag), so the fetch is lazy by
  // construction — no gate of its own is needed.
  const { data, isPending } = useShow(showId);
  const categories = data?.show.categories;
  const candidates = useMemo(() => selectionCandidates(categories ?? []), [categories]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  function toggle(key: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  // Derived from the LIVE candidate list, not `selected` alone: a show
  // refetch mid-modal (instruction removed elsewhere) can orphan selected
  // keys, and gating Generate on this intersection keeps the button honest —
  // it can never be enabled while a click would submit nothing.
  const selection = useMemo(
    () =>
      candidates.flatMap((candidate): EventGenerateSelection[] =>
        selected.has(candidate.key)
          ? [
              {
                category_id: candidate.categoryId,
                ...(candidate.optionLabel === undefined
                  ? {}
                  : { option_label: candidate.optionLabel }),
              },
            ]
          : [],
      ),
    [candidates, selected],
  );

  function submit() {
    if (selection.length > 0) onSubmit(selection);
  }

  const grouped = candidates.reduce<Map<string, Candidate[]>>((groups, candidate) => {
    const group = groups.get(candidate.categoryId) ?? [];
    group.push(candidate);
    groups.set(candidate.categoryId, group);
    return groups;
  }, new Map());

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Custom event generation"
      description="Choose the button and option instructions to use for this generation run."
      className="md:!w-[min(38rem,96vw)]"
    >
      <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto">
        {/* `isPending` is true for a DISABLED query too (null showId, nothing to
            fetch), so it is paired with the id — otherwise the modal would
            claim to be loading a show it never requested. */}
        {isPending && showId !== null && <p className="modal-hint muted">Loading instructions…</p>}
        {[...grouped.values()].map((group) => (
          <fieldset
            key={group[0].categoryId}
            className="rounded-v5-sm border border-v5-border px-3 py-2"
          >
            <legend className="px-1 text-[0.85rem] font-semibold text-v5-text">
              {group[0].categoryLabel}
            </legend>
            <div className="flex flex-col gap-2">
              {group.map((candidate) => {
                const label = candidate.optionLabel ?? 'Button instruction';
                return (
                  <label
                    key={candidate.key}
                    className="flex cursor-pointer items-start gap-2 text-[0.82rem] text-v5-text"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(candidate.key)}
                      onChange={(event) => toggle(candidate.key, event.target.checked)}
                    />
                    <span>
                      <span className={candidate.optionLabel ? 'pl-3 font-medium' : 'font-medium'}>
                        {label}
                      </span>
                      <span className="mt-0.5 block text-[0.76rem] text-v5-muted">
                        {candidate.instruction}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={selection.length === 0}
          onClick={submit}
        >
          Generate
        </button>
      </div>
    </Dialog>
  );
}
